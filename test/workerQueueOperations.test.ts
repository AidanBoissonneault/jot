import { describe, expect, test, vi } from 'vitest';
import { createWorkerQueueOperations } from '@/apps/worker/src/services/workerQueueOperations';
import {
  reactivateProjectForNewerPageEdit,
  threadKey,
} from '@/apps/worker/src/projectDatabaseValues';
import type { Project, ProjectPage } from '@/src/types/capture';
import type { ManagedBlockOperation, NotionObject, WorkerStore } from '@/apps/worker/src/types';

describe('queued Notion block operations', () => {
  test('restores an archived project when a durable page edit is newer than the archive', async () => {
    const installationId = 15;
    const archivedAt = '2026-10-28T21:07:25.066Z';
    const pageEditedAt = '2026-10-28T21:07:30.537Z';
    const operationCreatedAt = '2026-10-28T21:07:30.644Z';
    const project = {
      id: 'project-1',
      name: 'My Project',
      status: 'archived',
      createdAt: '2026-10-27T12:00:00.000Z',
      updatedAt: archivedAt,
      stateContent: { type: 'doc', content: [] },
    } as Project;
    const content = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'newer local edit' }] }],
    } as const;
    const page = {
      id: 'page-1',
      projectId: project.id,
      title: 'Hello World',
      status: 'active',
      createdAt: '2026-10-27T12:00:00.000Z',
      updatedAt: pageEditedAt,
      content,
      syncBaselineContent: content,
    } as ProjectPage;
    const store = {
      blockMappings: {},
      installationId,
      notePages: {},
      projectPages: {},
      threadBlocks: {},
      tokens: { access_token: 'token' },
    } as unknown as WorkerStore;
    const ensureProjectPage = vi.fn(async (_syncStore: WorkerStore, syncedProject: Project) => ({
      id: 'project-row',
      project: syncedProject,
      title: syncedProject.name,
    }));
    const appendLog = vi.fn();
    const applyManagedBlockOps = vi.fn(async () => ({
      content,
      baselineContent: content,
      createdBlocks: [],
      notionBlocks: [],
    }));
    const supabase = {
      from: vi.fn((table: string) => {
        const query: Record<string, ReturnType<typeof vi.fn>> = {};
        query.select = vi.fn(() => query);
        query.eq = vi.fn(() => query);
        query.limit = vi.fn(() => query);
        query.maybeSingle = vi.fn(async () => ({
          data: table === 'notion_installations'
            ? { id: installationId, user_id: 'notion:user' }
            : { accessToken: 'token' },
          error: null,
        }));
        return query;
      }),
    };
    const operations = createWorkerQueueOperations({
      appendLog,
      applyManagedBlockOps,
      archiveThreadToggle: vi.fn(),
      ensureProjectPage,
      ensureThreadToggle: vi.fn(async () => ({ id: 'thread-toggle' } as NotionObject)),
      notionRequest: vi.fn(async () => ({ last_edited_time: operationCreatedAt })),
      pushPageToNotionCore: vi.fn(),
      readStore: () => store,
      replaceManagedBlocks: vi.fn(),
      supabase,
      updateThreadToggleTitle: vi.fn(),
      withFreshInstallationStore: async (_syncStore: WorkerStore, operation: (freshStore: WorkerStore) => Promise<unknown>) => operation(store),
      writeStore: vi.fn(),
      freshConnectedStore: async (syncStore: WorkerStore) => syncStore,
      performSyncProjectFolder: vi.fn(),
    } as never);
    const ops = [{
      type: 'block_create',
      createdAt: operationCreatedAt,
      payload: { block: content.content[0] },
    }] as unknown as ManagedBlockOperation[];

    const result = await operations.applyBlockOpsToNotionForInstallation(installationId, {
      ops,
      page,
      project,
      selectedParentPageId: undefined,
    });

    expect(result.page?.notionPageId).toBe('thread-toggle');
    expect(ensureProjectPage.mock.calls[0]?.[1].status).toBe('active');
    expect(Date.parse(ensureProjectPage.mock.calls[0]![1].updatedAt)).toBeGreaterThan(Date.parse(archivedAt));
    expect(applyManagedBlockOps).toHaveBeenCalledOnce();
    expect(appendLog).toHaveBeenCalledWith(
      store,
      'sync_project_restored_after_page_edit',
      'Restored an archived project after a newer local page edit.',
    );
  });

  test('keeps an archived project archived when its page edit predates the archive', () => {
    const archivedAt = '2026-10-28T21:07:25.066Z';
    const editAt = '2026-10-28T21:07:20.000Z';
    const project = {
      id: 'project-1',
      name: 'My Project',
      status: 'archived',
      updatedAt: archivedAt,
    } as Project;
    const page = {
      id: 'page-1',
      projectId: project.id,
      title: 'Hello World',
      status: 'active',
      updatedAt: editAt,
    } as ProjectPage;

    expect(reactivateProjectForNewerPageEdit(project, page, [editAt])).toEqual({
      project,
      reactivated: false,
    });
  });

  test('rebuilds an archived thread from the durable local page snapshot', async () => {
    const installationId = 15;
    const project = {
      id: 'project-1',
      name: 'My Project',
      status: 'active',
      stateContent: { type: 'doc', content: [] },
    } as Project;
    const content = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'latest local edit' }] }],
    } as const;
    const page = {
      id: 'page-1',
      projectId: project.id,
      title: 'Hello World',
      status: 'active',
      content,
      syncBaselineContent: content,
    } as ProjectPage;
    const store = {
      blockMappings: { [page.id]: [{ notionBlockId: 'archived-child' }] },
      installationId,
      notePages: {},
      projectPages: {},
      threadBlocks: { [threadKey(page.id)]: { blockId: 'archived-toggle' } },
      tokens: { access_token: 'token' },
    } as unknown as WorkerStore;
    const archivedError = Object.assign(
      new Error("Can't edit block that is archived. You must unarchive the block before editing."),
      { code: 'validation_error', endpoint: '/blocks/archived-toggle/children', status: 400 },
    );
    const ensureProjectPage = vi.fn(async () => ({
      id: 'project-row',
      project,
      title: project.name,
    }));
    const ensureThreadToggle = vi.fn(async (
      syncStore: WorkerStore,
      _projectPageId: string,
      _page: ProjectPage,
      options?: { excludedBlockIds?: ReadonlySet<string> },
    ) => {
      if (ensureThreadToggle.mock.calls.length === 1) {
        return { id: 'archived-toggle' } as NotionObject;
      }
      expect(options?.excludedBlockIds?.has('archived-toggle')).toBe(true);
      expect(syncStore.threadBlocks).not.toHaveProperty(threadKey(page.id));
      expect(syncStore.blockMappings).not.toHaveProperty(page.id);
      syncStore.threadBlocks[threadKey(page.id)] = { blockId: 'fresh-toggle' } as never;
      return { id: 'fresh-toggle' } as NotionObject;
    });
    const applyManagedBlockOps = vi.fn().mockRejectedValueOnce(archivedError);
    const replaceManagedBlocks = vi.fn(async () => ({
      content,
      baselineContent: content,
      createdBlocks: [],
      notionBlocks: [],
    }));
    const supabase = {
      from: vi.fn((table: string) => {
        const query: Record<string, ReturnType<typeof vi.fn>> = {};
        query.select = vi.fn(() => query);
        query.eq = vi.fn(() => query);
        query.limit = vi.fn(() => query);
        query.maybeSingle = vi.fn(async () => ({
          data: table === 'notion_installations'
            ? { id: installationId, user_id: 'notion:user' }
            : { accessToken: 'token' },
          error: null,
        }));
        return query;
      }),
    };
    const operations = createWorkerQueueOperations({
      appendLog: vi.fn(),
      applyManagedBlockOps,
      archiveThreadToggle: vi.fn(),
      ensureProjectPage,
      ensureThreadToggle,
      notionRequest: vi.fn(async () => ({ last_edited_time: '2026-10-28T12:00:00.000Z' })),
      pushPageToNotionCore: vi.fn(),
      readStore: () => store,
      replaceManagedBlocks,
      supabase,
      updateThreadToggleTitle: vi.fn(),
      withFreshInstallationStore: async (_syncStore: WorkerStore, operation: (freshStore: WorkerStore) => Promise<unknown>) => operation(store),
      writeStore: vi.fn(),
      freshConnectedStore: async (syncStore: WorkerStore) => syncStore,
      performSyncProjectFolder: vi.fn(),
    } as never);
    const ops = [{ type: 'block_create', payload: { block: content.content[0] } }] as unknown as ManagedBlockOperation[];

    const result = await operations.applyBlockOpsToNotionForInstallation(installationId, {
      ops,
      page,
      project,
      selectedParentPageId: undefined,
    });

    expect(result.page?.notionPageId).toBe('fresh-toggle');
    expect(result.page?.content).toEqual(content);
    expect(applyManagedBlockOps).toHaveBeenCalledOnce();
    expect(replaceManagedBlocks).toHaveBeenCalledWith(store, page.id, 'fresh-toggle', content);
    expect(ensureProjectPage).toHaveBeenCalledTimes(2);
    expect(ensureThreadToggle).toHaveBeenCalledTimes(2);
  });
});
