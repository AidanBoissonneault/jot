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
      await registerNotionWebhook(env, installationId, tokens.access_token).catch(() => undefined);
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
  const installation = await auth.getActiveInstallation(session.user.id).catch(() => undefined);
  if (installation?.id) {
    await deleteNotionWebhook(c.env, installation.id).catch(() => undefined);
  }
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

app.get('/youtube/embed', (c) => {
  const src = c.req.query('src') ?? '';
  const embedUrl = youtubeEmbedUrl(src);

  if (!embedUrl) {
    return c.text('Invalid YouTube URL.', 400);
  }

  c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  c.header(
    'Content-Security-Policy',
    "default-src 'none'; frame-src https://www.youtube.com https://www.youtube-nocookie.com; style-src 'unsafe-inline';",
  );

  return c.html(youtubeEmbedPage(embedUrl));
});

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
  const body = await c.req.json<SyncPageRequest>().catch(() => ({}));
  const { page, project, selectedParentPageId } = body ?? {};

  if (!page?.id || !project?.id) {
    return c.json({ status: 'error', message: 'Missing page or project.' });
  }

  const store = await requireConnectedStore(c);
  const version = await enqueueSync(c.env, {
    type: 'page',
    localId: page.id,
    projectId: project.id,
    installationId: store.installationId,
    payload: { page, project, selectedParentPageId },
  });

  return c.json({ queued: true, version });
});

app.post('/sync/project', async (c) => {
  const body = await c.req.json<SyncProjectRequest>().catch(() => ({}));
  const { project, selectedParentPageId } = body ?? {};

  if (!project?.id) {
    return c.json({ status: 'error', message: 'Missing project.' });
  }

  try {
    return c.json(await syncProjectToNotion({ c, project, selectedParentPageId }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[sync/project] failed:', message, error);
    return c.json({ status: 'error', message }, 500);
  }
});

app.get('/sync/status', async (c) => {
  const pageId = c.req.query('pageId');

  if (!pageId) return c.json({ error: 'Missing pageId' }, 400);

  const store = await requireConnectedStore(c);
  const { data: row } = await supabase
    .from('notion_block_sync')
    .select('local_version, synced_version, status, notion_block_id')
    .eq('installation_id', store.installationId)
    .eq('local_id', pageId)
    .maybeSingle();

  if (!row) return c.json({ status: 'synced', localVersion: 0, syncedVersion: 0 });

  return c.json({
    status: row.status,
    localVersion: row.local_version,
    syncedVersion: row.synced_version,
    notionBlockId: row.notion_block_id ?? null,
  });
});

app.get('/sync/events', async (c) => {
  const store = await requireConnectedStore(c);
  const doId = c.env.SYNC_EVENTS.idFromName(store.installationId);
  const stub = c.env.SYNC_EVENTS.get(doId);
  return stub.fetch(new Request('http://do/connect'));
});

app.post('/sync/validate', async (c) => {
  const body = await c.req.json<SyncValidationRequest>().catch(() => ({}));
  const { pages = [], projects = [], knownVersions = {} } = body ?? {};
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

  // Fetch stale + version info from notion_block_sync
  const { data: syncRows } = await supabase
    .from('notion_block_sync')
    .select('local_id, local_version, is_stale')
    .eq('installation_id', store.installationId);

  const stalePageIds: string[] = [];
  const aheadPageIds: string[] = [];
  const serverVersions: Record<string, number> = {};

  for (const row of syncRows ?? []) {
    serverVersions[row.local_id] = row.local_version;
    if (row.is_stale) {
      stalePageIds.push(row.local_id);
    } else if (
      typeof knownVersions[row.local_id] === 'number' &&
      row.local_version > knownVersions[row.local_id]
    ) {
      aheadPageIds.push(row.local_id);
    }
  }

  return c.json({
    status: 'saved',
    clearSelectedParentPage: result.clearSelectedParentPage,
    uncachedProjectIds: result.uncachedProjectIds,
    uncachedPageIds: result.uncachedPageIds,
    stalePageIds,
    aheadPageIds,
    serverVersions,
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

  // Keep notion_block_id in sync so webhooks can route back to this local page
  await Promise.all([
    supabase.from('notion_block_sync').upsert(
      { installation_id: store.installationId, local_id: page.id, notion_block_id: page.notionPageId, entity_type: 'page' },
      { onConflict: 'installation_id,local_id', ignoreDuplicates: true },
    ),
    supabase.from('notion_block_sync')
      .update({ notion_block_id: page.notionPageId })
      .eq('installation_id', store.installationId)
      .eq('local_id', page.id)
      .is('notion_block_id', null),
  ]).catch(() => {});

  const notionContainer = await retrieveNotionPageOrBlock(store, page);

  if (page.remoteRevision && notionContainer.last_edited_time === page.remoteRevision) {
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

  console.log('[sync/pull] importing blocks from Notion', page.notionPageId, 'revision changed', page.remoteRevision, '->', notionContainer.last_edited_time);
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

app.post('/sync/clear-stale', async (c) => {
  const body = await c.req.json<{ pageIds?: string[] }>().catch(() => ({}));
  const pageIds = Array.isArray(body?.pageIds) ? body.pageIds : [];
  if (!pageIds.length) return c.json({ cleared: true });

  const store = await requireConnectedStore(c);
  await supabase
    .from('notion_block_sync')
    .update({ is_stale: false, stale_since: null })
    .eq('installation_id', store.installationId)
    .in('local_id', pageIds);

  return c.json({ cleared: true });
});

app.post('/webhooks/notion', async (c) => {
  const rawBody = await c.req.text();
  console.log('[webhooks/notion] body:', rawBody);

  const signature = c.req.header('notion-signature') ?? '';
  if (c.env.NOTION_WEBHOOK_SECRET) {
    const expected = await computeHmacSignature(c.env.NOTION_WEBHOOK_SECRET, rawBody);
    if (signature !== `v0=${expected}`) {
      return c.json({ error: 'Invalid signature' }, 401);
    }
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400);
  }

  // Notion webhook URL verification challenge
  if (payload.type === 'url_verification' && payload.challenge) {
    return c.json({ challenge: payload.challenge });
  }

  const notionPageId = (payload.entity as Record<string, unknown> | undefined)?.id as string | undefined;
  if (!notionPageId) return c.json({ ok: true });

  // Skip changes made by our own bot integration (new format uses authors[], old format uses actor)
  const authors = payload.authors as Array<Record<string, unknown>> | undefined;
  const actor = payload.actor as Record<string, unknown> | undefined;
  if (actor?.type === 'bot' || (authors?.length && authors.every((a) => a.type === 'bot'))) {
    return c.json({ ok: true });
  }

  const { data: rows } = await supabase
    .from('notion_block_sync')
    .select('installation_id, local_id')
    .eq('notion_block_id', notionPageId);

  if (!rows?.length) {
    console.log('[webhooks/notion] no local pages mapped to notion page', notionPageId);
    return c.json({ ok: true });
  }

  console.log('[webhooks/notion] notifying', rows.length, 'page(s) stale for notion page', notionPageId);
  for (const row of rows) {
    await supabase
      .from('notion_block_sync')
      .update({ is_stale: true, stale_since: new Date().toISOString() })
      .eq('installation_id', row.installation_id)
      .eq('local_id', row.local_id);

    const doStub = c.env.SYNC_EVENTS.get(
      c.env.SYNC_EVENTS.idFromName(String(row.installation_id)),
    );
    await doStub.fetch(new Request('http://do/notify', {
      method: 'POST',
      body: JSON.stringify({ status: 'stale', pageId: row.local_id }),
    })).catch(() => undefined);
  }

  return c.json({ ok: true });
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
let ensureJotRootPage, ensureProjectRootPage, pageSummary;
let archiveThreadToggle, ensureProjectDatabase, ensureProjectPage, ensureThreadToggle,
    reloadProjectDatabaseFromNotion, updateThreadToggleTitle;

function initSingletons(env) {
  supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY);
  auth = createAuth(supabase);

  const NOTION_VERSION = env.NOTION_VERSION ?? '2026-03-11';
  const JOT_ROOT_PAGE_TITLE = env.JOT_ROOT_PAGE_TITLE ?? 'Jot';

  notionRequest = createNotionRequester({ notionVersion: NOTION_VERSION });

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

// ─── Queue helpers ─────────────────────────────────────────────────────────────

async function enqueueSync(env, job) {
  const { data: version } = await supabase.rpc('increment_block_version', {
    p_installation_id: job.installationId,
    p_local_id: job.localId,
    p_entity_type: job.type,
  });
  await env.SYNC_QUEUE.send({ ...job, queuedVersion: version });
  return version;
}

async function getInstallationById(installationId) {
  const { data: installRow } = await supabase
    .from('notion_installations')
    .select('id, user_id')
    .eq('id', installationId)
    .eq('active', 1)
    .maybeSingle();

  if (!installRow) return null;

  const { data: accountRow } = await supabase
    .from('account')
    .select('accessToken')
    .eq('userId', installRow.user_id)
    .eq('providerId', 'notion')
    .limit(1)
    .maybeSingle();

  if (!accountRow?.accessToken) return null;

  return { id: installRow.id, tokens: { access_token: accountRow.accessToken } };
}

async function pushPageToNotionForInstallation(installationId, { page, project, selectedParentPageId }) {
  const installation = await getInstallationById(installationId);
  if (!installation) throw new Error('Installation not found or revoked.');

  const store = await freshConnectedStore({
    installationId,
    tokens: installation.tokens,
  });

  return withFreshInstallationStore(store, (freshStore) =>
    pushPageToNotionCore({
      request: {},
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

async function syncProjectToNotionForInstallation(installationId, { project, selectedParentPageId }) {
  const installation = await getInstallationById(installationId);
  if (!installation) throw new Error('Installation not found or revoked.');

  const store = await freshConnectedStore({
    installationId,
    tokens: installation.tokens,
  });

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

// ─── Notion webhook helpers ────────────────────────────────────────────────────

async function computeHmacSignature(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function registerNotionWebhook(env, installationId: number, accessToken: string): Promise<void> {
  if (!env.NOTION_WEBHOOK_SECRET) return;

  const workerUrl = serverBaseUrl(env);
  const response = await fetch('https://api.notion.com/v1/webhooks', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'Notion-Version': env.NOTION_VERSION ?? '2026-03-11',
    },
    body: JSON.stringify({
      url: `${workerUrl}/webhooks/notion`,
      filter: { event_types: ['page.content_updated', 'page.properties_updated'] },
    }),
  });

  if (!response.ok) return;

  const data = await response.json().catch(() => ({}));
  if (data?.id) {
    await supabase
      .from('notion_installations')
      .update({ notion_webhook_id: data.id })
      .eq('id', installationId);
  }
}

async function deleteNotionWebhook(env, installationId: number): Promise<void> {
  const { data: row } = await supabase
    .from('notion_installations')
    .select('notion_webhook_id')
    .eq('id', installationId)
    .maybeSingle();

  if (!row?.notion_webhook_id) return;

  const { data: accountRow } = await supabase
    .from('notion_installations')
    .select('user_id')
    .eq('id', installationId)
    .maybeSingle();

  if (!accountRow?.user_id) return;

  const { data: account } = await supabase
    .from('account')
    .select('accessToken')
    .eq('userId', accountRow.user_id)
    .eq('providerId', 'notion')
    .maybeSingle();

  if (!account?.accessToken) return;

  await fetch(`https://api.notion.com/v1/webhooks/${row.notion_webhook_id}`, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${account.accessToken}`,
      'Notion-Version': env.NOTION_VERSION ?? '2026-03-11',
    },
  }).catch(() => undefined);

  await supabase
    .from('notion_installations')
    .update({ notion_webhook_id: null })
    .eq('id', installationId);
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

function youtubeEmbedUrl(value) {
  const info = youtubeVideoInfo(value);

  if (!info) {
    return '';
  }

  const url = new URL(`https://www.youtube-nocookie.com/embed/${info.id}`);
  url.searchParams.set('rel', '1');

  if (info.start > 0) {
    url.searchParams.set('start', String(info.start));
  }

  return url.toString();
}

function youtubeVideoInfo(value) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    let id = '';

    if (host.endsWith('youtu.be')) {
      id = url.pathname.split('/').filter(Boolean)[0] ?? '';
    } else if (
      host === 'youtube.com' ||
      host.endsWith('.youtube.com') ||
      host === 'youtube-nocookie.com' ||
      host.endsWith('.youtube-nocookie.com')
    ) {
      id =
        url.searchParams.get('v') ??
        url.pathname.match(/^\/(?:embed|shorts|v)\/([\w-]+)/i)?.[1] ??
        '';
    }

    if (!/^[\w-]+$/.test(id)) {
      return null;
    }

    return {
      id,
      start: youtubeStartSeconds(url.searchParams.get('start') ?? url.searchParams.get('t') ?? ''),
    };
  } catch {
    return null;
  }
}

function youtubeStartSeconds(value) {
  if (!value) {
    return 0;
  }

  if (/^\d+$/.test(value)) {
    return Number(value);
  }

  const match = value.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/i);

  if (!match) {
    return 0;
  }

  return (
    Number(match[1] ?? 0) * 3600 +
    Number(match[2] ?? 0) * 60 +
    Number(match[3] ?? 0)
  );
}

function youtubeEmbedPage(embedUrl) {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="referrer" content="strict-origin-when-cross-origin">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>YouTube video</title>
  <style>
    html, body { width: 100%; height: 100%; margin: 0; background: #111113; overflow: hidden; }
    iframe { width: 100%; height: 100%; border: 0; display: block; }
  </style>
</head>
<body>
  <iframe
    src="${escapeHtml(embedUrl)}"
    title="YouTube video player"
    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
    referrerpolicy="strict-origin-when-cross-origin"
    allowfullscreen></iframe>
</body>
</html>`;
}

function closePage(message) {
  return `<!doctype html><html><body><p>${escapeHtml(message)}</p><script>setTimeout(() => window.close(), 900)</script></body></html>`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

// ─── SSE Durable Object ────────────────────────────────────────────────────────

export class SyncEventsDO {
  private sessions = new Map<string, { writer: WritableStreamDefaultWriter<Uint8Array>; encoder: TextEncoder }>();

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/connect') {
      const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
      const writer = writable.getWriter();
      const encoder = new TextEncoder();
      const id = crypto.randomUUID();
      this.sessions.set(id, { writer, encoder });

      const heartbeat = setInterval(() => {
        writer.write(encoder.encode(': heartbeat\n\n')).catch(() => {
          clearInterval(heartbeat);
          this.sessions.delete(id);
        });
      }, 25000);

      writer.closed.finally(() => {
        clearInterval(heartbeat);
        this.sessions.delete(id);
      });

      return new Response(readable, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'X-Accel-Buffering': 'no',
        },
      });
    }

    if (url.pathname === '/notify' && request.method === 'POST') {
      const event = await request.json<object>();
      const payload = `data: ${JSON.stringify(event)}\n\n`;
      const dead: string[] = [];

      for (const [id, { writer, encoder }] of this.sessions) {
        try {
          await writer.write(encoder.encode(payload));
        } catch {
          dead.push(id);
        }
      }
      dead.forEach((id) => this.sessions.delete(id));
      return new Response('ok');
    }

    return new Response('not found', { status: 404 });
  }
}

// ─── Worker export ─────────────────────────────────────────────────────────────

export default {
  async fetch(request, env, ctx) {
    initSingletons(env);
    return app.fetch(request, env, ctx);
  },

  async queue(batch, env) {
    initSingletons(env);

    for (const msg of batch.messages) {
      const job = msg.body;
      console.log('[queue] processing', job.type, job.localId, 'v', job.queuedVersion);
      try {
        const { data: row } = await supabase
          .from('notion_block_sync')
          .select('local_version')
          .eq('installation_id', job.installationId)
          .eq('local_id', job.localId)
          .maybeSingle();

        // Stale check — a newer edit was enqueued after this one
        if (row && row.local_version > job.queuedVersion) {
          msg.ack();
          continue;
        }

        await supabase
          .from('notion_block_sync')
          .update({ status: 'syncing', updated_at: new Date().toISOString() })
          .eq('installation_id', job.installationId)
          .eq('local_id', job.localId);

        let notionBlockId = null;

        if (job.type === 'page') {
          const result = await pushPageToNotionForInstallation(job.installationId, {
            page: job.payload.page,
            project: job.payload.project,
            selectedParentPageId: job.payload.selectedParentPageId,
          });
          notionBlockId = result?.page?.notionPageId ?? null;
        } else if (job.type === 'project') {
          await syncProjectToNotionForInstallation(job.installationId, {
            project: job.payload.project,
            selectedParentPageId: job.payload.selectedParentPageId,
          });
        }

        await supabase
          .from('notion_block_sync')
          .update({
            status: 'synced',
            synced_version: job.queuedVersion,
            notion_block_id: notionBlockId,
            updated_at: new Date().toISOString(),
          })
          .eq('installation_id', job.installationId)
          .eq('local_id', job.localId);

        const doStub = env.SYNC_EVENTS.get(env.SYNC_EVENTS.idFromName(job.installationId));
        await doStub.fetch(new Request('http://do/notify', {
          method: 'POST',
          body: JSON.stringify({ status: 'synced', pageId: job.localId, notionBlockId }),
        })).catch(() => undefined);

        console.log('[queue] done', job.type, job.localId);
        msg.ack();
      } catch (err) {
        console.error('[queue] failed', job.type, job.localId, err);
        await supabase
          .from('notion_block_sync')
          .update({ status: 'failed', updated_at: new Date().toISOString() })
          .eq('installation_id', job.installationId)
          .eq('local_id', job.localId)
          .then(() => {}).catch(() => {});

        const doStub = env.SYNC_EVENTS.get(env.SYNC_EVENTS.idFromName(job.installationId));
        await doStub.fetch(new Request('http://do/notify', {
          method: 'POST',
          body: JSON.stringify({ status: 'failed', pageId: job.localId }),
        })).catch(() => undefined);

        msg.retry();
      }
    }
  },
};
