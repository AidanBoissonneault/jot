/**
 * @file Defines the Inkwell API routes and composes authentication, Notion, persistence, and queue services.
 * @author Aidan Boissonneault
 * @lastModified September 2026
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { createAuth } from './auth.js';
import {
  isNotionFileUploadBlock,
  kindFromNotionBlock,
  notionBlocksToTiptapDocument,
  tiptapDocumentToNotionBlocks,
} from './blockConversion.js';
import { importManagedBlocks as importManagedBlocksWithDependencies } from './importManagedBlocks.js';
import {
  applyManagedBlockOps as applyManagedBlockOpsWithDependencies,
  replaceManagedBlocks as replaceManagedBlocksWithDependencies,
} from './managedBlocks.js';
import { createNotionRequester, uploadFileToNotion } from './notionRequest.js';
import { normalizeSyncedMediaContent, pushPageToNotionCore } from './pageSync.js';
import {
  createProjectDatabaseHelpers,
  projectStateKey,
  threadKey,
} from './projectDatabase.js';
import { syncProjectFolder } from './projectSync.js';
import { createRootPageHelpers } from './rootPages.js';
import { closePage, legalPage, privacyBody, termsBody, youtubeEmbedPage } from './htmlPages.js';
import {
  computeHmacSignature,
  deleteNotionWebhook,
  exchangeNotionCode,
  notionUserFromToken,
  registerNotionWebhook,
} from './notionAuth.js';
import {
  MAX_SYNC_QUEUE_MESSAGE_BYTES,
  chunkSyncOpsForQueue,
  queueMessageBytes,
  syncOpGroupsByPage,
  syncOpWithoutRepeatedContext,
} from './syncQueueMessages.js';
import {
  chunks,
  findMappedNotionBlockId,
  findNotionBlockIdByFileUploadId,
  hash,
  isBase64,
  isBlockNotPageError,
  isNotionObjectNotFound,
  isSupportedMediaMimeType,
  isTrustedOrigin,
  mediaFallbackBlock,
  mediaUrlFromNotionBlock,
  positionAfterCreatedBlocks,
  randomToken,
  sanitizeMediaFilename,
  serverBaseUrl,
  stringValue,
  titleFromPage,
  updateBodyFromNotionBlock,
} from './workerUtils.js';
export { SyncEventsDO } from './syncEvents.js';
import type { AuthService, AuthSessionResult } from './auth.js';
import type {
  Identifier,
  BlockQueuePayload,
  ConnectedWorkerStore,
  JsonObject,
  NotionBlock,
  NotionBlockPayload,
  NotionObject,
  NotionRequester,
  PageQueuePayload,
  ManagedBlockOperation,
  WorkerEnv,
  WorkerStore,
  WorkerSupabaseClient,
  SyncQueueMessage,
} from './types.js';
import type { DocumentContent, NotionParentPage, Project, ProjectPage } from '../../../src/types/capture.js';
import type { QueueJobBase } from './syncQueueMessages.js';
import type { BlockPosition } from './workerUtils.js';
import type {
  CreateNotionPageRequest,
  MediaRefreshRequest,
  MediaUploadRequest,
  SyncPageRequest,
  SyncProjectRequest,
  SyncProjectSourceRequest,
  SyncReloadRequest,
  SyncBlockOperation,
  SyncValidationRequest,
} from '../../../src/types/sync.js';
import { youtubeEmbedUrl, youtubeVideoInfo, youtubeStartSeconds } from '../../../src/lib/youtubeUtils.js';

const INKWELL_SESSION_COOKIE = 'inkwell_session';
const INKWELL_OAUTH_STATE_COOKIE = 'inkwell_notion_oauth_state';
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;
const MAX_MEDIA_UPLOAD_BYTES = 20 * 1024 * 1024;

// TODO: replace with Durable Objects for cross-instance distributed locking
const installationMutationLocks = new Map<string, Promise<unknown>>();

type ApiContext = Context<{ Bindings: WorkerEnv }>;

interface PageSyncInput {
  page: ProjectPage;
  project: Project;
  selectedParentPageId: string | undefined;
}

interface ProjectSyncInput {
  project: Project;
  selectedParentPageId: string | undefined;
}

interface BlockOpsInput extends PageSyncInput {
  ops: ManagedBlockOperation[];
}

interface EnqueueJobBase {
  installationId: Identifier;
  localId: string;
  pageId: string;
  projectId: string;
}

interface BlockEnqueueJob extends EnqueueJobBase {
  batchId: string;
  batchIndex: number;
  batchSize: number;
  payload: BlockQueuePayload;
  type: 'block_op';
}

interface PageEnqueueJob extends EnqueueJobBase {
  payload: PageQueuePayload;
  type: 'page';
}

type EnqueueJob = BlockEnqueueJob | PageEnqueueJob;

interface InstallationTokens {
  id: Identifier;
  tokens: { access_token: string };
}

export const app = new Hono<{ Bindings: WorkerEnv }>();

/** Applies CORS headers and handles preflight requests. @param c - Hono context. @param next - Downstream middleware. @returns Middleware response. */
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

/** Serves the terms page. @param c - Hono context. @returns HTML response. */
app.get('/terms', (c) => c.html(legalPage('Terms of Service', termsBody())));
/** Serves the privacy page. @param c - Hono context. @returns HTML response. */
app.get('/privacy', (c) => c.html(legalPage('Privacy Policy', privacyBody())));

// ─── Auth routes ──────────────────────────────────────────────────────────────

/** Serves the successful authentication close page. @param c - Hono context. @returns HTML response. */
app.get('/auth/inkwell/complete', (c) =>
  c.html(closePage('You are logged in to Inkwell. You can return to the side panel.')),
);

/** Serves the failed authentication close page. @param c - Hono context. @returns HTML response. */
app.get('/auth/inkwell/error', (c) =>
  c.html(closePage('Inkwell login did not complete. You can close this tab and try again.'), 400),
);

/** Starts the Notion OAuth flow. @param c - Hono context. @returns Redirect response. */
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

  setCookie(c, INKWELL_OAUTH_STATE_COOKIE, state, {
    httpOnly: true,
    maxAge: 600,
    path: '/auth/notion',
    sameSite: 'Lax',
    secure: workerUrl.startsWith('https://'),
  });

  return c.redirect(url.toString());
});

/** Completes OAuth and creates an application session. @param c - Hono context. @returns Redirect response. */
app.get('/auth/notion/callback', async (c) => {
  const env = c.env;
  const expectedState = getCookie(c, INKWELL_OAUTH_STATE_COOKIE);
  const state = c.req.query('state') ?? '';
  const code = c.req.query('code') ?? '';
  const error = c.req.query('error') ?? '';

  deleteCookie(c, INKWELL_OAUTH_STATE_COOKIE, { path: '/auth/notion' });

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
      await ensureInkwellSyncStateRow(installationId);
      await registerNotionWebhook(
        env,
        supabase,
        installationId,
        tokens.access_token,
        serverBaseUrl(env),
      ).catch(() => undefined);
    }

    setCookie(c, INKWELL_SESSION_COOKIE, sessionToken, {
      httpOnly: true,
      maxAge: SESSION_MAX_AGE_SECONDS,
      path: '/',
      sameSite: 'Lax',
      secure: serverBaseUrl(env).startsWith('https://'),
    });

    return c.html(closePage('You are logged in to Inkwell. You can return to the side panel.'));
  } catch (err) {
    console.error('Failed to complete Notion login', err);
    return c.html(closePage('Notion login failed. You can close this tab and try again.'), 500);
  }
});

/** Returns the active application and Notion session. @param c - Hono context. @returns JSON response. */
app.get('/session', async (c) => {
  const session = await getInkwellSession(c);
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

/** Revokes the active installation and clears its session. @param c - Hono context. @returns JSON response. */
app.post('/auth/notion/logout', async (c) => {
  const session = await requireInkwellSession(c);
  if (!session) return;

  const token = getCookie(c, INKWELL_SESSION_COOKIE);
  const installation = await auth.getActiveInstallation(session.user.id).catch(() => undefined);
  if (installation?.id) {
    await deleteNotionWebhook(c.env, supabase, installation.id).catch(() => undefined);
  }
  await auth.revokeInstallation(session.user.id);
  await auth.deleteCustomSession(token);
  deleteCookie(c, INKWELL_SESSION_COOKIE, { path: '/' });

  return c.json({ connected: false });
});

/** Returns recent installation diagnostics. @param c - Hono context. @returns JSON response. */
app.get('/logs', async (c) => {
  const store = await readStore();
  return c.json({ logs: store.logs.slice(-100) });
});

// ─── Notion routes ─────────────────────────────────────────────────────────────

/** Serves the restricted YouTube embed wrapper. @param c - Hono context. @returns HTML response. */
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

/** Lists selectable Notion parent pages. @param c - Hono context. @returns JSON response. */
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

/** Creates a selectable Notion workspace page. @param c - Hono context. @returns JSON response. */
app.post('/notion/pages', async (c) => {
  const body: Partial<CreateNotionPageRequest> = await c.req.json<CreateNotionPageRequest>().catch(() => ({}));
  const title = String(body?.title ?? '').trim() || 'Inkwell';
  const store = await requireConnectedStore(c);
  const page = await createWorkspacePage(store, title);

  appendLog(store, 'parent_page_created', title);
  await writeStore(store);

  return c.json({ page: { id: page.id, title: titleFromPage(page), url: page.url } });
});

// ─── Sync routes ───────────────────────────────────────────────────────────────

/** Queues page or block synchronization work. @param c - Hono context. @returns JSON response. */
app.post('/sync/push', async (c) => {
  const body: Partial<SyncPageRequest> = await c.req.json<SyncPageRequest>().catch(() => ({}));
  const { page, project, selectedParentPageId } = body ?? {};
  const ops = Array.isArray(body?.ops) ? body.ops : [];

  if (!ops.length && (!page?.id || !project?.id)) {
    return c.json({ status: 'error', message: 'Missing page or project.' });
  }

  const store = await requireConnectedStore(c);
  const versions: Record<string, number> = {};
  const opVersions: Record<string, number> = {};

  if (ops.length) {
    const groups = syncOpGroupsByPage(ops);

    for (const group of groups) {
      const latestOp = group.ops.at(-1);
      if (!latestOp?.opId || !latestOp?.pageId || !latestOp?.payload?.page || !latestOp?.payload?.project) {
        return c.json({ status: 'error', message: 'Invalid sync operation.' }, 400);
      }

      const queuedOps = group.ops.map(syncOpWithoutRepeatedContext);
      const jobBase: QueueJobBase = {
        type: 'block_op',
        localId: latestOp.pageId,
        pageId: latestOp.pageId,
        projectId: latestOp.projectId,
        installationId: store.installationId,
        batchId: `${latestOp.pageId}:${group.version}`,
        payload: {
          page: latestOp.payload.page,
          project: latestOp.payload.project,
          selectedParentPageId: latestOp.payload.selectedParentPageId,
        },
      };
      const chunks = chunkSyncOpsForQueue(jobBase, queuedOps, group.version);
      if (!chunks) {
        const oversized = queuedOps.find((op) =>
          queueMessageBytes({
            ...jobBase,
            queuedVersion: group.version,
            batchIndex: 0,
            batchSize: 1,
            payload: { ...jobBase.payload, ops: [op] },
          }) > MAX_SYNC_QUEUE_MESSAGE_BYTES,
        );
        return c.json({
          status: 'error',
          message: `A single block is too large to queue (${oversized?.inkwellBlockId ?? oversized?.type ?? 'unknown block'}).`,
        }, 413);
      }
      const jobs = chunks.map((chunk, batchIndex) => ({
        ...jobBase,
        batchIndex,
        batchSize: chunks.length,
        payload: { ...jobBase.payload, ops: chunk },
      }));

      let version = group.version;
      for (const job of jobs) {
        version = await enqueueSync(c.env, job, group.version);
      }
      versions[latestOp.pageId] = version;
      for (const op of group.ops) {
        opVersions[op.opId] = version;
      }
    }

    return c.json({ queued: true, versions, opVersions });
  }

  if (!page || !project) {
    return c.json({ status: 'error', message: 'Missing page or project.' }, 400);
  }

  const version = await enqueueSync(c.env, {
    type: 'page',
    localId: page.id,
    pageId: page.id,
    projectId: project.id,
    installationId: store.installationId,
    payload: { page, project, selectedParentPageId },
  }, page.localSyncVersion ?? page.knownSyncVersion ?? 0);

  return c.json({ queued: true, version });
});

/** Synchronizes project metadata immediately. @param c - Hono context. @returns JSON response. */
app.post('/sync/project', async (c) => {
  const body: Partial<SyncProjectRequest> = await c.req.json<SyncProjectRequest>().catch(() => ({}));
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

/** Synchronizes one project-state source block. @param c - Hono context. @returns JSON response. */
app.post('/sync/project/source', async (c) => {
  const body: Partial<SyncProjectSourceRequest> = await c.req.json<SyncProjectSourceRequest>().catch(() => ({}));
  const { project, blockId, block, selectedParentPageId } = body ?? {};

  if (!project?.id || !blockId || !block) {
    return c.json({ status: 'error', message: 'Missing project source.' }, 400);
  }

  try {
    const store = await requireConnectedStore(c);
    return c.json(await withFreshInstallationStore(store, async (freshStore) => {
      const completeProject: Project = { ...project, stateContent: { type: 'doc', content: [] } };
      const projectPage = await ensureProjectPage(freshStore, completeProject, {
        selectedParentPageId,
        syncState: false,
      });
      const container = await ensureProjectStateContainer(
        freshStore,
        projectPage.id,
        project.id,
      );
      await applyManagedBlockOps(
        freshStore,
        projectStateKey(project.id),
        container.id,
        [{
          type: 'block_update',
          inkwellBlockId: stringValue(block.attrs?.inkwellBlockId)
            ?? `source:${encodeURIComponent(blockId)}`,
          payload: { block },
        }],
        { type: 'doc', content: [block] },
      );
      const refreshed = await notionRequest(freshStore, `/blocks/${container.id}`)
        .catch(() => container);
      freshStore.projectBlocks[projectStateKey(project.id)] = {
        ...freshStore.projectBlocks[projectStateKey(project.id)],
        blockId: container.id,
        lastEditedTime: refreshed.last_edited_time,
        parentPageId: projectPage.id,
        title: 'Project State',
      };
      await writeStore(freshStore);
      return { status: 'saved', project };
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[sync/project/source] failed:', message, error);
    return c.json({ status: 'error', message }, 500);
  }
});

/** Returns local synchronization versions and statuses. @param c - Hono context. @returns JSON response. */
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

/** Proxies the installation event stream from its durable object. @param c - Hono context. @returns Streaming response. */
app.get('/sync/events', async (c) => {
  const store = await requireConnectedStore(c);
  const doId = c.env.SYNC_EVENTS.idFromName(String(store.installationId));
  const stub = c.env.SYNC_EVENTS.get(doId);
  return stub.fetch(new Request('http://do/connect'));
});

/** Compares client state with persisted versions and remote cache validity. @param c - Hono context. @returns JSON response. */
app.post('/sync/validate', async (c) => {
  const body: Partial<SyncValidationRequest> = await c.req.json<SyncValidationRequest>().catch(() => ({}));
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

/** Reloads database-backed project state from Notion. @param c - Hono context. @returns JSON response. */
app.post('/sync/reload', async (c) => {
  const body: Partial<SyncReloadRequest> = await c.req.json<SyncReloadRequest>().catch(() => ({}));
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

/** Pulls a linked page from Notion. @param c - Hono context. @returns JSON response. */
app.post('/sync/pull', async (c) => {
  const body: Partial<SyncPageRequest> = await c.req.json<SyncPageRequest>().catch(() => ({}));
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
      message: 'Notion changed this page in a way Inkwell cannot safely import automatically.',
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

/** Marks a stale synchronization row as current. @param c - Hono context. @returns JSON response. */
app.post('/sync/clear-stale', async (c) => {
  const body: { pageIds?: string[] } = await c.req.json<{ pageIds?: string[] }>().catch(() => ({}));
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

/** Verifies and accepts Notion webhook events. @param c - Hono context. @returns JSON acknowledgement. */
app.post('/webhooks/notion', async (c) => {
  const rawBody = await c.req.text();

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    console.warn('[webhooks/notion] invalid JSON payload');
    return c.json({ ok: true, ignored: 'invalid_json' });
  }

  // Current Notion webhook setup sends a one-time verification_token that must
  // be copied from server logs into the Notion integration settings.
  if (typeof payload.verification_token === 'string') {
    console.log('[webhooks/notion] verification token received:', payload.verification_token);
    return c.json({ ok: true });
  }

  // Older Notion webhook URL verification must be answered synchronously.
  if (payload.type === 'url_verification' && payload.challenge) {
    return c.json({ challenge: payload.challenge });
  }

  const signature = c.req.header('x-notion-signature') ?? c.req.header('notion-signature') ?? '';
  if (c.env.NOTION_WEBHOOK_SECRET) {
    const expected = await computeHmacSignature(c.env.NOTION_WEBHOOK_SECRET, rawBody).catch((error) => {
      console.error('[webhooks/notion] signature computation failed:', error);
      return '';
    });
    if (signature !== `sha256=${expected}` && signature !== `v0=${expected}`) {
      console.warn('[webhooks/notion] invalid signature');
      return c.json({ ok: true, ignored: 'invalid_signature' });
    }
  }

  const processing = processNotionWebhook(c.env, payload).catch((error) => {
    console.error('[webhooks/notion] processing failed:', error);
  });
  c.executionCtx?.waitUntil?.(processing);

  return c.json({ ok: true });
});

/** Processes a verified Notion event and marks mapped local pages stale. @param env - Worker bindings. @param payload - Parsed webhook body. @returns Completion after notifications are queued. */
async function processNotionWebhook(env: WorkerEnv, payload: JsonObject): Promise<void> {
  const notionPageId = (payload.entity as Record<string, unknown> | undefined)?.id as string | undefined;
  if (!notionPageId) return;

  // Skip changes made by our own bot integration (new format uses authors[], old format uses actor)
  const authors = payload.authors as Array<Record<string, unknown>> | undefined;
  const actor = payload.actor as Record<string, unknown> | undefined;
  if (actor?.type === 'bot' || (authors?.length && authors.every((a) => a.type === 'bot'))) {
    return;
  }

  const { data: rows } = await supabase
    .from('notion_block_sync')
    .select('installation_id, local_id')
    .eq('notion_block_id', notionPageId);

  if (!rows?.length) {
    console.log('[webhooks/notion] no local pages mapped to notion page', notionPageId);
    return;
  }

  console.log('[webhooks/notion] notifying', rows.length, 'page(s) stale for notion page', notionPageId);
  for (const row of rows) {
    const { data: staleVersion } = await supabase.rpc('increment_block_version', {
      p_installation_id: row.installation_id,
      p_local_id: row.local_id,
      p_entity_type: 'page',
    });

    await supabase
      .from('notion_block_sync')
      .update({ is_stale: true, stale_since: new Date().toISOString() })
      .eq('installation_id', row.installation_id)
      .eq('local_id', row.local_id);

    const doStub = env.SYNC_EVENTS.get(
      env.SYNC_EVENTS.idFromName(String(row.installation_id)),
    );
    await doStub.fetch(new Request('http://do/notify', {
      method: 'POST',
      body: JSON.stringify({ status: 'stale', pageId: row.local_id, version: staleVersion }),
    })).catch(() => undefined);
  }

}

// ─── Media upload ──────────────────────────────────────────────────────────────

/** Uploads validated local media to Notion. @param c - Hono context. @returns JSON upload metadata. */
app.post('/media/upload', async (c) => {
  const body: Partial<MediaUploadRequest> = await c.req.json<MediaUploadRequest>().catch(() => ({}));
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

/** Refreshes the signed URL for uploaded Notion media. @param c - Hono context. @returns JSON response. */
app.post('/media/refresh', async (c) => {
  const body: Partial<MediaRefreshRequest> = await c.req.json<MediaRefreshRequest>().catch(() => ({}));
  const fileUploadId = String(body?.fileUploadId ?? '').trim();
  const requestedBlockId = String(body?.notionBlockId ?? '').trim();
  if (!fileUploadId && !requestedBlockId) {
    return c.json({ error: 'Missing media identity.' }, 400);
  }

  const store = await requireConnectedStore(c);
  const notionBlockId =
    (fileUploadId ? findNotionBlockIdByFileUploadId(store, fileUploadId) : null) ??
    findMappedNotionBlockId(store, requestedBlockId);
  if (!notionBlockId) return c.json({ error: 'Media block is not synced yet.' }, 404);

  const block = await notionRequest(store, `/blocks/${notionBlockId}`);
  const url = mediaUrlFromNotionBlock(block);
  if (!url) return c.json({ error: 'Unable to refresh this media URL.' }, 404);

  return c.json({ url });
});

// ─── Per-request singletons ────────────────────────────────────────────────────

type RootHelpers = ReturnType<typeof createRootPageHelpers>;
type DatabaseHelpers = ReturnType<typeof createProjectDatabaseHelpers>;

let supabase: WorkerSupabaseClient;
let auth: AuthService;
let notionRequest: NotionRequester;
let ensureInkwellRootPage: RootHelpers['ensureInkwellRootPage'];
let ensureProjectRootPage: RootHelpers['ensureProjectRootPage'];
let pageSummary: RootHelpers['pageSummary'];
let archiveThreadToggle: DatabaseHelpers['archiveThreadToggle'];
let ensureProjectDatabase: DatabaseHelpers['ensureProjectDatabase'];
let ensureProjectPage: DatabaseHelpers['ensureProjectPage'];
let ensureProjectStateContainer: DatabaseHelpers['ensureProjectStateContainer'];
let ensureThreadToggle: DatabaseHelpers['ensureThreadToggle'];
let reloadProjectDatabaseFromNotion: DatabaseHelpers['reloadProjectDatabaseFromNotion'];
let updateThreadToggleTitle: DatabaseHelpers['updateThreadToggleTitle'];

/** Initializes request-scoped service singletons from worker bindings. @param env - Worker bindings. @returns Nothing. */
function initSingletons(env: WorkerEnv): void {
  supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY);
  auth = createAuth(supabase);

  const NOTION_VERSION = env.NOTION_VERSION ?? '2026-03-11';
  const INKWELL_ROOT_PAGE_TITLE = env.INKWELL_ROOT_PAGE_TITLE ?? 'Inkwell';

  notionRequest = createNotionRequester({ notionVersion: NOTION_VERSION });

  const rootHelpers = createRootPageHelpers({
    appendLog,
    createChildPage,
    createWorkspacePage,
    isNotionObjectNotFound,
    inkwellRootPageTitle: INKWELL_ROOT_PAGE_TITLE,
    listAllBlockChildren,
    notionRequest,
    titleFromPage,
    updatePageTitle,
  });
  ensureInkwellRootPage = rootHelpers.ensureInkwellRootPage;
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
  ensureProjectStateContainer = dbHelpers.ensureProjectStateContainer;
  ensureThreadToggle = dbHelpers.ensureThreadToggle;
  reloadProjectDatabaseFromNotion = dbHelpers.reloadProjectDatabaseFromNotion;
  updateThreadToggleTitle = dbHelpers.updateThreadToggleTitle;
}

// ─── Sync handlers ─────────────────────────────────────────────────────────────

/** Pushes a page from an authenticated HTTP request. @param input - Request context and page synchronization data. @returns Synchronization response data. */
async function pushPageToNotion({ c, page, project, selectedParentPageId }: PageSyncInput & { c: ApiContext }) {
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
        ensureInkwellRootPage,
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

/** Synchronizes one project using an already refreshed store. @param freshStore - Current installation state. @param input - Project and parent selection. @returns Project synchronization result. */
async function performSyncProjectFolder(freshStore: WorkerStore, { project, selectedParentPageId }: ProjectSyncInput) {
  const response = await syncProjectFolder({
    store: freshStore,
    project,
    selectedParentPageId,
    ensureInkwellRootPage,
    ensureProjectPage,
    ensureProjectRootPage,
    archiveProjectRootPage,
    pageSummary,
  });
  appendLog(freshStore, project.status === 'archived' ? 'project_archived' : 'project_synced', project.name);
  await writeStore(freshStore);
  return response;
}

/** Synchronizes a project from an authenticated HTTP request. @param input - Request context and project data. @returns Project synchronization result. */
async function syncProjectToNotion({ c, project, selectedParentPageId }: ProjectSyncInput & { c: ApiContext }) {
  const store = await requireConnectedStore(c);
  return withFreshInstallationStore(store, (freshStore) => performSyncProjectFolder(freshStore, { project, selectedParentPageId }));
}

// ─── Queue helpers ─────────────────────────────────────────────────────────────

/** Persists a pending version and sends its normalized Queue message. @param env - Worker bindings. @param job - Queue job input. @param clientVersion - Client-side revision. @returns Enqueued revision number. */
async function enqueueSync(env: WorkerEnv, job: EnqueueJob, clientVersion = 0): Promise<number> {
  const version = Number.isFinite(Number(clientVersion)) ? Number(clientVersion) : 0;
  const { data: existing } = await supabase
    .from('notion_block_sync')
    .select('local_version')
    .eq('installation_id', job.installationId)
    .eq('local_id', job.localId)
    .maybeSingle();

  await supabase.from('notion_block_sync').upsert(
    {
      installation_id: job.installationId,
      local_id: job.localId,
      entity_type: job.type,
      local_version: Math.max(existing?.local_version ?? 0, version),
      status: 'pending',
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'installation_id,local_id' },
  );

  const message: SyncQueueMessage = job.type === 'block_op'
    ? { ...job, queuedVersion: version }
    : { ...job, queuedVersion: version };
  await env.SYNC_QUEUE.send(message);
  return version;
}

/** Loads an active installation and its Notion token. @param installationId - Installation identifier. @returns Installation tokens, or null when unavailable. */
async function getInstallationById(installationId: Identifier): Promise<InstallationTokens | null> {
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

/** Builds fresh normalized state for a queue installation. @param installationId - Installation identifier. @returns Connected worker state. */
async function freshConnectedStoreForInstallation(installationId: Identifier): Promise<WorkerStore> {
  const installation = await getInstallationById(installationId);
  if (!installation) throw new Error('Installation not found or revoked.');
  return freshConnectedStore(normalizeStore({ installationId, tokens: installation.tokens }));
}

/** Pushes a page for a background installation. @param installationId - Installation identifier. @param input - Page synchronization input. @returns Synchronization response data. */
async function pushPageToNotionForInstallation(installationId: Identifier, { page, project, selectedParentPageId }: PageSyncInput) {
  const store = await freshConnectedStoreForInstallation(installationId);

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
        ensureInkwellRootPage,
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

/** Applies queued block operations for one installation. @param installationId - Installation identifier. @param input - Operations and page context. @returns Updated page result. */
async function applyBlockOpsToNotionForInstallation(installationId: Identifier, { ops, page, project, selectedParentPageId }: BlockOpsInput) {
  const store = await freshConnectedStoreForInstallation(installationId);

  return withFreshInstallationStore(store, async (freshStore) => {
    let notionPageId;
    let parentPageId;
    let refreshed;

    if (ensureProjectPage && ensureThreadToggle) {
      const projectPage = await ensureProjectPage(freshStore, project, {
        selectedParentPageId,
        syncState: false,
      });
      if (page.status === 'archived' || ops.some((op) => op.type === 'page_archive')) {
        await archiveThreadToggle?.(freshStore, page);
        appendLog(freshStore, 'sync_thread_archived', page.title);
        await writeStore(freshStore);
        return { page: { ...page, notionParentPageId: projectPage.id, syncState: 'saved' } };
      }
      const toggle = await ensureThreadToggle(freshStore, projectPage.id, page);
      await updateThreadToggleTitle?.(freshStore, page);
      notionPageId = toggle.id;
      parentPageId = projectPage.id;
      const content = syncContentForOps(ops, page.content);
      const replacement = await applyManagedBlockOps(freshStore, page.id, notionPageId, ops, content);
      page.content = normalizeSyncedMediaContent(content, replacement?.createdBlocks ?? []);
      refreshed = await notionRequest(freshStore, `/blocks/${notionPageId}`).catch(() => toggle);
      freshStore.notePages[page.id] = {
        archived: false,
        dataSourceId: undefined,
        notionPageId,
        parentPageId,
        title: page.title,
        lastEditedTime: refreshed.last_edited_time,
        kind: 'thread',
      };
    } else {
      const inkwellRootPage = await ensureInkwellRootPage(freshStore, { selectedParentPageId });
      const projectRootPage = await ensureProjectRootPage(freshStore, inkwellRootPage.id, project, {
        candidateNotionPageId: page.notionParentPageId,
      });
      const existingPageId = page.notionPageId ?? freshStore.notePages[page.id]?.notionPageId;
      const existingPage = existingPageId
        ? await notionRequest(freshStore, `/pages/${existingPageId}`).catch(() => undefined)
        : undefined;
      const notePage = existingPage ?? await createChildPage(freshStore, projectRootPage.id, page.title);
      await updateChildNotePage(freshStore, notePage.id, page);
      notionPageId = notePage.id;
      parentPageId = projectRootPage.id;
      const content = syncContentForOps(ops, page.content);
      const replacement = await applyManagedBlockOps(freshStore, page.id, notionPageId, ops, content);
      page.content = normalizeSyncedMediaContent(content, replacement?.createdBlocks ?? []);
      refreshed = await notionRequest(freshStore, `/pages/${notionPageId}`).catch(() => notePage);
      freshStore.notePages[page.id] = {
        archived: false,
        dataSourceId: undefined,
        kind: undefined,
        notionPageId,
        parentPageId,
        title: page.title,
        lastEditedTime: refreshed.last_edited_time,
      };
    }

    appendLog(freshStore, 'sync_block_push', `${page.title} (${ops.length} ops)`);
    await writeStore(freshStore);

    return {
      page: {
        ...page,
        notionPageId,
        notionDatabaseId: undefined,
        notionDataSourceId: undefined,
        notionParentPageId: parentPageId,
        notionLastEditedTime: refreshed?.last_edited_time,
        remoteRevision: refreshed?.last_edited_time,
        syncState: 'saved',
      },
      status: 'saved',
      message: 'Synced block changes to Notion.',
    };
  });
}

/** Selects the newest replacement document carried by queued operations. @param ops - Managed block operations. @param legacyContent - Page content fallback. @returns Effective document content. */
function syncContentForOps(ops: ManagedBlockOperation[], legacyContent: DocumentContent): DocumentContent {
  if (legacyContent?.content) return legacyContent;
  const blocks = ops
    .map((op: ManagedBlockOperation) => op.payload.block)
    .filter((block: DocumentContent | undefined): block is DocumentContent => Boolean(block));
  return { type: 'doc', content: blocks };
}

/** Reads the single-operation field used by older Queue messages. @param payload - Current or legacy block payload. @returns Legacy operation when present. */
function legacyQueueOperation(payload: BlockQueuePayload): ManagedBlockOperation | undefined {
  const operation: unknown = (payload as unknown as JsonObject).op;
  if (!operation || typeof operation !== 'object' || Array.isArray(operation)) return undefined;
  const candidate = operation as JsonObject;
  if (typeof candidate.type !== 'string' || !candidate.payload || typeof candidate.payload !== 'object') return undefined;
  return operation as ManagedBlockOperation;
}

/** Synchronizes a project for a background installation. @param installationId - Installation identifier. @param input - Project synchronization input. @returns Project synchronization result. */
async function syncProjectToNotionForInstallation(installationId: Identifier, { project, selectedParentPageId }: ProjectSyncInput) {
  const store = await freshConnectedStoreForInstallation(installationId);
  return withFreshInstallationStore(store, (freshStore) => performSyncProjectFolder(freshStore, { project, selectedParentPageId }));
}

// ─── Store helpers ─────────────────────────────────────────────────────────────

/** Creates an empty normalized worker store. @returns Empty normalized state. */
function readStore(): WorkerStore {
  return normalizeStore({});
}

/** Persists normalized state for its connected installation. @param store - Worker state. @returns Completion after persistence. */
async function writeStore(store: WorkerStore): Promise<void> {
  if (store.installationId) {
    await writeInkwellSyncState(store.installationId, store);
  }
}

/** Fills all state collections and nullable connection values. @param store - Partial persisted state. @returns Fully normalized state. */
function normalizeStore(store: Partial<WorkerStore>): WorkerStore {
  return {
    ignoredInkwellDatabaseIds: store.ignoredInkwellDatabaseIds ?? new Set<string>(),
    installationId: store.installationId,
    parentPages: store.parentPages ?? {},
    projectPages: store.projectPages ?? {},
    projectBlocks: store.projectBlocks ?? {},
    threadBlocks: store.threadBlocks ?? {},
    inkwellRootPage: store.inkwellRootPage,
    inkwellDatabase: store.inkwellDatabase,
    notePages: store.notePages ?? {},
    blockMappings: store.blockMappings ?? {},
    logs: store.logs ?? [],
    tokens: store.tokens,
  };
}

/** Appends a bounded diagnostic event to worker state. @param store - Worker state. @param event - Event code. @param message - Human-readable detail. @returns Nothing. */
function appendLog(store: WorkerStore, event: string, message: string): void {
  store.logs.push({ at: new Date().toISOString(), event, message });
  store.logs = store.logs.slice(-250);
}

/** Resolves authenticated installation state for an API request. @param c - Hono request context. @returns Connected normalized state. */
async function requireConnectedStore(c: ApiContext): Promise<ConnectedWorkerStore> {
  const session = await getInkwellSession(c);

  if (!session) throw new Error('Log in to Inkwell before syncing Notion.');

  const [store, installation] = await Promise.all([
    readStore(),
    auth.getActiveInstallationWithTokens(session.user.id),
  ]);

  if (!installation?.tokens?.access_token || !installation?.id) {
    throw new Error('Notion is not connected.');
  }

  const syncState = await readInkwellSyncState(installation.id);

  return {
    ...store,
    ...syncState,
    installationId: installation.id,
    tokens: installation.tokens,
  };
}

/** Serializes mutations for one installation in the current isolate. @param installationId - Installation identifier. @param operation - Mutating operation. @returns Operation result. */
function withInstallationLock<Result>(
  lockKey: string,
  operation: () => Promise<Result>,
): Promise<Result> {
  const previous = installationMutationLocks.get(lockKey) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  const tracked = current.finally(() => {
    if (installationMutationLocks.get(lockKey) === tracked) {
      installationMutationLocks.delete(lockKey);
    }
  });

  installationMutationLocks.set(lockKey, tracked);
  return current;
}

/** Refreshes state under the installation lock before executing work. @param store - Connected state. @param operation - Operation using fresh state. @returns Operation result. */
async function withFreshInstallationStore<Result>(
  store: WorkerStore,
  mutator: (freshStore: WorkerStore) => Promise<Result>,
): Promise<Result> {
  const lockKey = store.installationId ? String(store.installationId) : 'local';
  return withInstallationLock(lockKey, async () => {
    const freshStore = await freshConnectedStore(store);
    return mutator(freshStore);
  });
}

/** Reloads persisted state while preserving active credentials. @param store - Connected state. @returns Fresh connected state. */
async function freshConnectedStore(store: WorkerStore): Promise<WorkerStore> {
  if (!store.installationId) return store;

  const [localStore, syncState] = await Promise.all([
    readStore(),
    readInkwellSyncState(store.installationId),
  ]);

  return {
    ...localStore,
    ...syncState,
    installationId: store.installationId,
    tokens: store.tokens,
  };
}

// ─── Session helpers ───────────────────────────────────────────────────────────

/** Reads the current application session cookie. @param c - Hono request context. @returns Session data, or null. */
async function getInkwellSession(c: ApiContext): Promise<AuthSessionResult | null> {
  return auth.getCustomSession(getCookie(c, INKWELL_SESSION_COOKIE));
}

/** Requires a valid session and emits an HTTP error when absent. @param c - Hono request context. @returns Session data, or null after responding. */
async function requireInkwellSession(c: ApiContext): Promise<AuthSessionResult | null> {
  const session = await getInkwellSession(c);

  if (!session) {
    c.res = c.json({ error: 'Unauthorized', message: 'Log in to Inkwell first.' }, 401);
    return null;
  }

  return session;
}

// ─── Sync state (Supabase) ─────────────────────────────────────────────────────

/** Ensures persisted synchronization state exists. @param installationId - Installation identifier. @returns Completion after upsert. */
async function ensureInkwellSyncStateRow(installationId: Identifier): Promise<void> {
  await supabase.from('inkwell_sync_state').upsert(
    { installation_id: installationId },
    { onConflict: 'installation_id', ignoreDuplicates: true },
  );
}

/** Loads and normalizes persisted synchronization state. @param installationId - Installation identifier. @returns Normalized state. */
async function readInkwellSyncState(installationId: Identifier): Promise<WorkerStore> {
  await ensureInkwellSyncStateRow(installationId);

  const { data: row } = await supabase
    .from('inkwell_sync_state')
    .select('*')
    .eq('installation_id', installationId)
    .single();

  if (!row) return normalizeStore({});

  return normalizeStore({
    inkwellRootPage: row.inkwell_database_id && !row.inkwell_data_source_id
      ? { id: row.inkwell_database_id, parentPageId: row.inkwell_parent_page_id, title: row.inkwell_database_title }
      : undefined,
    inkwellDatabase: row.inkwell_database_id
      ? {
          databaseId: row.inkwell_database_id,
          dataSourceId: row.inkwell_data_source_id,
          parentPageId: row.inkwell_parent_page_id,
          title: row.inkwell_database_title,
          propertyIds: {},
          url: undefined,
          views: {},
        }
      : undefined,
    // Supabase returns JSONB columns as parsed objects already
    notePages: row.note_pages_json ?? {},
    blockMappings: row.block_mappings_json ?? {},
    parentPages: row.parent_pages_json ?? {},
    projectPages: row.project_pages_json ?? {},
    projectBlocks: row.project_blocks_json ?? {},
    threadBlocks: row.thread_blocks_json ?? {},
  });
}

/** Serializes worker state into the persistence row. @param installationId - Installation identifier. @param store - Normalized state. @returns Completion after persistence. */
async function writeInkwellSyncState(installationId: Identifier, store: WorkerStore): Promise<void> {
  await ensureInkwellSyncStateRow(installationId);
  await supabase.from('inkwell_sync_state').update({
    inkwell_database_id: store.inkwellDatabase?.databaseId ?? store.inkwellRootPage?.id ?? null,
    inkwell_data_source_id: store.inkwellDatabase?.dataSourceId ?? null,
    inkwell_parent_page_id: store.inkwellDatabase?.parentPageId ?? store.inkwellRootPage?.id ?? store.inkwellRootPage?.parentPageId ?? null,
    inkwell_database_title: store.inkwellDatabase?.title ?? store.inkwellRootPage?.title ?? null,
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

// ─── Notion OAuth helpers ──────────────────────────────────────────────────────

// ─── Notion API helpers ────────────────────────────────────────────────────────

/** Removes cached mappings whose Notion objects no longer exist. @param store - Worker state. @param entities - Local pages and projects. @returns Cache validation summary. */
async function validateNotionCache(store: WorkerStore, { pages, projects }: { pages: ProjectPage[]; projects: Project[] }) {
  const uncachedProjectIds = new Set();
  const uncachedPageIds = new Set();
  let clearSelectedParentPage = false;
  let changed = false;

  if (store.inkwellRootPage?.id && !(await notionObjectExists(store, 'page', store.inkwellRootPage.id))) {
    store.inkwellRootPage = undefined;
    store.inkwellDatabase = undefined;
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
    store.inkwellDatabase?.databaseId &&
    !(await notionObjectExists(store, 'database', store.inkwellDatabase.databaseId))
  ) {
    store.inkwellDatabase = undefined;
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

/** Removes every cached record associated with a local page. @param store - Worker state. @param pageId - Local page identifier. @returns Nothing. */
function uncachePage(store: WorkerStore, pageId: string): void {
  delete store.threadBlocks?.[threadKey(pageId)];
  delete store.notePages?.[pageId];
  delete store.blockMappings?.[pageId];
}

/** Checks whether a cached Notion object remains retrievable. @param store - Worker state. @param kind - Notion object kind. @param id - Notion identifier. @returns Whether the object exists. */
async function notionObjectExists(store: WorkerStore, kind: 'block' | 'database' | 'page', id: string): Promise<boolean> {
  try {
    const endpoint = kind === 'database' ? `/databases/${id}` : kind === 'block' ? `/blocks/${id}` : `/pages/${id}`;
    await notionRequest(store, endpoint);
    return true;
  } catch (error) {
    if (isNotionObjectNotFound(error)) return false;
    throw error;
  }
}

/** Retrieves a linked page, falling back to the block endpoint for threads. @param store - Worker state. @param page - Linked local page. @returns Notion page or block response. */
async function retrieveNotionPageOrBlock(store: WorkerStore, page: ProjectPage): Promise<NotionObject> {
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

/** Determines whether a local page is represented by a toggle block. @param store - Worker state. @param page - Local page. @returns Whether the page is thread-backed. */
function isThreadBackedPage(store: WorkerStore, page: ProjectPage): boolean {
  const cachedThread = store.threadBlocks?.[threadKey(page.id)];
  const cachedNote = store.notePages?.[page.id];
  return Boolean(cachedThread?.blockId === page.notionPageId || cachedNote?.kind === 'thread');
}

/** Replaces managed children and updates mappings. @param store - Worker state. @param localPageId - Local page identifier. @param notionPageId - Parent Notion identifier. @param content - Desired document. @returns Replacement result. */
async function replaceManagedBlocks(store: WorkerStore, localPageId: string, notionPageId: string, content: DocumentContent) {
  return replaceManagedBlocksWithDependencies({
    store, localPageId, notionPageId, content,
    listAllBlockChildren, deleteManagedBlock, appendManagedBlocks,
    updateManagedBlock, tiptapDocumentToNotionBlocks, kindFromNotionBlock, hash,
  });
}

/** Applies incremental managed-block changes. @param store - Worker state. @param localPageId - Local page identifier. @param notionPageId - Parent Notion identifier. @param ops - Ordered changes. @param content - Effective document. @returns Mutation result. */
async function applyManagedBlockOps(store: WorkerStore, localPageId: string, notionPageId: string, ops: ManagedBlockOperation[], content: DocumentContent) {
  return applyManagedBlockOpsWithDependencies({
    store, localPageId, notionPageId, ops, content,
    appendManagedBlocks, deleteManagedBlock, updateManagedBlock,
    replaceManagedBlocks, tiptapDocumentToNotionBlocks, kindFromNotionBlock, hash,
  });
}

/** Imports supported remote children for a linked page. @param store - Worker state. @param page - Linked local page. @returns Imported document, or null. */
async function importManagedBlocks(store: WorkerStore, page: ProjectPage): Promise<DocumentContent | null> {
  if (!page.notionPageId) return null;
  return importManagedBlocksWithDependencies({
    hash,
    listAllBlockChildren,
    page: { id: page.id, notionPageId: page.notionPageId },
    store,
  });
}

/** Loads every paginated child of a Notion block. @param store - Worker state. @param blockId - Parent block identifier. @returns All child blocks. */
async function listAllBlockChildren(store: WorkerStore, blockId: string): Promise<NotionBlock[]> {
  const results: NotionBlock[] = [];
  let cursor: string | undefined;

  do {
    const search = new URLSearchParams();
    search.set('page_size', '100');
    if (cursor) search.set('start_cursor', cursor);

    const response = await notionRequest(store, `/blocks/${blockId}/children?${search}`);
    results.push(...(response.results as NotionBlock[]));
    cursor = response.has_more ? response.next_cursor ?? undefined : undefined;
  } while (cursor);

  return results;
}

/** Creates a child page beneath a Notion page. @param store - Worker state. @param parentPageId - Parent identifier. @param title - Page title. @returns Created page. */
async function createChildPage(store: WorkerStore, parentPageId: string, title: string): Promise<NotionObject> {
  return notionRequest(store, '/pages', {
    method: 'POST',
    body: {
      parent: { type: 'page_id', page_id: parentPageId },
      properties: { title: [{ text: { content: title || 'Untitled Page' } }] },
    },
  });
}

/** Creates a top-level workspace page. @param store - Worker state. @param title - Page title. @returns Created page. */
async function createWorkspacePage(store: WorkerStore, title: string): Promise<NotionObject> {
  return notionRequest(store, '/pages', {
    method: 'POST',
    body: {
      parent: { type: 'workspace', workspace: true },
      properties: { title: [{ text: { content: title || 'Inkwell' } }] },
    },
  });
}

/** Updates a Notion page title. @param store - Worker state. @param pageId - Page identifier. @param title - New title. @returns Updated page. */
async function updatePageTitle(store: WorkerStore, pageId: string, title: string): Promise<NotionObject> {
  return notionRequest(store, `/pages/${pageId}`, {
    method: 'PATCH',
    body: { properties: { title: [{ text: { content: title || 'Untitled Page' } }] } },
  });
}

/** Updates a linked note page title and archive state. @param store - Worker state. @param pageId - Notion page identifier. @param page - Local page state. @returns Updated page. */
async function updateChildNotePage(store: WorkerStore, pageId: string, page: ProjectPage): Promise<NotionObject> {
  const body: JsonObject = { properties: { title: [{ text: { content: page.title || 'Untitled Page' } }] } };
  if (page.status === 'archived') body.archived = true;
  return notionRequest(store, `/pages/${pageId}`, { method: 'PATCH', body });
}

/** Archives a legacy project root page. @param store - Worker state. @param pageId - Notion page identifier. @returns Archived page. */
async function archiveProjectRootPage(store: WorkerStore, pageId: string): Promise<NotionObject> {
  return notionRequest(store, `/pages/${pageId}`, { method: 'PATCH', body: { archived: true } });
}

/** Deletes a managed Notion block. @param store - Worker state. @param blockId - Block identifier. @returns Deleted block response. */
async function deleteManagedBlock(store: WorkerStore, blockId: string): Promise<NotionObject> {
  return notionRequest(store, `/blocks/${blockId}`, { method: 'DELETE' });
}

/** Updates a managed Notion block in place. @param store - Worker state. @param blockId - Block identifier. @param notionBlock - Desired block payload. @returns Updated block. */
async function updateManagedBlock(store: WorkerStore, blockId: string, notionBlock: NotionBlockPayload): Promise<NotionObject> {
  return notionRequest(store, `/blocks/${blockId}`, {
    method: 'PATCH',
    body: updateBodyFromNotionBlock(notionBlock),
  });
}

/** Appends managed blocks in API-sized batches. @param store - Worker state. @param notionPageId - Parent identifier. @param notionBlocks - Blocks to append. @param position - Optional insertion position. @returns Created blocks. */
async function appendManagedBlocks(store: WorkerStore, notionPageId: string, notionBlocks: NotionBlockPayload[], position?: BlockPosition): Promise<NotionBlock[]> {
  const createdBlocks: NotionBlock[] = [];

  for (const batch of chunks(notionBlocks, 100)) {
    let results: NotionBlock[];
    try {
      const response = await notionRequest(store, `/blocks/${notionPageId}/children`, {
        method: 'PATCH',
        body: { children: batch, ...(position ? { position } : {}) },
      });
      results = response.results as NotionBlock[];
    } catch {
      results = await appendBlocksWithFallback(store, notionPageId, batch, position);
    }

    createdBlocks.push(...results);
    position = positionAfterCreatedBlocks(position, results);
  }

  return createdBlocks;
}

/** Appends blocks individually and substitutes unsupported media. @param store - Worker state. @param notionPageId - Parent identifier. @param blocks - Blocks to append. @param position - Optional insertion position. @returns Created blocks. */
async function appendBlocksWithFallback(store: WorkerStore, notionPageId: string, blocks: NotionBlockPayload[], position?: BlockPosition): Promise<NotionBlock[]> {
  const results: NotionBlock[] = [];

  for (const block of blocks) {
    try {
      const response = await notionRequest(store, `/blocks/${notionPageId}/children`, {
        method: 'PATCH',
        body: { children: [block], ...(position ? { position } : {}) },
      });
      const created = response.results as NotionBlock[];
      results.push(...created);
      position = positionAfterCreatedBlocks(position, created);
    } catch (error) {
      // A Notion file upload is the only durable copy of a dropped local file.
      // Never turn a transient attach failure into a permanent placeholder;
      // fail the sync job so the queue retries the original upload instead.
      if (isNotionFileUploadBlock(block)) {
        throw error;
      }

      const fallback = mediaFallbackBlock(block);
      try {
        const response = await notionRequest(store, `/blocks/${notionPageId}/children`, {
          method: 'PATCH',
          body: { children: [fallback], ...(position ? { position } : {}) },
        });
        const created = response.results as NotionBlock[];
        results.push(...created);
        position = positionAfterCreatedBlocks(position, created);
      } catch {
        // skip block rather than aborting the whole page
      }
    }
  }

  return results;
}

// ─── Utility helpers ───────────────────────────────────────────────────────────


// ─── SSE Durable Object ────────────────────────────────────────────────────────


// ─── Worker export ─────────────────────────────────────────────────────────────

export default {
  /** Dispatches an HTTP request through Hono. @param request - Incoming request. @param env - Worker bindings. @param ctx - Execution context. @returns HTTP response. */
  async fetch(request, env, ctx) {
    initSingletons(env);
    return app.fetch(request, env, ctx);
  },

  /** Processes synchronization Queue messages. @param batch - Queue batch. @param env - Worker bindings. @returns Completion after every message is acknowledged or retried. */
  async queue(batch, env) {
    initSingletons(env);

    for (const msg of batch.messages) {
      const job = msg.body;
      const installationId = String(job.installationId);
      const queuedVersion = job.queuedVersion ?? 0;
      let syncRow;
      console.log('[queue] processing', job.type, job.localId, 'v', queuedVersion);
      try {
        const { data: row } = await supabase
          .from('notion_block_sync')
          .select('local_version')
          .eq('installation_id', job.installationId)
          .eq('local_id', job.localId)
          .maybeSingle();
        syncRow = row;

        // Stale check — a newer edit was enqueued after this one
        // A block batch may span multiple Queue messages. Every chunk must run
        // or the remote page would be left only partially applied.
        if (job.type !== 'block_op' && row && row.local_version > queuedVersion) {
          console.log('[queue] skipped stale', job.type, job.localId, 'v', queuedVersion, 'latest', row.local_version);
          msg.ack();
          continue;
        }

        await supabase
          .from('notion_block_sync')
          .update({ status: 'syncing', updated_at: new Date().toISOString() })
          .eq('installation_id', job.installationId)
          .eq('local_id', job.localId);

        let notionBlockId = null;

        if (job.type === 'block_op') {
          const queuedPage = job.payload.page;
          const queuedProject = job.payload.project;
          if (!queuedPage || !queuedProject) throw new Error('Block queue job is missing page or project context.');
          const legacyOperation = legacyQueueOperation(job.payload);
          const result = await applyBlockOpsToNotionForInstallation(installationId, {
            ops: job.payload.ops?.length ? job.payload.ops : legacyOperation ? [legacyOperation] : [],
            page: { ...queuedPage, content: queuedPage.content ?? { type: 'doc', content: [] } },
            project: { ...queuedProject, stateContent: queuedProject.stateContent ?? { type: 'doc', content: [] } },
            selectedParentPageId: job.payload.selectedParentPageId,
          });
          notionBlockId = result?.page?.notionPageId ?? null;
        } else if (job.type === 'page') {
          const queuedPage = job.payload.page;
          const queuedProject = job.payload.project;
          if (!queuedPage || !queuedProject) throw new Error('Page queue job is missing page or project context.');
          const result = await pushPageToNotionForInstallation(installationId, {
            page: { ...queuedPage, content: queuedPage.content ?? { type: 'doc', content: [] } },
            project: { ...queuedProject, stateContent: queuedProject.stateContent ?? { type: 'doc', content: [] } },
            selectedParentPageId: job.payload.selectedParentPageId,
          });
          notionBlockId = result?.page?.notionPageId ?? null;
        } else if (job.type === 'project') {
          const queuedProject = job.payload.project;
          if (!queuedProject) throw new Error('Project queue job is missing project context.');
          await syncProjectToNotionForInstallation(installationId, {
            project: { ...queuedProject, stateContent: queuedProject.stateContent ?? { type: 'doc', content: [] } },
            selectedParentPageId: job.payload.selectedParentPageId,
          });
        }

        const isFinalBatchMessage = job.type !== 'block_op' || job.batchIndex === job.batchSize - 1;
        const isCurrentVersion = !row || row.local_version <= queuedVersion;
        if (isFinalBatchMessage && isCurrentVersion) {
          await supabase
            .from('notion_block_sync')
            .update({
              status: 'synced',
              synced_version: queuedVersion,
              notion_block_id: notionBlockId,
              updated_at: new Date().toISOString(),
            })
            .eq('installation_id', job.installationId)
            .eq('local_id', job.localId);

          const doStub = env.SYNC_EVENTS.get(env.SYNC_EVENTS.idFromName(installationId));
          await doStub.fetch(new Request('http://do/notify', {
            method: 'POST',
            body: JSON.stringify({ status: 'synced', pageId: job.localId, notionBlockId, version: queuedVersion }),
          })).catch(() => undefined);
        }

        console.log('[queue] done', job.type, job.localId);
        msg.ack();
      } catch (err) {
        console.error('[queue] failed', job.type, job.localId, err);
        await Promise.resolve(supabase
          .from('notion_block_sync')
          .update({ status: 'failed', updated_at: new Date().toISOString() })
          .eq('installation_id', job.installationId)
          .eq('local_id', job.localId)
          .eq('local_version', queuedVersion))
          .then((): void => undefined)
          .catch((): void => undefined);

        if (!syncRow || syncRow.local_version <= queuedVersion) {
          const doStub = env.SYNC_EVENTS.get(env.SYNC_EVENTS.idFromName(installationId));
          await doStub.fetch(new Request('http://do/notify', {
            method: 'POST',
            body: JSON.stringify({ status: 'failed', pageId: job.localId }),
          })).catch(() => undefined);
        }

        msg.retry();
      }
    }
  },
} satisfies ExportedHandler<WorkerEnv, SyncQueueMessage>;
