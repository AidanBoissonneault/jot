/** @file Publishes sync work to Cloudflare Queue and applies background Notion updates. */
import { normalizeSyncedMediaContent } from '../pageSync.js';
import type {
  BlockOpsInput,
  PageSyncInput,
  ProjectSyncInput,
  WorkerSyncDependencies,
} from './workerSyncOperations.js';
import type {
  BlockQueuePayload,
  Identifier,
  JsonObject,
  ManagedBlockOperation,
  NotionObject,
  SyncQueueMessage,
  WorkerEnv,
  WorkerStore,
} from '../types.js';
import type { DocumentContent } from '../../../../src/types/capture.js';

/** Queue job before the server assigns its persisted version. */
export type EnqueueJob =
  | {
      installationId: Identifier;
      localId: string;
      pageId: string;
      projectId: string;
      batchId: string;
      batchIndex: number;
      batchSize: number;
      payload: BlockQueuePayload;
      type: 'block_op';
    }
  | {
      installationId: Identifier;
      localId: string;
      pageId: string;
      projectId: string;
      payload: Extract<SyncQueueMessage, { type: 'page' }>['payload'];
      type: 'page';
    };

interface WorkerQueueDependencies extends WorkerSyncDependencies {
  performSyncProjectFolder: (store: WorkerStore, input: ProjectSyncInput) => Promise<unknown>;
}

/** Creates queue publishing and background synchronization operations. */
export function createWorkerQueueOperations(dependencies: WorkerQueueDependencies) {
  const {
    appendLog,
    applyManagedBlockOps,
    archiveThreadToggle,
    createChildPage,
    ensureInkwellRootPage,
    ensureProjectPage,
    ensureProjectRootPage,
    ensureThreadToggle,
    notionRequest,
    pushPageToNotionCore: pushPageCore,
    readStore,
    replaceManagedBlocks,
    supabase,
    updateChildNotePage,
    updateThreadToggleTitle,
    withFreshInstallationStore,
    writeStore,
    freshConnectedStore,
    performSyncProjectFolder,
  } = dependencies;
  /** Persists a pending version and sends its normalized Queue message. */
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

    const message: SyncQueueMessage = { ...job, queuedVersion: version };
    await env.SYNC_QUEUE.send(message);
    return version;
  }

  /** Loads an active installation and its Notion token. */
  async function getInstallationById(installationId: Identifier) {
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

  /** Builds fresh normalized state for a queued installation. */
  async function freshConnectedStoreForInstallation(
    installationId: Identifier,
  ): Promise<WorkerStore> {
    const installation = await getInstallationById(installationId);
    if (!installation) throw new Error('Installation not found or revoked.');
    return freshConnectedStore({
      ...readStore(),
      installationId,
      tokens: installation.tokens,
    });
  }

  /** Pushes a page for a background installation. */
  async function pushPageToNotionForInstallation(
    installationId: Identifier,
    { page, project, selectedParentPageId }: PageSyncInput,
  ) {
    const store = await freshConnectedStoreForInstallation(installationId);
    return withFreshInstallationStore(store, (freshStore) =>
      pushPageCore({
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

  /** Applies queued block operations for one installation. */
  async function applyBlockOpsToNotionForInstallation(
    installationId: Identifier,
    { ops, page, project, selectedParentPageId }: BlockOpsInput,
  ) {
    const store = await freshConnectedStoreForInstallation(installationId);
    return withFreshInstallationStore(store, async (freshStore) => {
      let notionPageId: string;
      let parentPageId: string;
      let refreshed: NotionObject;

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
        const replacement = await applyManagedBlockOps(
          freshStore,
          page.id,
          notionPageId,
          ops,
          content,
        );
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
        const projectRootPage = await ensureProjectRootPage(
          freshStore,
          inkwellRootPage.id,
          project,
          { candidateNotionPageId: page.notionParentPageId },
        );
        const existingPageId = page.notionPageId ?? freshStore.notePages[page.id]?.notionPageId;
        const existingPage = existingPageId
          ? await notionRequest(freshStore, `/pages/${existingPageId}`).catch(() => undefined)
          : undefined;
        const notePage =
          existingPage ?? (await createChildPage(freshStore, projectRootPage.id, page.title));
        await updateChildNotePage(freshStore, notePage.id, page);
        notionPageId = notePage.id;
        parentPageId = projectRootPage.id;
        const content = syncContentForOps(ops, page.content);
        const replacement = await applyManagedBlockOps(
          freshStore,
          page.id,
          notionPageId,
          ops,
          content,
        );
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
          notionLastEditedTime: refreshed.last_edited_time,
          remoteRevision: refreshed.last_edited_time,
          syncState: 'saved',
        },
        status: 'saved',
        message: 'Synced block changes to Notion.',
      };
    });
  }

  /** Synchronizes a project for a background installation. */
  async function syncProjectToNotionForInstallation(
    installationId: Identifier,
    { project, selectedParentPageId }: ProjectSyncInput,
  ) {
    const store = await freshConnectedStoreForInstallation(installationId);
    return withFreshInstallationStore(store, (freshStore) =>
      performSyncProjectFolder(freshStore, { project, selectedParentPageId }),
    );
  }

  return {
    applyBlockOpsToNotionForInstallation,
    enqueueSync,
    freshConnectedStoreForInstallation,
    pushPageToNotionForInstallation,
    syncProjectToNotionForInstallation,
    legacyQueueOperation,
  };
}
/** Uses the most recent replacement document in a job or falls back to stored content. */
function syncContentForOps(
  ops: ManagedBlockOperation[],
  legacyContent: DocumentContent,
): DocumentContent {
  if (legacyContent?.content?.length) return legacyContent;
  const blocks = ops
    .filter((op) => op.type === 'block_create' && op.payload?.block)
    .sort((first, second) => (first.payload.index ?? 0) - (second.payload.index ?? 0))
    .map((op) => op.payload.block)
    .filter((block): block is DocumentContent => Boolean(block));
  return blocks.length ? { type: 'doc', content: blocks } : legacyContent;
}

/** Reads the single-operation property from legacy Queue messages. */
function legacyQueueOperation(payload: BlockQueuePayload): ManagedBlockOperation | undefined {
  const operation: unknown = (payload as unknown as JsonObject).op;
  if (!operation || typeof operation !== 'object' || Array.isArray(operation)) return undefined;
  const candidate = operation as JsonObject;
  if (
    typeof candidate.type !== 'string' ||
    !candidate.payload ||
    typeof candidate.payload !== 'object'
  ) {
    return undefined;
  }
  return operation as ManagedBlockOperation;
}
