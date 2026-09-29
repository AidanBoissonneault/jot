/**
 * @file Owns the initialized worker service graph, persisted synchronization state, and Notion mutation orchestration.
 * @author Aidan Boissonneault
 * @lastModified September 2026
 */

import type { Context } from 'hono';
import { createClient } from '@supabase/supabase-js';
import { createAuth } from '../auth.js';
import { notionBlocksToTiptapDocument, tiptapDocumentToNotionBlocks } from '../blockConversion.js';
import { createNotionRequester } from '../notionRequest.js';
import { createWorkerStorePersistence } from './workerStorePersistence.js';
import { pushPageToNotionCore } from '../pageSync.js';
import { createWorkerSyncOperations } from './workerSyncOperations.js';
import { createWorkerQueueOperations } from './workerQueueOperations.js';
import { createWorkerInstallationState } from './workerInstallationState.js';
import { createWorkerNotionOperations } from './workerNotionOperations.js';
import type { BlockOpsInput, PageSyncInput, ProjectSyncInput } from './workerSyncOperations.js';
import type { EnqueueJob } from './workerQueueOperations.js';
import { createProjectDatabaseHelpers, projectStateKey, threadKey } from '../projectDatabase.js';
import { syncProjectFolder } from '../projectSync.js';
import { createRootPageHelpers } from '../rootPages.js';
import { isNotionObjectNotFound, titleFromPage } from '../workerUtils.js';
import type { BlockPosition } from '../workerUtils.js';
import type { AuthService, AuthSessionResult } from '../auth.js';
import type {
  ConnectedWorkerStore,
  BlockQueuePayload,
  Identifier,
  ManagedBlockOperation,
  NotionBlock,
  NotionBlockPayload,
  NotionObject,
  NotionRequester,
  WorkerEnv,
  WorkerStore,
  WorkerSupabaseClient,
} from '../types.js';
import type { DocumentContent, Project, ProjectPage } from '../../../../src/types/capture.js';

export const INKWELL_SESSION_COOKIE = 'inkwell_session';

export type { BlockOpsInput, PageSyncInput, ProjectSyncInput } from './workerSyncOperations.js';
export type { EnqueueJob } from './workerQueueOperations.js';

/** Hono context carrying the worker's environment bindings. */
export type ApiContext = Context<{ Bindings: WorkerEnv }>;

// ─── Per-request singletons ────────────────────────────────────────────────────

/** Describes the root helpers contract used by this API feature. */
type RootHelpers = ReturnType<typeof createRootPageHelpers>;
/** Describes the database helpers contract used by this API feature. */
type DatabaseHelpers = ReturnType<typeof createProjectDatabaseHelpers>;

let supabase: WorkerSupabaseClient;
let auth: AuthService;
let notionRequest: NotionRequester;
let workerStorePersistence: ReturnType<typeof createWorkerStorePersistence>;
let workerSyncOperations: ReturnType<typeof createWorkerSyncOperations>;
let workerQueueOperations: ReturnType<typeof createWorkerQueueOperations>;
let workerInstallationState: ReturnType<typeof createWorkerInstallationState>;
let workerNotionOperations: ReturnType<typeof createWorkerNotionOperations>;
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
  workerStorePersistence = createWorkerStorePersistence(supabase);
  auth = createAuth(supabase);
  workerInstallationState = createWorkerInstallationState({
    auth,
    cookieName: INKWELL_SESSION_COOKIE,
    readInkwellSyncState,
    readStore,
  });

  const NOTION_VERSION = env.NOTION_VERSION ?? '2026-03-11';
  const INKWELL_ROOT_PAGE_TITLE = env.INKWELL_ROOT_PAGE_TITLE ?? 'Inkwell';

  notionRequest = createNotionRequester({ notionVersion: NOTION_VERSION });
  workerNotionOperations = createWorkerNotionOperations({
    appendLog,
    notionRequest,
  });

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
    importManagedBlocks: (store, page, blocks) =>
      workerNotionOperations.importManagedBlocks(store, page, blocks),
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

  const syncDependencies = {
    appendLog,
    applyManagedBlockOps,
    archiveProjectRootPage,
    archiveThreadToggle,
    createChildPage,
    ensureInkwellRootPage,
    ensureProjectPage,
    ensureProjectRootPage,
    ensureThreadToggle,
    pageSummary,
    notionRequest,
    pushPageToNotionCore,
    readStore,
    replaceManagedBlocks,
    requireConnectedStore,
    supabase,
    syncProjectFolder,
    updateChildNotePage,
    updateThreadToggleTitle,
    withFreshInstallationStore,
    writeStore,
    freshConnectedStore,
  };
  workerSyncOperations = createWorkerSyncOperations(syncDependencies);
  workerQueueOperations = createWorkerQueueOperations({
    ...syncDependencies,
    performSyncProjectFolder: workerSyncOperations.performSyncProjectFolder,
  });
}

// ─── Sync handlers ─────────────────────────────────────────────────────────────

/** Pushes a page from an authenticated HTTP request. */
function pushPageToNotion(input: PageSyncInput & { c: ApiContext }) {
  return workerSyncOperations.pushPageToNotion(input);
}

/** Synchronizes a project with its selected Notion parent. */
function syncProjectToNotion(input: ProjectSyncInput & { c: ApiContext }) {
  return workerSyncOperations.syncProjectToNotion(input);
}

/** Synchronizes a project folder with a refreshed installation state. */
function performSyncProjectFolder(store: WorkerStore, input: ProjectSyncInput) {
  return workerSyncOperations.performSyncProjectFolder(store, input);
}

/** Enqueues a page or block synchronization job. */
function enqueueSync(env: WorkerEnv, job: EnqueueJob, clientVersion = 0): Promise<number> {
  return workerQueueOperations.enqueueSync(env, job, clientVersion);
}

/** Loads fresh state and credentials for a queued installation. */
function freshConnectedStoreForInstallation(installationId: Identifier): Promise<WorkerStore> {
  return workerQueueOperations.freshConnectedStoreForInstallation(installationId);
}

/** Pushes a page from a background installation job. */
function pushPageToNotionForInstallation(installationId: Identifier, input: PageSyncInput) {
  return workerQueueOperations.pushPageToNotionForInstallation(installationId, input);
}

/** Applies queued block operations for one installation. */
function applyBlockOpsToNotionForInstallation(installationId: Identifier, input: BlockOpsInput) {
  return workerQueueOperations.applyBlockOpsToNotionForInstallation(installationId, input);
}

/** Synchronizes a project for a background installation job. */
function syncProjectToNotionForInstallation(installationId: Identifier, input: ProjectSyncInput) {
  return workerQueueOperations.syncProjectToNotionForInstallation(installationId, input);
}

/** Reads the single-operation property from legacy Queue messages. */
function legacyQueueOperation(payload: BlockQueuePayload): ManagedBlockOperation | undefined {
  return workerQueueOperations.legacyQueueOperation(payload);
}
/** Creates an empty normalized worker store. @returns Empty normalized state. */
function readStore(): WorkerStore {
  return workerStorePersistence.readStore();
}

/** Persists normalized state for its connected installation. @param store - Worker state. @returns Completion after persistence. */
function writeStore(store: WorkerStore): Promise<void> {
  return workerStorePersistence.writeStore(store);
}

/** Appends a bounded diagnostic event to worker state. @param store - Worker state. @param event - Event code. @param message - Human-readable detail. @returns Nothing. */
function appendLog(store: WorkerStore, event: string, message: string): void {
  workerStorePersistence.appendLog(store, event, message);
}
/** Resolves authenticated installation state for an API request. */
function requireConnectedStore(c: ApiContext): Promise<ConnectedWorkerStore> {
  return workerInstallationState.requireConnectedStore(c);
}

/** Reloads state under an installation lock before executing a mutation. */
function withFreshInstallationStore<Result>(
  store: WorkerStore,
  operation: (freshStore: WorkerStore) => Promise<Result>,
): Promise<Result> {
  return workerInstallationState.withFreshInstallationStore(store, operation);
}

/** Reloads persisted installation state while preserving active credentials. */
function freshConnectedStore(store: WorkerStore): Promise<WorkerStore> {
  return workerInstallationState.freshConnectedStore(store);
}

/** Reads the current application session cookie. */
function getInkwellSession(c: ApiContext): Promise<AuthSessionResult | null> {
  return workerInstallationState.getInkwellSession(c);
}

/** Requires a valid application session or responds with an unauthorized status. */
function requireInkwellSession(c: ApiContext): Promise<AuthSessionResult | null> {
  return workerInstallationState.requireInkwellSession(c);
}
/** Ensures persisted synchronization state exists. @param installationId - Installation identifier. @returns Completion after upsert. */
function ensureInkwellSyncStateRow(installationId: Identifier): Promise<void> {
  return workerStorePersistence.ensureInkwellSyncStateRow(installationId);
}

/** Loads and normalizes persisted synchronization state. @param installationId - Installation identifier. @returns Normalized state. */
function readInkwellSyncState(installationId: Identifier): Promise<WorkerStore> {
  return workerStorePersistence.readInkwellSyncState(installationId);
}

/** Serializes worker state into the persistence row. @param installationId - Installation identifier. @param store - Normalized state. @returns Completion after persistence. */
function writeInkwellSyncState(installationId: Identifier, store: WorkerStore): Promise<void> {
  return workerStorePersistence.writeInkwellSyncState(installationId, store);
}
/** Checks and clears stale cached Notion mappings. */
function validateNotionCache(
  store: WorkerStore,
  entities: { pages: ProjectPage[]; projects: Project[] },
) {
  return workerNotionOperations.validateNotionCache(store, entities);
}

/** Removes all cached Notion records associated with a local page. */
function uncachePage(store: WorkerStore, pageId: string): void {
  workerNotionOperations.uncachePage(store, pageId);
}

/** Checks whether a Notion page, block, or database still exists. */
function notionObjectExists(
  store: WorkerStore,
  kind: 'block' | 'database' | 'page',
  id: string,
): Promise<boolean> {
  return workerNotionOperations.notionObjectExists(store, kind, id);
}

/** Retrieves a linked page, falling back to the block endpoint for threads. */
function retrieveNotionPageOrBlock(store: WorkerStore, page: ProjectPage): Promise<NotionObject> {
  return workerNotionOperations.retrieveNotionPageOrBlock(store, page);
}

/** Replaces managed children and updates local block mappings. */
function replaceManagedBlocks(
  store: WorkerStore,
  localPageId: string,
  notionPageId: string,
  content: DocumentContent,
) {
  return workerNotionOperations.replaceManagedBlocks(store, localPageId, notionPageId, content);
}

/** Applies incremental managed-block changes. */
function applyManagedBlockOps(
  store: WorkerStore,
  localPageId: string,
  notionPageId: string,
  ops: ManagedBlockOperation[],
  content: DocumentContent,
) {
  return workerNotionOperations.applyManagedBlockOps(
    store,
    localPageId,
    notionPageId,
    ops,
    content,
  );
}

/** Imports supported remote child blocks for a linked page. */
function importManagedBlocks(
  store: WorkerStore,
  page: ProjectPage,
): Promise<DocumentContent | null> {
  return workerNotionOperations.importManagedBlocks(store, page);
}

/** Lists every paginated child block beneath a Notion object. */
function listAllBlockChildren(store: WorkerStore, blockId: string): Promise<NotionBlock[]> {
  return workerNotionOperations.listAllBlockChildren(store, blockId);
}

/** Creates a child page beneath a Notion page. */
function createChildPage(
  store: WorkerStore,
  parentPageId: string,
  title: string,
): Promise<NotionObject> {
  return workerNotionOperations.createChildPage(store, parentPageId, title);
}

/** Creates a top-level workspace page. */
function createWorkspacePage(store: WorkerStore, title: string): Promise<NotionObject> {
  return workerNotionOperations.createWorkspacePage(store, title);
}

/** Updates a Notion page title. */
function updatePageTitle(store: WorkerStore, pageId: string, title: string): Promise<NotionObject> {
  return workerNotionOperations.updatePageTitle(store, pageId, title);
}

/** Updates a linked note page title and archive state. */
function updateChildNotePage(
  store: WorkerStore,
  pageId: string,
  page: ProjectPage,
): Promise<NotionObject> {
  return workerNotionOperations.updateChildNotePage(store, pageId, page);
}

/** Archives a legacy project root page. */
function archiveProjectRootPage(store: WorkerStore, pageId: string): Promise<NotionObject> {
  return workerNotionOperations.archiveProjectRootPage(store, pageId);
}

/** Deletes a managed Notion block. */
function deleteManagedBlock(store: WorkerStore, blockId: string): Promise<NotionObject> {
  return workerNotionOperations.deleteManagedBlock(store, blockId);
}

/** Updates a managed Notion block in place. */
function updateManagedBlock(
  store: WorkerStore,
  blockId: string,
  notionBlock: NotionBlockPayload,
): Promise<NotionObject> {
  return workerNotionOperations.updateManagedBlock(store, blockId, notionBlock);
}

/** Appends managed blocks in API-sized batches. */
function appendManagedBlocks(
  store: WorkerStore,
  notionPageId: string,
  notionBlocks: NotionBlockPayload[],
  position?: BlockPosition,
): Promise<NotionBlock[]> {
  return workerNotionOperations.appendManagedBlocks(store, notionPageId, notionBlocks, position);
}

/** Appends blocks individually and substitutes unsupported media. */
function appendBlocksWithFallback(
  store: WorkerStore,
  notionPageId: string,
  blocks: NotionBlockPayload[],
  position?: BlockPosition,
): Promise<NotionBlock[]> {
  return workerNotionOperations.appendBlocksWithFallback(store, notionPageId, blocks, position);
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
