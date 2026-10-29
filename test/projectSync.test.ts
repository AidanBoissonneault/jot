import { describe, expect, it, vi } from 'vitest';
import { syncProjectFolder } from '@/apps/worker/src/projectSync';
import type { Project } from '@/src/types/capture';
import type { WorkerStore } from '@/apps/worker/src/types';

describe('project row sync', () => {
  it.each([
    ['active', 'Synced project to Notion database.'],
    ['archived', 'Archived project in Notion.'],
  ] as const)('syncs %s projects through the managed database', async (status, message) => {
    const project = { id: 'project-1', name: 'Project', status } as Project;
    const store = {} as WorkerStore;
    const projectPage = { id: 'project-row', project, title: project.name };
    const ensureProjectPage = vi.fn(async () => projectPage);

    const result = await syncProjectFolder({
      ensureProjectPage,
      project,
      selectedParentPageId: 'parent-page',
      store,
    });

    expect(ensureProjectPage).toHaveBeenCalledWith(store, project, {
      selectedParentPageId: 'parent-page',
    });
    expect(result).toEqual({ project, projectPage, status: 'saved', message });
  });
});
