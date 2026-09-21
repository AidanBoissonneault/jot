/**
 * @file Owns the initialized worker service graph, persisted synchronization state, and Notion mutation orchestration.
 * @author Aidan Boissonneault
 * @lastModified September 2026
 */

import type { Context } from 'hono';
import { getCookie } from 'hono/cookie';
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { createAuth } from '../auth.js';
import {
  isNotionFileUploadBlock,
  kindFromNotionBlock,
  notionBlocksToTiptapDocument,
  tiptapDocumentToNotionBlocks,
} from '../blockConversion.js';
import { importManagedBlocks as importManagedBlocksWithDependencies } from '../importManagedBlocks.js';
import {
  applyManagedBlockOps as applyManagedBlockOpsWithDependencies,
  replaceManagedBlocks as replaceManagedBlocksWithDependencies,
} from '../managedBlocks.js';
import { createNotionRequester } from '../notionRequest.js';
import { normalizeSyncedMediaContent, pushPageToNotionCore } from '../pageSync.js';
import { createProjectDatabaseHelpers, projectStateKey, threadKey } from '../projectDatabase.js';
import { syncProjectFolder } from '../projectSync.js';
import { createRootPageHelpers } from '../rootPages.js';
import {
  chunks,
  hash,
  isBlockNotPageError,
  isNotionObjectNotFound,
  mediaFallbackBlock,
  positionAfterCreatedBlocks,
  titleFromPage,
  updateBodyFromNotionBlock,
} from '../workerUtils.js';
import type { AuthService, AuthSessionResult } from '../auth.js';
import type {
  ConnectedWorkerStore,
  BlockQueuePayload,
  Identifier,
  JsonObject,
  ManagedBlockOperation,
  NotionBlock,
  NotionBlockPayload,
  NotionObject,
  NotionRequester,
  PageQueuePayload,
  SyncQueueMessage,
  WorkerEnv,
  WorkerStore,
  WorkerSupabaseClient,
} from '../types.js';
import type { DocumentContent, Project, ProjectPage } from '../../../../src/types/capture.js';
import type { BlockPosition } from '../workerUtils.js';

export const INKWELL_SESSION_COOKIE = 'inkwell_session';
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;
const installationMutationLocks = new Map<string, Promise<unknown>>();

/** Hono context carrying the worker's environment bindings. */
export type ApiContext = Context<{ Bindings: WorkerEnv }>;

/** Complete page and project context required by a page synchronization operation. */
export interface PageSyncInput {
  page: ProjectPage;
  project: Project;
  selectedParentPageId: string | undefined;
}

/** Project context required by a project synchronization operation. */
export interface ProjectSyncInput {
  project: Project;
  selectedParentPageId: string | undefined;
}

/** Incremental block operations plus their complete page synchronization context. */
export interface BlockOpsInput extends PageSyncInput {
  ops: ManagedBlockOperation[];
}

/** Active Notion installation credentials loaded for background work. */
interface InstallationTokens {
  id: Identifier;
  tokens: { access_token: string };
}

/** Common identity fields required by every page-oriented synchronization job. */
interface EnqueueJobBase {
  installationId: Identifier;
  localId: string;
  pageId: string;
  projectId: string;
}

/** Incremental block job before its server queue version is assigned. */
interface BlockEnqueueJob extends EnqueueJobBase {
  batchId: string;
  batchIndex: number;
  batchSize: number;
  payload: BlockQueuePayload;
  type: 'block_op';
}

/** Full-page job before its server queue version is assigned. */
interface PageEnqueueJob extends EnqueueJobBase {
  payload: PageQueuePayload;
  type: 'page';
}

/** Supported synchronization jobs accepted by the queue publisher. */
type EnqueueJob = BlockEnqueueJob | PageEnqueueJob;

// ─── Per-request singletons ────────────────────────────────────────────────────

/** Describes the root helpers contract used by this API feature. */
type RootHelpers = ReturnType<typeof createRootPageHelpers>;
/** Describes the database helpers contract used by this API feature. */
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

export {
  appendBlocksWithFallback,
  appendLog,
  appendManagedBlocks,
  applyBlockOpsToNotionForInstallation,
  applyManagedBlockOps,
  archiveProjectRootPage,
  archiveThreadToggle,
  auth,
  createChildPage,
  createWorkspacePage,
  deleteManagedBlock,
  ensureInkwellRootPage,
  ensureInkwellSyncStateRow,
  ensureProjectDatabase,
  ensureProjectPage,
  ensureProjectStateContainer,
  ensureThreadToggle,
  freshConnectedStore,
  freshConnectedStoreForInstallation,
  getInkwellSession,
  importManagedBlocks,
  initSingletons,
  enqueueSync,
  legacyQueueOperation,
  listAllBlockChildren,
  notionObjectExists,
  notionRequest,
  pageSummary,
  performSyncProjectFolder,
  pushPageToNotion,
  pushPageToNotionForInstallation,
  readInkwellSyncState,
  readStore,
  reloadProjectDatabaseFromNotion,
  replaceManagedBlocks,
  requireConnectedStore,
  requireInkwellSession,
  retrieveNotionPageOrBlock,
  supabase,
  syncProjectToNotion,
  syncProjectToNotionForInstallation,
  uncachePage,
  updateChildNotePage,
  updatePageTitle,
  updateThreadToggleTitle,
  validateNotionCache,
  withFreshInstallationStore,
  writeStore,
};
