/**
 * @file Coordinates page synchronization for legacy page trees and project-database threads.
 * @author Aidan Boissonneault
 * @lastModified September 2026
 */

import type { DocumentContent, NotionParentPage, Project, ProjectPage } from '../../../src/types/capture.js';
import type {
  AppendLog,
  ManagedBlockResult,
  NotionObject,
  NotionRequester,
  WorkerStore,
} from './types.js';

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
  createChildPage: (store: WorkerStore, parentPageId: string, title: string) => Promise<NotionObject>;
  ensureInkwellRootPage: (
    store: WorkerStore,
    options: { selectedParentPageId: string | undefined },
  ) => Promise<NotionParentPage>;
  ensureProjectPage: ((
    store: WorkerStore,
    project: Project,
    options: { selectedParentPageId: string | undefined },
  ) => Promise<ProjectPageResult>) | undefined;
  ensureProjectRootPage: (
    store: WorkerStore,
    rootPageId: string,
    project: Project,
    options: { candidateNotionPageId: string | undefined },
  ) => Promise<NotionParentPage>;
  ensureThreadToggle: ((
    store: WorkerStore,
    projectPageId: string,
    page: ProjectPage,
  ) => Promise<NotionObject>) | undefined;
  notionRequest: NotionRequester;
  replaceManagedBlocks: (
    store: WorkerStore,
    localPageId: string,
    notionPageId: string,
    content: DocumentContent,
  ) => Promise<ManagedBlockResult>;
  requireConnectedStore: (request: unknown) => Promise<WorkerStore>;
  updateChildNotePage: (store: WorkerStore, pageId: string, page: ProjectPage) => Promise<unknown>;
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

/** Describes the project database push options contract used by this API feature. */
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
 * Pushes a local page through the configured Notion storage strategy.
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
    createChildPage,
    ensureInkwellRootPage,
    ensureProjectPage,
    ensureProjectRootPage,
    ensureThreadToggle,
    notionRequest,
    replaceManagedBlocks,
    requireConnectedStore,
    updateThreadToggleTitle,
    updateChildNotePage,
    writeStore,
  } = dependencies;
  const store = await requireConnectedStore(request);

  if (ensureProjectPage && ensureThreadToggle) {
    return pushPageToProjectDatabase({
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
    });
  }

  const inkwellRootPage = await ensureInkwellRootPage(store, { selectedParentPageId });
  const projectRootPage = await ensureProjectRootPage(store, inkwellRootPage.id, project, {
    candidateNotionPageId: page.notionParentPageId,
  });
  const notionPageId = page.notionPageId ?? store.notePages[page.id]?.notionPageId;
  const isUserReviewedReplacement = page.content.attrs?.inkwellConflictResolution === true;

  let notePage = notionPageId
    ? await notionRequest(store, `/pages/${notionPageId}`)
    : undefined;

  if (
    !isUserReviewedReplacement &&
    notePage?.last_edited_time &&
    page.remoteRevision &&
    notePage.last_edited_time !== page.remoteRevision
  ) {
    appendLog(store, 'sync_stale', `${page.title} changed in Notion.`);
    await writeStore(store);
    return {
      page: {
        ...page,
        notionPageId,
        notionDatabaseId: undefined,
        notionDataSourceId: undefined,
        notionParentPageId: projectRootPage.id,
        notionLastEditedTime: notePage.last_edited_time,
        remoteRevision: notePage.last_edited_time,
      },
      status: 'stale',
      message: 'This page changed in Notion. Pull or review it before saving over it.',
    };
  }

  if (!notePage) {
    notePage = await createChildPage(store, projectRootPage.id, page.title);
  } else {
    await updateChildNotePage(store, notePage.id, page);
  }

  const replacement = await replaceManagedBlocks(store, page.id, notePage.id, page.content);
  const refreshedPage = await notionRequest(store, `/pages/${notePage.id}`);
  const syncedContent = normalizeSyncedMediaContent(
    page.content,
    replacement?.createdBlocks ?? [],
  );
  const syncedPage = {
    ...page,
    content: syncedContent,
    notionPageId: notePage.id,
    notionDatabaseId: undefined,
    notionDataSourceId: undefined,
    notionParentPageId: projectRootPage.id,
    notionLastEditedTime: refreshedPage.last_edited_time,
    remoteRevision: refreshedPage.last_edited_time,
    syncState: 'saved',
  };

  store.notePages[page.id] = {
    archived: false,
    dataSourceId: undefined,
    kind: undefined,
    notionPageId: notePage.id,
    parentPageId: projectRootPage.id,
    title: page.title,
    lastEditedTime: refreshedPage.last_edited_time,
  };
  appendLog(store, 'sync_push', page.title);
  await writeStore(store);

  return {
    parentPage: inkwellRootPage,
    page: syncedPage,
    status: 'saved',
    message: 'Synced to Notion.',
  };
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
  const projectPage = await ensureProjectPage(store, project, { selectedParentPageId });

  if (page.status === 'archived') {
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

  const toggle = await ensureThreadToggle(store, projectPage.id, page);
  const isUserReviewedReplacement = page.content.attrs?.inkwellConflictResolution === true;

  if (
    !isUserReviewedReplacement &&
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

  await updateThreadToggleTitle?.(store, page);
  const replacement = await replaceManagedBlocks(store, page.id, toggle.id, page.content);
  const refreshedBlock = await notionRequest(store, `/blocks/${toggle.id}`).catch(() => toggle);
  const syncedContent = normalizeSyncedMediaContent(
    page.content,
    replacement?.createdBlocks ?? [],
  );
  const syncedPage = {
    ...page,
    content: syncedContent,
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
