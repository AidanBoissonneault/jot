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
  ManagedBlockOperation,
  NotionObject,
  SyncQueueMessage,
  SyncQueueReference,
  WorkerEnv,
  WorkerStore,
} from '../types.js';
import type { DocumentContent } from '../../../../src/types/capture.js';
import { requireActiveSiblingPage } from '../pageArchiveInvariant.js';
import {
  isArchivedBlockEditError,
  reactivateProjectForNewerPageEdit,
  threadKey,
} from '../projectDatabaseValues.js';
import { notionBlockIdFromError, safeNotionErrorMetadata } from '../workerUtils.js';

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
    ensureProjectPage,
    ensureThreadToggle,
    notionRequest,
    pushPageToNotionCore: pushPageCore,
    readStore,
    replaceManagedBlocks,
    supabase,
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
          ensureProjectPage,
          ensureThreadToggle,
          notionRequest,
          replaceManagedBlocks,
          requireConnectedStore: async () => freshStore,
          updateThreadToggleTitle,
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

      const projectRecovery = reactivateProjectForNewerPageEdit(
        project,
        page,
        ops.filter((op) => op.type !== 'page_archive').map((op) => op.createdAt),
      );
      const projectForPageSync = projectRecovery.project;
      if (projectRecovery.reactivated) {
        appendLog(
          freshStore,
          'sync_project_restored_after_page_edit',
          'Restored an archived project after a newer local page edit.',
        );
      }

      let projectPage: Awaited<ReturnType<typeof ensureProjectPage>>;
      try {
        projectPage = await ensureProjectPage(freshStore, projectForPageSync, {
          isForcedMerge: page.content.attrs?.jottathingConflictResolution === true,
          selectedParentPageId,
          syncState: false,
        });
      } catch (error) {
        console.error('[queue] project row preparation failed before page sync', {
          failureTarget: knownArchivedWriteTarget(
            error,
            freshStore,
            projectForPageSync.id,
            page.id,
            selectedParentPageId,
          ),
          error: safeNotionErrorMetadata(error),
        });
        throw error;
      }
      if (page.status === 'archived' || ops.some((op) => op.type === 'page_archive')) {
        requireActiveSiblingPage(freshStore, page, projectPage.id);
        await archiveThreadToggle?.(freshStore, page);
        appendLog(freshStore, 'sync_thread_archived', page.title);
        await writeStore(freshStore);
        return { page: { ...page, notionParentPageId: projectPage.id, syncState: 'saved' } };
      }

      const content = syncContentForOps(ops, page.content);
      let toggle: NotionObject;
      let replacement: Awaited<ReturnType<typeof applyManagedBlockOps>>;
      try {
        toggle = await ensureThreadToggle(freshStore, projectPage.id, page);
        await updateThreadToggleTitle?.(freshStore, page);
        replacement = await applyManagedBlockOps(
          freshStore,
          page.id,
          toggle.id,
          ops,
          content,
          page.syncBaselineContent,
        );
      } catch (error) {
        const isArchivedWrite = isArchivedBlockEditError(error);
        console.log('[queue] block operation write failed', {
          classifiedArchivedBlock: isArchivedWrite,
          projectArchived: projectForPageSync.status === 'archived',
          restoredAfterNewerPageEdit: projectRecovery.reactivated,
          error: safeNotionErrorMetadata(error),
        });
        if (!isArchivedWrite || projectForPageSync.status === 'archived') throw error;
        const mappedToggleId = freshStore.threadBlocks?.[threadKey(page.id)]?.blockId;
        const failedBlockId = notionBlockIdFromError(error);
        const excludedBlockIds = failedBlockId && failedBlockId === mappedToggleId
          ? new Set([failedBlockId])
          : undefined;
        const initialFailureTarget = archivedWriteTarget(error, projectPage.id, mappedToggleId);
        console.log('[queue] archived Notion write recovery started', {
          failureTarget: initialFailureTarget,
          rejectedThreadToggle: Boolean(excludedBlockIds?.size),
        });
        freshStore.threadBlocks ??= {};
        freshStore.blockMappings ??= {};
        delete freshStore.threadBlocks[threadKey(page.id)];
        // The archived child IDs cannot be edited. Keep the latest durable
        // page snapshot and rebuild it under a fresh active thread toggle.
        delete freshStore.blockMappings[page.id];
        appendLog(freshStore, 'sync_thread_container_repaired', 'Replaced an archived Notion thread container.');
        const originalProjectPageId = projectPage.id;
        let recoveryProjectPageId = projectPage.id;
        let recoveryThreadToggleId: string | undefined;
        try {
          projectPage = await ensureProjectPage(freshStore, projectForPageSync, {
            selectedParentPageId,
            syncState: false,
          });
          recoveryProjectPageId = projectPage.id;
          toggle = await ensureThreadToggle(freshStore, projectPage.id, page, {
            excludedBlockIds,
          });
          recoveryThreadToggleId = toggle.id;
          await updateThreadToggleTitle?.(freshStore, page);
          replacement = await replaceManagedBlocks(freshStore, page.id, toggle.id, content);
        } catch (recoveryError) {
          console.error('[queue] archived Notion write recovery failed', {
            failureTarget: initialFailureTarget,
            recoveryFailureTarget: archivedWriteTarget(
              recoveryError,
              recoveryProjectPageId,
              recoveryThreadToggleId,
            ),
            error: safeNotionErrorMetadata(recoveryError),
          });
          throw recoveryError;
        }
        console.log('[queue] archived Notion write recovery completed', {
          failureTarget: initialFailureTarget,
          projectRowReplaced: recoveryProjectPageId !== originalProjectPageId,
          threadToggleReplaced: Boolean(excludedBlockIds?.size) && recoveryThreadToggleId !== failedBlockId,
        });
      }
      notionPageId = toggle.id;
      parentPageId = projectPage.id;
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

/** Classifies a failed archived block write without logging the block identifier. */
function archivedWriteTarget(
  error: unknown,
  projectPageId: string,
  threadToggleId: string | undefined,
): 'project_row' | 'thread_toggle' | 'other_block' | 'unknown' {
  const failedBlockId = notionBlockIdFromError(error);
  if (!failedBlockId) return 'unknown';
  if (failedBlockId === projectPageId) return 'project_row';
  if (failedBlockId === threadToggleId) return 'thread_toggle';
  return 'other_block';
}

/** Classifies a failed block write against known workspace mappings without logging IDs. */
function knownArchivedWriteTarget(
  error: unknown,
  store: WorkerStore,
  projectId: string,
  pageId: string,
  selectedParentPageId: string | undefined,
): 'workspace_root' | 'selected_parent' | 'project_database' | 'project_row' | 'thread_toggle' | 'other_block' | 'unknown' {
  const failedBlockId = notionBlockIdFromError(error);
  if (!failedBlockId) return 'unknown';
  if (failedBlockId === store.jottathingRootPage?.id) return 'workspace_root';
  if (failedBlockId === selectedParentPageId) return 'selected_parent';
  if (
    failedBlockId === store.jottathingDatabase?.databaseId ||
    failedBlockId === store.jottathingDatabase?.dataSourceId
  ) return 'project_database';
  if (failedBlockId === store.projectPages?.[projectId]?.notionPageId) return 'project_row';
  if (failedBlockId === store.threadBlocks?.[threadKey(pageId)]?.blockId) return 'thread_toggle';
  return 'other_block';
}
