import { describe, expect, test, vi } from 'vitest';
import { pushPageToNotionCore } from '@/apps/worker/src/pageSync';
import { threadKey } from '@/apps/worker/src/projectDatabaseValues';
import type { Project, ProjectPage } from '@/src/types/capture';
import type { NotionObject, NotionRequester, WorkerStore } from '@/apps/worker/src/types';

describe('Notion page sync recovery', () => {
  test('rebuilds an archived thread container from the saved local page', async () => {
    const content = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'local edit' }] }],
    } as const;
    const project = {
      id: 'project-1',
      name: 'Project',
      status: 'active',
      createdAt: '2026-10-27T12:00:00.000Z',
      updatedAt: '2026-10-28T12:00:00.000Z',
      stateContent: { type: 'doc', content: [] },
    } as Project;
    const page = {
      id: 'page-1',
      projectId: project.id,
      title: 'Page',
      status: 'active',
      createdAt: '2026-10-27T12:00:00.000Z',
      updatedAt: '2026-10-28T12:00:00.000Z',
      content,
      syncBaselineContent: content,
    } as ProjectPage;
    const store = {
      blockMappings: { [page.id]: [{ notionBlockId: 'archived-child' }] },
      notePages: {},
      projectPages: {},
      threadBlocks: { [threadKey(page.id)]: { blockId: 'archived-toggle' } },
    } as unknown as WorkerStore;
    const ensureProjectPage = vi.fn(async () => ({
      id: 'project-row',
      project,
      title: 'Project',
    }));
    const ensureThreadToggle = vi.fn(async () => {
      if (ensureThreadToggle.mock.calls.length === 1) {
        return { id: 'archived-toggle', last_edited_time: '2026-10-27T12:00:00.000Z' } as NotionObject;
      }
      expect(store.threadBlocks).not.toHaveProperty(threadKey(page.id));
      expect(store.blockMappings).not.toHaveProperty(page.id);
      store.threadBlocks[threadKey(page.id)] = { blockId: 'fresh-toggle' } as never;
      return { id: 'fresh-toggle', last_edited_time: '2026-10-28T12:00:00.000Z' } as NotionObject;
    });
    const archivedError = Object.assign(
      new Error("Can't edit block that is archived. You must unarchive the block before editing."),
      { code: 'validation_error', endpoint: '/blocks/archived-toggle/children', status: 400 },
    );
    const replaceManagedBlocks = vi.fn()
      .mockRejectedValueOnce(archivedError)
      .mockResolvedValueOnce({ createdBlocks: [], notionBlocks: [] });
    const notionRequest = vi.fn(async () => ({
      last_edited_time: '2026-10-28T12:00:00.000Z',
    })) as unknown as NotionRequester;
    const dependencies = {
      appendLog: vi.fn(),
      archiveThreadToggle: vi.fn(),
      createChildPage: vi.fn(),
      ensureJottathingRootPage: vi.fn(),
      ensureProjectPage,
      ensureProjectRootPage: vi.fn(),
      ensureThreadToggle,
      notionRequest,
      replaceManagedBlocks,
      requireConnectedStore: vi.fn(async () => store),
      updateChildNotePage: vi.fn(),
      updateThreadToggleTitle: vi.fn(),
      writeStore: vi.fn(async () => undefined),
    } as never;

    const result = await pushPageToNotionCore({
      dependencies,
      page,
      project,
      request: {},
      selectedParentPageId: undefined,
    });

    expect(result.status).toBe('saved');
    expect(result.page.notionPageId).toBe('fresh-toggle');
    expect(ensureProjectPage).toHaveBeenCalledTimes(2);
    expect(ensureThreadToggle).toHaveBeenCalledTimes(2);
    expect(replaceManagedBlocks).toHaveBeenCalledTimes(2);
  });
});
