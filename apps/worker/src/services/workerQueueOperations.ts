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
  SyncQueueReference,
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
    ensureJottathingRootPage,
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
  /** Persists a server-assigned revision and sends its normalized Queue message. */
  async function enqueueSync(
    env: WorkerEnv,
    job: EnqueueJob,
    batchVersion?: number,
  ): Promise<number> {
    let version = batchVersion;
    // `0` is the client's starting version, not a server-assigned revision.
    // Treat it like an omitted batch version so the first queue job always
    // creates a durable notion_block_sync row before publishing its reference.
    if (version === undefined || !Number.isSafeInteger(version) || version < 1) {
      const { data, error } = await supabase.rpc('increment_block_version', {
        p_installation_id: job.installationId,
        p_local_id: job.localId,
        p_entity_type: job.type,
      });
      const assignedVersion = Number(data);
      if (error || !Number.isSafeInteger(assignedVersion) || assignedVersion < 1) {
        throw new Error('Unable to assign a server sync version.');
      }
      version = assignedVersion;
    }

    const jobId = crypto.randomUUID();
    const message: SyncQueueMessage = { ...job, queuedVersion: version };
    const { error: payloadError } = await supabase
      .from('jottathing_sync_queue_payloads')
      .insert({
        id: jobId,
        installation_id: job.installationId,
        payload: message,
        status: 'pending',
      });
    if (payloadError) throw new Error('Unable to store the pending sync payload.');

    try {
      const reference: SyncQueueReference = { jobId };
      await env.SYNC_QUEUE.send(reference);
    } catch {
      // Keep the durable outbox payload. The extension retains its local
      // operations too, and can redrive this reference automatically later.
      const retryableMessage: SyncQueueMessage = {
        ...message,
        deliveryPendingAt: new Date().toISOString(),
      };
      await supabase
        .from('jottathing_sync_queue_payloads')
        .update({ payload: retryableMessage, updated_at: new Date().toISOString() })
        .eq('id', jobId)
        .eq('status', 'pending');
      throw new Error('Unable to publish the pending sync job.');
    }
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
    if (!installation) {
      throw Object.assign(new Error('Installation is no longer active.'), {
        code: 'installation_revoked',
      });
    }
    return freshConnectedStore({
      ...readStore(),
      installationId,
      tokens: installation.tokens,
    });
  }

  /** Revalidates credentials after acquiring the per-installation mutation lock. */
  async function withActiveInstallationStore<Result>(
    store: WorkerStore,
    operation: (freshStore: WorkerStore) => Promise<Result>,
  ): Promise<Result> {
    const installationId = store.installationId;
    return withFreshInstallationStore(store, async (freshStore) => {
      if (!installationId) throw new Error('Installation is no longer active.');
      const installation = await getInstallationById(installationId);
      if (!installation) {
        throw Object.assign(new Error('Installation is no longer active.'), {
          code: 'installation_revoked',
        });
      }
      return operation({ ...freshStore, tokens: installation.tokens });
    });
  }

  /** Pushes a page for a background installation. */
  async function pushPageToNotionForInstallation(
    installationId: Identifier,
    { page, project, selectedParentPageId }: PageSyncInput,
  ) {
    const store = await freshConnectedStoreForInstallation(installationId);
    return withActiveInstallationStore(store, (freshStore) =>
      pushPageCore({
        request: {},
        page,
        project,
        selectedParentPageId,
        dependencies: {
          appendLog,
          archiveThreadToggle,
          createChildPage,
          ensureJottathingRootPage,
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
    return withActiveInstallationStore(store, async (freshStore) => {
      let notionPageId: string;
      let parentPageId: string;
      let refreshed: NotionObject;

      if (ensureProjectPage && ensureThreadToggle) {
        const projectPage = await ensureProjectPage(freshStore, project, {
          isForcedMerge: page.content.attrs?.jottathingConflictResolution === true,
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
          page.syncBaselineContent,
        );
        page.content = normalizeSyncedMediaContent(content, replacement?.createdBlocks ?? []);
        page.syncBaselineContent = replacement?.baselineContent ?? page.syncBaselineContent;
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
        const jottathingRootPage = await ensureJottathingRootPage(freshStore, { selectedParentPageId });
        const projectRootPage = await ensureProjectRootPage(
          freshStore,
          jottathingRootPage.id,
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
          page.syncBaselineContent,
        );
        page.content = normalizeSyncedMediaContent(content, replacement?.createdBlocks ?? []);
        page.syncBaselineContent = replacement?.baselineContent ?? page.syncBaselineContent;
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
    return withActiveInstallationStore(store, (freshStore) =>
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
