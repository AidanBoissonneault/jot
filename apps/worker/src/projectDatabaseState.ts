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
import type {
  ListAllBlockChildren,
  NotionBlock,
  NotionObject,
  NotionRequester,
  ReplaceManagedBlocks,
  StoredBlock,
  WorkerStore,
} from './types.js';

/** Dependencies used to read and write nested project state and thread blocks. */
interface ProjectDatabaseStateDependencies {
  listAllBlockChildren: ListAllBlockChildren;
  notionBlocksToTiptapDocument: (blocks: NotionBlock[]) => DocumentContent;
  notionRequest: NotionRequester;
  replaceManagedBlocks: ReplaceManagedBlocks;
}

/** Mapping key and project/thread block mappings for a managed Notion toggle. */
interface ToggleOptions {
  key: string;
  mappings: Record<string, StoredBlock>;
}

/** Creates operations for project state containers and page thread toggles. */
export function createProjectDatabaseStateHelpers({
  listAllBlockChildren,
  notionBlocksToTiptapDocument,
  notionRequest,
  replaceManagedBlocks,
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
    const content = contentBlocks.length
      ? notionBlocksToTiptapDocument(contentBlocks)
      : emptyDocument();
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
  async function syncProjectState(store: WorkerStore, notionPageId: string, project: Project) {
    const key = projectStateKey(project.id);
    const previous = store.projectBlocks?.[key];
    const container = await ensureToggleBlock(store, notionPageId, 'Project State', {
      key,
      mappings: store.projectBlocks,
    });
    const hasRemoteEdit =
      previous?.lastEditedTime &&
      container.last_edited_time &&
      container.last_edited_time !== previous.lastEditedTime;

    if (hasRemoteEdit) {
      const blocks = await listAllBlockChildren(store, container.id);
      const content = blocks.length ? notionBlocksToTiptapDocument(blocks) : emptyDocument();
      store.projectBlocks[key] = {
        ...store.projectBlocks[key],
        blockId: container.id,
        lastEditedTime: container.last_edited_time,
        parentPageId: notionPageId,
        title: 'Project State',
      };
      return {
        content,
        lastEditedTime: container.last_edited_time,
      };
    }

    const stateContent = project.stateContent ?? emptyDocument();
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
      key: threadKey(page.id),
      mappings: store.threadBlocks,
    });
  }

  /** Finds a mapped toggle, discovers an existing toggle, or creates one. */
  async function ensureToggleBlock(
    store: WorkerStore,
    parentBlockId: string,
    title: string,
    { key, mappings }: ToggleOptions,
  ): Promise<NotionObject> {
    const stored = mappings?.[key];
    if (stored?.blockId) {
      const block = await notionRequest(store, `/blocks/${stored.blockId}`).catch(() => undefined);

      if (block?.id && !block.archived) {
        if (toggleTitle(block) !== title) {
          await updateToggleTitle(store, block.id, title);
        }
        return { ...block, id: block.id };
      }
    }

    const children = await listAllBlockChildren(store, parentBlockId).catch(() => []);
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
