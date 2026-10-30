import { setActivePinia, createPinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { nextTick } from 'vue';
import { applySyncResult, notionClient } from '@/src/services/notionClient';
import { idbGetMany } from '@/src/services/idbStore';
import {
  addPendingProjectSyncEvent,
  compactPendingSyncOps,
  listPendingProjectSyncEvents,
  listPendingSyncOps,
} from '@/src/services/syncQueue';
import { useJottathingStore } from '@/src/stores/jottathing';
import type { DocumentContent, Project, ProjectPage, SyncConfig, Workspace } from '@/src/types/capture';
import type { SyncBlockOperation } from '@/src/types/sync';
import { readBrowserStorage, resetBrowserStorage } from './setup';
import { doc, paragraph, image } from './helpers/docBuilders';
import { sourceFromProjectState } from '@/src/extensions/sourceRegistry';

const originalFetch = globalThis.fetch;

type Deferred<T> = {
  promise: Promise<T>;
  reject: (error: unknown) => void;
  resolve: (value: T) => void;
};

class FakeSyncEventSource {
  onerror: ((event: Event) => unknown) | null = null;
  onmessage: ((event: MessageEvent) => unknown) | null = null;
  onopen: ((event: Event) => unknown) | null = null;
  closed = false;

  constructor() {
    queueMicrotask(() => this.onopen?.(new Event('open')));
  }

  close(): void {
    this.closed = true;
  }

  emit(message: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(message) } as MessageEvent);
  }
}

const testSyncEventSources: FakeSyncEventSource[] = [];

const baseProject: Project = {
  id: 'project-jottathing',
  name: 'Jottathing',
  status: 'active',
  category: 'General',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  stateContent: emptyDocument(),
  stateSyncBaselineContent: emptyDocument(),
  tags: ['jottathing'],
  syncState: 'saved',
};
const basePage: ProjectPage = {
  id: 'page-jottathing',
  projectId: 'project-jottathing',
  kind: 'page',
  title: 'Untitled Page',
  status: 'active',
  content: emptyDocument(),
  syncBaselineContent: emptyDocument(),
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  syncState: 'saved',
};
const connectedConfig: SyncConfig = {
  serverUrl: 'http://localhost:8787',
  authenticated: true,
  connected: true,
  userId: 'notion:test-user',
  syncQueueOwnerUserId: 'notion:test-user',
};
const testNotionWorkspace: Workspace = {
  id: 'workspace-notion-notion%3Atest-user-unknown',
  name: 'Notion workspace',
  kind: 'notion',
  accountId: 'notion:test-user',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};
const notionTestProject: Project = {
  ...baseProject,
  workspaceId: testNotionWorkspace.id,
  syncMode: 'notion',
};
const notionTestPage: ProjectPage = {
  ...basePage,
  workspaceId: testNotionWorkspace.id,
  syncMode: 'notion',
  syncAccountId: testNotionWorkspace.accountId,
};

beforeEach(() => {
  setActivePinia(createPinia());
  testSyncEventSources.length = 0;
  vi.stubGlobal('EventSource', class extends FakeSyncEventSource {
    constructor(url: string, options?: EventSourceInit) {
      super();
      testSyncEventSources.push(this);
      void url;
      void options;
    }
  } as unknown as typeof EventSource);
  resetBrowserStorage({
    activePageIdsByProject: { 'project-jottathing': 'page-jottathing' },
    currentProjectId: 'project-jottathing',
    hasMigratedCapturesToPages: true,
    pages: [basePage],
    projects: [baseProject],
    syncConfig: connectedConfig,
  });
  vi.clearAllMocks();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.stubGlobal('fetch', originalFetch);
});

describe('local workspace defaults', () => {
  test('creates a starter project and page owned by the active account', async () => {
    const workspace = await notionClient.createLocalWorkspace('  Research  ');
    const stored = readBrowserStorage();
    const project = (stored.projects as Project[]).find((entry) => entry.workspaceId === workspace.id);
    const page = (stored.pages as ProjectPage[]).find((entry) => entry.projectId === project?.id);

    expect(workspace.name).toBe('Research');
    expect(project).toMatchObject({ workspaceId: workspace.id, syncMode: 'local' });
    expect(page).toMatchObject({
      projectId: project?.id,
      workspaceId: workspace.id,
      syncAccountId: 'notion:test-user',
      syncMode: 'local',
    });
    expect(stored.currentWorkspaceId).toBe(workspace.id);
    expect(stored.activePageIdsByProject).toMatchObject({ [project?.id ?? '']: page?.id });
  });

  test('keeps stored projects without the retired capture migration', async () => {
    const retiredProjects = ['project-product-research', 'project-writing'].map((id) => ({
      ...baseProject,
      id,
      name: id,
    }));
    resetBrowserStorage({
      projects: retiredProjects,
      pages: [],
      captures: [{ id: 'old-capture', projectId: retiredProjects[0].id }],
      hasMigratedCapturesToPages: false,
      activePageIdsByProject: {},
      currentProjectId: retiredProjects[0].id,
      syncConfig: connectedConfig,
    });

    await notionClient.createLocalWorkspace('Research');

    const stored = readBrowserStorage();
    expect((stored.projects as Project[]).map((project) => project.id)).toEqual(
      expect.arrayContaining(retiredProjects.map((project) => project.id)),
    );
    expect((stored.pages as ProjectPage[]).map((page) => page.projectId)).toEqual(
      expect.arrayContaining(retiredProjects.map((project) => project.id)),
    );
  });
});

describe('workspace sync status', () => {
  test('uses the highest page state and keeps the first message when states tie', async () => {
    const workspace: Workspace = {
      id: 'workspace-local-status',
      name: 'Local notes',
      kind: 'local',
      accountId: 'notion:test-user',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const project = {
      ...baseProject,
      workspaceId: workspace.id,
      syncMode: 'local' as const,
    };
    const pages: ProjectPage[] = [
      {
        ...basePage,
        id: 'page-stale',
        projectId: project.id,
        workspaceId: workspace.id,
        syncMode: 'local',
        syncState: 'stale',
        syncMessage: 'older warning',
      },
      {
        ...basePage,
        id: 'page-error-first',
        projectId: project.id,
        workspaceId: workspace.id,
        syncMode: 'local',
        syncState: 'error',
        syncMessage: 'first error',
      },
      {
        ...basePage,
        id: 'page-error-second',
        projectId: project.id,
        workspaceId: workspace.id,
        syncMode: 'local',
        syncState: 'error',
        syncMessage: 'second error',
      },
    ];
    resetBrowserStorage({
      activePageIdsByProject: { [project.id]: pages[0]!.id },
      currentProjectId: project.id,
      currentProjectIdByWorkspace: { [workspace.id]: project.id },
      currentWorkspaceId: workspace.id,
      hasMigratedCapturesToPages: true,
      pages,
      projects: [project],
      syncConfig: connectedConfig,
      workspaces: [workspace],
    });

    const [visibleProject] = await notionClient.listProjects();
    const [visibleWorkspace] = await notionClient.listWorkspaces();

    expect(visibleProject).toMatchObject({ syncState: 'error', syncMessage: 'first error' });
    expect(visibleWorkspace).toMatchObject({ syncState: 'error', syncMessage: 'first error' });
  });
});

describe('optimistic project creation', () => {
  test('sync payload includes project database metadata defaults', async () => {
    const projectSync = deferred<Response>();
    const fetchMock = vi.fn(() => projectSync.promise);
    vi.stubGlobal('fetch', fetchMock);
    const store = useJottathingStore();

    await seedNotionStore(store);
    await store.createProject('Roadmap');
    const requestBody = await waitForFirstRequest(fetchMock);

    expect(requestBody.project.category).toBe('');
    expect(requestBody.project.createdAt).toEqual(expect.any(String));
    expect(requestBody.project.updatedAt).toEqual(expect.any(String));
    expect(stripJottathingBlockIds(requestBody.project.stateContent)).toEqual(emptyDocument());
  });

  test('appears and is selected before project sync settles', async () => {
    const { projectSync, store } = await setupProjectSyncTest('Roadmap');

    expect(store.currentProjectId).toMatch(/^temp-project-/);
    expect(store.currentPage?.id).toMatch(/^temp-page-/);
    expect(store.projects.at(-1)?.name).toBe('Roadmap');
    expect(store.saveStatus).toBe('creating');

    projectSync.resolve(jsonResponse({ status: 'saved', queued: true, versions: {} }));
    await waitFor(() => expect(store.saveStatus).not.toBe('creating'));
  });

  test('applies an immediate rename to the durable project ID after creation settles', async () => {
    const projectSync = deferred<Response>();
    const fetchMock = vi.fn(() => projectSync.promise);
    vi.stubGlobal('fetch', fetchMock);
    const workspace: Workspace = {
      id: 'workspace-notion-notion%3Atest-user-unknown',
      name: 'Notion',
      kind: 'notion',
      accountId: 'notion:test-user',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    resetBrowserStorage({
      activePageIdsByProject: { [baseProject.id]: basePage.id },
      currentProjectId: baseProject.id,
      currentWorkspaceId: workspace.id,
      hasMigratedCapturesToPages: true,
      pages: [notionTestPage],
      projects: [notionTestProject],
      syncConfig: connectedConfig,
      workspaces: [workspace],
    });
    const store = useJottathingStore();
    await seedStore(store);
    await notionClient.setCurrentWorkspaceId(workspace.id);
    store.currentWorkspaceId = workspace.id;
    store.workspaces = [workspace];
    await store.createProject('Untitled Project');
    const temporaryProjectId = store.currentProjectId;
    const rename = store.renameCurrentProject('My Project');

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await flushPromises(5);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    projectSync.resolve(jsonResponse({ status: 'saved', queued: true, versions: {} }));
    await rename;
    await waitFor(() => {
      const requests = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>;
      expect(requests.filter(([url]) => url.endsWith('/sync/project'))).toHaveLength(2);
    });

    const requests = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>;
    const projectBodies = requests
      .filter(([url]) => url.endsWith('/sync/project'))
      .map(([, init]) => JSON.parse(String(init.body)) as { project: Project });
    expect(projectBodies[0]?.project.id).not.toBe(temporaryProjectId);
    expect(projectBodies[1]?.project.id).toBe(projectBodies[0]?.project.id);
    expect(projectBodies[1]?.project.name).toBe('My Project');
  });

  test('uploads the latest first-page edit made while project creation is still syncing', async () => {
    const projectSync = deferred<Response>();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) =>
      String(input).endsWith('/sync/project')
        ? projectSync.promise
        : jsonResponse({ queued: true, versions: {} }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const workspace: Workspace = {
      id: 'workspace-notion-notion%3Atest-user-unknown',
      name: 'Notion',
      kind: 'notion',
      accountId: 'notion:test-user',
      notionWorkspaceId: 'notion-workspace',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    resetBrowserStorage({
      activePageIdsByProject: { [baseProject.id]: basePage.id },
      currentProjectId: baseProject.id,
      currentProjectIdByWorkspace: { [workspace.id]: baseProject.id },
      currentWorkspaceId: workspace.id,
      hasMigratedCapturesToPages: true,
      pages: [{
        ...basePage,
        workspaceId: workspace.id,
        syncMode: 'notion',
        syncAccountId: workspace.accountId,
        syncWorkspaceId: workspace.notionWorkspaceId,
      }],
      projects: [{ ...baseProject, workspaceId: workspace.id, syncMode: 'notion' }],
      syncConfig: { ...connectedConfig, workspaceId: workspace.notionWorkspaceId },
      workspaces: [workspace],
    });

    const creation = await notionClient.createProject('Untitled Project', {
      workspaceId: workspace.id,
    });
    try {
      await waitFor(() => expect((fetchMock.mock.calls as unknown as Array<[string]>).some(([url]) =>
        url.endsWith('/sync/project'),
      )).toBe(true));
      const projectRequest = JSON.parse(String(
        (fetchMock.mock.calls as unknown as Array<[string, RequestInit]>).find(([url]) =>
          url.endsWith('/sync/project'),
        )?.[1]?.body,
      )) as { project: Project };
      const editedContent = docWithText('first page edit during creation');
      const editedPage = await notionClient.updateProjectPage({
        ...creation.page,
        content: editedContent,
      });

      expect(editedPage.id).not.toBe(creation.page.id);
      expect(editedPage.projectId).toBe(projectRequest.project.id);
      projectSync.resolve(jsonResponse({ status: 'saved' }));
      const settled = await creation.settled;
      await waitFor(() => expect((fetchMock.mock.calls as unknown as Array<[string, RequestInit]>).some(
        ([url, request]) => url.endsWith('/sync/push') &&
          String(request.body).includes('first page edit during creation'),
      )).toBe(true));

      expect(settled.page.projectId).toBe(projectRequest.project.id);
      expect(stripJottathingBlockIds(settled.page.content)).toEqual(editedContent);
    } finally {
      projectSync.resolve(jsonResponse({ status: 'saved' }));
    }
  });

  test('reconciles temp ids and preserves a project switch during sync', async () => {
    const { projectSync, store } = await setupProjectSyncTest('Roadmap');
    const tempProjectId = store.currentProjectId;
    await store.selectProject('project-jottathing');

    projectSync.resolve(jsonResponse({ status: 'saved' }));
    await waitFor(() =>
      expect(store.projects.some((project) => project.id === tempProjectId)).toBe(false),
    );

    expect(store.currentProjectId).toBe('project-jottathing');
    expect(readBrowserStorage().currentProjectId).toBe('project-jottathing');
    expect(readBrowserStorage().currentProjectIdByWorkspace).toMatchObject({
      [testNotionWorkspace.id]: 'project-jottathing',
    });
    expect((readBrowserStorage().projects as Project[]).some((project) =>
      project.id.startsWith('temp-project-'),
    )).toBe(false);
  });

  test('keeps a new project locally and queues it when sync fails', async () => {
    const { projectSync, store } = await setupProjectSyncTest('Broken');
    const tempProjectId = store.currentProjectId;

    const syncFailure = expect(projectSync.promise).rejects.toThrow('Notion unavailable');
    projectSync.reject(new Error('Notion unavailable'));
    await syncFailure;
    await waitFor(() => {
      expect(store.currentProjectId).not.toBe(tempProjectId);
      expect(store.saveStatus).not.toBe('creating');
    });

    expect(store.currentProject?.name).toBe('Broken');
    expect(store.projects.some((project) => project.id === tempProjectId)).toBe(false);
    expect(await notionClient.pendingSyncEventCount()).toBeGreaterThan(0);
  });
});

describe('logout credential cleanup', () => {
  test('scrubs live account tokens even if durable local cleanup fails', async () => {
    const store = useJottathingStore();
    store.syncConfig = {
      ...connectedConfig,
      accessToken: 'legacy-live-access-token',
      refresh_token: 'legacy-live-refresh-token',
    } as SyncConfig;
    vi.spyOn(notionClient, 'logoutSyncSession').mockRejectedValueOnce(
      new Error('local storage unavailable'),
    );

    await expect(store.logout()).resolves.toBe(false);

    expect(store.syncConfig).not.toHaveProperty('accessToken');
    expect(store.syncConfig).not.toHaveProperty('refresh_token');
    expect(store.syncConfig.userId).toBe(connectedConfig.userId);
    expect(store.syncConfig.connected).toBe(false);
  });

  test('exposes a retry path after local logout when server cleanup is pending', async () => {
    const store = useJottathingStore();
    store.syncConfig = { ...connectedConfig };
    const logout = vi.spyOn(notionClient, 'logoutSyncSession')
      .mockResolvedValueOnce({
        notionTokenRevoked: false,
        serverDataCleanupComplete: false,
        syncConfig: {
          ...connectedConfig,
          authenticated: false,
          connected: false,
          logoutCleanupPending: true,
        },
      })
      .mockResolvedValueOnce({
        notionTokenRevoked: true,
        serverDataCleanupComplete: true,
        syncConfig: {
          ...connectedConfig,
          authenticated: false,
          connected: false,
          logoutCleanupPending: false,
        },
      });

    await expect(store.logout()).resolves.toBe(true);
    expect(store.syncConfig.logoutCleanupPending).toBe(true);

    await expect(store.retryLogoutCleanup()).resolves.toBe(true);
    expect(store.syncConfig.logoutCleanupPending).toBe(false);
    expect(logout).toHaveBeenCalledTimes(2);
  });
});

describe('project metadata', () => {
  test('shows Notion page search loading and ignores stale search results', async () => {
    const firstSearch = deferred<Awaited<ReturnType<typeof notionClient.listNotionParentPages>>>();
    const secondSearch = deferred<Awaited<ReturnType<typeof notionClient.listNotionParentPages>>>();
    vi.spyOn(notionClient, 'listNotionParentPages')
      .mockReturnValueOnce(firstSearch.promise)
      .mockReturnValueOnce(secondSearch.promise);
    const store = useJottathingStore();

    const firstRequest = store.loadNotionParentPages('first');
    expect(store.isLoadingNotionParentPages).toBe(true);
    const secondRequest = store.loadNotionParentPages('second');
    secondSearch.resolve([{ id: 'new-result', title: 'Latest result' }]);
    await secondRequest;

    expect(store.isLoadingNotionParentPages).toBe(false);
    expect(store.notionParentPages).toEqual([{ id: 'new-result', title: 'Latest result' }]);

    firstSearch.resolve([{ id: 'old-result', title: 'Stale result' }]);
    await firstRequest;
    expect(store.notionParentPages).toEqual([{ id: 'new-result', title: 'Latest result' }]);
  });

  test('makes a captured origin available before its network sync finishes', async () => {
    const sourceSync = deferred<Response>();
    vi.stubGlobal('fetch', vi.fn(() => sourceSync.promise));
    const store = useJottathingStore();
    await seedStore(store);

    const registration = store.registerCurrentProjectSource('capture-block', {
      text: 'Dragged text',
      sourceUrl: 'https://example.com/article',
      pageTitle: 'Article',
      highlightMeta: {
        text: 'Dragged text',
        sourceLink: 'https://example.com/article#:~:text=Dragged%20text',
      },
    });

    expect(sourceFromProjectState(
      store.currentProject?.stateContent,
      'capture-block',
    )).toMatchObject({ sourceUrl: 'https://example.com/article' });

    sourceSync.resolve(jsonResponse({ status: 'saved' }));
    await registration;
  });

  test('validateNotionCache uncaches missing Notion project and page metadata', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        clearSelectedParentPage: true,
        uncachedProjectIds: ['project-jottathing'],
        uncachedPageIds: ['page-jottathing'],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    resetBrowserStorage({
      activePageIdsByProject: { 'project-jottathing': 'page-jottathing' },
      currentProjectId: 'project-jottathing',
      hasMigratedCapturesToPages: true,
      pages: [
        {
          ...basePage,
          notionPageId: 'missing-thread',
          notionParentPageId: 'missing-project-page',
          notionLastEditedTime: 'remote-time',
          remoteRevision: 'remote-time',
          syncMessage: 'Stale',
          syncState: 'stale',
        },
      ],
      projects: [
        {
          ...baseProject,
          stateRemoteRevision: 'remote-state',
          syncMessage: 'Stale',
          syncState: 'stale',
        },
      ],
      syncConfig: {
        ...connectedConfig,
        selectedParentPageId: 'missing-root',
        selectedParentPageTitle: 'Missing root',
      },
    });

    await notionClient.validateNotionCache();
    const storage = readBrowserStorage();
    const [page] = storage.pages as ProjectPage[];
    const [project] = storage.projects as Project[];

    expect(page.notionPageId).toBeUndefined();
    expect(page.notionParentPageId).toBeUndefined();
    expect(page.remoteRevision).toBeUndefined();
    expect(page.syncState).toBe('saved');
    expect(project.stateRemoteRevision).toBeUndefined();
    expect(project.syncState).toBe('saved');
    expect((storage.syncConfig as SyncConfig).selectedParentPageId).toBeUndefined();
  });

  test('reloadFromNotion replaces local projects and pages and preserves sync config', async () => {
    const reloadedProject: Project = {
      ...baseProject,
      id: 'project-remote',
      name: 'Remote',
      category: 'Remote',
      updatedAt: '2026-01-03T00:00:00.000Z',
      tags: ['Remote'],
    };
    const reloadedPage: ProjectPage = {
      ...basePage,
      id: 'page-remote',
      projectId: 'project-remote',
      title: 'Remote page',
      notionPageId: 'thread-remote',
      notionParentPageId: 'project-page-remote',
      notionLastEditedTime: '2026-01-03T00:00:00.000Z',
      remoteRevision: '2026-01-03T00:00:00.000Z',
    };
    const syncConfig = {
      ...connectedConfig,
      selectedParentPageId: 'parent-page',
      selectedParentPageTitle: 'Parent',
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ hasPending: false }))
      .mockResolvedValueOnce(jsonResponse({
        activePageIdsByProject: { 'project-remote': 'page-remote' },
        currentProjectId: 'missing-local-project',
        pages: [reloadedPage],
        projects: [reloadedProject],
        status: 'saved',
      }));
    vi.stubGlobal('fetch', fetchMock);
    resetBrowserStorage({
      activePageIdsByProject: { [notionTestProject.id]: notionTestPage.id },
      currentProjectId: notionTestProject.id,
      currentProjectIdByWorkspace: { [testNotionWorkspace.id]: notionTestProject.id },
      currentWorkspaceId: testNotionWorkspace.id,
      hasMigratedCapturesToPages: true,
      pages: [notionTestPage, { ...notionTestPage, id: 'page-deleted' }],
      projects: [notionTestProject],
      syncConfig,
      workspaces: [testNotionWorkspace],
    });
    const store = useJottathingStore();

    await seedStore(store, [notionTestPage]);
    store.syncConfig = syncConfig;
    store.workspaces = [testNotionWorkspace];
    store.currentWorkspaceId = testNotionWorkspace.id;
    await store.reloadFromNotion();
    const storage = readBrowserStorage();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(store.currentProjectId).toBe('project-remote');
    expect(store.currentPage?.id).toBe('page-remote');
    expect(store.pages.map((page) => page.id)).toEqual(['page-remote']);
    expect((storage.pages as ProjectPage[])
      .filter((page) => page.workspaceId === testNotionWorkspace.id)
      .map((page) => page.id)).toEqual(['page-remote']);
    expect((storage.projects as Project[])
      .filter((project) => project.workspaceId === testNotionWorkspace.id)
      .map((project) => project.id)).toEqual(['project-remote']);
    expect((storage.syncConfig as SyncConfig).selectedParentPageId).toBe('parent-page');
  });

  test('reloadFromNotion preserves the selected project and page when they still exist', async () => {
    const secondProject: Project = {
      ...notionTestProject,
      id: 'project-career',
      name: 'Career Prep',
    };
    const selectedPage: ProjectPage = {
      ...notionTestPage,
      id: 'page-career-selected',
      projectId: secondProject.id,
      title: 'LinkedIn Demo',
    };
    const serverActivePage: ProjectPage = {
      ...notionTestPage,
      id: 'page-career-server-active',
      projectId: secondProject.id,
      title: 'Another page',
    };
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(jsonResponse({ hasPending: false }))
      .mockResolvedValueOnce(jsonResponse({
        activePageIdsByProject: {
          [notionTestProject.id]: notionTestPage.id,
          [secondProject.id]: serverActivePage.id,
        },
        currentProjectId: notionTestProject.id,
        pages: [notionTestPage, selectedPage, serverActivePage],
        projects: [notionTestProject, secondProject],
        status: 'saved',
      })));
    resetBrowserStorage({
      activePageIdsByProject: {
        [notionTestProject.id]: notionTestPage.id,
        [secondProject.id]: selectedPage.id,
      },
      currentProjectId: secondProject.id,
      currentProjectIdByWorkspace: { [testNotionWorkspace.id]: secondProject.id },
      currentWorkspaceId: testNotionWorkspace.id,
      hasMigratedCapturesToPages: true,
      pages: [notionTestPage, selectedPage],
      projects: [notionTestProject, secondProject],
      syncConfig: connectedConfig,
      workspaces: [testNotionWorkspace],
    });

    const reloaded = await notionClient.reloadFromNotion({ force: true });
    const storage = readBrowserStorage();

    expect(reloaded.currentProjectId).toBe(secondProject.id);
    expect((storage.activePageIdsByProject as Record<string, string>)[secondProject.id])
      .toBe(selectedPage.id);
  });

  test('manual reload keeps the selected page instead of choosing the first page', async () => {
    const secondProject: Project = {
      ...notionTestProject,
      id: 'project-career',
      name: 'Career Prep',
    };
    const selectedPage: ProjectPage = {
      ...notionTestPage,
      id: 'page-career-selected',
      projectId: secondProject.id,
      title: 'LinkedIn Demo',
    };
    const firstPage: ProjectPage = {
      ...notionTestPage,
      id: 'page-career-first',
      projectId: secondProject.id,
      title: 'First page',
    };
    const store = useJottathingStore();
    await seedStore(store, [notionTestPage, selectedPage]);
    store.projects = [notionTestProject, secondProject];
    store.pages = [selectedPage, firstPage];
    store.currentProjectId = secondProject.id;
    store.workspaces = [testNotionWorkspace];
    store.currentWorkspaceId = testNotionWorkspace.id;
    store.currentPage = selectedPage;
    const reload = vi.spyOn(notionClient, 'reloadFromNotion').mockResolvedValue({
      currentProjectId: secondProject.id,
      pages: [firstPage, selectedPage],
      projects: [notionTestProject, secondProject],
      syncConfig: connectedConfig,
    });
    const listPages = vi.spyOn(notionClient, 'listProjectPages')
      .mockResolvedValue([firstPage, selectedPage]);
    const getPage = vi.spyOn(notionClient, 'getProjectPage').mockResolvedValue(selectedPage);

    try {
      await store.reloadFromNotion();

      expect(reload).toHaveBeenCalledWith({ force: true });
      expect(store.currentProjectId).toBe(secondProject.id);
      expect(store.currentPage?.id).toBe(selectedPage.id);
    } finally {
      reload.mockRestore();
      listPages.mockRestore();
      getPage.mockRestore();
    }
  });

  test('reloadFromNotion refreshes for a structural change without stale or new sync rows', async () => {
    const remotePage: ProjectPage = {
      ...notionTestPage,
      id: 'page-created-elsewhere',
      title: 'Ravens Heart',
      notionPageId: 'thread-created-elsewhere',
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        aheadPageIds: [],
        failedPageIds: [],
        newPageIds: [],
        stalePageIds: [],
        workspaceChanged: true,
      }))
      .mockResolvedValueOnce(jsonResponse({ hasPending: false }))
      .mockResolvedValueOnce(jsonResponse({
        activePageIdsByProject: { [notionTestProject.id]: remotePage.id },
        currentProjectId: notionTestProject.id,
        pages: [remotePage],
        projects: [notionTestProject],
        status: 'saved',
      }));
    vi.stubGlobal('fetch', fetchMock);
    resetBrowserStorage({
      activePageIdsByProject: { [notionTestProject.id]: notionTestPage.id },
      currentProjectId: notionTestProject.id,
      currentProjectIdByWorkspace: { [testNotionWorkspace.id]: notionTestProject.id },
      currentWorkspaceId: testNotionWorkspace.id,
      hasMigratedCapturesToPages: true,
      pages: [notionTestPage],
      projects: [notionTestProject],
      syncConfig: connectedConfig,
      workspaces: [testNotionWorkspace],
    });

    const reloaded = await notionClient.reloadFromNotion();

    expect(reloaded.pages.filter((page) => page.workspaceId === testNotionWorkspace.id)
      .map((page) => page.title)).toEqual(['Ravens Heart']);
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      'http://localhost:8787/sync/validate',
      'http://localhost:8787/sync/status',
      'http://localhost:8787/sync/reload',
    ]);
  });

  test('reloadFromNotion clears selected parent when server reports it invalid', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(jsonResponse({ hasPending: false }))
      .mockResolvedValueOnce(jsonResponse({
        activePageIdsByProject: {},
        clearSelectedParentPage: true,
        currentProjectId: '',
        pages: [],
        projects: [],
        status: 'saved',
      })));
    resetBrowserStorage({
      activePageIdsByProject: { [notionTestProject.id]: notionTestPage.id },
      currentProjectId: notionTestProject.id,
      currentProjectIdByWorkspace: { [testNotionWorkspace.id]: notionTestProject.id },
      currentWorkspaceId: testNotionWorkspace.id,
      hasMigratedCapturesToPages: true,
      pages: [notionTestPage],
      projects: [notionTestProject],
      syncConfig: {
        ...connectedConfig,
        selectedParentPageId: 'missing-parent',
        selectedParentPageTitle: 'Missing',
      },
      workspaces: [testNotionWorkspace],
    });

    await notionClient.reloadFromNotion({ force: true });
    const storage = readBrowserStorage();

    expect((storage.syncConfig as SyncConfig).selectedParentPageId).toBeUndefined();
    expect((storage.syncConfig as SyncConfig).selectedParentPageTitle).toBeUndefined();
    await expect(notionClient.listProjects()).resolves.toEqual([]);
  });

  test('waits for accepted server jobs before reloading the Notion snapshot', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ hasPending: true }))
      .mockResolvedValueOnce(jsonResponse({ hasPending: false }))
      .mockResolvedValueOnce(jsonResponse({
        activePageIdsByProject: {},
        currentProjectId: '',
        pages: [],
        projects: [],
        status: 'saved',
      }));
    vi.stubGlobal('fetch', fetchMock);
    resetBrowserStorage({
      activePageIdsByProject: { 'project-jottathing': 'page-jottathing' },
      currentProjectId: 'project-jottathing',
      hasMigratedCapturesToPages: true,
      pages: [basePage],
      projects: [baseProject],
      syncConfig: connectedConfig,
    });

    const reload = notionClient.reloadFromNotion({ force: true });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(testSyncEventSources).toHaveLength(1));
    testSyncEventSources[0]?.emit({ status: 'queue_idle' });
    await reload;

    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      'http://localhost:8787/sync/status',
      'http://localhost:8787/sync/status',
      'http://localhost:8787/sync/reload',
    ]);
  });

  test('rechecks once when a queue idle event arrives during the initial status request', async () => {
    const pendingStatus = deferred<Response>();
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => pendingStatus.promise)
      .mockResolvedValueOnce(jsonResponse({ hasPending: false }))
      .mockResolvedValueOnce(jsonResponse({
        activePageIdsByProject: {},
        currentProjectId: '',
        pages: [],
        projects: [],
        status: 'saved',
      }));
    vi.stubGlobal('fetch', fetchMock);
    resetBrowserStorage({
      activePageIdsByProject: { 'project-jottathing': 'page-jottathing' },
      currentProjectId: 'project-jottathing',
      hasMigratedCapturesToPages: true,
      pages: [basePage],
      projects: [baseProject],
      syncConfig: connectedConfig,
    });

    const reload = notionClient.reloadFromNotion({ force: true });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    testSyncEventSources[0]?.emit({ status: 'queue_idle' });
    pendingStatus.resolve(jsonResponse({ hasPending: true }));
    await reload;

    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      'http://localhost:8787/sync/status',
      'http://localhost:8787/sync/status',
      'http://localhost:8787/sync/reload',
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  test('keeps a fetched snapshot when server progress events update local sync metadata', async () => {
    const versionedPage: ProjectPage = {
      ...basePage,
      notionPageId: 'notion-page-local',
      knownSyncVersion: 1,
      serverSyncVersion: 1,
    };
    const remoteOnlyPage: ProjectPage = {
      ...basePage,
      id: 'page-from-another-instance',
      title: 'Created remotely',
      notionPageId: 'notion-page-remote',
    };
    const reloadResponse = deferred<Response>();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ hasPending: true }))
      .mockResolvedValueOnce(jsonResponse({ hasPending: false }))
      .mockImplementationOnce(() => reloadResponse.promise);
    vi.stubGlobal('fetch', fetchMock);
    resetBrowserStorage({
      activePageIdsByProject: { 'project-jottathing': versionedPage.id },
      currentProjectId: 'project-jottathing',
      hasMigratedCapturesToPages: true,
      pages: [versionedPage],
      projects: [baseProject],
      syncConfig: connectedConfig,
    });

    const reload = notionClient.reloadFromNotion({ force: true });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await applySyncResult({
      status: 'synced',
      pageId: versionedPage.id,
      version: 2,
    });
    testSyncEventSources[0]?.emit({ status: 'queue_idle' });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    await applySyncResult({
      status: 'synced',
      pageId: versionedPage.id,
      version: 3,
    });
    reloadResponse.resolve(jsonResponse({
        activePageIdsByProject: { 'project-jottathing': versionedPage.id },
        currentProjectId: 'project-jottathing',
        pages: [versionedPage, remoteOnlyPage],
        projects: [baseProject],
        status: 'saved',
    }));
    await reload;

    expect((readBrowserStorage().pages as ProjectPage[]).map((page) => page.id))
      .toContain(remoteOnlyPage.id);
  });

  test('does not mark remote content current until its newer version is pulled', async () => {
    const versionedPage: ProjectPage = {
      ...basePage,
      notionPageId: 'thread-remote',
      knownSyncVersion: 3,
      serverSyncVersion: 3,
    };
    resetBrowserStorage({
      activePageIdsByProject: { 'project-jottathing': versionedPage.id },
      currentProjectId: 'project-jottathing',
      hasMigratedCapturesToPages: true,
      pages: [versionedPage],
      projects: [baseProject],
      syncConfig: connectedConfig,
    });

    const updated = await applySyncResult({
      status: 'synced',
      pageId: versionedPage.id,
      version: 4,
    });

    expect(updated?.serverSyncVersion).toBe(4);
    expect(updated?.knownSyncVersion).toBe(3);
    expect((readBrowserStorage().pages as ProjectPage[])[0]?.knownSyncVersion).toBe(3);
  });

  test('resync reloads server-only pages after queued local work finishes', async () => {
    const linkedPage: ProjectPage = {
      ...basePage,
      notionPageId: 'notion-page-local',
    };
    resetBrowserStorage({
      activePageIdsByProject: { 'project-jottathing': linkedPage.id },
      currentProjectId: 'project-jottathing',
      hasMigratedCapturesToPages: true,
      pages: [linkedPage],
      projects: [baseProject],
      syncConfig: connectedConfig,
    });
    await notionClient.updateProjectPage({
      ...linkedPage,
      content: docWithText('queued local edit'),
    });
    expect(await notionClient.pendingSyncEventCount()).toBeGreaterThan(0);

    const remoteOnlyPage: ProjectPage = {
      ...basePage,
      id: 'page-present-only-on-server',
      title: 'Server only',
      notionPageId: 'notion-page-server-only',
    };
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).endsWith('/sync/retry')) return jsonResponse({ requeuedCount: 0 });
      if (String(url).endsWith('/sync/validate')) {
        return jsonResponse({
          aheadPageIds: [],
          failedPageIds: [],
          newPageIds: [remoteOnlyPage.id],
          stalePageIds: [],
        });
      }
      if (String(url).endsWith('/sync/page/resync')) {
        return jsonResponse({ status: 'saved', page: linkedPage });
      }
      if (String(url).endsWith('/sync/status')) {
        return jsonResponse({ hasPending: false });
      }
      if (String(url).endsWith('/sync/reload')) {
        return jsonResponse({
          activePageIdsByProject: {
            'project-jottathing': linkedPage.id,
          },
          currentProjectId: 'project-jottathing',
          pages: [linkedPage, remoteOnlyPage],
          projects: [baseProject],
          status: 'saved',
        });
      }
      throw new Error(`Unexpected sync request: ${String(url)}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await notionClient.resyncPendingChanges();

    expect(result.reloadedFromNotion).toBe(true);
    expect(result.remainingCount).toBe(0);
    expect((readBrowserStorage().pages as ProjectPage[]).map((page) => page.id))
      .toContain(remoteOnlyPage.id);
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toContain(
      'http://localhost:8787/sync/reload',
    );
  });

  test('manual resync reloads the Notion workspace even when validation reports no changes', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).endsWith('/sync/retry')) return jsonResponse({ requeuedCount: 0 });
      if (String(url).endsWith('/sync/validate')) {
        return jsonResponse({
          aheadPageIds: [],
          failedPageIds: [],
          newPageIds: [],
          stalePageIds: [],
          workspaceChanged: false,
        });
      }
      if (String(url).endsWith('/sync/status')) return jsonResponse({ hasPending: false });
      if (String(url).endsWith('/sync/reload')) {
        return jsonResponse({
          activePageIdsByProject: { [baseProject.id]: basePage.id },
          currentProjectId: baseProject.id,
          pages: [basePage],
          projects: [baseProject],
          status: 'saved',
        });
      }
      throw new Error(`Unexpected sync request: ${String(url)}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await notionClient.resyncPendingChanges();

    expect(result.reloadedFromNotion).toBe(true);
    expect(result.remoteReloadPending).toBe(false);
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      'http://localhost:8787/sync/retry',
      'http://localhost:8787/sync/status',
      'http://localhost:8787/sync/validate',
      'http://localhost:8787/sync/status',
      'http://localhost:8787/sync/status',
      'http://localhost:8787/sync/reload',
    ]);
  });

  test('manual resync uploads unbaselined Notion snapshots before reloading the workspace', async () => {
    const workspace: Workspace = {
      id: 'workspace-notion-resync',
      name: 'Notion',
      kind: 'notion',
      accountId: connectedConfig.userId,
      notionWorkspaceId: 'notion-workspace-resync',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const localProject: Project = {
      ...baseProject,
      id: 'project-unbaselined-resync',
      name: 'Local project snapshot',
      workspaceId: workspace.id,
      syncMode: 'notion',
      stateSyncBaselineContent: undefined,
      stateContent: docWithText('local project state'),
    };
    const localPage: ProjectPage = {
      ...basePage,
      id: 'page-unbaselined-resync',
      projectId: localProject.id,
      workspaceId: workspace.id,
      syncMode: 'notion',
      syncBaselineContent: undefined,
      content: docWithText('local page snapshot'),
      localSyncVersion: 2,
      knownSyncVersion: 1,
    };
    resetBrowserStorage({
      activePageIdsByProject: { [localProject.id]: localPage.id },
      currentProjectId: localProject.id,
      currentProjectIdByWorkspace: { [workspace.id]: localProject.id },
      currentWorkspaceId: workspace.id,
      hasMigratedCapturesToPages: true,
      pages: [localPage],
      projects: [localProject],
      syncConfig: {
        ...connectedConfig,
        workspaceId: workspace.notionWorkspaceId,
        workspaceName: workspace.name,
      },
      workspaces: [workspace],
    });

    let projectRequest: Project | undefined;
    let pageRequest: ProjectPage | undefined;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const route = String(url).replace(connectedConfig.serverUrl, '');
      if (route === '/sync/retry') return jsonResponse({ requeuedCount: 0 });
      if (route === '/sync/project') {
        projectRequest = JSON.parse(String(init?.body)).project as Project;
        return jsonResponse({
          status: 'saved',
          project: {
            ...projectRequest,
            stateSyncBaselineContent: projectRequest.stateContent,
          },
        });
      }
      if (route === '/sync/page/resync') {
        pageRequest = JSON.parse(String(init?.body)).page as ProjectPage;
        return jsonResponse({
          status: 'saved',
          page: {
            ...pageRequest,
            syncBaselineContent: pageRequest.content,
            knownSyncVersion: 2,
            serverSyncVersion: 2,
          },
        });
      }
      if (route === '/sync/status') return jsonResponse({ hasPending: false });
      if (route === '/sync/validate') {
        return jsonResponse({
          aheadPageIds: [],
          failedPageIds: [],
          newPageIds: [],
          stalePageIds: [],
          workspaceChanged: false,
        });
      }
      if (route === '/sync/reload') {
        return jsonResponse({
          activePageIdsByProject: { [localProject.id]: localPage.id },
          currentProjectId: localProject.id,
          pages: [{ ...localPage, syncBaselineContent: localPage.content, knownSyncVersion: 2 }],
          projects: [{ ...localProject, stateSyncBaselineContent: localProject.stateContent }],
          status: 'saved',
        });
      }
      throw new Error(`Unexpected sync request: ${String(url)}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await notionClient.resyncPendingChanges();

    expect(result.reloadedFromNotion).toBe(true);
    expect(stripJottathingBlockIds(projectRequest?.stateContent)).toEqual(
      stripJottathingBlockIds(localProject.stateContent),
    );
    expect(stripJottathingBlockIds(pageRequest?.content)).toEqual(
      stripJottathingBlockIds(localPage.content),
    );
    const calls = fetchMock.mock.calls.map(([url]) => String(url));
    expect(calls.indexOf('http://localhost:8787/sync/project'))
      .toBeLessThan(calls.indexOf('http://localhost:8787/sync/page/resync'));
    expect(calls.indexOf('http://localhost:8787/sync/page/resync'))
      .toBeLessThan(calls.indexOf('http://localhost:8787/sync/reload'));

    await notionClient.resyncPendingChanges();
    const callsAfterSecondSync = fetchMock.mock.calls.map(([url]) => String(url));
    expect(callsAfterSecondSync.filter((url) => url.endsWith('/sync/project'))).toHaveLength(1);
    expect(callsAfterSecondSync.filter((url) => url.endsWith('/sync/page/resync'))).toHaveLength(1);
  });

  test('page listing and manual resync remove a persisted temp-ID duplicate', async () => {
    const workspace: Workspace = {
      id: 'workspace-notion-temp-duplicate',
      name: 'Notion',
      kind: 'notion',
      accountId: connectedConfig.userId,
      notionWorkspaceId: 'notion-workspace-temp-duplicate',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const project: Project = {
      ...baseProject,
      workspaceId: workspace.id,
      syncMode: 'notion',
      syncState: 'saved',
    };
    const existingPage = {
      ...basePage,
      workspaceId: workspace.id,
      syncMode: 'notion' as const,
      syncAccountId: workspace.accountId,
      syncWorkspaceId: workspace.notionWorkspaceId,
      pageOrder: 0,
      syncBaselineContent: emptyDocument(),
    };
    const createdAt = '2026-10-29T10:00:00.000Z';
    const durablePage: ProjectPage = {
      ...basePage,
      id: `page-${project.id}-temp-duplicate-recovered`,
      title: 'Renamed Page',
      projectId: project.id,
      workspaceId: workspace.id,
      syncMode: 'notion',
      syncAccountId: workspace.accountId,
      syncWorkspaceId: workspace.notionWorkspaceId,
      createdAt,
      updatedAt: '2026-10-29T10:02:00.000Z',
      pageOrder: 1,
      notionPageId: 'notion-page-temp-duplicate-recovered',
      syncBaselineContent: emptyDocument(),
      knownSyncVersion: 1,
      serverSyncVersion: 1,
      syncState: 'saved',
    };
    const tempGhost: ProjectPage = {
      ...durablePage,
      id: 'temp-page-ghost-from-old-build',
      title: 'Page 2',
      updatedAt: createdAt,
      notionPageId: undefined,
      syncBaselineContent: undefined,
      knownSyncVersion: undefined,
      serverSyncVersion: undefined,
      syncState: 'saving',
    };
    resetBrowserStorage({
      activePageIdsByProject: { [project.id]: durablePage.id },
      currentProjectId: project.id,
      currentProjectIdByWorkspace: { [workspace.id]: project.id },
      currentWorkspaceId: workspace.id,
      hasMigratedCapturesToPages: true,
      pages: [existingPage, durablePage, tempGhost],
      projects: [project],
      syncConfig: {
        ...connectedConfig,
        workspaceId: workspace.notionWorkspaceId,
        workspaceName: workspace.name,
      },
      workspaces: [workspace],
    });

    const pageResyncIds: string[] = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const route = String(url).replace(connectedConfig.serverUrl, '');
      if (route.startsWith('/sync/retry')) return jsonResponse({ requeuedCount: 0 });
      if (route === '/sync/status') return jsonResponse({ hasPending: false, failedCount: 0 });
      if (route === '/sync/validate') {
        return jsonResponse({
          aheadPageIds: [], failedPageIds: [], newPageIds: [], stalePageIds: [], workspaceChanged: false,
        });
      }
      if (route === '/sync/page/resync') {
        const request = JSON.parse(String(init?.body)) as { page: ProjectPage };
        pageResyncIds.push(request.page.id);
        return jsonResponse({ status: 'saved', page: request.page });
      }
      if (route === '/sync/reload') {
        return jsonResponse({
          activePageIdsByProject: { [project.id]: durablePage.id },
          currentProjectId: project.id,
          pages: [existingPage, durablePage],
          projects: [project],
          status: 'saved',
        });
      }
      if (route === '/sync/push') return jsonResponse({ queued: true, versions: {} });
      throw new Error(`Unexpected sync request: ${String(url)}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const listedPages = await notionClient.listProjectPages(project.id);
    expect(listedPages.map((page) => page.id)).toHaveLength(2);
    expect(listedPages.some((page) => page.id === tempGhost.id)).toBe(false);

    // Exercise the hard-sync cleanup independently in case resync runs before
    // the UI has loaded the affected project's page list.
    resetBrowserStorage({
      activePageIdsByProject: { [project.id]: durablePage.id },
      currentProjectId: project.id,
      currentProjectIdByWorkspace: { [workspace.id]: project.id },
      currentWorkspaceId: workspace.id,
      hasMigratedCapturesToPages: true,
      pages: [existingPage, durablePage, tempGhost],
      projects: [project],
      syncConfig: {
        ...connectedConfig,
        workspaceId: workspace.notionWorkspaceId,
        workspaceName: workspace.name,
      },
      workspaces: [workspace],
    });

    const result = await notionClient.resyncPendingChanges();
    const storedPages = readBrowserStorage().pages as ProjectPage[];

    expect(result.reloadedFromNotion).toBe(true);
    expect(storedPages.some((page) => page.id === tempGhost.id)).toBe(false);
    expect(storedPages.find((page) => page.id === durablePage.id)?.title).toBe('Renamed Page');
    expect(pageResyncIds).not.toContain(tempGhost.id);
  });

  test('manual resync restores an archived project for a newer active page edit', async () => {
    const workspace: Workspace = {
      id: 'workspace-notion-archive-resync',
      name: 'Notion',
      kind: 'notion',
      accountId: connectedConfig.userId,
      notionWorkspaceId: 'notion-workspace-archive-resync',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const archivedAt = '2026-10-27T12:00:00.000Z';
    const editedAt = '2026-10-28T12:00:00.000Z';
    const archivedProject: Project = {
      ...baseProject,
      id: 'project-archived-before-local-edit',
      name: 'Archived project',
      workspaceId: workspace.id,
      syncMode: 'notion',
      status: 'archived',
      updatedAt: archivedAt,
    };
    const editedPage: ProjectPage = {
      ...basePage,
      id: 'page-edited-after-project-archive',
      projectId: archivedProject.id,
      workspaceId: workspace.id,
      syncMode: 'notion',
      content: docWithText('edit after archive'),
      syncBaselineContent: docWithText('before archive'),
      updatedAt: editedAt,
      localSyncVersion: 2,
      knownSyncVersion: 1,
    };
    resetBrowserStorage({
      activePageIdsByProject: { [archivedProject.id]: editedPage.id },
      currentProjectId: archivedProject.id,
      currentProjectIdByWorkspace: { [workspace.id]: archivedProject.id },
      currentWorkspaceId: workspace.id,
      hasMigratedCapturesToPages: true,
      pages: [editedPage],
      projects: [archivedProject],
      syncConfig: {
        ...connectedConfig,
        workspaceId: workspace.notionWorkspaceId,
        workspaceName: workspace.name,
      },
      workspaces: [workspace],
    });

    let pageRequest: ProjectPage | undefined;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const route = String(url).replace(connectedConfig.serverUrl, '');
      if (route === '/sync/retry') return jsonResponse({ requeuedCount: 0 });
      if (route === '/sync/page/resync') {
        const request = JSON.parse(String(init?.body)) as { page: ProjectPage };
        pageRequest = request.page;
        return jsonResponse({
          status: 'saved',
          page: { ...request.page, syncBaselineContent: request.page.content },
        });
      }
      if (route === '/sync/status') return jsonResponse({ hasPending: false });
      if (route === '/sync/validate') {
        return jsonResponse({
          aheadPageIds: [],
          failedPageIds: [],
          newPageIds: [],
          stalePageIds: [],
          workspaceChanged: false,
        });
      }
      if (route === '/sync/reload') {
        return jsonResponse({
          activePageIdsByProject: { [archivedProject.id]: editedPage.id },
          currentProjectId: archivedProject.id,
          pages: [{ ...editedPage, syncBaselineContent: editedPage.content }],
          projects: [{ ...archivedProject, status: 'active', updatedAt: editedAt }],
          status: 'saved',
        });
      }
      throw new Error(`Unexpected sync request: ${String(url)}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await notionClient.resyncPendingChanges();

    expect(result.reloadedFromNotion).toBe(true);
    expect(pageRequest?.updatedAt).toBe(editedAt);
    expect(stripJottathingBlockIds(pageRequest?.content)).toEqual(
      stripJottathingBlockIds(editedPage.content),
    );
    expect(fetchMock.mock.calls.map(([url]) => String(url)))
      .toContain('http://localhost:8787/sync/page/resync');
  });

  test('manual resync continues project state delivery when a parked upload exists', async () => {
    await addPendingProjectSyncEvent(baseProject);
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).endsWith('/sync/retry')) return jsonResponse({ requeuedCount: 0 });
      if (String(url).endsWith('/sync/status')) {
        return jsonResponse({ hasPending: false, pendingCount: 0, failedCount: 1 });
      }
      if (String(url).endsWith('/sync/project')) {
        return jsonResponse({ status: 'saved', project: baseProject });
      }
      if (String(url).endsWith('/sync/validate')) {
        return jsonResponse({
          aheadPageIds: [],
          failedPageIds: [],
          newPageIds: [],
          stalePageIds: [],
          workspaceChanged: false,
        });
      }
      throw new Error(`Unexpected sync request: ${String(url)}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await notionClient.resyncPendingChanges();

    expect(result.failedUploadCount).toBe(1);
    expect(result.remoteReloadPending).toBe(true);
    expect(await listPendingProjectSyncEvents()).toEqual([]);
    const calls = fetchMock.mock.calls.map(([url]) => String(url));
    expect(calls.indexOf('http://localhost:8787/sync/project'))
      .toBeLessThan(calls.indexOf('http://localhost:8787/sync/validate'));
    expect(calls).not.toContain('http://localhost:8787/sync/reload');
  });

  test('manual resync delivers project state when the page queue is already empty', async () => {
    await addPendingProjectSyncEvent({ ...baseProject, syncMode: 'notion' });
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).endsWith('/sync/retry')) return jsonResponse({ requeuedCount: 0 });
      if (String(url).endsWith('/sync/status')) return jsonResponse({ hasPending: false });
      if (String(url).endsWith('/sync/project')) {
        return jsonResponse({ status: 'saved', project: baseProject });
      }
      if (String(url).endsWith('/sync/validate')) {
        return jsonResponse({
          aheadPageIds: [],
          failedPageIds: [],
          newPageIds: [],
          stalePageIds: [],
          workspaceChanged: false,
        });
      }
      if (String(url).endsWith('/sync/reload')) {
        return jsonResponse({
          activePageIdsByProject: { [baseProject.id]: basePage.id },
          currentProjectId: baseProject.id,
          pages: [basePage],
          projects: [baseProject],
          status: 'saved',
        });
      }
      throw new Error(`Unexpected sync request: ${String(url)}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await notionClient.resyncPendingChanges();

    expect(result.reloadedFromNotion).toBe(true);
    expect(await listPendingProjectSyncEvents()).toEqual([]);
    const calls = fetchMock.mock.calls.map(([url]) => String(url));
    expect(calls.indexOf('http://localhost:8787/sync/project'))
      .toBeLessThan(calls.indexOf('http://localhost:8787/sync/validate'));
  });

  test('manual resync refreshes the session without running a second sync validation', async () => {
    const store = useJottathingStore();
    await seedStore(store);
    const refreshSession = vi.spyOn(notionClient, 'refreshSyncSession').mockResolvedValue(connectedConfig);
    const prepareWorkspace = vi.spyOn(notionClient, 'prepareLocalWorkspaceForFirstSync').mockResolvedValue(false);
    const sync = vi.spyOn(store, 'syncPendingChanges').mockResolvedValue(undefined);

    await store.refreshSyncSession(false, false);

    expect(refreshSession).toHaveBeenCalledOnce();
    expect(prepareWorkspace).not.toHaveBeenCalled();
    expect(sync).not.toHaveBeenCalled();
    refreshSession.mockRestore();
    prepareWorkspace.mockRestore();
    sync.mockRestore();
  });

  test('resync imports pages created by another instance even without installation sync rows', async () => {
    const localPage = { ...basePage, notionPageId: 'thread-local' };
    const externalPage: ProjectPage = {
      ...basePage,
      id: 'random-id-from-second-device',
      title: 'External page',
      notionPageId: 'thread-created-on-second-device',
    };
    resetBrowserStorage({
      activePageIdsByProject: { 'project-jottathing': localPage.id },
      currentProjectId: 'project-jottathing',
      hasMigratedCapturesToPages: true,
      pages: [localPage],
      projects: [baseProject],
      syncConfig: connectedConfig,
    });
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).endsWith('/sync/retry')) return jsonResponse({ requeuedCount: 0 });
      if (String(url).endsWith('/sync/validate')) {
        return jsonResponse({
          aheadPageIds: [],
          failedPageIds: [],
          newPageIds: [],
          stalePageIds: [],
          workspaceChanged: true,
        });
      }
      if (String(url).endsWith('/sync/status')) return jsonResponse({ hasPending: false });
      if (String(url).endsWith('/sync/reload')) {
        return jsonResponse({
          activePageIdsByProject: { 'project-jottathing': localPage.id },
          currentProjectId: 'project-jottathing',
          pages: [localPage, externalPage],
          projects: [baseProject],
          status: 'saved',
        });
      }
      throw new Error(`Unexpected sync request: ${String(url)}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await notionClient.resyncPendingChanges();

    expect(result.reloadedFromNotion).toBe(true);
    expect((readBrowserStorage().pages as ProjectPage[]).map((page) => page.notionPageId))
      .toContain(externalPage.notionPageId);
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toContain(
      'http://localhost:8787/sync/reload',
    );
  });

  test('resync removes a page deleted on another instance', async () => {
    const survivingPage = { ...basePage, notionPageId: 'thread-survivor' };
    const deletedPage: ProjectPage = {
      ...basePage,
      id: 'random-id-for-deleted-page',
      title: 'Deleted page',
      notionPageId: 'thread-deleted-on-second-device',
    };
    resetBrowserStorage({
      activePageIdsByProject: { 'project-jottathing': deletedPage.id },
      currentProjectId: 'project-jottathing',
      hasMigratedCapturesToPages: true,
      pages: [deletedPage, survivingPage],
      projects: [baseProject],
      syncConfig: connectedConfig,
    });
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).endsWith('/sync/retry')) return jsonResponse({ requeuedCount: 0 });
      if (String(url).endsWith('/sync/validate')) {
        return jsonResponse({
          aheadPageIds: [],
          failedPageIds: [],
          newPageIds: [],
          stalePageIds: [],
          workspaceChanged: true,
        });
      }
      if (String(url).endsWith('/sync/status')) return jsonResponse({ hasPending: false });
      if (String(url).endsWith('/sync/reload')) {
        return jsonResponse({
          activePageIdsByProject: { 'project-jottathing': survivingPage.id },
          currentProjectId: 'project-jottathing',
          pages: [survivingPage],
          projects: [baseProject],
          status: 'saved',
        });
      }
      throw new Error(`Unexpected sync request: ${String(url)}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await notionClient.resyncPendingChanges();

    expect(result.reloadedFromNotion).toBe(true);
    expect((readBrowserStorage().pages as ProjectPage[]).map((page) => page.id))
      .toEqual([survivingPage.id]);
  });

  test('initial hydration keeps the starter project when the remote workspace is new', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(jsonResponse({ hasPending: false }))
      .mockResolvedValueOnce(jsonResponse({
      activePageIdsByProject: {},
      currentProjectId: '',
      pages: [],
      projects: [],
      status: 'saved',
      })));
    resetBrowserStorage({
      activePageIdsByProject: { 'project-jottathing': 'page-jottathing' },
      currentProjectId: 'project-jottathing',
      hasMigratedCapturesToPages: true,
      pages: [basePage],
      projects: [baseProject],
      syncConfig: {
        ...connectedConfig,
        workspaceId: 'workspace-new',
      },
    });

    const reloaded = await notionClient.reloadFromNotion({
      force: true,
      preserveLocalWhenRemoteEmpty: true,
    });

    expect(reloaded.projects.map((project) => project.id)).toEqual(['project-jottathing']);
    expect((readBrowserStorage().projects as Project[]).map((project) => project.id))
      .toEqual(['project-jottathing']);
    expect(readBrowserStorage().notionHydrationSource).toBe(
      'http://localhost:8787::workspace-new',
    );
  });

  test('local pages render before the session check resolves', async () => {
    const session = deferred<Response>();
    const fetchMock = vi.fn(() => session.promise);
    vi.stubGlobal('fetch', fetchMock);
    const localPage = {
      ...basePage,
      content: docWithText('cached local notes'),
    };
    resetBrowserStorage({
      activePageIdsByProject: { 'project-jottathing': 'page-jottathing' },
      currentProjectId: 'project-jottathing',
      hasExplicitlyLoggedOut: false,
      hasMigratedCapturesToPages: true,
      pages: [localPage],
      projects: [baseProject],
      syncConfig: connectedConfig,
    });

    const store = useJottathingStore();
    const initialization = store.initialize();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    expect(store.isLoading).toBe(false);
    expect(store.isCheckingSync).toBe(true);
    expect(stripJottathingBlockIds(store.currentPage?.content)).toEqual(localPage.content);

    session.resolve(jsonResponse({ authenticated: false, connected: false }));
    await initialization;

    expect(store.isCheckingSync).toBe(false);
    expect(stripJottathingBlockIds(store.currentPage?.content)).toEqual(localPage.content);
  });

  test('keeps local workspace available when session verification fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connection refused')));
    const localPage = {
      ...basePage,
      content: docWithText('still available offline'),
    };
    resetBrowserStorage({
      activePageIdsByProject: { 'project-jottathing': 'page-jottathing' },
      currentProjectId: 'project-jottathing',
      hasExplicitlyLoggedOut: false,
      hasMigratedCapturesToPages: true,
      pages: [localPage],
      projects: [baseProject],
      syncConfig: connectedConfig,
    });

    const store = useJottathingStore();
    await store.initialize();

    expect(store.isLoading).toBe(false);
    expect(store.isCheckingSync).toBe(false);
    expect(store.syncCheckError).toContain('connection refused');
    expect(stripJottathingBlockIds(store.currentPage?.content)).toEqual(localPage.content);
  });

  test('shows local content and reports server validation failures', async () => {
    const localPage = {
      ...basePage,
      content: docWithText('cached while server validation is unavailable'),
    };
    vi.spyOn(notionClient, 'refreshSyncSession').mockResolvedValue(connectedConfig);
    vi.spyOn(notionClient, 'prepareLocalWorkspaceForFirstSync').mockResolvedValue(false);
    vi.spyOn(notionClient, 'needsInitialNotionHydration').mockResolvedValue(false);
    vi.spyOn(notionClient, 'validateNotionCache').mockRejectedValue(
      new Error('Sync server returned 500.'),
    );
    const OriginalEventSource = globalThis.EventSource;
    resetBrowserStorage({
      activePageIdsByProject: { 'project-jottathing': 'page-jottathing' },
      currentProjectId: 'project-jottathing',
      hasMigratedCapturesToPages: true,
      notionHydrationSource: 'http://localhost:8787::',
      pages: [localPage],
      projects: [baseProject],
      syncConfig: connectedConfig,
    });

    try {
      const store = useJottathingStore();
      await store.initialize();

      expect(store.syncCheckError).toContain('Couldn\'t check Notion for changes.');
      expect(store.syncCheckError).toContain('Sync server returned 500.');
      expect(stripJottathingBlockIds(store.currentPage?.content)).toEqual(localPage.content);
    } finally {
      globalThis.EventSource = OriginalEventSource;
      vi.restoreAllMocks();
    }
  });

  test('keeps edits made during remote hydration instead of replacing them', async () => {
    const reload = deferred<Response>();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ hasPending: false }))
      .mockImplementationOnce(() => reload.promise);
    vi.stubGlobal('fetch', fetchMock);
    const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { onLine: false },
    });
    resetBrowserStorage({
      activePageIdsByProject: { 'project-jottathing': 'page-jottathing' },
      currentProjectId: 'project-jottathing',
      hasMigratedCapturesToPages: true,
      pages: [basePage],
      projects: [baseProject],
      syncConfig: connectedConfig,
    });

    try {
      const reloadPromise = notionClient.reloadFromNotion({ force: true });
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
      const editedPage = {
        ...basePage,
        content: docWithText('edited while server checks'),
      };
      await notionClient.updateProjectPage(editedPage);

      reload.resolve(jsonResponse({
        activePageIdsByProject: { 'project-jottathing': 'page-jottathing' },
        currentProjectId: 'project-jottathing',
        pages: [{ ...basePage, content: docWithText('older server snapshot') }],
        projects: [baseProject],
        status: 'saved',
      }));
      const result = await reloadPromise;
      const storedPage = (readBrowserStorage().pages as ProjectPage[])[0];

      expect(JSON.stringify(result.pages[0]?.content)).toContain('edited while server checks');
      expect(JSON.stringify(storedPage.content)).toContain('edited while server checks');
      expect(JSON.stringify(storedPage.content)).not.toContain('older server snapshot');
    } finally {
      if (originalNavigator) {
        Object.defineProperty(globalThis, 'navigator', originalNavigator);
      } else {
        Reflect.deleteProperty(globalThis, 'navigator');
      }
    }
  });

  test('a fresh extension install hydrates all projects from its connected workspace', async () => {
    const remoteProjects = [
      { ...baseProject, id: 'project-one', name: 'One' },
      { ...baseProject, id: 'project-two', name: 'Two' },
    ];
    const remotePages = remoteProjects.map((project, index) => ({
      ...basePage,
      id: `page-${index + 1}`,
      projectId: project.id,
      notionPageId: `notion-page-${index + 1}`,
    }));
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        authenticated: true,
        userId: 'notion:fresh-user',
        connected: true,
        workspaceId: 'workspace-main',
        workspaceName: 'Main workspace',
      }))
      .mockResolvedValueOnce(jsonResponse({ hasPending: false }))
      .mockResolvedValueOnce(jsonResponse({
        activePageIdsByProject: {
          'project-one': 'page-1',
          'project-two': 'page-2',
        },
        currentProjectId: 'project-one',
        pages: remotePages,
        projects: remoteProjects,
        status: 'saved',
      }));
    vi.stubGlobal('fetch', fetchMock);
    const OriginalEventSource = globalThis.EventSource;
    resetBrowserStorage({
      hasExplicitlyLoggedOut: false,
      syncConfig: {
        serverUrl: 'http://localhost:8787',
        authenticated: false,
        connected: false,
      },
    });

    try {
      const store = useJottathingStore();
      await store.initialize();

      expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
        'http://localhost:8787/session',
        'http://localhost:8787/sync/status',
        'http://localhost:8787/sync/reload',
      ]);
      expect(store.projects.map((project) => project.id)).toEqual([
        'project-one',
        'project-two',
      ]);
      expect(readBrowserStorage().notionHydrationSource).toBe(
        'http://localhost:8787::workspace-main',
      );
    } finally {
      globalThis.EventSource = OriginalEventSource;
    }
  });

  test('loads pages created by another installation after local sync drains', async () => {
    const remoteProject: Project = {
      ...baseProject,
      id: 'project-from-server',
      name: 'Server project',
    };
    const remotePage: ProjectPage = {
      ...basePage,
      id: 'page-from-server',
      projectId: remoteProject.id,
      title: 'Page from server',
    };
    const workspaceConfig = { ...connectedConfig, workspaceId: 'workspace-main' };
    const reloadOrder: string[] = [];
    const reloadFromNotion = vi.spyOn(notionClient, 'reloadFromNotion')
      .mockImplementation(async () => {
        reloadOrder.push('reload');
        return {
          currentProjectId: remoteProject.id,
          pages: [remotePage],
          projects: [remoteProject],
          syncConfig: workspaceConfig,
        };
      });
    vi.spyOn(notionClient, 'refreshSyncSession').mockResolvedValue(workspaceConfig);
    vi.spyOn(notionClient, 'prepareLocalWorkspaceForFirstSync').mockResolvedValue(false);
    vi.spyOn(notionClient, 'needsInitialNotionHydration').mockResolvedValue(false);
    vi.spyOn(notionClient, 'validateNotionCache').mockResolvedValue({
      stalePageIds: [],
      aheadPageIds: [],
      failedPageIds: [],
      newPageIds: [],
      workspaceChanged: true,
    });
    vi.spyOn(notionClient, 'pendingSyncEventCount')
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(0);
    vi.spyOn(notionClient, 'flushPendingSyncOps').mockImplementation(async () => {
      reloadOrder.push('flush');
    });
    vi.spyOn(notionClient, 'listProjectPages').mockImplementation(async (projectId) =>
      projectId === remoteProject.id ? [remotePage] : [basePage],
    );
    vi.spyOn(notionClient, 'getProjectPage').mockImplementation(async (projectId) =>
      projectId === remoteProject.id ? remotePage : basePage,
    );
    vi.spyOn(notionClient, 'prefetchProjectPages').mockResolvedValue(undefined);
    const originalEventSource = globalThis.EventSource;
    resetBrowserStorage({
      activePageIdsByProject: { 'project-jottathing': 'page-jottathing' },
      currentProjectId: 'project-jottathing',
      hasMigratedCapturesToPages: true,
      notionHydrationSource: 'http://localhost:8787::workspace-main',
      pages: [basePage],
      projects: [baseProject],
      syncConfig: workspaceConfig,
    });

    try {
      const store = useJottathingStore();
      await store.initialize();
      await waitFor(() => expect(reloadFromNotion).toHaveBeenCalledTimes(1));

      expect(reloadOrder).toEqual(['flush', 'reload']);
      expect(store.projects.map((project) => project.id)).toEqual([remoteProject.id]);
      expect(store.pages.map((page) => page.id)).toEqual([remotePage.id]);
      expect(store.currentPage?.id).toBe(remotePage.id);
    } finally {
      globalThis.EventSource = originalEventSource;
      vi.restoreAllMocks();
    }
  });

  test('reloads the workspace when a sync event refers to a page missing locally', async () => {
    const remoteProject: Project = {
      ...baseProject,
      id: 'project-discovered-by-event',
      name: 'Discovered project',
    };
    const remotePage: ProjectPage = {
      ...basePage,
      id: 'page-discovered-by-event',
      projectId: remoteProject.id,
      title: 'Discovered page',
    };
    const workspaceConfig = { ...connectedConfig, workspaceId: 'workspace-main' };
    const reloadFromNotion = vi.spyOn(notionClient, 'reloadFromNotion')
      .mockResolvedValue({
        currentProjectId: remoteProject.id,
        pages: [remotePage],
        projects: [remoteProject],
        syncConfig: workspaceConfig,
      });
    vi.spyOn(notionClient, 'refreshSyncSession').mockResolvedValue(workspaceConfig);
    vi.spyOn(notionClient, 'prepareLocalWorkspaceForFirstSync').mockResolvedValue(false);
    vi.spyOn(notionClient, 'needsInitialNotionHydration').mockResolvedValue(false);
    vi.spyOn(notionClient, 'validateNotionCache').mockResolvedValue({
      stalePageIds: [],
      aheadPageIds: [],
      failedPageIds: [],
      newPageIds: [],
    });
    vi.spyOn(notionClient, 'listProjectPages').mockImplementation(async (projectId) =>
      projectId === remoteProject.id ? [remotePage] : [basePage],
    );
    vi.spyOn(notionClient, 'getProjectPage').mockImplementation(async (projectId) =>
      projectId === remoteProject.id ? remotePage : basePage,
    );
    vi.spyOn(notionClient, 'prefetchProjectPages').mockResolvedValue(undefined);

    const originalEventSource = globalThis.EventSource;
    let eventSource: EventSource | undefined;
    globalThis.EventSource = class {
      onerror = null;
      onmessage = null;
      onopen = null;
      close() {}
      constructor() { eventSource = this as unknown as EventSource; }
    } as unknown as typeof EventSource;
    resetBrowserStorage({
      activePageIdsByProject: { 'project-jottathing': 'page-jottathing' },
      currentProjectId: 'project-jottathing',
      hasMigratedCapturesToPages: true,
      notionHydrationSource: 'http://localhost:8787::workspace-main',
      pages: [basePage],
      projects: [baseProject],
      syncConfig: workspaceConfig,
    });

    try {
      const store = useJottathingStore();
      await store.initialize();

      expect(eventSource).toBeDefined();
      (eventSource?.onmessage as ((event: { data: string }) => void) | null)?.({
        data: JSON.stringify({
          status: 'synced',
          pageId: remotePage.id,
          version: 1,
        }),
      });
      await waitFor(() => expect(reloadFromNotion).toHaveBeenCalledWith({ force: true }));

      expect(store.projects.map((project) => project.id)).toEqual([remoteProject.id]);
      expect(store.pages.map((page) => page.id)).toEqual([remotePage.id]);
      expect(store.currentPage?.id).toBe(remotePage.id);
    } finally {
      globalThis.EventSource = originalEventSource;
      vi.restoreAllMocks();
    }
  });

  test('listProjects sorts by updated date descending', async () => {
    const olderProject = {
      ...baseProject,
      id: 'project-older',
      name: 'Older',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const newerProject = {
      ...baseProject,
      id: 'project-newer',
      name: 'Newer',
      updatedAt: '2026-01-03T00:00:00.000Z',
    };

    resetBrowserStorage({
      activePageIdsByProject: {
        'project-older': 'page-jottathing',
        'project-newer': 'page-jottathing',
      },
      currentProjectId: 'project-older',
      hasMigratedCapturesToPages: true,
      pages: [basePage],
      projects: [olderProject, newerProject],
      syncConfig: connectedConfig,
    });

    const projects = await notionClient.listProjects();

    expect(projects.map((project) => project.id)).toEqual([
      'project-newer',
      'project-older',
    ]);
  });

  test('updating category and state persists locally and syncs metadata', async () => {
    const metadataSync = deferred<Response>();
    const fetchMock = vi.fn(() => metadataSync.promise);
    vi.stubGlobal('fetch', fetchMock);
    const store = useJottathingStore();

    await seedStore(store);
    const updatePromise = store.updateCurrentProjectMetadata({
      category: 'Research',
      stateText: 'Todo\nShip database sync',
    });
    const requestBody = await waitForFirstRequest(fetchMock);

    expect(requestBody.project.category).toBe('Research');
    expect(requestBody.project.stateContent).toEqual(docWithParagraphs([
      'Todo',
      'Ship database sync',
    ]));

    metadataSync.resolve(jsonResponse({ status: 'saved' }));
    await updatePromise;

    expect(store.currentProject?.category).toBe('Research');
    expect((readBrowserStorage().projects as Project[])[0].stateContent).toEqual(docWithParagraphs([
      'Todo',
      'Ship database sync',
    ]));
  });
});

describe('optimistic page creation', () => {
  test('appears and is selected immediately with an empty document', async () => {
    const pageSync = deferred<Response>();
    vi.stubGlobal('fetch', vi.fn(() => pageSync.promise));
    const store = useJottathingStore();

    await seedStore(store);
    await store.createPage();

    expect(store.currentPage?.id).toMatch(/^temp-page-/);
    expect(stripJottathingBlockIds(store.currentPage?.content)).toEqual(emptyDocument());
    expect(store.pages.some((page) => page.id === store.currentPage?.id)).toBe(true);
    expect(store.saveStatus).toBe('creating');
  });

  test('keeps the optimistic page visible when an older page-list load finishes during creation', async () => {
    const optimisticPage: ProjectPage = {
      ...basePage,
      id: 'temp-page-create-list-race',
      title: 'Page 2',
      pageOrder: 1,
      syncState: 'creating',
    };
    const durablePage: ProjectPage = {
      ...optimisticPage,
      id: 'page-create-list-race',
      syncState: 'saving',
    };
    const settled = deferred<ProjectPage>();
    const olderPageList = deferred<ProjectPage[]>();
    vi.spyOn(notionClient, 'createProjectPage').mockResolvedValue({
      page: optimisticPage,
      settled: settled.promise,
    });
    vi.spyOn(notionClient, 'listProjectPages')
      .mockImplementationOnce(() => olderPageList.promise)
      .mockResolvedValue([basePage, durablePage]);
    vi.spyOn(notionClient, 'listProjects').mockResolvedValue([baseProject]);
    const store = useJottathingStore();

    try {
      await seedStore(store);
      await store.createPage();

      const listLoad = store.loadProjectPages();
      olderPageList.resolve([basePage]);
      await listLoad;

      expect(store.pages.some((page) => page.id === optimisticPage.id)).toBe(true);
      expect(store.currentPage?.id).toBe(optimisticPage.id);

      settled.resolve(durablePage);
      await waitFor(() => expect(store.currentPage?.id).toBe(durablePage.id));
      expect(store.pages.some((page) => page.id === durablePage.id)).toBe(true);
      expect(store.pages.some((page) => page.id === optimisticPage.id)).toBe(false);
    } finally {
      olderPageList.resolve([basePage]);
      settled.resolve(durablePage);
      vi.restoreAllMocks();
    }
  });

  test('does not restore a stale auto-title page list after an early rename', async () => {
    const optimisticPage: ProjectPage = {
      ...basePage,
      id: 'temp-page-early-rename',
      title: 'Auto Page Name',
      syncState: 'creating',
    };
    const renamedTempPage = { ...optimisticPage, title: 'User Page Name' };
    const resolvedPage: ProjectPage = {
      ...optimisticPage,
      id: 'page-early-rename',
      title: 'Auto Page Name',
      syncState: 'saving',
    };
    const renamedResolvedPage = { ...resolvedPage, title: 'User Page Name' };
    const settled = deferred<ProjectPage>();
    const firstPageLoad = deferred<ProjectPage[]>();
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ queued: true, versions: {} })));
    let renameStarted = false;
    let pageListRequests = 0;
    vi.spyOn(notionClient, 'createProjectPage').mockResolvedValue({
      page: optimisticPage,
      settled: settled.promise,
    });
    vi.spyOn(notionClient, 'renameProjectPage').mockImplementation(async () => {
      renameStarted = true;
      return renamedTempPage;
    });
    vi.spyOn(notionClient, 'listProjects').mockResolvedValue([baseProject]);
    vi.spyOn(notionClient, 'listProjectPages').mockImplementation(async () => {
      if (!renameStarted) return [basePage];
      pageListRequests += 1;
      return pageListRequests === 1 ? firstPageLoad.promise : [renamedResolvedPage];
    });
    const store = useJottathingStore();

    try {
      await seedStore(store);
      await store.createPage();
      await flushPromises(10);
      const rename = store.renameCurrentPage('User Page Name');
      await waitFor(() => expect(pageListRequests).toBeGreaterThan(0));

      settled.resolve(resolvedPage);
      await waitFor(() => expect(pageListRequests).toBe(2));
      await waitFor(() => expect(store.currentPage?.id).toBe(resolvedPage.id));
      firstPageLoad.resolve([optimisticPage]);
      await rename;
      await flushPromises(5);

      expect(store.pages.map((page) => page.id)).toEqual([renamedResolvedPage.id]);
      expect(store.pages[0]?.title).toBe('User Page Name');
      expect(store.currentPage?.title).toBe('User Page Name');
    } finally {
      firstPageLoad.resolve([optimisticPage]);
      vi.restoreAllMocks();
    }
  });

  test('replays latest edit after temp page reconciliation through the local queue', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ queued: true, versions: { 'page-jottathing': 1 } }));
    vi.stubGlobal('fetch', fetchMock);
    const store = useJottathingStore();
    const editedContent = docWithText('typed while creating');

    await seedStore(store);
    await store.createPage();
    const tempPageId = store.currentPage?.id ?? '';
    await store.saveCurrentPageContent(editedContent, { preserveLocalContent: true });

    await waitFor(() => expect(store.currentPage?.id).not.toBe(tempPageId));

    expect(stripJottathingBlockIds(store.currentPage?.content)).toEqual(editedContent);
    const pushRequest = (fetchMock.mock.calls as unknown as Array<[string, RequestInit]>).find(
      ([url]) => url.endsWith('/sync/push'),
    );
    expect(pushRequest).toBeDefined();
    expect(String(pushRequest?.[1]?.body)).toContain('typed while creating');
    expect(await listPendingSyncOps()).toHaveLength(0);
  });

  test('does not resurrect a temp ghost when an editor save overlaps page replacement', async () => {
    const workspace: Workspace = {
      id: 'workspace-notion-notion%3Atest-user-unknown',
      name: 'Notion',
      kind: 'notion',
      accountId: connectedConfig.userId,
      notionWorkspaceId: 'notion-workspace',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const existingProject = {
      ...baseProject,
      workspaceId: workspace.id,
      syncMode: 'notion' as const,
    };
    const existingPage = {
      ...basePage,
      workspaceId: workspace.id,
      syncMode: 'notion' as const,
      syncAccountId: workspace.accountId,
      syncWorkspaceId: workspace.notionWorkspaceId,
    };
    resetBrowserStorage({
      activePageIdsByProject: { [existingProject.id]: existingPage.id },
      currentProjectId: existingProject.id,
      currentProjectIdByWorkspace: { [workspace.id]: existingProject.id },
      currentWorkspaceId: workspace.id,
      hasMigratedCapturesToPages: true,
      pages: [existingPage],
      projects: [existingProject],
      syncConfig: { ...connectedConfig, workspaceId: workspace.notionWorkspaceId },
      workspaces: [workspace],
    });

    const firstQueueWriteStarted = deferred<void>();
    const allowFirstQueueWrite = deferred<void>();
    let isFirstQueueWrite = true;
    const originalAddPendingSyncOps = (
      await vi.importActual<typeof import('@/src/services/syncQueue')>('@/src/services/syncQueue')
    ).addPendingSyncOps;
    const addOps = vi.spyOn(await import('@/src/services/syncQueue'), 'addPendingSyncOps')
      .mockImplementation(async (ops) => {
        if (isFirstQueueWrite) {
          isFirstQueueWrite = false;
          firstQueueWriteStarted.resolve();
          await allowFirstQueueWrite.promise;
        }
        return originalAddPendingSyncOps(ops);
      });
    const editorReadStarted = deferred<void>();
    const allowEditorRead = deferred<void>();
    const replacementReadStarted = deferred<void>();
    const allowReplacementRead = deferred<void>();
    let delayEditorRead = false;
    let delayReplacementRead = false;
    const originalIdbGetMany = idbGetMany;
    const getManySpy = vi.spyOn(await import('@/src/services/idbStore'), 'idbGetMany')
      .mockImplementation(async (keys) => {
        const result = await originalIdbGetMany(keys);
        if (delayEditorRead && keys.includes('syncConfig') && keys.includes('pages')) {
          delayEditorRead = false;
          editorReadStarted.resolve();
          await allowEditorRead.promise;
        } else if (delayReplacementRead && keys.length === 2 && keys.includes('activePageIdsByProject')) {
          delayReplacementRead = false;
          replacementReadStarted.resolve();
          await allowReplacementRead.promise;
        }
        return result;
      });
    const fetchMock = vi.fn(async () => jsonResponse({ queued: true, versions: {} }));
    vi.stubGlobal('fetch', fetchMock);

    try {
      const creation = await notionClient.createProjectPage(existingProject.id, 'Auto Page Name');
      await firstQueueWriteStarted.promise;
      delayEditorRead = true;
      delayReplacementRead = true;
      const editorSave = notionClient.updateProjectPage({
        ...creation.page,
        title: 'User Page Name',
      });
      await editorReadStarted.promise;
      allowFirstQueueWrite.resolve();
      await replacementReadStarted.promise;
      allowEditorRead.resolve();
      await flushPromises(10);
      allowReplacementRead.resolve();
      const settledPage = await creation.settled;
      await editorSave;
      await notionClient.flushPendingSyncOps({ force: true });

      const storedPages = readBrowserStorage().pages as ProjectPage[];
      const createdPages = storedPages.filter((page) =>
        page.projectId === existingProject.id && page.id !== existingPage.id,
      );
      const pushedOps = (fetchMock.mock.calls as unknown as Array<[string, RequestInit]>)
        .filter(([url]) => url.endsWith('/sync/push'))
        .flatMap(([, request]) => JSON.parse(String(request.body)).ops as SyncBlockOperation[]);

      expect(createdPages).toHaveLength(1);
      expect(createdPages[0]).toMatchObject({ id: settledPage.id, title: 'User Page Name' });
      expect(pushedOps.some((op) =>
        op.pageId === settledPage.id && op.payload.page.title === 'User Page Name',
      )).toBe(true);
    } finally {
      allowFirstQueueWrite.resolve();
      allowEditorRead.resolve();
      allowReplacementRead.resolve();
      addOps.mockRestore();
      getManySpy.mockRestore();
    }
  });

  test('persists one page when the editor saves its early title before creation settles', async () => {
    const workspace: Workspace = {
      id: 'workspace-notion-notion%3Atest-user-unknown',
      name: 'Notion',
      kind: 'notion',
      accountId: connectedConfig.userId,
      notionWorkspaceId: 'notion-workspace',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const existingProject = {
      ...baseProject,
      workspaceId: workspace.id,
      syncMode: 'notion' as const,
    };
    const existingPage = {
      ...basePage,
      workspaceId: workspace.id,
      syncMode: 'notion' as const,
      syncAccountId: workspace.accountId,
      syncWorkspaceId: workspace.notionWorkspaceId,
    };
    resetBrowserStorage({
      activePageIdsByProject: { [existingProject.id]: existingPage.id },
      currentProjectId: existingProject.id,
      currentProjectIdByWorkspace: { [workspace.id]: existingProject.id },
      currentWorkspaceId: workspace.id,
      hasMigratedCapturesToPages: true,
      pages: [existingPage],
      projects: [existingProject],
      syncConfig: { ...connectedConfig, workspaceId: workspace.notionWorkspaceId },
      workspaces: [workspace],
    });

    const firstQueueWriteStarted = deferred<void>();
    const allowFirstQueueWrite = deferred<void>();
    let isFirstQueueWrite = true;
    const originalAddPendingSyncOps = (
      await vi.importActual<typeof import('@/src/services/syncQueue')>('@/src/services/syncQueue')
    ).addPendingSyncOps;
    const addOps = vi.spyOn(await import('@/src/services/syncQueue'), 'addPendingSyncOps')
      .mockImplementation(async (ops) => {
        if (isFirstQueueWrite) {
          isFirstQueueWrite = false;
          firstQueueWriteStarted.resolve();
          await allowFirstQueueWrite.promise;
        }
        return originalAddPendingSyncOps(ops);
      });
    const fetchMock = vi.fn(async () => jsonResponse({ queued: true, versions: {} }));
    vi.stubGlobal('fetch', fetchMock);
    const store = useJottathingStore();

    try {
      await seedStore(store, [existingPage]);
      store.projects = [existingProject];
      store.syncConfig = { ...connectedConfig, workspaceId: workspace.notionWorkspaceId };
      store.currentProjectId = existingProject.id;
      store.currentPage = existingPage;
      await store.createPage();
      const tempPageId = store.currentPage?.id ?? '';
      await firstQueueWriteStarted.promise;
      await store.saveCurrentPageContent(emptyDocument(), {
        preserveLocalContent: true,
        title: 'User Page Name',
      });
      allowFirstQueueWrite.resolve();

      await waitFor(() => expect(store.currentPage?.id).not.toBe(tempPageId));
      await notionClient.flushPendingSyncOps({ force: true });

      const storedPages = readBrowserStorage().pages as ProjectPage[];
      const createdPages = storedPages.filter((page) =>
        page.projectId === existingProject.id && page.id !== existingPage.id,
      );
      const pushedOps = (fetchMock.mock.calls as unknown as Array<[string, RequestInit]>)
        .filter(([url]) => url.endsWith('/sync/push'))
        .flatMap(([, request]) => JSON.parse(String(request.body)).ops as SyncBlockOperation[]);

      expect(createdPages).toHaveLength(1);
      expect(createdPages[0]).toMatchObject({ title: 'User Page Name' });
      expect(pushedOps.some((op) =>
        op.pageId === createdPages[0].id && op.payload.page.title === 'User Page Name',
      )).toBe(true);
    } finally {
      allowFirstQueueWrite.resolve();
      addOps.mockRestore();
    }
  });

  test('keeps created page locally when queue delivery fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('offline');
    }));
    const store = useJottathingStore();

    await seedStore(store);
    await store.createPage();
    const tempPageId = store.currentPage?.id ?? '';

    await waitFor(() => expect(store.currentPage?.id).not.toBe(tempPageId));

    expect(store.pages.some((page) => page.id === tempPageId)).toBe(false);
    expect((await listPendingSyncOps()).length).toBeGreaterThan(0);
  });

  test('follows the resolved project after a page create settles', async () => {
    const resolvedProject: Project = { ...baseProject, id: 'project-resolved' };
    const optimisticPage: ProjectPage = {
      ...basePage,
      id: 'temp-page-create',
      syncState: 'creating',
    };
    const resolvedPage: ProjectPage = {
      ...optimisticPage,
      id: 'page-project-resolved',
      projectId: resolvedProject.id,
      syncState: 'saving',
    };
    vi.spyOn(notionClient, 'createProjectPage').mockResolvedValue({
      page: optimisticPage,
      settled: Promise.resolve(resolvedPage),
    });
    vi.spyOn(notionClient, 'listProjects').mockResolvedValue([resolvedProject]);
    vi.spyOn(notionClient, 'listProjectPages').mockResolvedValue([resolvedPage]);
    const store = useJottathingStore();

    try {
      await seedStore(store);
      await store.createPage();
      await waitFor(() => expect(store.currentProjectId).toBe(resolvedProject.id));

      expect(store.currentProject?.id).toBe(resolvedProject.id);
      expect(store.currentPage?.id).toBe(resolvedPage.id);
    } finally {
      vi.restoreAllMocks();
    }
  });

  test('does not recreate a project row when a durable project still says creating', async () => {
    const workspace: Workspace = {
      id: 'workspace-notion-notion%3Atest-user-unknown',
      name: 'Notion',
      kind: 'notion',
      accountId: 'notion:test-user',
      notionWorkspaceId: 'notion-workspace',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const existingProject: Project = {
      ...baseProject,
      id: 'project-resumed',
      workspaceId: workspace.id,
      syncMode: 'notion',
      syncState: 'creating',
    };
    const existingPage: ProjectPage = {
      ...basePage,
      id: 'page-project-resumed',
      projectId: existingProject.id,
      workspaceId: workspace.id,
      syncMode: 'notion',
      syncAccountId: workspace.accountId,
      syncWorkspaceId: workspace.notionWorkspaceId,
      syncState: 'creating',
    };
    resetBrowserStorage({
      activePageIdsByProject: { [existingProject.id]: existingPage.id },
      currentProjectId: existingProject.id,
      currentProjectIdByWorkspace: { [workspace.id]: existingProject.id },
      currentWorkspaceId: workspace.id,
      hasMigratedCapturesToPages: true,
      pages: [existingPage],
      projects: [existingProject],
      syncConfig: { ...connectedConfig, workspaceId: workspace.notionWorkspaceId },
      workspaces: [workspace],
    });
    const fetchMock = vi.fn(async () => {
      return jsonResponse({ queued: true, versions: {} });
    });
    vi.stubGlobal('fetch', fetchMock);

    const creation = await notionClient.createProjectPage(existingProject.id, 'Page 2');
    const settledPage = await creation.settled;
    const stored = readBrowserStorage();
    const projectRequests = (fetchMock.mock.calls as unknown as Array<[string]>).filter(([url]) =>
      url.endsWith('/sync/project'),
    );

    expect(projectRequests).toHaveLength(0);
    expect(settledPage.projectId).toBe(existingProject.id);
    expect((stored.projects as Project[])
      .filter((project) => project.workspaceId === workspace.id)
      .map((project) => project.id)).toEqual([existingProject.id]);
    expect((stored.pages as ProjectPage[]).map((page) => page.id)).toContain(existingPage.id);
    expect((stored.pages as ProjectPage[]).map((page) => page.id)).toContain(settledPage.id);
    expect((stored.activePageIdsByProject as Record<string, string>)[existingProject.id])
      .toBe(settledPage.id);
  });
});

describe('page title and content saves', () => {
  test('reports when a local page save fails so the editor can retry', async () => {
    const store = useJottathingStore();
    await seedStore(store);
    vi.spyOn(notionClient, 'updateProjectPage').mockRejectedValueOnce(
      new Error('local storage unavailable'),
    );

    const saved = await store.saveCurrentPageContent(docWithText('retry this edit'), {
      preserveLocalContent: true,
    });

    expect(saved).toBe(false);
    expect(store.saveStatus).toBe('error');
  });

  test('reports when an exit-time page snapshot fails to persist', async () => {
    const store = useJottathingStore();
    await seedStore(store);
    vi.spyOn(notionClient, 'updateProjectPage').mockRejectedValueOnce(
      new Error('local storage unavailable'),
    );

    const saved = await store.savePageContentSnapshot(
      { ...store.currentPage! },
      docWithText('retry this exit snapshot'),
      { preserveLocalContent: true },
    );

    expect(saved).toBe(false);
    expect(store.saveStatus).toBe('error');
  });

  test('content saves can carry the latest draft title', async () => {
    const { fetchMock, store } = await setupTimerFetchStoreTest();
    await store.saveCurrentPageContent(docWithText('body edit'), {
      preserveLocalContent: true,
      title: 'Renamed Page',
    });

    await advanceTimersToFlush(fetchMock);
    const [, requestInit] = pushedRequests(fetchMock)[0]!;
    const requestBody = JSON.parse(String(requestInit.body));

    expect(requestBody.ops.at(-1).payload.page.title).toBe('Renamed Page');
    expect(requestBody.ops.at(-1).localVersion).toEqual(expect.any(Number));
    expect(store.currentPage?.title).toBe('Renamed Page');
  });

  test('local content is persisted before queue delivery resolves', async () => {
    vi.useFakeTimers();
    const saveRequest = deferred<Response>();
    const fetchMock = vi.fn((input: RequestInfo | URL) =>
      String(input).includes('/sync/retry')
        ? Promise.resolve(jsonResponse({ requeuedCount: 0, requeuedOperationIds: [] }))
        : saveRequest.promise,
    );
    vi.stubGlobal('fetch', fetchMock);
    const store = useJottathingStore();
    const content = docWithText('durable draft');

    await seedStore(store);
    await store.saveCurrentPageContent(content, {
      preserveLocalContent: true,
    });

    expect(stripJottathingBlockIds((readBrowserStorage().pages as ProjectPage[])[0].content)).toEqual(content);
    expect((await listPendingSyncOps()).length).toBeGreaterThan(0);
    await advanceTimersToFlush(fetchMock);
    saveRequest.resolve(jsonResponse({ queued: true, versions: { 'page-jottathing': 1 } }));
  });

  test('content save stays queued locally until its delivery timer fires', async () => {
    const { fetchMock, store } = await setupTimerFetchStoreTest();
    await store.saveCurrentPageContent(docWithText('local state is enough'), {
      preserveLocalContent: true,
    });

    expect(store.saveStatus).toBe('saving');
    expect(store.currentPage?.syncState).toBe('saving');
    expect((await listPendingSyncOps()).length).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(499);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('local queue waits 500 ms after the latest edit before pushing compacted updates', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () =>
      jsonResponse({ queued: true, versions: { 'page-jottathing': 2 } }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const store = useJottathingStore();
    const startingPage = { ...basePage, content: docWithBlock('debounced-block', 'first') };

    await setupStoreWithPages(store, [startingPage]);
    store.currentPage = startingPage;
    await store.saveCurrentPageContent(docWithBlock('debounced-block', 'second'), {
      preserveLocalContent: true,
    });
    await vi.advanceTimersByTimeAsync(250);
    await store.saveCurrentPageContent(docWithBlock('debounced-block', 'third'), {
      preserveLocalContent: true,
    });

    await vi.advanceTimersByTimeAsync(499);
    expect(fetchMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await flushPromises(10);

    expect(pushedRequests(fetchMock)).toHaveLength(1);
    const [, requestInit] = pushedRequests(fetchMock)[0]!;
    const requestBody = JSON.parse(String(requestInit.body));
    expect(requestBody.ops).toHaveLength(1);
    expect(requestBody.ops[0].type).toBe('block_update');
    expect(requestBody.ops[0].payload.block).toEqual(blockWithId('debounced-block', 'third'));
  });

  test('force flushing sends pending edits immediately', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () =>
      jsonResponse({ queued: true, versions: { 'page-jottathing': 1 } }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const content = docWithText('flush now');

    await notionClient.updateProjectPage({
      ...basePage,
      content,
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).not.toHaveBeenCalled();

    await notionClient.flushPendingSyncOps({ force: true });

    expect(pushedRequests(fetchMock)).toHaveLength(1);
    expect(await listPendingSyncOps()).toEqual([]);
  });

  test('overlapping force flushes send edits queued during the first upload', async () => {
    vi.useFakeTimers();
    const firstPush = deferred<Response>();
    const secondPush = deferred<Response>();
    const firstRequestStarted = deferred<void>();
    const secondRequestStarted = deferred<void>();
    let pushCount = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('/sync/retry')) {
        return jsonResponse({ requeuedCount: 0, requeuedOperationIds: [] });
      }
      if (++pushCount === 1) {
        firstRequestStarted.resolve(undefined);
        return firstPush.promise;
      }
      secondRequestStarted.resolve(undefined);
      return secondPush.promise;
    });
    vi.stubGlobal('fetch', fetchMock);
    const store = useJottathingStore();
    const startingPage = { ...basePage, content: docWithBlock('focus-block', 'first') };

    await setupStoreWithPages(store, [startingPage]);
    store.currentPage = startingPage;
    await store.saveCurrentPageContent(docWithBlock('focus-block', 'second'), {
      preserveLocalContent: true,
    });

    const firstFlush = notionClient.flushPendingSyncOps({ force: true });
    await firstRequestStarted.promise;
    await store.saveCurrentPageContent(docWithBlock('focus-block', 'third'), {
      preserveLocalContent: true,
    });
    const overlappingFlush = notionClient.flushPendingSyncOps({ force: true });

    firstPush.resolve(jsonResponse({ queued: true, versions: { 'page-jottathing': 1 } }));
    await secondRequestStarted.promise;
    expect(pushedRequests(fetchMock)).toHaveLength(2);

    secondPush.resolve(jsonResponse({ queued: true, versions: { 'page-jottathing': 2 } }));
    await Promise.all([firstFlush, overlappingFlush]);

    expect(await listPendingSyncOps()).toEqual([]);
  });

  test('failed force flushing keeps pending edits locally', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('offline');
    }));

    await notionClient.updateProjectPage({
      ...basePage,
      content: docWithText('offline force'),
    });

    await expect(notionClient.flushPendingSyncOps({ force: true })).rejects.toThrow('offline');
    expect((await listPendingSyncOps()).length).toBeGreaterThan(0);
  });

  test('multiple unsent edits to the same block compact to the final update', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('offline');
    }));
    const store = useJottathingStore();
    const startingPage = { ...basePage, content: docWithBlock('same-block', 'first') };

    await setupStoreWithPages(store, [startingPage]);
    store.currentPage = startingPage;
    await store.saveCurrentPageContent(docWithBlock('same-block', 'second'), {
      preserveLocalContent: true,
    });
    await store.saveCurrentPageContent(docWithBlock('same-block', 'third'), {
      preserveLocalContent: true,
    });

    const compacted = compactPendingSyncOps(await listPendingSyncOps());
    const updates = compacted.filter((op) => op.type === 'block_update');
    expect(updates).toHaveLength(1);
    expect(updates[0].payload.block).toEqual(blockWithId('same-block', 'third'));
  });

  test('mark-only formatting changes enqueue a block update', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('offline');
    }));
    const store = useJottathingStore();
    const startingPage = { ...basePage, content: docWithBlock('formatted-block', 'plain') };
    const formattedContent = docWithMarkedBlock('formatted-block', 'plain', [{ type: 'bold' }]);

    await setupStoreWithPages(store, [startingPage]);
    store.currentPage = startingPage;
    await store.saveCurrentPageContent(formattedContent, {
      preserveLocalContent: true,
    });

    const updates = compactPendingSyncOps(await listPendingSyncOps())
      .filter((op) => op.type === 'block_update');
    expect(updates).toHaveLength(1);
    expect(updates[0].payload.block).toEqual(formattedContent.content?.[0]);
  });

  test('highlight formatting changes enqueue a block update', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('offline');
    }));
    const store = useJottathingStore();
    const startingPage = { ...basePage, content: docWithBlock('highlight-block', 'plain') };
    const highlightedContent = docWithMarkedBlock('highlight-block', 'plain', [
      { type: 'textStyle', attrs: { backgroundColor: '#fef08a', color: null, fontSize: null } },
    ]);

    await setupStoreWithPages(store, [startingPage]);
    store.currentPage = startingPage;
    await store.saveCurrentPageContent(highlightedContent, {
      preserveLocalContent: true,
    });

    const updates = compactPendingSyncOps(await listPendingSyncOps())
      .filter((op) => op.type === 'block_update');
    expect(updates).toHaveLength(1);
    expect(updates[0].payload.block).toEqual(highlightedContent.content?.[0]);
  });

  test('saving unchanged content does not enqueue a fallback page upsert', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('offline');
    }));
    const store = useJottathingStore();
    const startingPage = { ...basePage, content: docWithBlock('unchanged-block', 'same') };

    await setupStoreWithPages(store, [startingPage]);
    store.currentPage = startingPage;
    await store.saveCurrentPageContent(startingPage.content, {
      preserveLocalContent: true,
    });

    expect(await listPendingSyncOps()).toEqual([]);
  });

  test('a create followed by update keeps the complete latest block snapshot', async () => {
    const { store } = await setupOfflineEmptyPageTest('new-block');
    await store.saveCurrentPageContent(docWithBlock('new-block', 'updated'), {
      preserveLocalContent: true,
    });

    const compacted = compactPendingSyncOps(await listPendingSyncOps());
    const creates = compacted.filter((op) => op.type === 'block_create');
    expect(creates).toHaveLength(1);
    expect(creates[0].payload.block).toEqual(blockWithId('new-block', 'updated'));
    expect(creates[0].payload.page).not.toHaveProperty('content');
  });

  test('a create followed by delete before delivery drops both redundant block ops', async () => {
    const { store } = await setupOfflineEmptyPageTest('temporary-block');
    const compacted = await saveEmptyAndCompact(store);
    expect(compacted.some((op) => op.type === 'block_create')).toBe(false);
    expect(compacted.some((op) => op.type === 'block_update')).toBe(false);
    expect(compacted.some((op) => op.type === 'block_delete')).toBe(false);
  });

  test('an update followed by delete drops the redundant update', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('offline');
    }));
    const store = useJottathingStore();
    const startingPage = { ...basePage, content: docWithBlock('removed-block', 'before') };

    await setupStoreWithPages(store, [startingPage]);
    store.currentPage = startingPage;
    await store.saveCurrentPageContent(docWithBlock('removed-block', 'after'), {
      preserveLocalContent: true,
    });
    const compacted = await saveEmptyAndCompact(store);
    expect(compacted.some((op) => op.type === 'block_update')).toBe(false);
    expect(compacted.some((op) => op.type === 'block_delete')).toBe(true);
  });

  test('force flushing compacts the queue before sending', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () =>
      jsonResponse({ queued: true, versions: { 'page-jottathing': 2 } }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const startingPage = { ...basePage, content: docWithBlock('force-block', 'first') };

    resetBrowserStorage({
      activePageIdsByProject: { 'project-jottathing': 'page-jottathing' },
      currentProjectId: 'project-jottathing',
      hasMigratedCapturesToPages: true,
      pages: [startingPage],
      projects: [baseProject],
      syncConfig: connectedConfig,
    });

    await notionClient.updateProjectPage({
      ...startingPage,
      content: docWithBlock('force-block', 'second'),
    });
    await notionClient.updateProjectPage({
      ...startingPage,
      content: docWithBlock('force-block', 'third'),
    });

    const requestBody = await flushAndReadRequest(fetchMock);
    expect(requestBody.ops).toHaveLength(1);
    expect(requestBody.ops[0].payload.page).not.toHaveProperty('content');
    expect(requestBody.ops[0].payload.block).toEqual(blockWithId('force-block', 'third'));
    expect(requestBody.ops[0].localVersion).toBeGreaterThan(1);
  });

  test('force flushing keeps metadata and latest block ops separate', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () =>
      jsonResponse({ queued: true, versions: { 'page-jottathing': 3 } }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const startingPage = { ...basePage, content: docWithBlock('snapshot-block', 'first') };

    resetBrowserStorage({
      activePageIdsByProject: { 'project-jottathing': 'page-jottathing' },
      currentProjectId: 'project-jottathing',
      hasMigratedCapturesToPages: true,
      pages: [startingPage],
      projects: [baseProject],
      syncConfig: connectedConfig,
    });

    await notionClient.updateProjectPage({
      ...startingPage,
      content: docWithBlock('snapshot-block', 'second'),
    });
    await notionClient.updateProjectPage({
      ...startingPage,
      title: 'Latest title',
      content: docWithBlock('snapshot-block', 'third'),
    });

    const requestBody = await flushAndReadRequest(fetchMock);

    expect(requestBody.ops).toHaveLength(2);
    expect(requestBody.ops.some((op: { type: string }) => op.type === 'page_upsert')).toBe(true);
    const updates = requestBody.ops.filter((op: { type: string }) => op.type === 'block_update');
    expect(updates).toHaveLength(1);
    expect(updates[0].payload.page.title).toBe('Latest title');
    expect(updates[0].payload.block).toEqual(blockWithId('snapshot-block', 'third'));
  });
});

describe('offline queue lifecycle', () => {
  test('expands the first sync into a complete local workspace snapshot', async () => {
    const secondProject = {
      ...baseProject,
      id: 'project-local-two',
      name: 'Local Two',
    };
    const secondPage = {
      ...basePage,
      id: 'page-local-two',
      projectId: secondProject.id,
      title: 'Second local page',
      content: docWithText('untouched sibling content'),
    };
    resetBrowserStorage({
      activePageIdsByProject: {
        'project-jottathing': 'page-jottathing',
        [secondProject.id]: secondPage.id,
      },
      currentProjectId: 'project-jottathing',
      hasMigratedCapturesToPages: true,
      pages: [basePage, secondPage],
      projects: [baseProject, secondProject],
      syncConfig: { ...connectedConfig, connected: false },
    });
    await notionClient.updateProjectPage({
      ...basePage,
      content: docWithText('local-only edit'),
    });
    await notionClient.updateSyncConfig({
      connected: true,
      workspaceId: 'workspace-first-sync',
    });

    expect(await notionClient.prepareLocalWorkspaceForFirstSync()).toBe(true);

    const projectEvents = await listPendingProjectSyncEvents();
    const pageOps = await listPendingSyncOps();
    expect(projectEvents.map((event) => event.projectId).sort()).toEqual([
      'project-jottathing',
      'project-local-two',
    ]);
    expect(new Set(pageOps.map((op) => op.pageId))).toEqual(new Set([
      'page-jottathing',
      'page-local-two',
    ]));
    expect(pageOps).toHaveLength(4);
    for (const pageId of ['page-jottathing', 'page-local-two']) {
      const ops = pageOps.filter((op) => op.pageId === pageId);
      expect(ops.map((op) => op.type)).toEqual(['blocks_reset', 'block_create']);
      expect(ops.every((op) => !('content' in op.payload.page))).toBe(true);
    }
    expect(readBrowserStorage().notionHydrationSource).toBe(
      'http://localhost:8787::workspace-first-sync',
    );
    expect(await notionClient.needsInitialNotionHydration()).toBe(false);
    expect(await notionClient.prepareLocalWorkspaceForFirstSync()).toBe(false);
  });

  test('restores local edits and their queue after an offline reload', async () => {
    vi.useFakeTimers();
    const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { onLine: false },
    });
    const offlineConfig = { ...connectedConfig, connected: false };
    resetBrowserStorage({
      activePageIdsByProject: { 'project-jottathing': 'page-jottathing' },
      currentProjectId: 'project-jottathing',
      hasMigratedCapturesToPages: true,
      pages: [basePage],
      projects: [baseProject],
      syncConfig: offlineConfig,
    });

    try {
      const offlineContent = docWithText('available after reload');
      await notionClient.updateProjectPage({ ...basePage, content: offlineContent });

      setActivePinia(createPinia());
      const reloadedStore = useJottathingStore();
      const initialization = reloadedStore.initialize();
      await vi.runAllTimersAsync();
      await initialization;

      expect(stripJottathingBlockIds(reloadedStore.currentPage?.content)).toEqual(offlineContent);
      expect(reloadedStore.pendingSyncCount).toBeGreaterThan(0);
      expect(reloadedStore.isOnline).toBe(false);
    } finally {
      if (originalNavigator) {
        Object.defineProperty(globalThis, 'navigator', originalNavigator);
      } else {
        Reflect.deleteProperty(globalThis, 'navigator');
      }
    }
  });

  test('uploads persisted local media as part of the first Notion sync', async () => {
    const localMediaPage = {
      ...basePage,
      content: doc([image({
        src: 'data:image/png;base64,YQ==',
        filename: 'offline.png',
        mimeType: 'image/png',
        uploadState: 'local',
        jottathingBlockId: 'offline-image',
      })]),
    };
    resetBrowserStorage({
      activePageIdsByProject: { 'project-jottathing': 'page-jottathing' },
      currentProjectId: 'project-jottathing',
      hasMigratedCapturesToPages: true,
      pages: [localMediaPage],
      projects: [baseProject],
      syncConfig: { ...connectedConfig, workspaceId: 'workspace-media' },
    });
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
      if (String(url).endsWith('/media/upload')) {
        return jsonResponse({ fileUploadId: 'notion-upload-id' });
      }
      if (String(url).endsWith('/sync/project')) {
        return jsonResponse({ status: 'saved', project: baseProject });
      }
      return jsonResponse({ queued: true, versions: { 'page-jottathing': 1 } });
    });
    vi.stubGlobal('fetch', fetchMock);

    expect(await notionClient.prepareLocalWorkspaceForFirstSync()).toBe(true);
    await notionClient.flushPendingSyncOps({ force: true });

    const pushCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/sync/push'));
    const pushBody = JSON.parse(String(pushCall?.[1]?.body));
    const serializedPush = JSON.stringify(pushBody);
    const storedPage = (readBrowserStorage().pages as ProjectPage[])[0];
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      'http://localhost:8787/sync/project',
      'http://localhost:8787/media/upload',
      'http://localhost:8787/sync/push',
    ]);
    expect(serializedPush).not.toContain('data:image/png');
    expect(serializedPush).toContain('notion-upload-id');
    expect(storedPage.content.content?.[0].attrs).toMatchObject({
      src: 'data:image/png;base64,YQ==',
      notionFileUploadId: 'notion-upload-id',
      uploadState: 'done',
    });
    expect(await notionClient.pendingSyncEventCount()).toBe(0);
  });

  test('flushes restored queue entries when the browser comes online', async () => {
    const fetchMock = vi.fn(async (url: string) =>
      String(url).endsWith('/session')
        ? jsonResponse({ authenticated: true, connected: true })
        : jsonResponse({ queued: true, versions: { 'page-jottathing': 1 } }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const OriginalEventSource = globalThis.EventSource;
    globalThis.EventSource = class {
      onerror = null;
      onmessage = null;
      onopen = null;
      close() {}
    } as unknown as typeof EventSource;

    try {
      await notionClient.updateProjectPage({
        ...basePage,
        content: docWithText('sync on reconnect'),
      });
      const store = useJottathingStore();
      await seedStore(store);
      store.handleOffline();

      await store.handleOnline();

      expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
        'http://localhost:8787/session',
        'http://localhost:8787/sync/project',
        'http://localhost:8787/sync/push',
        'http://localhost:8787/sync/validate',
      ]);
      expect(store.pendingSyncCount).toBe(0);
      expect(await notionClient.pendingSyncEventCount()).toBe(0);
    } finally {
      globalThis.EventSource = OriginalEventSource;
    }
  });
});

describe('project page caching', () => {
  test('selecting a cached page skips pull when server version is not newer', async () => {
    const pagePull = deferred<Response>();
    const fetchMock = vi.fn(() => pagePull.promise);
    vi.stubGlobal('fetch', fetchMock);
    const pageTwo = {
      ...basePage,
      id: 'page-two',
      title: 'Cached Page',
      content: docWithText('cached body'),
      notionPageId: 'notion-page-two',
      remoteRevision: 'rev-1',
    };
    const store = useJottathingStore();
    await setupStoreWithPages(store, [basePage, pageTwo]);

    await store.selectPage('page-two');

    expect(stripJottathingBlockIds(store.currentPage?.content)).toEqual(docWithText('cached body'));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('selecting a cached page pulls when server version is newer', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      status: 'saved',
      page: {
        ...basePage,
        id: 'page-two',
        title: 'Cached Page',
        content: docWithText('fresh body'),
        remoteRevision: 'rev-2',
        syncState: 'saved',
      },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const pageTwo = {
      ...basePage,
      id: 'page-two',
      title: 'Cached Page',
      content: docWithText('cached body'),
      notionPageId: 'notion-page-two',
      remoteRevision: 'rev-1',
      knownSyncVersion: 1,
      serverSyncVersion: 2,
    };
    const store = useJottathingStore();
    await setupStoreWithPages(store, [basePage, pageTwo]);

    await store.selectPage('page-two');

    await waitFor(() =>
      expect(store.currentPage?.content).toEqual(docWithText('fresh body')),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(store.currentPage?.knownSyncVersion).toBe(2);
  });

  test('background snapshot saves do not overwrite a newly selected page', async () => {
    const saveRequest = deferred<Response>();
    vi.stubGlobal('fetch', vi.fn(() => saveRequest.promise));
    const pageTwo = {
      ...basePage,
      id: 'page-two',
      title: 'Second Page',
      content: docWithText('second body'),
    };
    const store = useJottathingStore();

    await setupStoreWithPages(store, [basePage, pageTwo]);

    const savePromise = store.savePageContentSnapshot(
      basePage,
      docWithText('old page edit'),
      { preserveLocalContent: true },
    );
    store.currentPage = pageTwo;

    saveRequest.resolve(jsonResponse({
      status: 'saved',
      page: {
        ...basePage,
        content: docWithText('old page edit'),
        syncState: 'saved',
      },
    }));
    await savePromise;

    expect(store.currentPage?.id).toBe('page-two');
    expect(store.currentPage?.content).toEqual(docWithText('second body'));
    expect(store.pages.find((page) => page.id === 'page-jottathing')?.content)
      .toEqual(docWithText('old page edit'));
  });

  test('refreshing a selected page does not overwrite newer local content', async () => {
    const { pagePull, store, refreshPromise, syncedBasePage } = await setupRefreshTest();

    pagePull.resolve(jsonResponse({
      status: 'saved',
      page: {
        ...syncedBasePage,
        content: docWithText('remote content'),
        remoteRevision: 'remote-2',
        syncState: 'saved',
      },
    }));
    await refreshPromise;

    expect(store.currentPage?.content).toEqual(docWithText('newer local draft'));
    expect(store.currentPage?.remoteRevision).toBe('remote-2');
  });

  test('refreshing a selected page keeps Notion-added images with newer local content', async () => {
    const { pagePull, store, refreshPromise, syncedBasePage } = await setupRefreshTest();

    pagePull.resolve(jsonResponse({
      status: 'saved',
      page: {
        ...syncedBasePage,
        content: doc([
          paragraph('remote content'),
          image({
            src: 'https://secure.notion-static.com/image.png',
            jottathingBlockId: 'remote-image',
          }),
        ]),
        remoteRevision: 'remote-2',
        syncState: 'saved',
      },
    }));
    await refreshPromise;

    expect(store.currentPage?.content.content).toEqual([
      paragraph('newer local draft'),
      image({
        src: 'https://secure.notion-static.com/image.png',
        jottathingBlockId: 'remote-image',
      }),
    ]);
    expect(store.currentPage?.remoteRevision).toBe('remote-2');
  });

  test('runtime page updates do not overwrite newer active page content', async () => {
    const store = useJottathingStore();
    const localPage = {
      ...basePage,
      content: docWithText('newer local draft'),
      localRevision: 'local-2',
      remoteRevision: 'remote-1',
    };
    const incomingPage = {
      ...basePage,
      content: docWithText('background capture result'),
      localRevision: 'local-1',
      notionPageId: 'notion-page',
      remoteRevision: 'remote-2',
      syncState: 'saved' as const,
    };

    await seedStore(store, [localPage]);
    store.currentPage = localPage;
    store.startRuntimeListener();

    const listener = vi.mocked(browser.runtime.onMessage.addListener)
      .mock.calls.at(-1)?.[0] as ((message: unknown) => unknown) | undefined;
    listener?.({
      type: 'jottathing.projectPageUpdated',
      payload: {
        page: incomingPage,
      },
    });

    expect(store.currentPage?.content).toEqual(docWithText('newer local draft'));
    expect(store.currentPage?.notionPageId).toBe('notion-page');
    expect(store.currentPage?.remoteRevision).toBe('remote-2');
  });
});

describe('cross-instance workspace refresh', () => {
  test('manual resync refreshes the live project and page after a remote project change', async () => {
    const remoteProject: Project = {
      ...baseProject,
      id: 'project-from-another-instance',
      name: 'Remote project',
    };
    const remotePage: ProjectPage = {
      ...basePage,
      id: 'page-from-another-instance',
      projectId: remoteProject.id,
      title: 'Remote page',
    };
    const store = useJottathingStore();
    await setupStoreWithPages(store, [basePage]);
    const resync = vi.spyOn(notionClient, 'resyncPendingChanges').mockImplementation(async () => {
      resetBrowserStorage({
        activePageIdsByProject: { [remoteProject.id]: remotePage.id },
        currentProjectId: remoteProject.id,
        hasMigratedCapturesToPages: true,
        pages: [remotePage],
        projects: [remoteProject],
        syncConfig: connectedConfig,
      });
      return {
        blockedProjectCount: 0,
        conflicts: [],
        reloadedFromNotion: true,
        remoteReloadPending: false,
        failedUploadCount: 0,
        remainingCount: 0,
      };
    });

    await store.resyncPendingChanges();

    expect(store.projects.map((project) => project.id)).toEqual([remoteProject.id]);
    expect(store.currentProjectId).toBe(remoteProject.id);
    expect(store.pages.map((page) => page.id)).toEqual([remotePage.id]);
    expect(store.currentPage?.id).toBe(remotePage.id);
    resync.mockRestore();
  });

  test('manual resync replaces a remotely deleted current page with the surviving page', async () => {
    const survivingPage: ProjectPage = {
      ...basePage,
      id: 'page-that-survived-remotely',
      title: 'Surviving page',
    };
    const deletedPage: ProjectPage = {
      ...basePage,
      id: 'page-deleted-remotely',
      title: 'Deleted page',
    };
    const store = useJottathingStore();
    await setupStoreWithPages(store, [deletedPage, survivingPage]);
    store.currentPage = deletedPage;
    const resync = vi.spyOn(notionClient, 'resyncPendingChanges').mockImplementation(async () => {
      resetBrowserStorage({
        activePageIdsByProject: { [baseProject.id]: survivingPage.id },
        currentProjectId: baseProject.id,
        hasMigratedCapturesToPages: true,
        pages: [survivingPage],
        projects: [baseProject],
        syncConfig: connectedConfig,
      });
      return {
        blockedProjectCount: 0,
        conflicts: [],
        reloadedFromNotion: true,
        remoteReloadPending: false,
        failedUploadCount: 0,
        remainingCount: 0,
      };
    });

    await store.resyncPendingChanges();

    expect(store.pages.map((page) => page.id)).toEqual([survivingPage.id]);
    expect(store.currentPage?.id).toBe(survivingPage.id);
    resync.mockRestore();
  });

  test('manual sync reloads when remote project/page IDs changed without local event rows', async () => {
    const externalPage: ProjectPage = {
      ...basePage,
      id: 'page-created-in-another-instance',
      title: 'External page',
      notionPageId: 'external-thread-block',
    };
    const store = useJottathingStore();
    await setupStoreWithPages(store, [basePage]);
    vi.spyOn(notionClient, 'flushPendingSyncOps').mockResolvedValue(undefined);
    vi.spyOn(notionClient, 'pendingSyncEventCount').mockResolvedValue(0);
    vi.spyOn(notionClient, 'validateNotionCache').mockResolvedValue({
      stalePageIds: [],
      aheadPageIds: [],
      failedPageIds: [],
      newPageIds: [],
      workspaceChanged: true,
    });
    const reload = vi.spyOn(notionClient, 'reloadFromNotion').mockResolvedValue({
      currentProjectId: baseProject.id,
      pages: [basePage, externalPage],
      projects: [baseProject],
      syncConfig: connectedConfig,
    });
    vi.spyOn(notionClient, 'listProjectPages').mockResolvedValue([basePage, externalPage]);
    vi.spyOn(notionClient, 'getProjectPage').mockResolvedValue(basePage);
    vi.spyOn(notionClient, 'prefetchProjectPages').mockResolvedValue(undefined);

    await store.syncPendingChanges();

    expect(reload).toHaveBeenCalledWith({ force: true });
    expect(store.pages.map((page) => page.id)).toContain(externalPage.id);
  });
});

async function setupStoreWithPages(
  store: ReturnType<typeof useJottathingStore>,
  pages: ProjectPage[],
) {
  resetBrowserStorage({
    activePageIdsByProject: { 'project-jottathing': 'page-jottathing' },
    currentProjectId: 'project-jottathing',
    hasMigratedCapturesToPages: true,
    pages,
    projects: [baseProject],
    syncConfig: connectedConfig,
  });
  await seedStore(store, pages);
}

async function seedStore(
  store: ReturnType<typeof useJottathingStore>,
  pages = [basePage],
) {
  store.syncConfig = connectedConfig;
  store.projects = [baseProject];
  store.pages = pages;
  store.currentProjectId = 'project-jottathing';
  store.currentPage = basePage;
  await nextTick();
}

async function setupProjectSyncTest(projectName: string) {
  const projectSync = deferred<Response>();
  vi.stubGlobal('fetch', vi.fn(() => projectSync.promise));
  const store = useJottathingStore();
  await seedNotionStore(store);
  await store.createProject(projectName);
  return { projectSync, store };
}

async function seedNotionStore(store: ReturnType<typeof useJottathingStore>) {
  resetBrowserStorage({
    activePageIdsByProject: { [notionTestProject.id]: notionTestPage.id },
    currentProjectId: notionTestProject.id,
    currentProjectIdByWorkspace: { [testNotionWorkspace.id]: notionTestProject.id },
    currentWorkspaceId: testNotionWorkspace.id,
    hasMigratedCapturesToPages: true,
    pages: [notionTestPage],
    projects: [notionTestProject],
    syncConfig: connectedConfig,
    workspaces: [testNotionWorkspace],
  });
  await seedStore(store);
  store.projects = [notionTestProject];
  store.pages = [notionTestPage];
  store.workspaces = [testNotionWorkspace];
  store.currentWorkspaceId = testNotionWorkspace.id;
  store.currentPage = notionTestPage;
}

async function setupTimerFetchStoreTest() {
  vi.useFakeTimers();
  const fetchMock = vi.fn(async () =>
    jsonResponse({ queued: true, versions: { 'page-jottathing': 1 } }),
  );
  vi.stubGlobal('fetch', fetchMock);
  const store = useJottathingStore();
  await seedStore(store);
  return { fetchMock, store };
}

async function advanceTimersToFlush(fetchMock: ReturnType<typeof vi.fn>) {
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(499);
  expect(fetchMock).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await flushPromises(10);
  expect(pushedRequests(fetchMock)).toHaveLength(1);
}

async function waitForFirstRequest(fetchMock: ReturnType<typeof vi.fn>) {
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  return JSON.parse(String(
    (fetchMock.mock.calls as unknown as Array<[string, RequestInit]>)[0][1]?.body,
  ));
}

async function flushAndReadRequest(fetchMock: ReturnType<typeof vi.fn>) {
  await notionClient.flushPendingSyncOps({ force: true });
  const [, requestInit] = pushedRequests(fetchMock)[0]!;
  return JSON.parse(String(requestInit.body));
}

function pushedRequests(fetchMock: ReturnType<typeof vi.fn>) {
  return (fetchMock.mock.calls as unknown as Array<[string, RequestInit]>)
    .filter(([url]) => url.endsWith('/sync/push'));
}

async function setupOfflineEmptyPageTest(blockId: string) {
  vi.stubGlobal('fetch', vi.fn(async () => {
    throw new TypeError('offline');
  }));
  const store = useJottathingStore();
  const startingPage = { ...basePage, content: { type: 'doc', content: [] } };
  await setupStoreWithPages(store, [startingPage]);
  store.currentPage = startingPage;
  await store.saveCurrentPageContent(docWithBlock(blockId, 'created'), {
    preserveLocalContent: true,
  });
  return { store };
}

async function saveEmptyAndCompact(store: ReturnType<typeof useJottathingStore>) {
  await store.saveCurrentPageContent({ type: 'doc', content: [] }, {
    preserveLocalContent: true,
  });
  return compactPendingSyncOps(await listPendingSyncOps());
}

async function setupRefreshTest() {
  const syncedBasePage = {
    ...basePage,
    localRevision: 'local-1',
    notionPageId: 'notion-page',
    remoteRevision: 'remote-1',
    knownSyncVersion: 1,
    serverSyncVersion: 2,
  };
  const pagePull = deferred<Response>();
  vi.stubGlobal('fetch', vi.fn(() => pagePull.promise));
  const store = useJottathingStore();
  await setupStoreWithPages(store, [syncedBasePage]);
  const refreshPromise = store.refreshSelectedPage('page-jottathing');
  store.currentPage = {
    ...store.currentPage!,
    content: docWithText('newer local draft'),
    localRevision: 'local-2',
  };
  return { pagePull, store, refreshPromise, syncedBasePage };
}

function emptyDocument(): DocumentContent {
  return {
    type: 'doc',
    content: [{ type: 'paragraph' }],
  };
}

function docWithText(text: string): DocumentContent {
  return {
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [{ type: 'text', text }],
      },
    ],
  };
}

function docWithBlock(jottathingBlockId: string, text: string): DocumentContent {
  return {
    type: 'doc',
    content: [blockWithId(jottathingBlockId, text)],
  };
}

function blockWithId(jottathingBlockId: string, text: string): DocumentContent {
  return {
    type: 'paragraph',
    attrs: { jottathingBlockId },
    content: [{ type: 'text', text }],
  };
}

function docWithMarkedBlock(
  jottathingBlockId: string,
  text: string,
  marks: NonNullable<DocumentContent['marks']>,
): DocumentContent {
  return {
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        attrs: { jottathingBlockId },
        content: [{ type: 'text', text, marks }],
      },
    ],
  };
}

function docWithParagraphs(lines: string[]): DocumentContent {
  return {
    type: 'doc',
    content: lines.map((line) => ({
      type: 'paragraph',
      content: [{ type: 'text', text: line }],
    })),
  };
}


function stripJottathingBlockIds(content: DocumentContent | undefined): DocumentContent | undefined {
  if (!content) {
    return content;
  }

  const rest = { ...content };
  const originalContent = content.content;
  delete rest.attrs;
  delete rest.content;
  const attrs = content.attrs
    ? Object.fromEntries(
        Object.entries(content.attrs).filter(([key]) => key !== 'jottathingBlockId'),
      )
    : undefined;
  const children = originalContent
    ?.map(stripJottathingBlockIds)
    .filter((child): child is DocumentContent => Boolean(child));

  return {
    ...rest,
    ...(attrs && Object.keys(attrs).length ? { attrs } : {}),
    ...(children ? { content: children } : {}),
  };
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, reject, resolve };
}

function jsonResponse(payload: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => payload,
  } as Response;
}

async function waitFor(assertion: () => void) {
  const startedAt = Date.now();
  let lastError: unknown;

  while (Date.now() - startedAt < 1_000) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  throw lastError;
}

async function flushPromises(count = 1) {
  for (let index = 0; index < count; index += 1) {
    await Promise.resolve();
  }
}
