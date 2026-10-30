/**
 * @file Synchronizes project-database thread toggles and recovers archived containers.
 * @author Aidan Boissonneault
 * @lastModified September 2026
 */

import type { DocumentContent, Project, ProjectPage } from '../../../src/types/capture.js';
import { requireActiveSiblingPage } from './pageArchiveInvariant.js';
import {
  isArchivedBlockEditError,
  reactivateProjectForNewerPageEdit,
  threadKey,
} from './projectDatabaseValues.js';
import type {
  AppendLog,
  ManagedBlockResult,
  NotionObject,
  NotionRequester,
  WorkerStore,
} from './types.js';
import { notionBlockIdFromError } from './workerUtils.js';

/** Describes the project page result contract used by this API feature. */
interface ProjectPageResult {
  id: string;
  project: Project;
  title: string;
  url?: string;
}

/** Describes the page sync dependencies contract used by this API feature. */
interface PageSyncDependencies {
  appendLog: AppendLog;
  archiveThreadToggle: ((store: WorkerStore, page: ProjectPage) => Promise<void>) | undefined;
  ensureProjectPage: (
    store: WorkerStore,
    project: Project,
    options: { isForcedMerge?: boolean; selectedParentPageId: string | undefined; syncState?: boolean },
  ) => Promise<ProjectPageResult>;
  ensureThreadToggle: (
    store: WorkerStore,
    projectPageId: string,
    page: ProjectPage,
    options?: { excludedBlockIds?: ReadonlySet<string> },
  ) => Promise<NotionObject>;
  notionRequest: NotionRequester;
  replaceManagedBlocks: (
    store: WorkerStore,
    localPageId: string,
    notionPageId: string,
    content: DocumentContent,
    baselineContent?: DocumentContent,
  ) => Promise<ManagedBlockResult>;
  requireConnectedStore: (request: unknown) => Promise<WorkerStore>;
  updateThreadToggleTitle: ((store: WorkerStore, page: ProjectPage) => Promise<void>) | undefined;
  writeStore: (store: WorkerStore) => Promise<void>;
}

/** Describes the push page options contract used by this API feature. */
interface PushPageOptions {
  dependencies: PageSyncDependencies;
  page: ProjectPage;
  project: Project;
  request: unknown;
  selectedParentPageId: string | undefined;
}

/** Database and thread-toggle dependencies for pushing one page. */
interface ProjectDatabasePushOptions {
  appendLog: AppendLog;
  archiveThreadToggle: ((store: WorkerStore, page: ProjectPage) => Promise<void>) | undefined;
  ensureProjectPage: NonNullable<PageSyncDependencies['ensureProjectPage']>;
  ensureThreadToggle: NonNullable<PageSyncDependencies['ensureThreadToggle']>;
  notionRequest: NotionRequester;
  page: ProjectPage;
  project: Project;
  replaceManagedBlocks: PageSyncDependencies['replaceManagedBlocks'];
  selectedParentPageId: string | undefined;
  store: WorkerStore;
  updateThreadToggleTitle: PageSyncDependencies['updateThreadToggleTitle'];
  writeStore: PageSyncDependencies['writeStore'];
}

/**
 * Pushes a local page through its project's Notion database row and thread toggle.
 * @param options - Request context, page/project data, parent selection, and dependencies.
 * @returns The synchronization result and updated page metadata.
 */
export async function pushPageToNotionCore({
  request,
  page,
  project,
  selectedParentPageId,
  dependencies,
}: PushPageOptions) {
  const {
    archiveThreadToggle,
    appendLog,
    ensureProjectPage,
    ensureThreadToggle,
    notionRequest,
    replaceManagedBlocks,
    requireConnectedStore,
    updateThreadToggleTitle,
    writeStore,
  } = dependencies;
  const store = await requireConnectedStore(request);
  const projectRecovery = reactivateProjectForNewerPageEdit(project, page);
  const projectForPageSync = projectRecovery.project;
  if (projectRecovery.reactivated) {
    appendLog(
      store,
      'sync_project_restored_after_page_edit',
      'Restored an archived project after a newer local page edit.',
    );
  }

  return pushPageToProjectDatabase({
    appendLog,
    archiveThreadToggle,
    ensureProjectPage,
    ensureThreadToggle,
    notionRequest,
    page,
    project: projectForPageSync,
    replaceManagedBlocks,
    selectedParentPageId,
    store,
    updateThreadToggleTitle,
    writeStore,
  });
}

/**
 * Pushes a local page into its project's Notion toggle block.
 * @param options - Project-database dependencies and local page state.
 * @returns The synchronization result and updated thread metadata.
 */
async function pushPageToProjectDatabase({
  appendLog,
  archiveThreadToggle,
  ensureProjectPage,
  ensureThreadToggle,
  notionRequest,
  page,
  project,
  replaceManagedBlocks,
  selectedParentPageId,
  store,
  updateThreadToggleTitle,
  writeStore,
}: ProjectDatabasePushOptions) {
  const isForcedMerge = page.content.attrs?.jottathingConflictResolution === true;
  // Page writes must not trigger the separate project-state conflict check.
  let projectPage = await ensureProjectPage(store, project, {
    isForcedMerge,
    selectedParentPageId,
    syncState: false,
  });

  if (page.status === 'archived') {
    requireActiveSiblingPage(store, page, projectPage.id);
    await archiveThreadToggle?.(store, page);
    store.notePages[page.id] = {
      archived: true,
      dataSourceId: store.notePages[page.id]?.dataSourceId,
      kind: store.notePages[page.id]?.kind,
      lastEditedTime: store.notePages[page.id]?.lastEditedTime,
      notionPageId: store.notePages[page.id]?.notionPageId ?? page.notionPageId,
      parentPageId: projectPage.id,
      title: page.title,
    };
    appendLog(store, 'sync_thread_archived', page.title);
    await writeStore(store);
    return {
      projectPage,
      page: {
        ...page,
        notionParentPageId: projectPage.id,
        syncState: 'saved',
      },
      status: 'saved',
      message: 'Archived thread in Notion.',
    };
  }

  let toggle: NotionObject;
  let recoveredArchivedContainer = false;
  try {
    toggle = await ensureThreadToggle(store, projectPage.id, page);
  } catch (error) {
    if (!isArchivedBlockEditError(error) || project.status === 'archived') throw error;
    ({ projectPage, toggle } = await recoverArchivedThreadContainer(error));
    recoveredArchivedContainer = true;
  }
  const isUserReviewedReplacement = page.content.attrs?.jottathingConflictResolution === true;

  if (
    !recoveredArchivedContainer &&
    !isUserReviewedReplacement &&
    !page.syncBaselineContent &&
    toggle?.last_edited_time &&
    page.remoteRevision &&
    toggle.last_edited_time !== page.remoteRevision
  ) {
    appendLog(store, 'sync_stale', `${page.title} changed in Notion.`);
    await writeStore(store);
    return {
      projectPage,
      page: {
        ...page,
        notionPageId: toggle.id,
        notionDatabaseId: undefined,
        notionDataSourceId: undefined,
        notionParentPageId: projectPage.id,
        notionLastEditedTime: toggle.last_edited_time,
        remoteRevision: toggle.last_edited_time,
      },
      status: 'stale',
      message: 'This thread changed in Notion. Pull or review it before saving over it.',
    };
  }

  let replacement: ManagedBlockResult;
  try {
    await updateThreadToggleTitle?.(store, page);
    replacement = await replaceManagedBlocks(
      store,
      page.id,
      toggle.id,
      page.content,
      page.syncBaselineContent,
    );
  } catch (error) {
    if (!isArchivedBlockEditError(error) || project.status === 'archived') throw error;
    ({ projectPage, toggle } = await recoverArchivedThreadContainer(error));
    await updateThreadToggleTitle?.(store, page);
    replacement = await replaceManagedBlocks(
      store,
      page.id,
      toggle.id,
      page.content,
      page.syncBaselineContent,
    );
  }
  const refreshedBlock = await notionRequest(store, `/blocks/${toggle.id}`).catch(() => toggle);
  const syncedContent = normalizeSyncedMediaContent(
    replacement?.content ?? page.content,
    replacement?.createdBlocks ?? [],
  );
  const syncedPage = {
    ...page,
    content: syncedContent,
    syncBaselineContent: syncedContent,
    notionPageId: toggle.id,
    notionDatabaseId: undefined,
    notionDataSourceId: undefined,
    notionParentPageId: projectPage.id,
    notionLastEditedTime: refreshedBlock.last_edited_time,
    remoteRevision: refreshedBlock.last_edited_time,
    syncState: 'saved',
  };

  store.notePages[page.id] = {
    archived: false,
    dataSourceId: undefined,
    notionPageId: toggle.id,
    parentPageId: projectPage.id,
    title: page.title,
    lastEditedTime: refreshedBlock.last_edited_time,
    kind: 'thread',
  };
  appendLog(store, 'sync_thread_push', page.title);
  await writeStore(store);

  return {
    projectPage,
    page: syncedPage,
    status: 'saved',
    message: 'Synced thread to Notion.',
  };

  async function recoverArchivedThreadContainer(error: unknown) {
    const mappedToggleId = store.threadBlocks?.[threadKey(page.id)]?.blockId;
    const failedBlockId = notionBlockIdFromError(error);
    const excludedBlockIds = failedBlockId && failedBlockId === mappedToggleId
      ? new Set([failedBlockId])
      : undefined;
    store.threadBlocks ??= {};
    store.blockMappings ??= {};
    delete store.threadBlocks[threadKey(page.id)];
    // Rebuild child mappings from the local snapshot in a fresh, active
    // toggle. The archived Notion copy remains intact in trash for recovery.
    delete store.blockMappings[page.id];
    appendLog(store, 'sync_thread_container_repaired', 'Replaced an archived Notion thread container.');
    const refreshedProjectPage = await ensureProjectPage(store, project, {
      selectedParentPageId,
      syncState: false,
    });
    const refreshedToggle = await ensureThreadToggle(store, refreshedProjectPage.id, page, {
      excludedBlockIds,
    });
    return { projectPage: refreshedProjectPage, toggle: refreshedToggle };
  }
}

/**
 * Replaces temporary uploaded-media URLs with the canonical URLs returned by Notion.
 * @param content - Local Tiptap document.
 * @param createdBlocks - Notion blocks created in matching top-level order.
 * @returns A document with refreshed media attributes.
 */
export function normalizeSyncedMediaContent(
  content: DocumentContent,
  createdBlocks: Array<NotionObject | undefined>,
): DocumentContent {
  if (!content?.content?.length) {
    return content;
  }

  return {
    ...content,
    content: content.content.map((node, index) =>
      normalizeSyncedMediaNode(node, createdBlocks[index]),
    ),
  };
}

/**
 * Recursively refreshes one media node from its corresponding Notion block.
 * @param node - Tiptap node to normalize.
 * @param createdBlock - Corresponding created Notion block, when available.
 * @returns The normalized Tiptap node.
 */
function normalizeSyncedMediaNode(
  node: DocumentContent,
  createdBlock: NotionObject | undefined,
): DocumentContent {
  if ((node?.type === 'image' || node?.type === 'audio') && node.attrs?.notionFileUploadId) {
    const url = mediaUrlFromNotionBlock(createdBlock);

    if (url) {
      return {
        ...node,
        attrs: {
          ...node.attrs,
          src: url,
          uploadState: 'done',
          ...(createdBlock?.id ? { notionBlockId: createdBlock.id } : {}),
        },
      };
    }
  }

  if (!node?.content?.length) {
    return node;
  }

  return {
    ...node,
    content: node.content.map((child) => normalizeSyncedMediaNode(child, undefined)),
  };
}

/**
 * Reads the served URL from a Notion image or audio block.
 * @param block - Notion block returned after creation.
 * @returns The media URL, or null when unavailable.
 */
function mediaUrlFromNotionBlock(block: NotionObject | undefined): string | null {
  if (block?.type === 'image') {
    return nestedString(block, 'image', 'file', 'url')
      ?? nestedString(block, 'image', 'external', 'url')
      ?? null;
  }

  if (block?.type === 'audio') {
    return nestedString(block, 'audio', 'file', 'url')
      ?? nestedString(block, 'audio', 'external', 'url')
      ?? null;
  }

  return null;
}

/**
 * Safely reads a string along a nested object path.
 * @param value - Root object.
 * @param path - Property path to traverse.
 * @returns The nested string or undefined.
 */
function nestedString(value: Record<string, unknown>, ...path: string[]): string | undefined {
  let current: unknown = value;

  for (const key of path) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }

  return typeof current === 'string' ? current : undefined;
}
