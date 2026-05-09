// @ts-nocheck
import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { createAuth } from './auth.js';
import {
  kindFromNotionBlock,
  notionBlocksToTiptapDocument,
  tiptapDocumentToNotionBlocks,
} from './blockConversion.js';
import { importManagedBlocks as importManagedBlocksWithDependencies } from './importManagedBlocks.js';
import { replaceManagedBlocks as replaceManagedBlocksWithDependencies } from './managedBlocks.js';
import { createNotionRequester, uploadFileToNotion } from './notionRequest.js';
import { pushPageToNotionCore } from './pageSync.js';
import {
  createProjectDatabaseHelpers,
  projectStateKey,
  threadKey,
} from './projectDatabase.js';
import { syncProjectFolder } from './projectSync.js';
import { createRootPageHelpers } from './rootPages.js';
import { createSyncQueue } from './syncQueue.js';
import type {
  CreateNotionPageRequest,
  MediaUploadRequest,
  SyncPageRequest,
  SyncProjectRequest,
  SyncReloadRequest,
  SyncValidationRequest,
} from '../../../src/types/sync.js';

const JOT_SESSION_COOKIE = 'jot_session';
const JOT_OAUTH_STATE_COOKIE = 'jot_notion_oauth_state';
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;
const MAX_MEDIA_UPLOAD_BYTES = 20 * 1024 * 1024;

// TODO: replace with Durable Objects for cross-instance distributed locking
const installationMutationLocks = new Map();

const app = new Hono();

app.use('*', async (c, next) => {
  const origin = c.req.header('origin');
  const trusted = isTrustedOrigin(c.env, origin);

  c.header('Access-Control-Allow-Origin', trusted ? origin : '*');
  c.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  c.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
  c.header('Access-Control-Allow-Credentials', 'true');

  if (c.req.method === 'OPTIONS') return c.body(null, 204);

  await next();
});

// ─── Auth routes ──────────────────────────────────────────────────────────────

app.get('/auth/jot/complete', (c) =>
  c.html(closePage('You are logged in to Jot. You can return to the side panel.')),
);

app.get('/auth/jot/error', (c) =>
  c.html(closePage('Jot login did not complete. You can close this tab and try again.'), 400),
);

app.get('/auth/notion/start', async (c) => {
  const env = c.env;

  if (!env.NOTION_OAUTH_CLIENT_ID || !env.NOTION_OAUTH_CLIENT_SECRET) {
    return c.html(closePage('Notion login is not configured on the sync server yet.'), 503);
  }

  const workerUrl = serverBaseUrl(env);
  const state = randomToken(24);
  const redirectUri = `${workerUrl}/auth/notion/callback`;
  const url = new URL('https://api.notion.com/v1/oauth/authorize');
  url.searchParams.set('client_id', env.NOTION_OAUTH_CLIENT_ID);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('owner', 'user');
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('state', state);

  setCookie(c, JOT_OAUTH_STATE_COOKIE, state, {
    httpOnly: true,
    maxAge: 600,
    path: '/auth/notion',
    sameSite: 'Lax',
    secure: workerUrl.startsWith('https://'),
  });

  return c.redirect(url.toString());
});

app.get('/auth/notion/callback', async (c) => {
  const env = c.env;
  const expectedState = getCookie(c, JOT_OAUTH_STATE_COOKIE);
  const state = c.req.query('state') ?? '';
  const code = c.req.query('code') ?? '';
  const error = c.req.query('error') ?? '';

  deleteCookie(c, JOT_OAUTH_STATE_COOKIE, { path: '/auth/notion' });

  if (error) {
    return c.html(closePage('Notion login did not complete. You can close this tab and try again.'), 400);
  }

  if (!code || !state || !expectedState || state !== expectedState) {
    return c.html(closePage('Notion login could not be verified. You can close this tab and try again.'), 400);
  }

  try {
    const tokens = await exchangeNotionCode(env, code, `${serverBaseUrl(env)}/auth/notion/callback`);
    const user = notionUserFromToken(tokens);
    const userId = `notion:${user.id}`;

    const { sessionToken, installationId } = await auth.createNotionSession({
      userId,
      notionAccountId: user.id,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      workspaceId: tokens.workspace_id,
      workspaceName: tokens.workspace_name,
      user,
      ipAddress: c.req.header('cf-connecting-ip') ?? null,
      userAgent: c.req.header('user-agent') ?? null,
      sessionToken: randomToken(),
      sessionId: randomUUID(),
      SESSION_MAX_AGE_SECONDS,
    });

    if (installationId) {
      await ensureJotSyncStateRow(installationId);
    }

    setCookie(c, JOT_SESSION_COOKIE, sessionToken, {
      httpOnly: true,
      maxAge: SESSION_MAX_AGE_SECONDS,
      path: '/',
      sameSite: 'Lax',
      secure: serverBaseUrl(env).startsWith('https://'),
    });

    return c.html(closePage('You are logged in to Jot. You can return to the side panel.'));
  } catch (err) {
    console.error('Failed to complete Notion login', err);
    return c.html(closePage('Notion login failed. You can close this tab and try again.'), 500);
  }
});

app.get('/session', async (c) => {
  const session = await getJotSession(c);
  const installation = session
    ? await auth.getActiveInstallation(session.user.id).catch(() => undefined)
    : undefined;

  return c.json({
    authenticated: Boolean(session),
    userName: session?.user.name,
    userEmail: session?.user.email,
    connected: Boolean(installation),
    workspaceId: installation?.workspace_id,
    workspaceName: installation?.workspace_name,
  });
});

app.post('/auth/notion/logout', async (c) => {
  const session = await requireJotSession(c);
  if (!session) return;

  const token = getCookie(c, JOT_SESSION_COOKIE);
  await auth.revokeInstallation(session.user.id);
  await auth.deleteCustomSession(token);
  deleteCookie(c, JOT_SESSION_COOKIE, { path: '/' });

  return c.json({ connected: false });
});

app.get('/logs', async (c) => {
  const store = await readStore();
  return c.json({ logs: store.logs.slice(-100) });
});

// ─── Notion routes ─────────────────────────────────────────────────────────────

app.get('/notion/pages', async (c) => {
  const query = c.req.query('query') ?? '';
  const store = await requireConnectedStore(c);
  const response = await notionRequest(store, '/search', {
    method: 'POST',
    body: {
      query,
      page_size: 25,
      filter: { property: 'object', value: 'page' },
    },
  });

  return c.json({
    pages: response.results.map((page) => ({
      id: page.id,
      title: titleFromPage(page),
      url: page.url,
    })),
  });
});

app.post('/notion/pages', async (c) => {
  const body = await c.req.json<CreateNotionPageRequest>().catch(() => ({}));
  const title = String(body?.title ?? '').trim() || 'Jot';
  const store = await requireConnectedStore(c);
  const page = await createWorkspacePage(store, title);

  appendLog(store, 'parent_page_created', title);
  await writeStore(store);

  return c.json({ page: { id: page.id, title: titleFromPage(page), url: page.url } });
});

// ─── Sync routes ───────────────────────────────────────────────────────────────

app.post('/sync/push', async (c) => {
  // TODO: enqueue via Cloudflare Queue for rate-limit-aware Notion retry
  const body = await c.req.json<SyncPageRequest>().catch(() => ({}));
  const { page, project, selectedParentPageId } = body ?? {};

  if (!page?.id || !project?.id) {
    return c.json({ status: 'error', message: 'Missing page or project.' });
  }

  return c.json(
    await syncQueue.enqueue(
      `page:${project.id}:${page.id}`,
      { c, page, project, selectedParentPageId },
      pushPageToNotion,
    ),
  );
});

app.post('/sync/project', async (c) => {
  const body = await c.req.json<SyncProjectRequest>().catch(() => ({}));
  const { project, selectedParentPageId } = body ?? {};

  if (!project?.id) {
    return c.json({ status: 'error', message: 'Missing project.' });
  }

  return c.json(
    await syncQueue.enqueue(
      `project:${project.id}`,
      { c, project, selectedParentPageId },
      syncProjectToNotion,
    ),
  );
});

app.post('/sync/validate', async (c) => {
  const body = await c.req.json<SyncValidationRequest>().catch(() => ({}));
  const { pages = [], projects = [] } = body ?? {};
  const store = await requireConnectedStore(c);
  const result = await validateNotionCache(store, {
    pages: Array.isArray(pages) ? pages : [],
    projects: Array.isArray(projects) ? projects : [],
  });

  if (result.changed) {
    appendLog(
      store,
      'sync_cache_uncached',
      `${result.uncachedProjectIds.length} projects, ${result.uncachedPageIds.length} pages`,
    );
    await writeStore(store);
  }

  return c.json({
    status: 'saved',
    clearSelectedParentPage: result.clearSelectedParentPage,
    uncachedProjectIds: result.uncachedProjectIds,
    uncachedPageIds: result.uncachedPageIds,
  });
});

app.post('/sync/reload', async (c) => {
  const body = await c.req.json<SyncReloadRequest>().catch(() => ({}));
  const { selectedParentPageId } = body ?? {};
  const store = await requireConnectedStore(c);

  const result = await withFreshInstallationStore(store, async (freshStore) => {
    const reloaded = await reloadProjectDatabaseFromNotion(freshStore, { selectedParentPageId });
    appendLog(freshStore, 'sync_reload', `${reloaded.projects.length} projects, ${reloaded.pages.length} pages`);
    await writeStore(freshStore);
    return reloaded;
  });

  return c.json({ status: 'saved', ...result });
});

app.post('/sync/pull', async (c) => {
  const body = await c.req.json<SyncPageRequest>().catch(() => ({}));
  const { page } = body ?? {};

  if (!page?.id || !page.notionPageId) {
    return c.json({ page, status: 'saved', message: 'No Notion page is linked yet.' });
  }

  const store = await requireConnectedStore(c);
  const notionContainer = await retrieveNotionPageOrBlock(store, page);

  if (!page.remoteRevision || notionContainer.last_edited_time === page.remoteRevision) {
    return c.json({
      page: {
        ...page,
        notionLastEditedTime: notionContainer.last_edited_time,
        remoteRevision: notionContainer.last_edited_time,
        syncState: 'saved',
      },
      status: 'saved',
      message: 'Already current.',
    });
  }

  const pulledContent = await importManagedBlocks(store, page);

  if (!pulledContent) {
    return c.json({
      page: {
        ...page,
        notionLastEditedTime: notionContainer.last_edited_time,
        remoteRevision: notionContainer.last_edited_time,
        syncState: 'stale',
      },
      status: 'stale',
      message: 'Notion changed this page in a way Jot cannot safely import automatically.',
    });
  }

  appendLog(store, 'sync_pull', page.title);
  await writeStore(store);

  return c.json({
    page: {
      ...page,
      content: pulledContent,
      notionLastEditedTime: notionContainer.last_edited_time,
      remoteRevision: notionContainer.last_edited_time,
      syncState: 'saved',
    },
    status: 'saved',
    message: 'Imported simple Notion edits.',
  });
});

// ─── Media upload ──────────────────────────────────────────────────────────────

app.post('/media/upload', async (c) => {
  const body = await c.req.json<MediaUploadRequest>().catch(() => ({}));
  const { dataBase64, mimeType, filename } = body ?? {};

  if (!dataBase64 || !mimeType) return c.json({ error: 'Missing dataBase64 or mimeType.' }, 400);
  if (!isSupportedMediaMimeType(mimeType)) return c.json({ error: 'Only image and audio uploads are supported.' }, 400);
  if (!isBase64(dataBase64)) return c.json({ error: 'Invalid upload data.' }, 400);

  const store = await requireConnectedStore(c);
  const buffer = Buffer.from(dataBase64, 'base64');

  if (buffer.byteLength > MAX_MEDIA_UPLOAD_BYTES) {
    return c.json({ error: 'Media files must be 20 MB or smaller.' }, 413);
  }

  const fileUploadId = await uploadFileToNotion(
    store,
    { data: buffer, mimeType, filename: sanitizeMediaFilename(filename, mimeType) },
    { notionVersion: c.env.NOTION_VERSION ?? '2026-03-11' },
  );

  return c.json({ fileUploadId });
});

// ─── Per-request singletons ────────────────────────────────────────────────────

let supabase;
let auth;
let notionRequest;
let syncQueue;
let ensureJotRootPage, ensureProjectRootPage, pageSummary;
let archiveThreadToggle, ensureProjectDatabase, ensureProjectPage, ensureThreadToggle,
    reloadProjectDatabaseFromNotion, updateThreadToggleTitle;

function initSingletons(env) {
  supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY);
  auth = createAuth(supabase);

  const NOTION_VERSION = env.NOTION_VERSION ?? '2026-03-11';
  const JOT_ROOT_PAGE_TITLE = env.JOT_ROOT_PAGE_TITLE ?? 'Jot';

  notionRequest = createNotionRequester({ notionVersion: NOTION_VERSION });
  syncQueue = createSyncQueue();

  const rootHelpers = createRootPageHelpers({
    appendLog,
    createChildPage,
    createWorkspacePage,
    isNotionObjectNotFound,
    jotRootPageTitle: JOT_ROOT_PAGE_TITLE,
    listAllBlockChildren,
    notionRequest,
    titleFromPage,
    updatePageTitle,
  });
  ensureJotRootPage = rootHelpers.ensureJotRootPage;
  ensureProjectRootPage = rootHelpers.ensureProjectRootPage;
  pageSummary = rootHelpers.pageSummary;

  const dbHelpers = createProjectDatabaseHelpers({
    appendLog,
    createWorkspacePage,
    hash,
    isNotionObjectNotFound,
    listAllBlockChildren,
    notionBlocksToTiptapDocument,
    notionRequest,
    replaceManagedBlocks,
    tiptapDocumentToNotionBlocks,
  });
  archiveThreadToggle = dbHelpers.archiveThreadToggle;
  ensureProjectDatabase = dbHelpers.ensureProjectDatabase;
  ensureProjectPage = dbHelpers.ensureProjectPage;
  ensureThreadToggle = dbHelpers.ensureThreadToggle;
  reloadProjectDatabaseFromNotion = dbHelpers.reloadProjectDatabaseFromNotion;
  updateThreadToggleTitle = dbHelpers.updateThreadToggleTitle;
}

// ─── Sync handlers ─────────────────────────────────────────────────────────────

async function pushPageToNotion({ c, page, project, selectedParentPageId }) {
  const store = await requireConnectedStore(c);

  return withFreshInstallationStore(store, (freshStore) =>
    pushPageToNotionCore({
      request: { c },
      page,
      project,
      selectedParentPageId,
      dependencies: {
        appendLog,
        archiveThreadToggle,
        createChildPage,
        ensureJotRootPage,
        ensureProjectPage,
        ensureProjectRootPage,
        ensureThreadToggle,
        notionRequest,
        replaceManagedBlocks,
        requireConnectedStore: async () => freshStore,
        updateThreadToggleTitle,
        updateChildNotePage,
        writeStore,
      },
    }),
  );
}

async function syncProjectToNotion({ c, project, selectedParentPageId }) {
  const store = await requireConnectedStore(c);

  return withFreshInstallationStore(store, async (freshStore) => {
    const response = await syncProjectFolder({
      store: freshStore,
      project,
      selectedParentPageId,
      ensureJotRootPage,
      ensureProjectPage,
      ensureProjectRootPage,
      archiveProjectRootPage,
      pageSummary,
    });

    appendLog(freshStore, project.status === 'archived' ? 'project_archived' : 'project_synced', project.name);
    await writeStore(freshStore);
    return response;
  });
}

// ─── Store helpers ─────────────────────────────────────────────────────────────

function readStore() {
  return normalizeStore({});
}

async function writeStore(store) {
  if (store.installationId) {
    await writeJotSyncState(store.installationId, store);
  }
}

function normalizeStore(store) {
  return {
    parentPages: store.parentPages ?? {},
    projectPages: store.projectPages ?? {},
    projectBlocks: store.projectBlocks ?? {},
    threadBlocks: store.threadBlocks ?? {},
    jotRootPage: store.jotRootPage,
    jotDatabase: store.jotDatabase,
    notePages: store.notePages ?? {},
    blockMappings: store.blockMappings ?? {},
    logs: store.logs ?? [],
  };
}

function appendLog(store, event, message) {
  store.logs.push({ at: new Date().toISOString(), event, message });
  store.logs = store.logs.slice(-250);
}

async function requireConnectedStore(c) {
  const session = await getJotSession(c);

  if (!session) throw new Error('Log in to Jot before syncing Notion.');

  const [store, installation] = await Promise.all([
    readStore(),
    auth.getActiveInstallationWithTokens(session.user.id),
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

function withInstallationLock(lockKey, fn) {
  const previous = installationMutationLocks.get(lockKey) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(fn);
  const tracked = current.finally(() => {
    if (installationMutationLocks.get(lockKey) === tracked) {
      installationMutationLocks.delete(lockKey);
    }
  });

  installationMutationLocks.set(lockKey, tracked);
  return current;
}

async function withFreshInstallationStore(store, mutator) {
  const lockKey = store.installationId ? String(store.installationId) : 'local';
  return withInstallationLock(lockKey, async () => {
    const freshStore = await freshConnectedStore(store);
    return mutator(freshStore);
  });
}

async function freshConnectedStore(store) {
  if (!store.installationId) return store;

  const [localStore, syncState] = await Promise.all([
    readStore(),
    readJotSyncState(store.installationId),
  ]);

  return {
    ...localStore,
    ...syncState,
    installationId: store.installationId,
    tokens: store.tokens,
  };
}

// ─── Session helpers ───────────────────────────────────────────────────────────

async function getJotSession(c) {
  return auth.getCustomSession(getCookie(c, JOT_SESSION_COOKIE));
}

async function requireJotSession(c) {
  const session = await getJotSession(c);

  if (!session) {
    c.res = c.json({ error: 'Unauthorized', message: 'Log in to Jot first.' }, 401);
    return null;
  }

  return session;
}

// ─── Sync state (Supabase) ─────────────────────────────────────────────────────

async function ensureJotSyncStateRow(installationId) {
  await supabase.from('jot_sync_state').upsert(
    { installation_id: installationId },
    { onConflict: 'installation_id', ignoreDuplicates: true },
  );
}

async function readJotSyncState(installationId) {
  await ensureJotSyncStateRow(installationId);

  const { data: row } = await supabase
    .from('jot_sync_state')
    .select('*')
    .eq('installation_id', installationId)
    .single();

  if (!row) return normalizeStore({});

  return {
    jotRootPage: row.jot_database_id && !row.jot_data_source_id
      ? { id: row.jot_database_id, parentPageId: row.jot_parent_page_id, title: row.jot_database_title }
      : undefined,
    jotDatabase: row.jot_database_id
      ? {
          databaseId: row.jot_database_id,
          dataSourceId: row.jot_data_source_id,
          parentPageId: row.jot_parent_page_id,
          title: row.jot_database_title,
        }
      : undefined,
    // Supabase returns JSONB columns as parsed objects already
    notePages: row.note_pages_json ?? {},
    blockMappings: row.block_mappings_json ?? {},
    parentPages: row.parent_pages_json ?? {},
    projectPages: row.project_pages_json ?? {},
    projectBlocks: row.project_blocks_json ?? {},
    threadBlocks: row.thread_blocks_json ?? {},
  };
}

async function writeJotSyncState(installationId, store) {
  await ensureJotSyncStateRow(installationId);
  await supabase.from('jot_sync_state').update({
    jot_database_id: store.jotDatabase?.databaseId ?? store.jotRootPage?.id ?? null,
    jot_data_source_id: store.jotDatabase?.dataSourceId ?? null,
    jot_parent_page_id: store.jotDatabase?.parentPageId ?? store.jotRootPage?.id ?? store.jotRootPage?.parentPageId ?? null,
    jot_database_title: store.jotDatabase?.title ?? store.jotRootPage?.title ?? null,
    note_pages_json: store.notePages ?? {},
    block_mappings_json: store.blockMappings ?? {},
    parent_pages_json: store.parentPages ?? {},
    project_pages_json: store.projectPages ?? {},
    project_blocks_json: store.projectBlocks ?? {},
    thread_blocks_json: store.threadBlocks ?? {},
    updated_at: new Date().toISOString(),
  }).eq('installation_id', installationId);
}

// ─── Notion OAuth helpers ──────────────────────────────────────────────────────

async function exchangeNotionCode(env, code, redirectUri) {
  const credentials = Buffer.from(
    `${env.NOTION_OAUTH_CLIENT_ID}:${env.NOTION_OAUTH_CLIENT_SECRET}`,
  ).toString('base64');
  const response = await fetch('https://api.notion.com/v1/oauth/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${credentials}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ grant_type: 'authorization_code', code, redirect_uri: redirectUri }),
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

  if (!id) throw new Error('Notion OAuth response did not include a user or bot id.');

  return { id, name, email, image: ownerUser?.avatar_url ?? null };
}

// ─── Notion API helpers ────────────────────────────────────────────────────────

async function validateNotionCache(store, { pages, projects }) {
  const uncachedProjectIds = new Set();
  const uncachedPageIds = new Set();
  let clearSelectedParentPage = false;
  let changed = false;

  if (store.jotRootPage?.id && !(await notionObjectExists(store, 'page', store.jotRootPage.id))) {
    store.jotRootPage = undefined;
    store.jotDatabase = undefined;
    store.projectPages = {};
    store.projectBlocks = {};
    store.threadBlocks = {};
    store.notePages = {};
    store.blockMappings = {};
    clearSelectedParentPage = true;
    for (const project of projects) uncachedProjectIds.add(project.id);
    for (const page of pages) uncachedPageIds.add(page.id);
    return {
      changed: true,
      clearSelectedParentPage,
      uncachedProjectIds: [...uncachedProjectIds],
      uncachedPageIds: [...uncachedPageIds],
    };
  }

  if (
    store.jotDatabase?.databaseId &&
    !(await notionObjectExists(store, 'database', store.jotDatabase.databaseId))
  ) {
    store.jotDatabase = undefined;
    store.projectPages = {};
    store.projectBlocks = {};
    store.threadBlocks = {};
    store.notePages = {};
    store.blockMappings = {};
    for (const project of projects) uncachedProjectIds.add(project.id);
    for (const page of pages) uncachedPageIds.add(page.id);
    changed = true;
  }

  for (const project of projects) {
    const cached = store.projectPages?.[project.id];

    if (cached?.notionPageId && !(await notionObjectExists(store, 'page', cached.notionPageId))) {
      delete store.projectPages[project.id];
      delete store.projectBlocks?.[projectStateKey(project.id)];
      uncachedProjectIds.add(project.id);
      for (const page of pages.filter((p) => p.projectId === project.id)) {
        uncachePage(store, page.id);
        uncachedPageIds.add(page.id);
      }
      changed = true;
    }
  }

  for (const page of pages) {
    const cachedThread = store.threadBlocks?.[threadKey(page.id)];
    const cachedNote = store.notePages?.[page.id];
    const notionPageId = page.notionPageId ?? cachedNote?.notionPageId;

    if (cachedThread?.blockId && !(await notionObjectExists(store, 'block', cachedThread.blockId))) {
      uncachePage(store, page.id);
      uncachedPageIds.add(page.id);
      changed = true;
      continue;
    }

    if (
      notionPageId &&
      !cachedThread?.blockId &&
      !(await notionObjectExists(store, cachedNote?.kind === 'thread' ? 'block' : 'page', notionPageId))
    ) {
      uncachePage(store, page.id);
      uncachedPageIds.add(page.id);
      changed = true;
    }
  }

  return {
    changed,
    clearSelectedParentPage,
    uncachedProjectIds: [...uncachedProjectIds],
    uncachedPageIds: [...uncachedPageIds],
  };
}

function uncachePage(store, pageId) {
  delete store.threadBlocks?.[threadKey(pageId)];
  delete store.notePages?.[pageId];
  delete store.blockMappings?.[pageId];
}

async function notionObjectExists(store, kind, id) {
  try {
    const endpoint = kind === 'database' ? `/databases/${id}` : kind === 'block' ? `/blocks/${id}` : `/pages/${id}`;
    await notionRequest(store, endpoint);
    return true;
  } catch (error) {
    if (isNotionObjectNotFound(error)) return false;
    throw error;
  }
}

async function retrieveNotionPageOrBlock(store, page) {
  if (isThreadBackedPage(store, page)) {
    return notionRequest(store, `/blocks/${page.notionPageId}`);
  }

  try {
    return await notionRequest(store, `/pages/${page.notionPageId}`);
  } catch (error) {
    if (!isBlockNotPageError(error)) throw error;
    appendLog(store, 'sync_pull_block_fallback', page.title ?? page.id);
    return notionRequest(store, `/blocks/${page.notionPageId}`);
  }
}

function isThreadBackedPage(store, page) {
  const cachedThread = store.threadBlocks?.[threadKey(page.id)];
  const cachedNote = store.notePages?.[page.id];
  return Boolean(cachedThread?.blockId === page.notionPageId || cachedNote?.kind === 'thread');
}

async function replaceManagedBlocks(store, localPageId, notionPageId, content) {
  return replaceManagedBlocksWithDependencies({
    store, localPageId, notionPageId, content,
    listAllBlockChildren, deleteManagedBlock, appendManagedBlocks,
    updateManagedBlock, tiptapDocumentToNotionBlocks, kindFromNotionBlock, hash,
  });
}

async function importManagedBlocks(store, page) {
  return importManagedBlocksWithDependencies({ hash, listAllBlockChildren, page, store });
}

async function listAllBlockChildren(store, blockId) {
  const results = [];
  let cursor;

  do {
    const search = new URLSearchParams();
    search.set('page_size', '100');
    if (cursor) search.set('start_cursor', cursor);

    const response = await notionRequest(store, `/blocks/${blockId}/children?${search}`);
    results.push(...response.results);
    cursor = response.has_more ? response.next_cursor : undefined;
  } while (cursor);

  return results;
}

async function createChildPage(store, parentPageId, title) {
  return notionRequest(store, '/pages', {
    method: 'POST',
    body: {
      parent: { type: 'page_id', page_id: parentPageId },
      properties: { title: [{ text: { content: title || 'Untitled Page' } }] },
    },
  });
}

async function createWorkspacePage(store, title) {
  return notionRequest(store, '/pages', {
    method: 'POST',
    body: {
      parent: { type: 'workspace', workspace: true },
      properties: { title: [{ text: { content: title || 'Jot' } }] },
    },
  });
}

async function updatePageTitle(store, pageId, title) {
  return notionRequest(store, `/pages/${pageId}`, {
    method: 'PATCH',
    body: { properties: { title: [{ text: { content: title || 'Untitled Page' } }] } },
  });
}

async function updateChildNotePage(store, pageId, page) {
  const body = { properties: { title: [{ text: { content: page.title || 'Untitled Page' } }] } };
  if (page.status === 'archived') body.archived = true;
  return notionRequest(store, `/pages/${pageId}`, { method: 'PATCH', body });
}

async function archiveProjectRootPage(store, pageId) {
  return notionRequest(store, `/pages/${pageId}`, { method: 'PATCH', body: { archived: true } });
}

async function deleteManagedBlock(store, blockId) {
  return notionRequest(store, `/blocks/${blockId}`, { method: 'DELETE' });
}

async function updateManagedBlock(store, blockId, notionBlock) {
  return notionRequest(store, `/blocks/${blockId}`, {
    method: 'PATCH',
    body: updateBodyFromNotionBlock(notionBlock),
  });
}

async function appendManagedBlocks(store, notionPageId, notionBlocks, position) {
  const createdBlocks = [];

  for (const batch of chunks(notionBlocks, 100)) {
    let results;
    try {
      const response = await notionRequest(store, `/blocks/${notionPageId}/children`, {
        method: 'PATCH',
        body: { children: batch, ...(position ? { position } : {}) },
      });
      results = response.results;
    } catch {
      results = await appendBlocksWithFallback(store, notionPageId, batch, position);
    }

    createdBlocks.push(...results);
    position = positionAfterCreatedBlocks(position, results);
  }

  return createdBlocks;
}

async function appendBlocksWithFallback(store, notionPageId, blocks, position) {
  const results = [];

  for (const block of blocks) {
    try {
      const response = await notionRequest(store, `/blocks/${notionPageId}/children`, {
        method: 'PATCH',
        body: { children: [block], ...(position ? { position } : {}) },
      });
      results.push(...response.results);
      position = positionAfterCreatedBlocks(position, response.results);
    } catch {
      const fallback = mediaFallbackBlock(block);
      try {
        const response = await notionRequest(store, `/blocks/${notionPageId}/children`, {
          method: 'PATCH',
          body: { children: [fallback], ...(position ? { position } : {}) },
        });
        results.push(...response.results);
        position = positionAfterCreatedBlocks(position, response.results);
      } catch {
        // skip block rather than aborting the whole page
      }
    }
  }

  return results;
}

// ─── Utility helpers ───────────────────────────────────────────────────────────

function isTrustedOrigin(env, origin) {
  if (!origin) return true;
  if (origin.startsWith('chrome-extension://')) return true;

  const trusted = [
    env.WORKER_URL,
    env.JOT_EXTENSION_ORIGIN,
    ...(env.TRUSTED_ORIGINS?.split(',') ?? []),
  ].map((o) => o?.trim()).filter(Boolean);

  return trusted.includes(origin);
}

function serverBaseUrl(env) {
  return env.WORKER_URL ?? 'http://localhost:8787';
}

function randomToken(byteLength = 32) {
  return randomBytes(byteLength).toString('base64url');
}

function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}

function isNotionObjectNotFound(error) {
  return error?.status === 404 || error?.code === 'object_not_found';
}

function isBlockNotPageError(error) {
  return (
    error?.code === 'validation_error' &&
    /is a block, not a page|retrieve block API/i.test(error?.message ?? '')
  );
}

function updateBodyFromNotionBlock(block) {
  if (!block?.type) return {};
  return { [block.type]: block[block.type] ?? {} };
}

function positionAfterCreatedBlocks(position, createdBlocks) {
  const lastBlock = createdBlocks?.[createdBlocks.length - 1];
  return lastBlock?.id ? { type: 'after_block', after_block: { id: lastBlock.id } } : position;
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

function titleFromPage(page) {
  const titleProperty = Object.values(page.properties ?? {}).find((p) => p.type === 'title');
  return titleProperty?.title?.map((item) => item.plain_text).join('') || 'Untitled';
}

function chunks(values, size) {
  const result = [];
  for (let i = 0; i < values.length; i += size) result.push(values.slice(i, i + size));
  return result;
}

function isBase64(value) {
  return typeof value === 'string' && /^[A-Za-z0-9+/]*={0,2}$/.test(value) && value.length % 4 === 0;
}

function isSupportedMediaMimeType(mimeType) {
  const n = String(mimeType).toLowerCase();
  return n.startsWith('image/') || n.startsWith('audio/');
}

function sanitizeMediaFilename(filename, mimeType) {
  const safeName = String(filename ?? '')
    .trim()
    .replace(/[\\/:"*?<>|]+/g, '-')
    .replace(/\s+/g, ' ')
    .slice(0, 180);
  const mediaKind = String(mimeType).toLowerCase().startsWith('audio/') ? 'audio' : 'image';
  const extension = mediaExtensionFromMimeType(mimeType);
  const name = safeName || `${mediaKind}.${extension}`;
  return /\.[A-Za-z0-9]+$/.test(name) ? name : `${name}.${extension}`;
}

function mediaExtensionFromMimeType(mimeType) {
  return {
    'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp',
    'image/svg+xml': 'svg', 'image/avif': 'avif', 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3',
    'audio/mp4': 'm4a', 'audio/aac': 'aac', 'audio/wav': 'wav', 'audio/x-wav': 'wav',
    'audio/ogg': 'ogg', 'audio/opus': 'opus', 'audio/webm': 'webm',
  }[String(mimeType).toLowerCase()] ?? (String(mimeType).toLowerCase().startsWith('audio/') ? 'mp3' : 'png');
}

function closePage(message) {
  return `<!doctype html><html><body><p>${escapeHtml(message)}</p><script>setTimeout(() => window.close(), 900)</script></body></html>`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

// ─── Worker export ─────────────────────────────────────────────────────────────

export default {
  async fetch(request, env, ctx) {
    initSingletons(env);
    return app.fetch(request, env, ctx);
  },
};
