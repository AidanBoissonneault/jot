import { beforeEach, describe, expect, test, vi } from 'vitest';
import { notionClient } from '@/src/services/notionClient';
import { listPendingSyncOps } from '@/src/services/syncQueue';
import type { Project, ProjectPage, SyncConfig, Workspace } from '@/src/types/capture';
import { doc, paragraph } from './helpers/docBuilders';
import { readBrowserStorage, resetBrowserStorage } from './setup';

const timestamp = '2026-01-01T00:00:00.000Z';
const accountId = 'notion:project-move-test';
const connectedConfig: SyncConfig = {
  serverUrl: 'http://localhost:8787',
  authenticated: true,
  connected: true,
  userId: accountId,
  syncQueueOwnerUserId: accountId,
  workspaceId: 'notion-workspace-project-moves',
  workspaceName: 'Notion',
};

function makeWorkspace(id: string, kind: Workspace['kind'], notionWorkspaceId?: string): Workspace {
  return {
    id,
    name: id,
    kind,
    accountId,
    ...(notionWorkspaceId ? { notionWorkspaceId } : {}),
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
    stateContent: doc([paragraph(`${id} state`)]),
    stateSyncBaselineContent: doc([paragraph(`${id} state`)]),
    stateRemoteRevision: 'remote-revision',
    tags: [],
  };
}

function makePage(id: string, project: Project, workspace: Workspace): ProjectPage {
  return {
    id,
    projectId: project.id,
    workspaceId: workspace.id,
    kind: 'page',
    title: id,
    status: 'active',
    content: doc([paragraph(`${id} content`)]),
    syncBaselineContent: doc([]),
    syncMode: workspace.kind,
    syncAccountId: accountId,
    syncWorkspaceId: workspace.kind === 'notion' ? workspace.notionWorkspaceId : undefined,
    ...(workspace.kind === 'notion' ? { notionPageId: `notion-${id}` } : {}),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function seedProjectMove(options: {
  currentWorkspace: Workspace;
  currentProject: Project;
  workspaces: Workspace[];
  projects: Project[];
  pages: ProjectPage[];
  syncConfig?: SyncConfig;
  currentProjectByWorkspace?: Record<string, string>;
}) {
  resetBrowserStorage({
    activePageIdsByProject: Object.fromEntries(options.pages.map((page) => [page.projectId, page.id])),
    currentProjectId: options.currentProject.id,
    currentProjectIdByWorkspace: options.currentProjectByWorkspace ?? {
      [options.currentWorkspace.id]: options.currentProject.id,
    },
    currentWorkspaceId: options.currentWorkspace.id,
    hasMigratedCapturesToPages: true,
    pages: options.pages,
    projects: options.projects,
    syncConfig: options.syncConfig ?? connectedConfig,
    workspaces: options.workspaces,
  });
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function installSyncMock() {
  const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const route = String(input).replace(connectedConfig.serverUrl, '');
    if (route === '/sync/project') {
      const body = JSON.parse(String(init?.body)) as { project: Project };
      return jsonResponse({ status: 'saved', project: body.project });
    }
    if (route.startsWith('/sync/retry')) {
      return jsonResponse({ requeuedCount: 0, requeuedOperationIds: [] });
    }
    if (route === '/sync/push') return jsonResponse({ queued: true, versions: {} });
    if (route === '/sync/status') return jsonResponse({ hasPending: false, failedCount: 0 });
    throw new Error(`Unexpected sync request: ${route}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(() => resetBrowserStorage());

describe('project workspace moves', () => {
  test('moves the selected local project and repairs both workspace selections', async () => {
    const source = makeWorkspace('workspace-project-source', 'local');
    const destination = makeWorkspace('workspace-project-destination', 'local');
    const movedProject = makeProject('project-to-move', source);
    const remainingProject = makeProject('project-remains', source);
    const destinationProject = makeProject('project-at-destination', destination);
    const movedPage = makePage('page-to-move', movedProject, source);
    const remainingPage = makePage('page-remains', remainingProject, source);
    const destinationPage = makePage('page-at-destination', destinationProject, destination);
    seedProjectMove({
      currentWorkspace: source,
      currentProject: movedProject,
      workspaces: [source, destination],
      projects: [movedProject, remainingProject, destinationProject],
      pages: [movedPage, remainingPage, destinationPage],
      currentProjectByWorkspace: {
        [source.id]: movedProject.id,
        [destination.id]: destinationProject.id,
      },
    });

    const result = await notionClient.moveProjectToWorkspace(movedProject.id, destination.id);
    const stored = readBrowserStorage();
    const storedProject = (stored.projects as Project[]).find((entry) => entry.id === movedProject.id);
    const storedPage = (stored.pages as ProjectPage[]).find((entry) => entry.id === movedPage.id);

    expect(result.workspaceId).toBe(destination.id);
    expect(storedProject).toMatchObject({ workspaceId: destination.id, syncMode: 'local', status: 'active' });
    expect(storedProject?.stateRemoteRevision).toBeUndefined();
    expect(storedPage).toMatchObject({ workspaceId: destination.id, syncMode: 'local' });
    expect(storedPage?.content.content?.[0]?.content?.[0]?.text).toBe('page-to-move content');
    expect(stored.currentWorkspaceId).toBe(destination.id);
    expect(stored.currentProjectId).toBe(movedProject.id);
    expect(stored.currentProjectIdByWorkspace).toMatchObject({
      [source.id]: remainingProject.id,
      [destination.id]: movedProject.id,
    });
  });

  test('moves local pages into Notion with the destination account scope', async () => {
    const source = makeWorkspace('workspace-project-local-to-notion', 'local');
    const destination = makeWorkspace(
      'workspace-project-notion-destination',
      'notion',
      connectedConfig.workspaceId,
    );
    const project = makeProject('project-local-to-notion', source);
    const page = makePage('page-local-to-notion', project, source);
    seedProjectMove({
      currentWorkspace: source,
      currentProject: project,
      workspaces: [source, destination],
      projects: [project],
      pages: [page],
      syncConfig: connectedConfig,
    });
    const fetchMock = installSyncMock();

    await notionClient.moveProjectToWorkspace(project.id, destination.id);

    const storedProject = (readBrowserStorage().projects as Project[])
      .find((entry) => entry.id === project.id);
    const storedPage = (readBrowserStorage().pages as ProjectPage[])
      .find((entry) => entry.id === page.id);
    const routes = fetchMock.mock.calls.map(([url]) => String(url).replace(connectedConfig.serverUrl, ''));
    expect(storedProject).toMatchObject({ workspaceId: destination.id, syncMode: 'notion' });
    expect(storedPage).toMatchObject({
      workspaceId: destination.id,
      syncMode: 'notion',
      syncAccountId: accountId,
      syncWorkspaceId: destination.notionWorkspaceId,
    });
    expect(routes).toContain('/sync/project');
    expect(routes).toContain('/sync/push');
    expect(await listPendingSyncOps()).toHaveLength(0);
  });

  test('archives a Notion project before moving its identity to a local workspace', async () => {
    const source = makeWorkspace(
      'workspace-project-notion-source',
      'notion',
      connectedConfig.workspaceId,
    );
    const destination = makeWorkspace('workspace-project-notion-to-local', 'local');
    const project = makeProject('project-notion-to-local', source);
    const page = makePage('page-notion-to-local', project, source);
    seedProjectMove({
      currentWorkspace: source,
      currentProject: project,
      workspaces: [source, destination],
      projects: [project],
      pages: [page],
      syncConfig: connectedConfig,
    });
    const fetchMock = installSyncMock();

    await notionClient.moveProjectToWorkspace(project.id, destination.id);

    const archiveRequest = fetchMock.mock.calls
      .filter(([url]) => String(url).endsWith('/sync/project'))
      .map(([, init]) => JSON.parse(String(init?.body)) as { project: Project });
    const storedProject = (readBrowserStorage().projects as Project[])
      .find((entry) => entry.id === project.id);
    const storedPage = (readBrowserStorage().pages as ProjectPage[])
      .find((entry) => entry.id === page.id);
    expect(archiveRequest[0]?.project.status).toBe('archived');
    expect(storedProject).toMatchObject({ workspaceId: destination.id, syncMode: 'local', status: 'active' });
    expect(storedProject?.stateRemoteRevision).toBeUndefined();
    expect(storedPage).toMatchObject({ workspaceId: destination.id, syncMode: 'local' });
    expect(storedPage?.notionPageId).toBeUndefined();
    expect(storedPage?.content.content?.[0]?.content?.[0]?.text).toBe('page-notion-to-local content');
  });

  test('does not move local data into Notion while disconnected', async () => {
    const source = makeWorkspace('workspace-project-disconnected-source', 'local');
    const destination = makeWorkspace(
      'workspace-project-disconnected-notion',
      'notion',
      connectedConfig.workspaceId,
    );
    const project = makeProject('project-disconnected-move', source);
    const page = makePage('page-disconnected-move', project, source);
    seedProjectMove({
      currentWorkspace: source,
      currentProject: project,
      workspaces: [source, destination],
      projects: [project],
      pages: [page],
      syncConfig: { ...connectedConfig, connected: false },
    });

    await expect(notionClient.moveProjectToWorkspace(project.id, destination.id))
      .rejects.toThrow('Sign in to the Notion account that should own this project.');
    expect((readBrowserStorage().projects as Project[])
      .find((entry) => entry.id === project.id)?.workspaceId).toBe(source.id);
    expect((readBrowserStorage().pages as ProjectPage[])
      .find((entry) => entry.id === page.id)?.workspaceId).toBe(source.id);
  });
});
