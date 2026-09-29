/** @file Coordinates authenticated and queued page, block, and project synchronization. */
import type { Context } from 'hono';
import { pushPageToNotionCore, normalizeSyncedMediaContent } from '../pageSync.js';
import { createProjectDatabaseHelpers } from '../projectDatabase.js';
import { syncProjectFolder } from '../projectSync.js';
import { createRootPageHelpers } from '../rootPages.js';
import type {
  ConnectedWorkerStore,
  ManagedBlockOperation,
  ManagedBlockResult,
  NotionObject,
  NotionRequester,
  WorkerEnv,
  WorkerStore,
  WorkerSupabaseClient,
} from '../types.js';
import type { DocumentContent, Project, ProjectPage } from '../../../../src/types/capture.js';

type ApiContext = Context<{ Bindings: WorkerEnv }>;
type RootHelpers = ReturnType<typeof createRootPageHelpers>;
type DatabaseHelpers = ReturnType<typeof createProjectDatabaseHelpers>;

/** Full page and project context required for a page synchronization. */
export interface PageSyncInput {
  page: ProjectPage;
  project: Project;
  selectedParentPageId: string | undefined;
}

/** Project context required for a project synchronization. */
export interface ProjectSyncInput {
  project: Project;
  selectedParentPageId: string | undefined;
}

/** Incremental block operations plus their page and project context. */
export interface BlockOpsInput extends PageSyncInput {
  ops: ManagedBlockOperation[];
}

/** Services and Notion helpers required to run sync workflows. */
export interface WorkerSyncDependencies {
  appendLog: (store: WorkerStore, event: string, message: string) => void;
  applyManagedBlockOps: (
    store: WorkerStore,
    localPageId: string,
    notionPageId: string,
    ops: ManagedBlockOperation[],
    content: DocumentContent,
  ) => Promise<ManagedBlockResult>;
  archiveProjectRootPage: (store: WorkerStore, pageId: string) => Promise<NotionObject>;
  archiveThreadToggle: DatabaseHelpers['archiveThreadToggle'] | undefined;
  createChildPage: (
    store: WorkerStore,
    parentPageId: string,
    title: string,
  ) => Promise<NotionObject>;
  ensureInkwellRootPage: RootHelpers['ensureInkwellRootPage'];
  ensureProjectPage: DatabaseHelpers['ensureProjectPage'] | undefined;
  ensureProjectRootPage: RootHelpers['ensureProjectRootPage'];
  ensureThreadToggle: DatabaseHelpers['ensureThreadToggle'] | undefined;
  pageSummary: RootHelpers['pageSummary'];
  notionRequest: NotionRequester;
  pushPageToNotionCore: typeof pushPageToNotionCore;
  readStore: () => WorkerStore;
  replaceManagedBlocks: (
    store: WorkerStore,
    localPageId: string,
    notionPageId: string,
    content: DocumentContent,
  ) => Promise<ManagedBlockResult>;
  requireConnectedStore: (context: ApiContext) => Promise<ConnectedWorkerStore>;
  supabase: WorkerSupabaseClient;
  syncProjectFolder: typeof syncProjectFolder;
  updateChildNotePage: (
    store: WorkerStore,
    pageId: string,
    page: ProjectPage,
  ) => Promise<NotionObject>;
  updateThreadToggleTitle: DatabaseHelpers['updateThreadToggleTitle'] | undefined;
  withFreshInstallationStore: <Result>(
    store: WorkerStore,
    operation: (freshStore: WorkerStore) => Promise<Result>,
  ) => Promise<Result>;
  writeStore: (store: WorkerStore) => Promise<void>;
  freshConnectedStore: (store: WorkerStore) => Promise<WorkerStore>;
}

/** Creates the authenticated page and project synchronization operations. */
export function createWorkerSyncOperations(dependencies: WorkerSyncDependencies) {
  const {
    appendLog,
    archiveProjectRootPage,
    archiveThreadToggle,
    createChildPage,
    ensureInkwellRootPage,
    ensureProjectPage,
    ensureProjectRootPage,
    ensureThreadToggle,
    pageSummary,
    notionRequest,
    pushPageToNotionCore: pushPageCore,
    replaceManagedBlocks,
    requireConnectedStore,
    syncProjectFolder: syncFolder,
    updateChildNotePage,
    updateThreadToggleTitle,
    withFreshInstallationStore,
    writeStore,
  } = dependencies;

  /** Pushes a page from an authenticated HTTP request. */
  async function pushPageToNotion({
    c,
    page,
    project,
    selectedParentPageId,
  }: PageSyncInput & { c: ApiContext }) {
    const store = await requireConnectedStore(c);

    return withFreshInstallationStore(store, (freshStore) =>
      pushPageCore({
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

  /** Synchronizes a project folder against a refreshed installation state. */
  async function performSyncProjectFolder(
    freshStore: WorkerStore,
    { project, selectedParentPageId }: ProjectSyncInput,
  ) {
    const response = await syncFolder({
      store: freshStore,
      project,
      selectedParentPageId,
      ensureInkwellRootPage,
      ensureProjectPage,
      ensureProjectRootPage,
      archiveProjectRootPage,
      pageSummary,
    });
    appendLog(
      freshStore,
      project.status === 'archived' ? 'project_archived' : 'project_synced',
      project.name,
    );
    await writeStore(freshStore);
    return response;
  }

  /** Synchronizes a project from an authenticated HTTP request. */
  async function syncProjectToNotion({
    c,
    project,
    selectedParentPageId,
  }: ProjectSyncInput & { c: ApiContext }) {
    const store = await requireConnectedStore(c);
    return withFreshInstallationStore(store, (freshStore) =>
      performSyncProjectFolder(freshStore, { project, selectedParentPageId }),
    );
  }

  return {
    performSyncProjectFolder,
    pushPageToNotion,
    syncProjectToNotion,
  };
}
