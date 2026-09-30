/**
 * @file Imports and synchronizes the state blocks and page threads nested in project rows.
 * @author Aidan Boissonneault
 * @lastModified September 2026
 */
import {
  emptyDocument,
  projectStateKey,
  richText,
  threadKey,
  toggleBlock,
  toggleTitle,
} from './projectDatabaseValues.js';
import type { DocumentContent, Project, ProjectPage } from '../../../src/types/capture.js';
import {
  projectStateSourceBlockIds,
  pruneOrphanedProjectStateSources,
  SOURCE_BLOCK_ID_PREFIX,
} from '../../../src/lib/projectStateSources.js';
import type {
  ListAllBlockChildren,
  NotionBlock,
  NotionBlockPayload,
  NotionObject,
  NotionRequester,
  ReplaceManagedBlocks,
  StoredBlock,
  WorkerStore,
} from './types.js';
import { isNotionObjectForbidden } from './workerUtils.js';

/** Dependencies used to read and write nested project state and thread blocks. */
interface ProjectDatabaseStateDependencies {
  importManagedBlocks: (
    store: WorkerStore,
    page: { id: string; notionPageId: string },
    notionBlocks: NotionBlock[],
  ) => Promise<DocumentContent | null>;
  listAllBlockChildren: ListAllBlockChildren;
  notionBlocksToTiptapDocument: (blocks: NotionBlock[]) => DocumentContent;
  notionRequest: NotionRequester;
  replaceManagedBlocks: ReplaceManagedBlocks;
  deleteManagedBlock?: (store: WorkerStore, blockId: string) => Promise<unknown>;
  updateManagedBlock?: (
    store: WorkerStore,
    blockId: string,
    block: NotionBlockPayload,
  ) => Promise<unknown>;
  tiptapDocumentToNotionBlocks?: (document: DocumentContent) => NotionBlockPayload[];
}

/** Mapping key and project/thread block mappings for a managed Notion toggle. */
interface ToggleOptions {
  isForcedMerge?: boolean;
  key: string;
  mappings: Record<string, StoredBlock>;
}

/** Creates operations for project state containers and page thread toggles. */
export function createProjectDatabaseStateHelpers({
  importManagedBlocks,
  listAllBlockChildren,
  notionBlocksToTiptapDocument,
  notionRequest,
  replaceManagedBlocks,
  deleteManagedBlock,
  updateManagedBlock,
  tiptapDocumentToNotionBlocks,
}: ProjectDatabaseStateDependencies) {
  /** Imports project state content and records the managed container mapping. */
  async function importProjectState(
    store: WorkerStore,
    projectPage: NotionObject,
    project: Project,
    stateBlock: NotionBlock,
  ): Promise<Project> {
    const blocks = await listAllBlockChildren(store, stateBlock.id).catch(() => []);
    const content = blocks.length ? notionBlocksToTiptapDocument(blocks) : emptyDocument();
    store.projectBlocks[projectStateKey(project.id)] = {
      blockId: stateBlock.id,
      lastEditedTime: stateBlock.last_edited_time,
      parentPageId: projectPage.id,
      title: 'Project State',
    };

    return {
      ...project,
      stateContent: content,
      stateRemoteRevision: stateBlock.last_edited_time,
    };
  }

  /** Imports a thread toggle and its children as a local project page. */
  async function pageFromThreadBlock(
    store: WorkerStore,
    project: Project,
    projectPage: NotionObject,
    threadBlock: NotionBlock,
  ): Promise<ProjectPage> {
    const id = `page-${project.id}-${threadBlock.id}`;
    const title = toggleTitle(threadBlock) || 'Untitled Page';
    const contentBlocks = await listAllBlockChildren(store, threadBlock.id).catch(() => []);
    const importedContent = contentBlocks.length
      ? await importManagedBlocks(store, { id, notionPageId: threadBlock.id }, contentBlocks)
      : null;
    const content = importedContent ?? (contentBlocks.length
      ? notionBlocksToTiptapDocument(contentBlocks)
      : emptyDocument());
    if (!contentBlocks.length) store.blockMappings[id] = [];
    const timestamp = threadBlock.last_edited_time ?? project.updatedAt;

    store.threadBlocks[threadKey(id)] = {
      blockId: threadBlock.id,
      lastEditedTime: threadBlock.last_edited_time,
      parentPageId: projectPage.id,
      title,
    };
    store.notePages[id] = {
      archived: false,
      dataSourceId: undefined,
      notionPageId: threadBlock.id,
      parentPageId: projectPage.id,
      title,
      lastEditedTime: threadBlock.last_edited_time,
      kind: 'thread',
    };

    return {
      id,
      projectId: project.id,
      kind: 'page',
      title,
      status: 'active',
      content,
      createdAt: timestamp,
      updatedAt: timestamp,
      notionPageId: threadBlock.id,
      notionDatabaseId: undefined,
      notionDataSourceId: undefined,
      notionParentPageId: projectPage.id,
      notionLastEditedTime: threadBlock.last_edited_time,
      remoteRevision: threadBlock.last_edited_time,
      syncState: 'saved',
    };
  }

  /** Reconciles local project state with its Notion toggle, preserving remote edits. */
  async function syncProjectState(
    store: WorkerStore,
    notionPageId: string,
    project: Project,
    isForcedMerge = false,
  ) {
    const key = projectStateKey(project.id);
    const previous = store.projectBlocks?.[key];
    const isUserReviewedReplacement = project.stateContent?.attrs?.inkwellConflictResolution === true;
    const container = await ensureToggleBlock(store, notionPageId, 'Project State', {
      isForcedMerge: isForcedMerge || isUserReviewedReplacement,
      key,
      mappings: store.projectBlocks,
    });
    const hasRemoteEdit =
      previous?.lastEditedTime &&
      container.last_edited_time &&
      container.last_edited_time !== previous.lastEditedTime;
    const existingInkwellBlockIds = isUserReviewedReplacement
      ? new Set<string>()
      : inkwellBlockIdsForProjectState(store, key);
    const stateContent = isUserReviewedReplacement
      ? project.stateContent ?? emptyDocument()
      : pruneOrphanedProjectStateSources(
          project.stateContent ?? emptyDocument(),
          existingInkwellBlockIds,
        );
    let remoteBlocks: NotionBlock[] = [];

    // A reviewed merge is the user's chosen snapshot. Skip automatic source
    // pruning so metadata or unique blocks from that snapshot are not removed
    // before replaceManagedBlocks writes it.
    if (!isUserReviewedReplacement) {
      remoteBlocks = await listAllBlockChildren(store, container.id);
      const removedRemoteIds = new Set<string>();
      let changedRemoteState = false;

      for (const block of remoteBlocks) {
        const node = notionBlocksToTiptapDocument([block]).content?.[0];
        if (!node || !projectStateSourceBlockIds(node).some((blockId) =>
          !existingInkwellBlockIds.has(blockId),
        )) continue;

        const cleaned = pruneOrphanedProjectStateSources(
          { type: 'doc', content: [node] },
          existingInkwellBlockIds,
        );
        const replacementNode = cleaned.content?.[0];
        if (!replacementNode) {
          if (deleteManagedBlock) {
            await deleteManagedBlock(store, block.id);
          } else {
            await notionRequest(store, `/blocks/${block.id}`, { method: 'DELETE' });
          }
          removedRemoteIds.add(block.id);
          changedRemoteState = true;
          continue;
        }

        const [replacement] = tiptapDocumentToNotionBlocks?.(cleaned) ?? [];
        if (!replacement) continue;
        if (updateManagedBlock) {
          await updateManagedBlock(store, block.id, replacement);
        } else {
          const { object: _object, type: _type, ...body } = replacement;
          await notionRequest(store, `/blocks/${block.id}`, { method: 'PATCH', body });
        }
        changedRemoteState = true;
        for (const mapping of store.blockMappings[key] ?? []) {
          if (mapping.notionBlockId === block.id) mapping.newState = replacement;
        }
      }

      if (removedRemoteIds.size) {
        store.blockMappings[key] = (store.blockMappings[key] ?? [])
          .filter((mapping) => !removedRemoteIds.has(mapping.notionBlockId ?? ''));
      }
      if (changedRemoteState) {
        remoteBlocks = await listAllBlockChildren(store, container.id);
      }
    }

    if (hasRemoteEdit && !isUserReviewedReplacement) {
      const content = remoteBlocks.length
        ? pruneOrphanedProjectStateSources(
            notionBlocksToTiptapDocument(remoteBlocks),
            existingInkwellBlockIds,
          )
        : emptyDocument();
      const refreshed = await notionRequest(store, `/blocks/${container.id}`).catch(() => container);
      store.projectBlocks[key] = {
        ...store.projectBlocks[key],
        blockId: container.id,
        lastEditedTime: refreshed.last_edited_time,
        parentPageId: notionPageId,
        title: 'Project State',
      };
      return {
        content,
        lastEditedTime: refreshed.last_edited_time,
      };
    }

    await replaceManagedBlocks(store, key, container.id, stateContent);
    const refreshed = await notionRequest(store, `/blocks/${container.id}`).catch(() => container);
    store.projectBlocks[key] = {
      ...store.projectBlocks[key],
      blockId: container.id,
      lastEditedTime: refreshed.last_edited_time,
      parentPageId: notionPageId,
      title: 'Project State',
    };
    return {
      content: stateContent,
      lastEditedTime: refreshed.last_edited_time,
    };
  }

  /** Ensures that a project has its managed state toggle. */
  async function ensureProjectStateContainer(
    store: WorkerStore,
    notionPageId: string,
    projectId: string,
  ): Promise<NotionObject> {
    return ensureToggleBlock(store, notionPageId, 'Project State', {
      key: projectStateKey(projectId),
      mappings: store.projectBlocks,
    });
  }

  /** Ensures that a local page has a managed thread toggle under its project. */
  async function ensureThreadToggle(
    store: WorkerStore,
    projectPageId: string,
    page: ProjectPage,
  ): Promise<NotionObject> {
    return ensureToggleBlock(store, projectPageId, page.title || 'Untitled Page', {
      isForcedMerge: page.content.attrs?.inkwellConflictResolution === true,
      key: threadKey(page.id),
      mappings: store.threadBlocks,
    });
  }

  /** Finds a mapped toggle, discovers an existing toggle, or creates one. */
  async function ensureToggleBlock(
    store: WorkerStore,
    parentBlockId: string,
    title: string,
    { isForcedMerge = false, key, mappings }: ToggleOptions,
  ): Promise<NotionObject> {
    const stored = mappings?.[key];
    if (stored?.blockId) {
      const block = await notionRequest(store, `/blocks/${stored.blockId}`).catch((error) => {
        if (
          isNotionObjectNotFoundError(error) ||
          (!isForcedMerge && isNotionObjectForbidden(error))
        ) return undefined;
        throw error;
      });

      if (block?.id && !block.archived) {
        if (toggleTitle(block) !== title) {
          await updateToggleTitle(store, block.id, title);
        }
        return { ...block, id: block.id };
      }
    }

    const children = await listAllBlockChildren(store, parentBlockId).catch((error) => {
      if (
        isNotionObjectNotFoundError(error) ||
        (!isForcedMerge && isNotionObjectForbidden(error))
      ) return [];
      throw error;
    });
    const matching = children.find(
      (block) => block.type === 'toggle' && !block.archived && toggleTitle(block) === title,
    );

    if (matching) {
      mappings[key] = {
        blockId: matching.id,
        lastEditedTime: matching.last_edited_time,
        parentPageId: parentBlockId,
        title,
      };
      return matching;
    }

    const response = await notionRequest(store, `/blocks/${parentBlockId}/children`, {
      method: 'PATCH',
      body: { children: [toggleBlock(title)] },
    });
    const created = response.results?.[0];

    if (!created?.id) {
      throw new Error(`Unable to create Notion toggle for ${title}.`);
    }

    mappings[key] = {
      blockId: created.id,
      lastEditedTime: created.last_edited_time,
      parentPageId: parentBlockId,
      title,
    };
    return created;
  }

  /** Updates a Notion toggle title. */
  async function updateToggleTitle(
    store: WorkerStore,
    blockId: string,
    title: string,
  ): Promise<NotionObject> {
    return notionRequest(store, `/blocks/${blockId}`, {
      method: 'PATCH',
      body: {
        toggle: {
          rich_text: richText(title || 'Untitled Page'),
        },
      },
    });
  }

  /** Renames the mapped thread toggle when its page title changes. */
  async function updateThreadToggleTitle(store: WorkerStore, page: ProjectPage): Promise<void> {
    const stored = store.threadBlocks?.[threadKey(page.id)];

    if (!stored?.blockId || stored.title === page.title) {
      return;
    }

    await updateToggleTitle(store, stored.blockId, page.title || 'Untitled Page');
    stored.title = page.title || 'Untitled Page';
  }

  /** Archives the mapped thread toggle and clears its local block mappings. */
  async function archiveThreadToggle(store: WorkerStore, page: ProjectPage): Promise<void> {
    const stored = store.threadBlocks?.[threadKey(page.id)];

    if (!stored?.blockId) {
      return;
    }

    await notionRequest(store, `/blocks/${stored.blockId}`, {
      method: 'DELETE',
    });
    delete store.threadBlocks[threadKey(page.id)];
    delete store.blockMappings[page.id];
  }

  /** Reads a mapped thread's child blocks as editor document content. */
  async function importThreadContent(
    store: WorkerStore,
    page: ProjectPage,
  ): Promise<DocumentContent | null> {
    const stored = store.threadBlocks?.[threadKey(page.id)];

    if (!stored?.blockId) {
      return null;
    }

    const blocks = await listAllBlockChildren(store, stored.blockId);
    return blocks.length ? notionBlocksToTiptapDocument(blocks) : emptyDocument();
  }

  return {
    archiveThreadToggle,
    ensureProjectStateContainer,
    ensureThreadToggle,
    importProjectState,
    importThreadContent,
    pageFromThreadBlock,
    syncProjectState,
    updateThreadToggleTitle,
  };
}

function isNotionObjectNotFoundError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const detail = error as { status?: unknown; code?: unknown };
  return detail.status === 404 || detail.code === 'object_not_found';
}

function inkwellBlockIdsForProjectState(
  store: WorkerStore,
  projectStateMappingKey: string,
): Set<string> {
  const ids = new Set<string>();
  for (const [localPageId, mappings] of Object.entries(store.blockMappings ?? {})) {
    if (
      localPageId === projectStateMappingKey ||
      store.projectBlocks?.[localPageId] ||
      store.notePages?.[localPageId]?.archived
    ) continue;

    for (const mapping of mappings) {
      const id = mapping.inkwellBlockId ?? mapping.localNodeId;
      if (id && !id.startsWith(SOURCE_BLOCK_ID_PREFIX)) ids.add(id);
    }
  }
  return ids;
}
