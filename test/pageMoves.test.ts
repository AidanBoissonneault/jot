import { beforeEach, describe, expect, test } from 'vitest';
import { notionClient } from '@/src/services/notionClient';
import type { Project, ProjectPage, SyncConfig, Workspace } from '@/src/types/capture';
import { doc, paragraph } from './helpers/docBuilders';
import { readBrowserStorage, resetBrowserStorage } from './setup';

const timestamp = '2026-01-01T00:00:00.000Z';
const connectedConfig: SyncConfig = {
  serverUrl: 'http://localhost:8787',
  authenticated: true,
  connected: true,
  userId: 'notion:test-user',
  syncQueueOwnerUserId: 'notion:test-user',
};

function makeWorkspace(
  id: string,
  kind: Workspace['kind'] = 'local',
  accountId = 'notion:test-user',
): Workspace {
  return {
    id,
    name: id,
    kind,
    accountId,
    ...(kind === 'notion' ? { notionWorkspaceId: 'notion-workspace' } : {}),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function makeProject(id: string, workspace: Workspace): Project {
  return {
    id,
    name: id,
    workspaceId: workspace.id,
    syncMode: workspace.kind,
    status: 'active',
    createdAt: timestamp,
    updatedAt: timestamp,
    stateContent: doc([]),
    tags: [],
  };
}

function makePage(
  id: string,
  project: Project,
  workspace: Workspace,
  pageOrder = 0,
  content = doc([]),
): ProjectPage {
  return {
    id,
    projectId: project.id,
    workspaceId: workspace.id,
    kind: 'page',
    title: id,
    status: 'active',
    content,
    pageOrder,
    createdAt: timestamp,
    updatedAt: timestamp,
    syncMode: workspace.kind,
    syncAccountId: workspace.accountId,
    syncWorkspaceId: workspace.kind === 'notion' ? workspace.notionWorkspaceId : undefined,
  };
}

function seedMoveStorage(options: {
  currentProjectId: string;
  currentWorkspaceId: string;
  pages: ProjectPage[];
  projects: Project[];
  workspaces: Workspace[];
  syncConfig?: SyncConfig;
  activePageIdsByProject: Record<string, string>;
}) {
  resetBrowserStorage({
    activePageIdsByProject: options.activePageIdsByProject,
    currentProjectId: options.currentProjectId,
    currentProjectIdByWorkspace: { [options.currentWorkspaceId]: options.currentProjectId },
    currentWorkspaceId: options.currentWorkspaceId,
    hasMigratedCapturesToPages: true,
    pages: options.pages,
    projects: options.projects,
    syncConfig: options.syncConfig ?? connectedConfig,
    workspaces: options.workspaces,
  });
}

beforeEach(() => resetBrowserStorage());

describe('page ordering and moves', () => {
  test('reorders a page within its project without changing its identity', async () => {
    const workspace = makeWorkspace('workspace-local-order');
    const project = makeProject('project-order', workspace);
    const pages = ['page-one', 'page-two', 'page-three'].map((id, index) =>
      makePage(id, project, workspace, index),
    );
    seedMoveStorage({
      currentProjectId: project.id,
      currentWorkspaceId: workspace.id,
      activePageIdsByProject: { [project.id]: pages[0]!.id },
      pages,
      projects: [project],
      workspaces: [workspace],
    });

    const movedPage = await notionClient.movePageToProject('page-three', project.id, 'page-two', 'before');
    const activePages = (readBrowserStorage().pages as ProjectPage[])
      .filter((page) => page.projectId === project.id && page.status !== 'archived')
      .sort((first, second) => (first.pageOrder ?? 0) - (second.pageOrder ?? 0));

    expect(movedPage.id).toBe('page-three');
    expect(activePages.map((page) => page.id)).toEqual(['page-one', 'page-three', 'page-two']);
  });

  test('archives a moved page and creates a source replacement when it was the last page', async () => {
    const workspace = makeWorkspace('workspace-local-move');
    const sourceProject = makeProject('project-source', workspace);
    const destinationProject = makeProject('project-destination', workspace);
    const sourcePage = makePage(
      'page-source',
      sourceProject,
      workspace,
      0,
      doc([paragraph('keep this content')]),
    );
    const destinationPage = makePage('page-destination', destinationProject, workspace);
    seedMoveStorage({
      currentProjectId: sourceProject.id,
      currentWorkspaceId: workspace.id,
      activePageIdsByProject: {
        [sourceProject.id]: sourcePage.id,
        [destinationProject.id]: destinationPage.id,
      },
      pages: [sourcePage, destinationPage],
      projects: [sourceProject, destinationProject],
      workspaces: [workspace],
    });

    const movedPage = await notionClient.movePageToProject(
      sourcePage.id,
      destinationProject.id,
      destinationPage.id,
      'after',
    );
    const stored = readBrowserStorage();
    const pages = stored.pages as ProjectPage[];
    const sourceReplacement = pages.find((page) =>
      page.projectId === sourceProject.id && page.status !== 'archived',
    );

    expect(pages.find((page) => page.id === sourcePage.id)?.status).toBe('archived');
    expect(movedPage.id).not.toBe(sourcePage.id);
    expect(movedPage.content.content?.[0]?.content?.[0]?.text).toBe('keep this content');
    expect(sourceReplacement).toMatchObject({ projectId: sourceProject.id, status: 'active' });
    expect(stored.activePageIdsByProject).toMatchObject({
      [sourceProject.id]: sourceReplacement?.id,
      [destinationProject.id]: movedPage.id,
    });
    expect(stored.currentProjectId).toBe(destinationProject.id);
  });

  test('keeps existing selections when moving a non-current page without emptying its project', async () => {
    const workspace = makeWorkspace('workspace-local-selection');
    const sourceProject = makeProject('project-source-selection', workspace);
    const destinationProject = makeProject('project-destination-selection', workspace);
    const sourcePage = makePage('source-current', sourceProject, workspace, 0);
    const movedPage = makePage('source-to-move', sourceProject, workspace, 1);
    const destinationFirst = makePage('destination-first', destinationProject, workspace, 0);
    const destinationSelected = makePage('destination-selected', destinationProject, workspace, 1);
    seedMoveStorage({
      currentProjectId: sourceProject.id,
      currentWorkspaceId: workspace.id,
      activePageIdsByProject: {
        [sourceProject.id]: sourcePage.id,
        [destinationProject.id]: destinationSelected.id,
      },
      pages: [sourcePage, movedPage, destinationFirst, destinationSelected],
      projects: [sourceProject, destinationProject],
      workspaces: [workspace],
    });

    const newMovedPage = await notionClient.movePageToProject(
      movedPage.id,
      destinationProject.id,
      destinationSelected.id,
      'before',
    );
    const stored = readBrowserStorage();
    const pages = stored.pages as ProjectPage[];
    const destinationOrder = pages
      .filter((page) => page.projectId === destinationProject.id && page.status !== 'archived')
      .sort((first, second) => (first.pageOrder ?? 0) - (second.pageOrder ?? 0));

    expect(pages.find((page) => page.id === movedPage.id)?.status).toBe('archived');
    expect(pages.filter((page) => page.projectId === sourceProject.id && page.status !== 'archived'))
      .toHaveLength(1);
    expect(destinationOrder.map((page) => page.id)).toEqual([
      destinationFirst.id,
      newMovedPage.id,
      destinationSelected.id,
    ]);
    expect(stored.activePageIdsByProject).toMatchObject({
      [sourceProject.id]: sourcePage.id,
      [destinationProject.id]: destinationSelected.id,
    });
    expect(stored.currentProjectId).toBe(sourceProject.id);
  });

  test('rejects moving a page between local workspaces owned by different accounts', async () => {
    const sourceWorkspace = makeWorkspace('workspace-account-a', 'local', 'account-a');
    const destinationWorkspace = makeWorkspace('workspace-account-b', 'local', 'account-b');
    const sourceProject = makeProject('project-account-a', sourceWorkspace);
    const destinationProject = makeProject('project-account-b', destinationWorkspace);
    const sourcePage = makePage('page-account-a', sourceProject, sourceWorkspace);
    const destinationPage = makePage('page-account-b', destinationProject, destinationWorkspace);
    seedMoveStorage({
      currentProjectId: sourceProject.id,
      currentWorkspaceId: sourceWorkspace.id,
      activePageIdsByProject: {},
      pages: [sourcePage, destinationPage],
      projects: [sourceProject, destinationProject],
      workspaces: [sourceWorkspace, destinationWorkspace],
      syncConfig: { serverUrl: 'http://localhost:8787', connected: false, authenticated: false },
    });

    await expect(notionClient.movePageToProject(sourcePage.id, destinationProject.id))
      .rejects.toThrow('Projects and pages cannot move between different accounts.');
    expect((readBrowserStorage().pages as ProjectPage[])
      .find((page) => page.id === sourcePage.id)?.status).toBe('active');
  });

  test('requires an active Notion connection when either workspace is Notion-backed', async () => {
    const localWorkspace = makeWorkspace('workspace-local-connected');
    const notionWorkspace = makeWorkspace('workspace-notion-connected', 'notion');
    const localProject = makeProject('project-local-connected', localWorkspace);
    const notionProject = makeProject('project-notion-connected', notionWorkspace);
    const localPage = makePage('page-local-connected', localProject, localWorkspace);
    const notionPage = makePage('page-notion-connected', notionProject, notionWorkspace);
    seedMoveStorage({
      currentProjectId: localProject.id,
      currentWorkspaceId: localWorkspace.id,
      activePageIdsByProject: {},
      pages: [localPage, notionPage],
      projects: [localProject, notionProject],
      workspaces: [localWorkspace, notionWorkspace],
      syncConfig: { ...connectedConfig, connected: false, workspaceId: notionWorkspace.notionWorkspaceId },
    });

    await expect(notionClient.movePageToProject(localPage.id, notionProject.id))
      .rejects.toThrow('Sign in to the Notion account that should own this page.');
  });
});
