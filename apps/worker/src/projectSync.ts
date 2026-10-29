/**
 * @file Synchronizes project rows in the managed Notion database.
 * @author Aidan Boissonneault
 * @lastModified September 2026
 */

import type { Project } from '../../../src/types/capture.js';
import type { WorkerStore } from './types.js';

/** Result returned by the managed project-row writer. */
interface ProjectPageResult {
  id: string;
  project: Project;
  title: string;
  url?: string;
}

interface SyncProjectFolderOptions {
  ensureProjectPage: (
    store: WorkerStore,
    project: Project,
    options: { selectedParentPageId: string | undefined },
  ) => Promise<ProjectPageResult>;
  project: Project;
  selectedParentPageId: string | undefined;
  store: WorkerStore;
}

/** Syncs one project row and returns the saved project state. */
export async function syncProjectFolder({
  store,
  project,
  selectedParentPageId,
  ensureProjectPage,
}: SyncProjectFolderOptions) {
  const projectPage = await ensureProjectPage(store, project, { selectedParentPageId });
  return {
    project: projectPage.project,
    projectPage,
    status: 'saved',
    message: project.status === 'archived'
      ? 'Archived project in Notion.'
      : 'Synced project to Notion database.',
  };
}
