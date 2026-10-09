import { describe, expect, test, vi } from 'vitest';
import { createProjectDatabaseHelpers } from '@/apps/worker/src/projectDatabase';

const expectedProperties = {
  Name: {},
  Status: {},
  Category: {},
  Created: {},
  Updated: {},
  'Created by': {},
  'Last edited by': {},
  'Inkwell ID': {},
  'Managed by Inkwell': {},
};

function database(id: string, dataSourceId: string, lastEditedTime: string) {
  return {
    id,
    data_sources: [{ id: dataSourceId }],
    last_edited_time: lastEditedTime,
    parent: { type: 'workspace', workspace: true },
    title: [{ plain_text: 'Inkwell' }],
  };
}

function helpers(notionRequest: ReturnType<typeof vi.fn>) {
  return createProjectDatabaseHelpers({
    appendLog: vi.fn(),
    createWorkspacePage: vi.fn(),
    hash: vi.fn(),
    importManagedBlocks: vi.fn(async () => null),
    isNotionObjectNotFound: (error: { status?: number; code?: string }) =>
      error?.status === 404 || error?.code === 'object_not_found',
    listAllBlockChildren: vi.fn(),
    notionBlocksToTiptapDocument: vi.fn(),
    notionRequest,
    replaceManagedBlocks: vi.fn(),
    tiptapDocumentToNotionBlocks: vi.fn(),
  });
}

describe('Inkwell project database selection', () => {
  test('follows an explicit parent selection instead of a cached database under another parent', async () => {
    const selectedDatabase = {
      ...database('db-new-parent', 'ds-new-parent', '2026-10-07T12:00:00.000Z'),
      parent: { type: 'page_id', page_id: 'new-parent' },
    };
    const notionRequest = vi.fn(async (_store, endpoint) => {
      if (endpoint === '/pages/new-parent') {
        return {
          id: 'new-parent',
          properties: { Name: { type: 'title', title: [{ plain_text: 'New parent' }] } },
          url: 'https://notion.so/new-parent',
        };
      }
      if (endpoint === '/search') return { results: [selectedDatabase], has_more: false };
      if (endpoint === '/data_sources/ds-new-parent/query') {
        return { results: [], has_more: false };
      }
      if (endpoint === '/data_sources/ds-new-parent') {
        return { properties: expectedProperties };
      }
      if (endpoint === '/views?database_id=db-new-parent') {
        return { results: [
          { name: 'Active Projects' },
          { name: 'By Category' },
          { name: 'All Projects' },
        ] };
      }
      throw new Error(`Unexpected request: ${endpoint}`);
    });
    const store = {
      inkwellDatabase: {
        databaseId: 'db-old-parent',
        dataSourceId: 'ds-old-parent',
        parentPageId: 'old-parent',
        title: 'Inkwell',
        views: {},
      },
      logs: [],
      projectPages: {},
    };

    const selected = await helpers(notionRequest).ensureProjectDatabase(store as never, {
      selectedParentPageId: 'new-parent',
    });

    expect(selected.databaseId).toBe('db-new-parent');
    expect(selected.parentPageId).toBe('new-parent');
    expect(store.inkwellDatabase?.databaseId).toBe('db-new-parent');
    expect(notionRequest).not.toHaveBeenCalledWith(store, '/databases/db-old-parent');
  });

  test('keeps the saved database reference on transient lookup failures', async () => {
    const transientError = Object.assign(new Error('Notion unavailable'), { status: 503 });
    const notionRequest = vi.fn(async (store, endpoint) => {
      if (endpoint === '/databases/db-saved') throw transientError;
      throw new Error(`Unexpected request: ${endpoint}`);
    });
    const store = {
      inkwellDatabase: { databaseId: 'db-saved', dataSourceId: 'ds-saved' },
      logs: [],
    };

    await expect(helpers(notionRequest).ensureProjectDatabase(store)).rejects.toBe(transientError);
    expect(notionRequest).toHaveBeenCalledTimes(1);
    expect(store.inkwellDatabase.databaseId).toBe('db-saved');
  });

  test('searches every result page and adopts the database with the most managed projects', async () => {
    const emptyDatabase = database('db-empty', 'ds-empty', '2026-09-11T12:00:00.000Z');
    const mainDatabase = database('db-main', 'ds-main', '2026-09-10T12:00:00.000Z');
    const notionRequest = vi.fn(async (store, endpoint, init = {}) => {
      if (endpoint === '/search' && !init.body?.start_cursor) {
        return { results: [emptyDatabase], has_more: true, next_cursor: 'next' };
      }
      if (endpoint === '/search' && init.body?.start_cursor === 'next') {
        return { results: [mainDatabase], has_more: false };
      }
      if (endpoint === '/data_sources/ds-empty/query') {
        return { results: [], has_more: false };
      }
      if (endpoint === '/data_sources/ds-main/query') {
        return { results: [{ id: 'one' }, { id: 'two' }, { id: 'three' }], has_more: false };
      }
      if (endpoint === '/data_sources/ds-main') {
        return { properties: expectedProperties };
      }
      if (endpoint === '/views?database_id=db-main') {
        return {
          results: [
            { name: 'Active Projects' },
            { name: 'By Category' },
            { name: 'All Projects' },
          ],
        };
      }
      throw new Error(`Unexpected request: ${endpoint}`);
    });
    const store: { logs: unknown[]; inkwellDatabase?: { databaseId: string } } = { logs: [] };

    const selected = await helpers(notionRequest).ensureProjectDatabase(store);

    expect(selected.databaseId).toBe('db-main');
    expect(store.inkwellDatabase?.databaseId).toBe('db-main');
    const searchCalls = notionRequest.mock.calls.filter(([, endpoint]) => endpoint === '/search');
    expect(searchCalls).toHaveLength(2);
    expect(searchCalls[1][2].body.start_cursor).toBe('next');
  });
});

describe('Inkwell project database reload', () => {
  test('imports Ravens Heart and LinkedIn Demo from their remote projects and omits trashed records', async () => {
    const remoteContent = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Created remotely' }] }],
    };
    const externalProjectRow = {
      ...database('project-row-external', 'unused', '2026-10-06T12:00:00.000Z'),
      archived: false,
      in_trash: false,
      properties: {
        'Inkwell ID': { rich_text: [{ plain_text: 'project-plants' }] },
        Name: { type: 'title', title: [{ plain_text: 'Plants!' }] },
        Status: { select: { name: 'Active' } },
        Created: { date: { start: '2026-10-06T10:00:00.000Z' } },
        Updated: { date: { start: '2026-10-06T12:00:00.000Z' } },
      },
    };
    const trashedProjectRow = {
      ...externalProjectRow,
      id: 'project-row-trashed',
      archived: false,
      in_trash: true,
      properties: {
        ...externalProjectRow.properties,
        'Inkwell ID': { rich_text: [{ plain_text: 'project-trashed' }] },
        Name: { type: 'title', title: [{ plain_text: 'Trashed Project' }] },
      },
    };
    const careerPrepProjectRow = {
      ...externalProjectRow,
      id: 'project-row-career-prep',
      properties: {
        ...externalProjectRow.properties,
        'Inkwell ID': { rich_text: [{ plain_text: 'project-career-prep' }] },
        Name: { type: 'title', title: [{ plain_text: 'Career Prep' }] },
      },
    };
    const notionDatabase = database('db-main', 'ds-main', '2026-10-06T12:00:00.000Z');
    const externalThread = {
      id: 'thread-external',
      type: 'toggle',
      archived: false,
      in_trash: false,
      last_edited_time: '2026-10-06T12:30:00.000Z',
      toggle: { rich_text: [{ type: 'text', plain_text: 'Ravens Heart' }] },
    };
    const linkedinThread = {
      id: 'thread-linkedin-demo',
      type: 'toggle',
      archived: false,
      in_trash: false,
      last_edited_time: '2026-10-06T12:31:00.000Z',
      toggle: { rich_text: [{ type: 'text', plain_text: 'LinkedIn Demo' }] },
    };
    const trashedThread = {
      id: 'thread-trashed',
      type: 'toggle',
      archived: false,
      in_trash: true,
      toggle: { rich_text: [{ type: 'text', plain_text: 'Deleted remotely' }] },
    };
    const notionRequest = vi.fn(async (store, endpoint) => {
      if (endpoint === '/databases/db-main') return notionDatabase;
      if (endpoint === '/data_sources/ds-main') return { properties: expectedProperties };
      if (endpoint === '/views?database_id=db-main') {
        return { results: [
          { name: 'Active Projects' },
          { name: 'By Category' },
          { name: 'All Projects' },
        ] };
      }
      if (endpoint === '/data_sources/ds-main/query') {
        return { results: [externalProjectRow, careerPrepProjectRow, trashedProjectRow], has_more: false };
      }
      throw new Error(`Unexpected request: ${endpoint}`);
    });
    const listAllBlockChildren = vi.fn(async (_store, blockId) => {
      if (blockId === externalProjectRow.id) return [externalThread, trashedThread];
      if (blockId === careerPrepProjectRow.id) return [linkedinThread];
      if (blockId === externalThread.id || blockId === linkedinThread.id) {
        return [{ id: 'remote-paragraph', type: 'paragraph' }];
      }
      return [];
    });
    const helpers = createProjectDatabaseHelpers({
      appendLog: vi.fn(),
      createWorkspacePage: vi.fn(),
      importManagedBlocks: vi.fn(async () => remoteContent),
      isNotionObjectNotFound: (error: { status?: number; code?: string }) =>
        error?.status === 404 || error?.code === 'object_not_found',
      listAllBlockChildren,
      notionBlocksToTiptapDocument: vi.fn(() => ({ type: 'doc', content: [] })),
      notionRequest,
      replaceManagedBlocks: vi.fn(),
      tiptapDocumentToNotionBlocks: vi.fn(() => []),
    });
    const store = {
      blockMappings: {},
      inkwellDatabase: {
        databaseId: 'db-main',
        dataSourceId: 'ds-main',
        parentPageId: undefined,
        title: 'Inkwell',
        views: {},
      },
      notePages: {},
      projectBlocks: {},
      projectPages: {},
      threadBlocks: {},
    };

    const snapshot = await helpers.reloadProjectDatabaseFromNotion(store as never);

    expect(snapshot.projects.map((project) => project.name)).toEqual(['Plants!', 'Career Prep']);
    expect(snapshot.pages.map(({ title, projectId }) => ({ title, projectId }))).toEqual([
      { title: 'Ravens Heart', projectId: 'project-plants' },
      { title: 'LinkedIn Demo', projectId: 'project-career-prep' },
    ]);
    expect(snapshot.pages.every((page) => page.content === remoteContent)).toBe(true);
    expect(snapshot.activePageIdsByProject).toEqual({
      'project-plants': 'page-project-plants-thread-external',
      'project-career-prep': 'page-project-career-prep-thread-linkedin-demo',
    });
    expect(listAllBlockChildren).toHaveBeenCalledWith(store, externalProjectRow.id);
    expect(listAllBlockChildren).toHaveBeenCalledWith(store, careerPrepProjectRow.id);
    expect(listAllBlockChildren).toHaveBeenCalledWith(store, externalThread.id);
    expect(listAllBlockChildren).toHaveBeenCalledWith(store, linkedinThread.id);
    expect(listAllBlockChildren).not.toHaveBeenCalledWith(store, 'project-row-trashed');
    expect(store.notePages['page-project-plants-thread-external']?.notionPageId)
      .toBe(externalThread.id);
    expect(store.notePages['page-project-career-prep-thread-linkedin-demo']?.notionPageId)
      .toBe(linkedinThread.id);

    const structure = await helpers.readProjectDatabaseStructure(store as never);
    expect(structure).toEqual({
      pageIds: ['thread-external', 'thread-linkedin-demo'],
      projectIds: ['project-plants', 'project-career-prep'],
      projectPageIds: [externalProjectRow.id, careerPrepProjectRow.id],
    });
  });
});
