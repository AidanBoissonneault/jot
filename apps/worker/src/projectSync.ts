/**
 * @file Coordinates project-level synchronization for database-backed and legacy Notion layouts.
 * @author Aidan Boissonneault
 * @lastModified September 2026
 */

import type { NotionParentPage, Project } from '../../../src/types/capture.js';
import type { StoredPage, WorkerStore } from './types.js';

/** Describes the project page result contract used by this API feature. */
interface ProjectPageResult {
  id: string;
  project: Project;
  title: string;
  url?: string;
}

/** Describes the sync project folder options contract used by this API feature. */
interface SyncProjectFolderOptions {
  archiveProjectRootPage: (store: WorkerStore, pageId: string) => Promise<unknown>;
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
  ) => Promise<NotionParentPage>;
  pageSummary: (page: NotionParentPage) => NotionParentPage;
  project: Project;
  selectedParentPageId: string | undefined;
  store: WorkerStore;
}

/**
 * Synchronizes project metadata to the active Notion storage layout.
 * @param options - Project state, selected parent, worker store, and persistence dependencies.
 * @returns A saved project synchronization result.
 */
export async function syncProjectFolder({
  store,
  project,
  selectedParentPageId,
  ensureInkwellRootPage,
  ensureProjectPage,
  ensureProjectRootPage,
  archiveProjectRootPage,
  pageSummary,
}: SyncProjectFolderOptions) {
  if (project.status === 'archived') {
    if (ensureProjectPage) {
      const projectPage = await ensureProjectPage(store, project, { selectedParentPageId });

      return {
        project: projectPage.project,
        projectPage,
        status: 'saved',
        message: 'Archived project in Notion.',
      };
    }

    const stored: StoredPage | undefined = store.projectPages[project.id];

    if (!stored?.notionPageId) {
      return {
        status: 'saved',
        message: 'Project has no Notion folder to archive.',
      };
    }

    await archiveProjectRootPage(store, stored.notionPageId);
    delete store.projectPages[project.id];

    return {
      projectPage: pageSummary({
        id: stored.notionPageId,
        parentPageId: stored.parentPageId,
        title: stored.title || project.name || 'Untitled Project',
      }),
      status: 'saved',
      message: 'Archived project in Notion.',
    };
  }

  if (ensureProjectPage) {
    const projectPage = await ensureProjectPage(store, project, { selectedParentPageId });

    return {
      project: projectPage.project,
      projectPage,
      status: 'saved',
      message: 'Synced project to Notion database.',
    };
  }

  const inkwellRootPage = await ensureInkwellRootPage(store, { selectedParentPageId });
  const projectPage = await ensureProjectRootPage(store, inkwellRootPage.id, project);

  return {
    parentPage: inkwellRootPage,
    projectPage,
    status: 'saved',
    message: 'Synced project to Notion.',
  };
}
