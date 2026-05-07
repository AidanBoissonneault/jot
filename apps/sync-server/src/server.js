import Fastify from 'fastify';
import fastifyCors from '@fastify/cors';
import { betterAuth } from 'better-auth';
import { fromNodeHeaders } from 'better-auth/node';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import mysql from 'mysql2/promise';
import {
  kindFromNotionBlock,
  notionBlocksToTiptapDocument,
  tiptapDocumentToNotionBlocks,
} from './blockConversion.js';
import { replaceManagedBlocks as replaceManagedBlocksWithDependencies } from './managedBlocks.js';
import { createNotionRequester, uploadFileToNotion } from './notionRequest.js';
import { pushPageToNotionCore } from './pageSync.js';
import { syncProjectFolder } from './projectSync.js';
import { MergeableSyncQueue } from './syncQueue.js';

loadEnvFile(path.join(process.cwd(), '.env'));
loadEnvFile(path.join(process.cwd(), 'apps', 'sync-server', '.env'));

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? '127.0.0.1';
const NOTION_VERSION = process.env.NOTION_VERSION ?? '2026-03-11';
const DATA_DIR = process.env.JOT_SYNC_DATA_DIR ?? path.join(process.cwd(), '.data');
const STORE_FILE = path.join(DATA_DIR, 'store.json');
const JOT_ROOT_PAGE_TITLE = process.env.JOT_ROOT_PAGE_TITLE ?? 'Jot';
const JOT_SESSION_COOKIE = 'jot_session';
const JOT_OAUTH_STATE_COOKIE = 'jot_notion_oauth_state';
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;
const MAX_IMAGE_UPLOAD_BYTES = 20 * 1024 * 1024;

const fastify = Fastify({ logger: true });
const syncQueue = new MergeableSyncQueue();
const notionRequest = createNotionRequester({ notionVersion: NOTION_VERSION });
let mysqlPool;

const auth = betterAuth({
  appName: 'Jot',
  baseURL: process.env.BETTER_AUTH_URL ?? `http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`,
  secret: process.env.BETTER_AUTH_SECRET,
  database: mysql.createPool(mysqlConnectionConfig()),
  trustedOrigins: trustedOrigins(),
  socialProviders: {
    notion: {
      clientId: process.env.NOTION_OAUTH_CLIENT_ID,
      clientSecret: process.env.NOTION_OAUTH_CLIENT_SECRET,
    },
  },
  databaseHooks: {
    account: {
      create: {
        after: async (account) => {
          if (account.providerId !== 'notion') return;
          await getOrCreateInstallation(account.userId, account.accessToken).catch((error) => {
            fastify.log.error(error, 'Failed to create Notion installation after login');
          });
        },
      },
    },
  },
});

await fastify.register(fastifyCors, {
  origin(origin, callback) {
    if (!origin || isTrustedOrigin(origin)) {
      callback(null, true);
      return;
    }

    callback(new Error('Origin is not allowed by Jot sync server CORS policy.'), false);
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  credentials: true,
  maxAge: 86400,
});

fastify.addHook('onRequest', async (request, reply) => {
  const origin = request.headers.origin;
  reply.header(
    'Access-Control-Allow-Origin',
    origin && isTrustedOrigin(origin) ? origin : '*',
  );
  reply.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  reply.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
  reply.header('Access-Control-Allow-Credentials', 'true');

  if (request.method === 'OPTIONS') {
    return reply.status(204).send();
  }
});

fastify.route({
  method: ['GET', 'POST'],
  url: '/api/auth/*',
  async handler(request, reply) {
    try {
      const url = new URL(request.url, `http://${request.headers.host}`);
      const req = new Request(url.toString(), {
        method: request.method,
        headers: fromNodeHeaders(request.headers),
        ...(request.body ? { body: JSON.stringify(request.body) } : {}),
      });
      const response = await auth.handler(req);

      reply.status(response.status);
      response.headers.forEach((value, key) => reply.header(key, value));
      reply.send(response.body ? await response.text() : null);
    } catch (error) {
      fastify.log.error(error);
      reply.status(500).send({
        error: 'Internal authentication error',
        code: 'AUTH_FAILURE',
      });
    }
  },
});

fastify.get('/auth/jot/complete', async (_request, reply) =>
  reply.type('text/html').send(closePage('You are logged in to Jot. You can return to the side panel.')),
);

fastify.get('/auth/jot/error', async (_request, reply) =>
  reply
    .status(400)
    .type('text/html')
    .send(closePage('Jot login did not complete. You can close this tab and try again.')),
);

fastify.get('/auth/notion/start', async (_request, reply) => {
  if (!process.env.NOTION_OAUTH_CLIENT_ID || !process.env.NOTION_OAUTH_CLIENT_SECRET) {
    return reply
      .status(503)
      .type('text/html')
      .send(closePage('Notion login is not configured on the sync server yet.'));
  }

  const serverUrl = serverBaseUrl();
  const state = randomToken(24);
  const redirectUri = `${serverUrl}/auth/notion/callback`;
  const url = new URL('https://api.notion.com/v1/oauth/authorize');
  url.searchParams.set('client_id', process.env.NOTION_OAUTH_CLIENT_ID);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('owner', 'user');
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('state', state);

  setCookie(reply, JOT_OAUTH_STATE_COOKIE, state, {
    httpOnly: true,
    maxAge: 600,
    path: '/auth/notion',
    sameSite: 'Lax',
  });

  return reply.redirect(url.toString());
});

fastify.get('/auth/notion/callback', async (request, reply) => {
  const expectedState = readCookie(request, JOT_OAUTH_STATE_COOKIE);
  const state = typeof request.query?.state === 'string' ? request.query.state : '';
  const code = typeof request.query?.code === 'string' ? request.query.code : '';
  const error = typeof request.query?.error === 'string' ? request.query.error : '';

  clearCookie(reply, JOT_OAUTH_STATE_COOKIE, '/auth/notion');

  if (error) {
    return reply
      .status(400)
      .type('text/html')
      .send(closePage('Notion login did not complete. You can close this tab and try again.'));
  }

  if (!code || !state || !expectedState || state !== expectedState) {
    return reply
      .status(400)
      .type('text/html')
      .send(closePage('Notion login could not be verified. You can close this tab and try again.'));
  }

  try {
    const tokens = await exchangeNotionCode(code, `${serverBaseUrl()}/auth/notion/callback`);
    const user = notionUserFromToken(tokens);
    const userId = `notion:${user.id}`;
    const sessionToken = await createNotionSession({
      request,
      userId,
      notionAccountId: user.id,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      workspaceId: tokens.workspace_id,
      workspaceName: tokens.workspace_name,
      user,
    });

    setCookie(reply, JOT_SESSION_COOKIE, sessionToken, {
      httpOnly: true,
      maxAge: SESSION_MAX_AGE_SECONDS,
      path: '/',
      sameSite: 'Lax',
    });

    return reply
      .type('text/html')
      .send(closePage('You are logged in to Jot. You can return to the side panel.'));
  } catch (error) {
    fastify.log.error(error, 'Failed to complete Notion login');
    return reply
      .status(500)
      .type('text/html')
      .send(closePage('Notion login failed. You can close this tab and try again.'));
  }
});

fastify.get('/session', async (request) => {
  const session = await getJotSession(request);
  const installation = session
    ? await getActiveInstallation(session.user.id).catch(() => undefined)
    : undefined;

  return {
    authenticated: Boolean(session),
    userName: session?.user.name,
    userEmail: session?.user.email,
    connected: Boolean(installation),
    workspaceId: installation?.workspace_id,
    workspaceName: installation?.workspace_name,
  };
});

fastify.post('/auth/notion/logout', async (request, reply) => {
  const session = await requireJotSession(request, reply);

  if (!session) {
    return;
  }

  const db = await getDb();
  await db.execute(
    `UPDATE notion_installations SET active = 0, revoked_at = CURRENT_TIMESTAMP WHERE user_id = ?`,
    [session.user.id],
  );

  await auth.api.signOut({ headers: fromNodeHeaders(request.headers) }).catch(() => {});
  await deleteCustomSession(request).catch(() => {});
  clearCookie(reply, JOT_SESSION_COOKIE, '/');

  return { connected: false };
});

fastify.get('/logs', async () => {
  const store = await readStore();
  return { logs: store.logs.slice(-100) };
});

fastify.get('/notion/pages', async (request) => {
  const query = typeof request.query?.query === 'string' ? request.query.query : '';
  const store = await requireConnectedStore(request);
  const response = await notionRequest(store, '/search', {
    method: 'POST',
    body: {
      query,
      page_size: 25,
      filter: {
        property: 'object',
        value: 'page',
      },
    },
  });

  return {
    pages: response.results.map((page) => ({
      id: page.id,
      title: titleFromPage(page),
      url: page.url,
    })),
  };
});

fastify.post('/notion/pages', async (request) => {
  const title = String(request.body?.title ?? '').trim() || 'Jot';
  const store = await requireConnectedStore(request);
  const page = await createWorkspacePage(store, title);

  appendLog(store, 'parent_page_created', title);
  await writeStore(store);

  return {
    page: {
      id: page.id,
      title: titleFromPage(page),
      url: page.url,
    },
  };
});

fastify.post('/sync/push', async (request) => {
  const { page, project } = request.body ?? {};
  const { selectedParentPageId } = request.body ?? {};

  if (!page?.id || !project?.id) {
    return {
      status: 'error',
      message: 'Missing page or project.',
    };
  }

  return syncQueue.enqueue(
    `page:${project.id}:${page.id}`,
    {
      request,
      page,
      project,
      selectedParentPageId,
    },
    pushPageToNotion,
  );
});

fastify.post('/sync/project', async (request) => {
  const { project, selectedParentPageId } = request.body ?? {};

  if (!project?.id) {
    return {
      status: 'error',
      message: 'Missing project.',
    };
  }

  return syncQueue.enqueue(
    `project:${project.id}`,
    {
      request,
      project,
      selectedParentPageId,
    },
    syncProjectToNotion,
  );
});

async function syncProjectToNotion({
  request,
  project,
  selectedParentPageId,
}) {
  const store = await requireConnectedStore(request);
  const response = await syncProjectFolder({
    store,
    project,
    selectedParentPageId,
    ensureJotRootPage,
    ensureProjectRootPage,
    archiveProjectRootPage,
    pageSummary,
  });

  appendLog(store, project.status === 'archived' ? 'project_archived' : 'project_synced', project.name);
  await writeStore(store);

  return response;
}

async function pushPageToNotion({
  request,
  page,
  project,
  selectedParentPageId,
}) {
  return pushPageToNotionCore({
    request,
    page,
    project,
    selectedParentPageId,
    dependencies: {
      appendLog,
      createChildPage,
      ensureJotRootPage,
      ensureProjectRootPage,
      notionRequest,
      replaceManagedBlocks,
      requireConnectedStore,
      updateChildNotePage,
      writeStore,
    },
  });
}

fastify.post('/media/upload', async (request, reply) => {
  const { dataBase64, mimeType, filename } = request.body ?? {};
  if (!dataBase64 || !mimeType) {
    return reply.status(400).send({ error: 'Missing dataBase64 or mimeType.' });
  }

  if (!String(mimeType).startsWith('image/')) {
    return reply.status(400).send({ error: 'Only image uploads are supported.' });
  }

  if (!isBase64(dataBase64)) {
    return reply.status(400).send({ error: 'Invalid upload data.' });
  }

  const store = await requireConnectedStore(request);
  const buffer = Buffer.from(dataBase64, 'base64');

  if (buffer.byteLength > MAX_IMAGE_UPLOAD_BYTES) {
    return reply.status(413).send({ error: 'Images must be 20 MB or smaller.' });
  }

  const fileUploadId = await uploadFileToNotion(
    store,
    { data: buffer, mimeType, filename: sanitizeImageFilename(filename, mimeType) },
    { notionVersion: NOTION_VERSION },
  );

  return { fileUploadId };
});

fastify.post('/sync/pull', async (request) => {
  const { page } = request.body ?? {};

  if (!page?.id || !page.notionPageId) {
    return {
      page,
      status: 'saved',
      message: 'No Notion page is linked yet.',
    };
  }

  const store = await requireConnectedStore(request);
  const notionPage = await notionRequest(store, `/pages/${page.notionPageId}`);

  if (!page.remoteRevision || notionPage.last_edited_time === page.remoteRevision) {
    return {
      page: {
        ...page,
        notionLastEditedTime: notionPage.last_edited_time,
        remoteRevision: notionPage.last_edited_time,
        syncState: 'saved',
      },
      status: 'saved',
      message: 'Already current.',
    };
  }

  const pulledContent = await importManagedBlocks(store, page);

  if (!pulledContent) {
    return {
      page: {
        ...page,
        notionLastEditedTime: notionPage.last_edited_time,
        remoteRevision: notionPage.last_edited_time,
        syncState: 'stale',
      },
      status: 'stale',
      message: 'Notion changed this page in a way Jot cannot safely import automatically.',
    };
  }

  appendLog(store, 'sync_pull', page.title);
  await writeStore(store);

  return {
    page: {
      ...page,
      content: pulledContent,
      notionLastEditedTime: notionPage.last_edited_time,
      remoteRevision: notionPage.last_edited_time,
      syncState: 'saved',
    },
    status: 'saved',
    message: 'Imported simple Notion edits.',
  };
});

fastify.listen({ port: PORT, host: HOST });

async function readStore() {
  await mkdir(DATA_DIR, { recursive: true });

  try {
    const raw = await readFile(STORE_FILE, 'utf8');
    return normalizeStore(JSON.parse(raw));
  } catch {
    return normalizeStore({});
  }
}

async function writeStore(store) {
  if (store.installationId) {
    await writeJotSyncState(store.installationId, store);
  }

  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(STORE_FILE, JSON.stringify(normalizeStore(store), null, 2));
}

function normalizeStore(store) {
  return {
    parentPages: store.parentPages ?? {},
    projectPages: store.projectPages ?? {},
    jotRootPage: store.jotRootPage,
    jotDatabase: store.jotDatabase,
    notePages: store.notePages ?? {},
    blockMappings: store.blockMappings ?? {},
    logs: store.logs ?? [],
  };
}

function appendLog(store, event, message) {
  store.logs.push({
    at: new Date().toISOString(),
    event,
    message,
  });
  store.logs = store.logs.slice(-250);
}

async function requireConnectedStore(request) {
  const session = await getJotSession(request);

  if (!session) {
    throw new Error('Log in to Jot before syncing Notion.');
  }

  const [store, installation] = await Promise.all([
    readStore(),
    getActiveInstallationWithTokens(session.user.id),
  ]);

  if (!installation?.tokens?.access_token || !installation?.id) {
    throw new Error('Notion is not connected.');
  }

  const syncState = await readJotSyncState(installation.id);

  return {
    ...store,
    ...syncState,
    installationId: installation.id,
    tokens: installation.tokens,
  };
}

async function getJotSession(request) {
  const customSession = await getCustomSession(request);

  if (customSession) {
    return customSession;
  }

  return auth.api.getSession({
    headers: fromNodeHeaders(request.headers),
  }).catch(() => null);
}

async function requireJotSession(request, reply) {
  const session = await getJotSession(request);

  if (!session) {
    reply.status(401).send({
      error: 'Unauthorized',
      message: 'Log in to Jot first.',
    });
    return null;
  }

  return session;
}

function trustedOrigins() {
  return [
    process.env.BETTER_AUTH_URL ?? `http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`,
    process.env.JOT_EXTENSION_ORIGIN,
    ...(process.env.BETTER_AUTH_TRUSTED_ORIGINS?.split(',') ?? []),
  ]
    .map((origin) => origin?.trim())
    .filter(Boolean);
}

function isTrustedOrigin(origin) {
  if (origin.startsWith('chrome-extension://')) {
    return true;
  }

  return trustedOrigins().includes(origin);
}

function serverBaseUrl() {
  return process.env.BETTER_AUTH_URL ?? `http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`;
}

function randomToken(byteLength = 32) {
  return randomBytes(byteLength).toString('base64url');
}

function readCookie(request, name) {
  const cookieHeader = request.headers.cookie;

  if (!cookieHeader) {
    return undefined;
  }

  for (const part of cookieHeader.split(';')) {
    const [key, ...value] = part.trim().split('=');

    if (key === name) {
      return decodeURIComponent(value.join('='));
    }
  }

  return undefined;
}

function setCookie(reply, name, value, options = {}) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${options.path ?? '/'}`,
  ];

  if (options.httpOnly) {
    parts.push('HttpOnly');
  }

  if (options.maxAge) {
    parts.push(`Max-Age=${options.maxAge}`);
  }

  if (options.sameSite) {
    parts.push(`SameSite=${options.sameSite}`);
  }

  if (serverBaseUrl().startsWith('https://')) {
    parts.push('Secure');
  }

  appendSetCookie(reply, parts.join('; '));
}

function clearCookie(reply, name, pathValue = '/') {
  const parts = [`${name}=`, `Path=${pathValue}`, 'Max-Age=0', 'HttpOnly', 'SameSite=Lax'];

  if (serverBaseUrl().startsWith('https://')) {
    parts.push('Secure');
  }

  appendSetCookie(reply, parts.join('; '));
}

function appendSetCookie(reply, cookie) {
  const existing = reply.getHeader('Set-Cookie');

  if (!existing) {
    reply.header('Set-Cookie', cookie);
    return;
  }

  reply.header(
    'Set-Cookie',
    Array.isArray(existing) ? [...existing, cookie] : [existing, cookie],
  );
}

async function exchangeNotionCode(code, redirectUri) {
  const credentials = Buffer.from(
    `${process.env.NOTION_OAUTH_CLIENT_ID}:${process.env.NOTION_OAUTH_CLIENT_SECRET}`,
  ).toString('base64');
  const response = await fetch('https://api.notion.com/v1/oauth/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${credentials}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
    }),
  });
  const payload = await response.json().catch(() => ({}));

  if (!response.ok || !payload.access_token) {
    throw new Error(payload.message ?? `Notion OAuth returned ${response.status}.`);
  }

  return payload;
}

function notionUserFromToken(tokens) {
  const ownerUser = tokens.owner?.user;
  const id = ownerUser?.id ?? tokens.bot_id ?? tokens.workspace_id;
  const name = ownerUser?.name ?? tokens.workspace_name ?? 'Notion user';
  const email = ownerUser?.person?.email ?? `${id}@notion.local`;

  if (!id) {
    throw new Error('Notion OAuth response did not include a user or bot id.');
  }

  return {
    id,
    name,
    email,
    image: ownerUser?.avatar_url ?? null,
  };
}

async function createNotionSession({
  request,
  userId,
  notionAccountId,
  accessToken,
  refreshToken,
  workspaceId,
  workspaceName,
  user,
}) {
  const db = await getDb();
  userId = await upsertJotUser(db, userId, user);
  const sessionToken = randomToken();
  const sessionId = randomUUID();
  const accountId = `notion:${notionAccountId}`;
  const accountRowId = randomUUID();
  const expiresAt = new Date(Date.now() + SESSION_MAX_AGE_SECONDS * 1000);
  await db.execute(
    `INSERT INTO account (id, accountId, providerId, userId, accessToken, refreshToken)
     VALUES (?, ?, 'notion', ?, ?, ?)
     ON DUPLICATE KEY UPDATE userId = VALUES(userId),
       accessToken = VALUES(accessToken),
       refreshToken = VALUES(refreshToken)`,
    [accountRowId, accountId, userId, accessToken, refreshToken ?? null],
  );
  await db.execute(
    `DELETE FROM session WHERE userId = ? OR expiresAt < CURRENT_TIMESTAMP`,
    [userId],
  );
  await db.execute(
    `INSERT INTO session (id, expiresAt, token, ipAddress, userAgent, userId)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      sessionId,
      toMysqlDateTime(expiresAt),
      sessionToken,
      request.ip ?? null,
      request.headers['user-agent'] ?? null,
      userId,
    ],
  );

  await upsertNotionInstallation(userId, {
    workspaceId: workspaceId ?? null,
    workspaceName: workspaceName ?? null,
  });

  return sessionToken;
}

async function upsertJotUser(db, preferredUserId, user) {
  const [existingRows] = await db.execute(
    `SELECT id FROM user WHERE id = ? OR email = ? LIMIT 1`,
    [preferredUserId, user.email],
  );
  const userId = existingRows[0]?.id ?? preferredUserId;

  await db.execute(
    `INSERT INTO user (id, name, email, emailVerified, image)
     VALUES (?, ?, ?, 0, ?)
     ON DUPLICATE KEY UPDATE name = VALUES(name), email = VALUES(email), image = VALUES(image)`,
    [userId, user.name, user.email, user.image],
  );

  return userId;
}

async function getCustomSession(request) {
  const token = readCookie(request, JOT_SESSION_COOKIE);

  if (!token) {
    return null;
  }

  const db = await getDb();
  const [rows] = await db.execute(
    `SELECT s.id AS session_id, s.token, s.expiresAt, s.userId,
            u.id AS user_id, u.name, u.email, u.image, u.emailVerified
     FROM session s
     JOIN user u ON u.id = s.userId
     WHERE s.token = ? AND s.expiresAt > CURRENT_TIMESTAMP
     LIMIT 1`,
    [token],
  );
  const row = rows[0];

  if (!row) {
    return null;
  }

  return {
    session: {
      id: row.session_id,
      token: row.token,
      userId: row.userId,
      expiresAt: row.expiresAt,
    },
    user: {
      id: row.user_id,
      name: row.name,
      email: row.email,
      image: row.image,
      emailVerified: Boolean(row.emailVerified),
    },
  };
}

async function deleteCustomSession(request) {
  const token = readCookie(request, JOT_SESSION_COOKIE);

  if (!token) {
    return;
  }

  const db = await getDb();
  await db.execute(`DELETE FROM session WHERE token = ?`, [token]);
}

function toMysqlDateTime(date) {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

function isNotionObjectNotFound(error) {
  return error?.status === 404 || error?.code === 'object_not_found';
}

async function getDb() {
  if (!mysqlPool) {
    mysqlPool = mysql.createPool(mysqlConnectionConfig());
  }

  return mysqlPool;
}

function mysqlConnectionConfig() {
  const { MYSQL_DATABASE, MYSQL_USER, MYSQL_PASSWORD } = process.env;

  if (MYSQL_DATABASE && MYSQL_USER) {
    return {
      host: process.env.MYSQL_HOST ?? '127.0.0.1',
      port: Number(process.env.MYSQL_PORT ?? 3306),
      database: MYSQL_DATABASE,
      user: MYSQL_USER,
      password: MYSQL_PASSWORD ?? '',
      connectionLimit: Number(process.env.MYSQL_CONNECTION_LIMIT ?? 5),
      namedPlaceholders: true,
    };
  }

  if (process.env.DATABASE_URL) {
    return {
      uri: process.env.DATABASE_URL,
      connectionLimit: Number(process.env.MYSQL_CONNECTION_LIMIT ?? 5),
      namedPlaceholders: true,
    };
  }

  if (!MYSQL_DATABASE || !MYSQL_USER) {
    throw new Error('MySQL is not configured. Set DATABASE_URL or MYSQL_* environment variables.');
  }
}

async function getOrCreateInstallation(userId, accessToken) {
  let workspaceName = null;

  try {
    const profile = await notionRequest({ tokens: { access_token: accessToken } }, '/users/me');
    workspaceName = profile.bot?.workspace_name ?? null;
  } catch {
    // non-fatal: workspace name will just be null
  }

  await upsertNotionInstallation(userId, {
    workspaceId: null,
    workspaceName,
  });
}

async function upsertNotionInstallation(userId, { workspaceId, workspaceName }) {
  const db = await getDb();
  await db.execute(
    `UPDATE notion_installations SET active = 0, revoked_at = CURRENT_TIMESTAMP WHERE user_id = ?`,
    [userId],
  );
  const [result] = await db.execute(
    `INSERT INTO notion_installations (user_id, workspace_id, workspace_name, active)
     VALUES (?, ?, ?, 1)
     ON DUPLICATE KEY UPDATE
       id = LAST_INSERT_ID(id),
       workspace_name = VALUES(workspace_name),
       active = 1,
       revoked_at = NULL`,
    [userId, workspaceId, workspaceName],
  );
  await ensureJotSyncState(result.insertId);
}

async function getActiveInstallation(userId) {
  const db = await getDb();
  const [rows] = await db.execute(
    `SELECT id, workspace_id, workspace_name
     FROM notion_installations
     WHERE user_id = ? AND active = 1
     ORDER BY updated_at DESC
     LIMIT 1`,
    [userId],
  );

  return rows[0];
}

async function getActiveInstallationWithTokens(userId) {
  const db = await getDb();
  const [[accountRow], [installRow]] = await Promise.all([
    db
      .execute(`SELECT accessToken FROM account WHERE userId = ? AND providerId = 'notion' LIMIT 1`, [userId])
      .then(([rows]) => rows),
    db
      .execute(
        `SELECT id, workspace_id, workspace_name FROM notion_installations WHERE user_id = ? AND active = 1 ORDER BY updated_at DESC LIMIT 1`,
        [userId],
      )
      .then(([rows]) => rows),
  ]);

  if (!accountRow?.accessToken || !installRow) {
    return undefined;
  }

  return {
    ...installRow,
    tokens: { access_token: accountRow.accessToken },
  };
}

async function ensureJotSyncState(installationId, connection) {
  const db = connection ?? (await getDb());
  await db.execute(
    `INSERT IGNORE INTO jot_sync_state
      (installation_id, note_pages_json, block_mappings_json, parent_pages_json, project_pages_json)
     VALUES (?, JSON_OBJECT(), JSON_OBJECT(), JSON_OBJECT(), JSON_OBJECT())`,
    [installationId],
  );
}

async function readJotSyncState(installationId) {
  const db = await getDb();
  await ensureJotSyncState(installationId);
  const [rows] = await db.execute(
    `SELECT jot_database_id, jot_data_source_id, jot_parent_page_id, jot_database_title,
            note_pages_json, block_mappings_json, parent_pages_json, project_pages_json
     FROM jot_sync_state
     WHERE installation_id = ?`,
    [installationId],
  );
  const row = rows[0] ?? {};

  return {
    jotRootPage: row.jot_database_id
      ? {
          id: row.jot_database_id,
          parentPageId: row.jot_parent_page_id,
          title: row.jot_database_title,
        }
      : undefined,
    jotDatabase: row.jot_database_id
      ? {
          databaseId: row.jot_database_id,
          dataSourceId: row.jot_data_source_id,
          parentPageId: row.jot_parent_page_id,
          title: row.jot_database_title,
        }
      : undefined,
    notePages: parseJsonColumn(row.note_pages_json, {}),
    blockMappings: parseJsonColumn(row.block_mappings_json, {}),
    parentPages: parseJsonColumn(row.parent_pages_json, {}),
    projectPages: parseJsonColumn(row.project_pages_json, {}),
  };
}

async function writeJotSyncState(installationId, store) {
  const db = await getDb();
  await ensureJotSyncState(installationId);
  await db.execute(
    `UPDATE jot_sync_state
     SET jot_database_id = ?,
         jot_data_source_id = ?,
         jot_parent_page_id = ?,
         jot_database_title = ?,
         note_pages_json = ?,
         block_mappings_json = ?,
         parent_pages_json = ?,
         project_pages_json = ?
     WHERE installation_id = ?`,
    [
      store.jotRootPage?.id ?? store.jotDatabase?.databaseId ?? null,
      store.jotDatabase?.dataSourceId ?? null,
      store.jotRootPage?.parentPageId ?? store.jotDatabase?.parentPageId ?? null,
      store.jotRootPage?.title ?? store.jotDatabase?.title ?? null,
      JSON.stringify(store.notePages ?? {}),
      JSON.stringify(store.blockMappings ?? {}),
      JSON.stringify(store.parentPages ?? {}),
      JSON.stringify(store.projectPages ?? {}),
      installationId,
    ],
  );
}

function parseJsonColumn(value, fallback) {
  if (!value) {
    return fallback;
  }

  if (typeof value === 'object') {
    if (Buffer.isBuffer(value)) {
      return parseJsonColumn(value.toString('utf8'), fallback);
    }

    return value;
  }

  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

async function ensureJotRootPage(store, { selectedParentPageId }) {
  const stored = store.jotRootPage;

  if (stored?.id && (!selectedParentPageId || stored.parentPageId === selectedParentPageId)) {
    try {
      const page = await notionRequest(store, `/pages/${stored.id}`);
      store.jotRootPage = {
        id: page.id,
        parentPageId: selectedParentPageId ?? stored.parentPageId,
        title: titleFromPage(page) || stored.title || JOT_ROOT_PAGE_TITLE,
        url: page.url,
      };
      return pageSummary(store.jotRootPage);
    } catch (error) {
      appendLog(store, 'root_page_lookup_error', error.message);
    }
  }

  const { page, parentPageId } = await createJotRootPage(store, selectedParentPageId);

  store.jotRootPage = {
    id: page.id,
    parentPageId,
    title: titleFromPage(page) || JOT_ROOT_PAGE_TITLE,
    url: page.url,
  };
  store.jotDatabase = undefined;
  appendLog(store, 'root_page_created', store.jotRootPage.title);

  return pageSummary(store.jotRootPage);
}

async function createJotRootPage(store, selectedParentPageId) {
  if (selectedParentPageId) {
    try {
      return {
        page: await createChildPage(store, selectedParentPageId, JOT_ROOT_PAGE_TITLE),
        parentPageId: selectedParentPageId,
      };
    } catch (error) {
      if (!isNotionObjectNotFound(error)) {
        throw error;
      }

      appendLog(
        store,
        'root_parent_inaccessible',
        `${selectedParentPageId}: ${error.message}`,
      );
    }
  }

  return {
    page: await createWorkspacePage(store, JOT_ROOT_PAGE_TITLE),
    parentPageId: undefined,
  };
}

async function ensureProjectRootPage(store, jotRootPageId, project) {
  const stored = store.projectPages[project.id];

  if (stored?.notionPageId && stored.parentPageId === jotRootPageId) {
    try {
      const page = await notionRequest(store, `/pages/${stored.notionPageId}`);
      const title = project.name || stored.title || 'Untitled Project';

      if (titleFromPage(page) !== title) {
        await updatePageTitle(store, page.id, title);
      }

      store.projectPages[project.id] = {
        notionPageId: page.id,
        parentPageId: jotRootPageId,
        title,
        lastEditedTime: page.last_edited_time,
      };
      return pageSummary({
        id: page.id,
        parentPageId: jotRootPageId,
        title,
        url: page.url,
      });
    } catch (error) {
      appendLog(store, 'project_page_lookup_error', error.message);
    }
  }

  const page = await createChildPage(store, jotRootPageId, project.name || 'Untitled Project');
  store.projectPages[project.id] = {
    notionPageId: page.id,
    parentPageId: jotRootPageId,
    title: titleFromPage(page) || project.name || 'Untitled Project',
    lastEditedTime: page.last_edited_time,
  };
  appendLog(store, 'project_page_created', store.projectPages[project.id].title);

  return pageSummary({
    id: page.id,
    parentPageId: jotRootPageId,
    title: store.projectPages[project.id].title,
    url: page.url,
  });
}

function pageSummary(page) {
  return {
    id: page.id,
    parentPageId: page.parentPageId,
    title: page.title || JOT_ROOT_PAGE_TITLE,
    url: page.url,
  };
}

async function createChildPage(store, parentPageId, title) {
  return notionRequest(store, '/pages', {
    method: 'POST',
    body: {
      parent: {
        type: 'page_id',
        page_id: parentPageId,
      },
      properties: {
        title: [
          {
            text: {
              content: title || 'Untitled Page',
            },
          },
        ],
      },
    },
  });
}

async function createWorkspacePage(store, title) {
  return notionRequest(store, '/pages', {
    method: 'POST',
    body: {
      parent: {
        type: 'workspace',
        workspace: true,
      },
      properties: {
        title: [
          {
            text: {
              content: title || 'Jot',
            },
          },
        ],
      },
    },
  });
}

async function updatePageTitle(store, pageId, title) {
  return notionRequest(store, `/pages/${pageId}`, {
    method: 'PATCH',
    body: {
      properties: {
        title: [
          {
            text: {
              content: title || 'Untitled Page',
            },
          },
        ],
      },
    },
  });
}

async function updateChildNotePage(store, pageId, page) {
  const body = {
    properties: {
      title: [
        {
          text: {
            content: page.title || 'Untitled Page',
          },
        },
      ],
    },
  };

  if (page.status === 'archived') {
    body.archived = true;
  }

  return notionRequest(store, `/pages/${pageId}`, {
    method: 'PATCH',
    body,
  });
}

async function archiveProjectRootPage(store, pageId) {
  return notionRequest(store, `/pages/${pageId}`, {
    method: 'PATCH',
    body: {
      archived: true,
    },
  });
}

async function replaceManagedBlocks(store, localPageId, notionPageId, content) {
  return replaceManagedBlocksWithDependencies({
    store,
    localPageId,
    notionPageId,
    content,
    listAllBlockChildren,
    deleteManagedBlock,
    appendManagedBlocks,
    tiptapDocumentToNotionBlocks,
    kindFromNotionBlock,
    hash,
  });
}

async function deleteManagedBlock(store, blockId) {
  return notionRequest(store, `/blocks/${blockId}`, {
    method: 'DELETE',
  });
}

async function appendManagedBlocks(store, notionPageId, notionBlocks) {
  const createdBlocks = [];

  for (const batch of chunks(notionBlocks, 100)) {
    let results;

    try {
      const response = await notionRequest(store, `/blocks/${notionPageId}/children`, {
        method: 'PATCH',
        body: { children: batch },
      });
      results = response.results;
    } catch {
      results = await appendBlocksWithFallback(store, notionPageId, batch);
    }

    createdBlocks.push(...results);
  }

  return createdBlocks;
}

async function appendBlocksWithFallback(store, notionPageId, blocks) {
  const results = [];

  for (const block of blocks) {
    try {
      const response = await notionRequest(store, `/blocks/${notionPageId}/children`, {
        method: 'PATCH',
        body: { children: [block] },
      });
      results.push(...response.results);
    } catch {
      const fallback = mediaFallbackBlock(block);
      try {
        const response = await notionRequest(store, `/blocks/${notionPageId}/children`, {
          method: 'PATCH',
          body: { children: [fallback] },
        });
        results.push(...response.results);
      } catch {
        // fallback also rejected — skip block rather than aborting the whole page
      }
    }
  }

  return results;
}

function mediaFallbackBlock(block) {
  const url = mediaUrlFromNotionBlock(block);
  const isLinkable = url && !url.startsWith('data:');
  return {
    object: 'block',
    type: 'paragraph',
    paragraph: {
      rich_text: isLinkable
        ? [{ type: 'text', text: { content: url, link: { url } } }]
        : [{ type: 'text', text: { content: '[Image — not synced]' } }],
      color: 'default',
    },
  };
}

function mediaUrlFromNotionBlock(block) {
  const t = block?.type;
  if (t === 'image') return block.image?.external?.url ?? block.image?.file?.url ?? block.image?.file_upload?.url ?? null;
  if (t === 'video') return block.video?.external?.url ?? block.video?.file?.url ?? null;
  if (t === 'audio') return block.audio?.external?.url ?? block.audio?.file?.url ?? null;
  if (t === 'embed') return block.embed?.url ?? null;
  if (t === 'file') return block.file?.external?.url ?? block.file?.file?.url ?? null;
  return null;
}

async function importManagedBlocks(store, page) {
  const mappings = store.blockMappings[page.id] ?? [];

  if (!mappings.length) {
    return null;
  }

  const children = await listAllBlockChildren(store, page.notionPageId);
  const managedIds = new Set(mappings.map((mapping) => mapping.notionBlockId));
  const managedBlocks = children.filter((block) => managedIds.has(block.id));

  if (managedBlocks.length !== mappings.length) {
    return null;
  }

  const imported = notionBlocksToTiptapDocument(managedBlocks);
  return imported.content?.length ? imported : null;
}

async function listAllBlockChildren(store, blockId) {
  const results = [];
  let cursor;

  do {
    const search = new URLSearchParams();
    search.set('page_size', '100');

    if (cursor) {
      search.set('start_cursor', cursor);
    }

    const response = await notionRequest(store, `/blocks/${blockId}/children?${search}`);
    results.push(...response.results);
    cursor = response.has_more ? response.next_cursor : undefined;
  } while (cursor);

  return results;
}

function titleFromPage(page) {
  const titleProperty = Object.values(page.properties ?? {}).find(
    (property) => property.type === 'title',
  );
  return titleProperty?.title?.map((item) => item.plain_text).join('') || 'Untitled';
}

function titleFromRichText(richText = []) {
  return richText.map((item) => item.plain_text ?? item.text?.content ?? '').join('');
}

function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}

function chunks(values, size) {
  const result = [];

  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }

  return result;
}

function isBase64(value) {
  return typeof value === 'string' && /^[A-Za-z0-9+/]*={0,2}$/.test(value) && value.length % 4 === 0;
}

function sanitizeImageFilename(filename, mimeType) {
  const safeName = String(filename ?? '')
    .trim()
    .replace(/[\\/:"*?<>|]+/g, '-')
    .replace(/\s+/g, ' ')
    .slice(0, 180);
  const extension = imageExtensionFromMimeType(mimeType);
  const name = safeName || `image.${extension}`;

  return /\.[A-Za-z0-9]+$/.test(name) ? name : `${name}.${extension}`;
}

function imageExtensionFromMimeType(mimeType) {
  return {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/svg+xml': 'svg',
    'image/avif': 'avif',
  }[String(mimeType).toLowerCase()] ?? 'png';
}

function closePage(message) {
  return `<!doctype html><html><body><p>${escapeHtml(message)}</p><script>setTimeout(() => window.close(), 900)</script></body></html>`;
}

function redirectPage(url) {
  return `<!doctype html><html><body><p>Redirecting...</p><script>window.location.href=${JSON.stringify(url)}</script></body></html>`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function loadEnvFile(filePath) {
  if (!existsSync(filePath)) {
    return;
  }

  const lines = readFileSync(filePath, 'utf8').split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const separatorIndex = trimmed.indexOf('=');

    if (separatorIndex < 0) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1).trim();

    if (!key || process.env[key] !== undefined) {
      continue;
    }

    process.env[key] = unquoteEnvValue(value);
  }
}

function unquoteEnvValue(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  return value;
}
