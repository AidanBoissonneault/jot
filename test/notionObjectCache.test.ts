import { describe, expect, test, vi } from 'vitest';
import { createNotionObjectCache } from '@/apps/worker/src/services/notionObjectCache';
import { projectStateKey, threadKey } from '@/apps/worker/src/projectDatabaseValues';
import type { Project, ProjectPage } from '@/src/types/capture';

function createCache(notionRequest = vi.fn()) {
  return createNotionObjectCache({
    appendLog: vi.fn(),
    isBlockNotPageError: () => false,
    isNotionObjectNotFound: (error: { status?: number; code?: string }) =>
      error?.status === 404 || error?.code === 'object_not_found',
    notionRequest,
  });
}

describe('Notion object cache validation', () => {
  test('uses one workspace inventory instead of requesting each linked page', async () => {
    const notionRequest = vi.fn();
    const cache = createCache(notionRequest);
    const project = { id: 'project-1', status: 'active' } as Project;
    const page = {
      id: 'local-random-id',
      projectId: project.id,
      status: 'active',
      notionPageId: 'thread-1',
    } as ProjectPage;
    const store = {
      blockMappings: { [page.id]: [] },
      notePages: { [page.id]: { kind: 'thread', notionPageId: 'thread-1' } },
      projectBlocks: { [projectStateKey(project.id)]: { blockId: 'state-1' } },
      projectPages: { [project.id]: { notionPageId: 'project-row-1' } },
      threadBlocks: { [threadKey(page.id)]: { blockId: 'thread-1' } },
    };

    const result = await cache.validateNotionCache(store as never, {
      databaseVerified: true,
      pages: [page],
      projects: [project],
      remoteStructure: {
        pageIds: ['thread-1'],
        projectIds: [project.id],
        projectPageIds: ['project-row-1'],
      },
    });

    expect(result.changed).toBe(false);
    expect(result.uncachedProjectIds).toEqual([]);
    expect(result.uncachedPageIds).toEqual([]);
    expect(notionRequest).not.toHaveBeenCalled();
  });

  test('clears mappings for a page and project missing from the remote inventory', async () => {
    const notionRequest = vi.fn();
    const cache = createCache(notionRequest);
    const project = { id: 'project-1', status: 'active' } as Project;
    const page = {
      id: 'local-random-id',
      projectId: project.id,
      status: 'active',
      notionPageId: 'thread-deleted',
    } as ProjectPage;
    const store = {
      blockMappings: { [page.id]: [] },
      notePages: { [page.id]: { kind: 'thread', notionPageId: 'thread-deleted' } },
      projectBlocks: { [projectStateKey(project.id)]: { blockId: 'state-1' } },
      projectPages: { [project.id]: { notionPageId: 'project-row-deleted' } },
      threadBlocks: { [threadKey(page.id)]: { blockId: 'thread-deleted' } },
    };

    const result = await cache.validateNotionCache(store as never, {
      databaseVerified: true,
      pages: [page],
      projects: [project],
      remoteStructure: { pageIds: [], projectIds: [], projectPageIds: [] },
    });

    expect(result.changed).toBe(true);
    expect(result.uncachedProjectIds).toEqual([project.id]);
    expect(result.uncachedPageIds).toEqual([page.id]);
    expect(store.projectPages[project.id]).toBeUndefined();
    expect(store.notePages[page.id]).toBeUndefined();
    expect(notionRequest).not.toHaveBeenCalled();
  });
});
