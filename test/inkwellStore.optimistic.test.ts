import { createPinia, disposePinia, getActivePinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { nextTick } from 'vue';
import { websiteHighlightsFromProjectState } from '@/src/extensions/sourceRegistry';
import { notionClient } from '@/src/services/notionClient';
import {
  compactPendingSyncOps,
  listPendingProjectSyncEvents,
  listPendingSyncOps,
} from '@/src/services/syncQueue';
import { useInkwellStore } from '@/src/stores/inkwell';
import type { DocumentContent, Project, ProjectPage, SyncConfig } from '@/src/types/capture';
import type { WebsiteHighlight } from '@/src/types/messages';
import type { SyncBlockOperation } from '@/src/types/sync';
import { readBrowserStorage, resetBrowserStorage } from './setup';
import { doc, paragraph, image } from './helpers/docBuilders';

type Deferred<T> = {
  promise: Promise<T>;
  reject: (error: unknown) => void;
  resolve: (value: T) => void;
};

const baseProject: Project = {
  id: 'project-inkwell',
  name: 'Inkwell',
  status: 'active',
  category: 'General',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  stateContent: emptyDocument(),
  tags: ['inkwell'],
  syncState: 'saved',
};
const basePage: ProjectPage = {
  id: 'page-inkwell',
  projectId: 'project-inkwell',
  kind: 'page',
  title: 'Untitled Page',
  status: 'active',
  content: emptyDocument(),
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  syncState: 'saved',
};
const connectedConfig: SyncConfig = {
  serverUrl: 'http://localhost:8787',
  authenticated: true,
  connected: true,
};
const websiteHighlight: WebsiteHighlight = {
  id: 'highlight-1',
  url: 'https://example.com/article',
  text: 'a precise passage',
  color: 'yellow',
  createdAt: '2026-09-13T12:00:00.000Z',
  anchor: {
    startXPath: '/html[1]/body[1]/p[1]/text()[1]',
    startOffset: 0,
    endXPath: '/html[1]/body[1]/p[1]/text()[1]',
    endOffset: 17,
    blockXPath: '/html[1]/body[1]/p[1]',
    blockText: 'a precise passage',
  },
};

beforeEach(() => {
  const activePinia = getActivePinia();
  if (activePinia) disposePinia(activePinia);
  setActivePinia(createPinia());
  resetBrowserStorage({
    activePageIdsByProject: { 'project-inkwell': 'page-inkwell' },
    currentProjectId: 'project-inkwell',
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
});

describe('optimistic project creation', () => {
  test('sync payload includes project database metadata defaults', async () => {
    const projectSync = deferred<Response>();
    const fetchMock = vi.fn(() => projectSync.promise);
    vi.stubGlobal('fetch', fetchMock);
    const store = useInkwellStore();

    await seedStore(store);
    await store.createProject('Roadmap');
    const requestBody = await waitForFirstRequest(fetchMock);

    expect(requestBody.project.category).toBe('');
    expect(requestBody.project.createdAt).toEqual(expect.any(String));
    expect(requestBody.project.updatedAt).toEqual(expect.any(String));
    expect(stripInkwellBlockIds(requestBody.project.stateContent)).toEqual(emptyDocument());
  });

  test('appears and is selected before project sync settles', async () => {
    const { projectSync, store } = await setupProjectSyncTest('Roadmap');

    expect(store.currentProjectId).toMatch(/^temp-project-/);
    expect(store.currentPage?.id).toMatch(/^temp-page-/);
    expect(store.projects.at(-1)?.name).toBe('Roadmap');
    expect(store.saveStatus).toBe('creating');
  });

  test('reconciles temp ids and preserves a project switch during sync', async () => {
    const { projectSync, store } = await setupProjectSyncTest('Roadmap');
    const tempProjectId = store.currentProjectId;
    vi.mocked(browser.runtime.sendMessage).mockClear();
    await store.selectProject('project-inkwell');

    expect(browser.runtime.sendMessage).toHaveBeenCalledWith({
      type: 'inkwell.refreshWebsiteHighlights',
    });

    projectSync.resolve(jsonResponse({ status: 'saved' }));
    await waitFor(() =>
      expect(store.projects.some((project) => project.id === tempProjectId)).toBe(false),
    );

    expect(store.currentProjectId).toBe('project-inkwell');
    expect(readBrowserStorage().currentProjectId).toBe('project-inkwell');
    expect((readBrowserStorage().projects as Project[]).some((project) =>
      project.id.startsWith('temp-project-'),
    )).toBe(false);
  });

  test('keeps a new project locally and queues it when sync fails', async () => {
    const { projectSync, store } = await setupProjectSyncTest('Broken');
    const tempProjectId = store.currentProjectId;

    projectSync.reject(new Error('Notion unavailable'));
    await waitFor(() => {
      expect(store.currentProjectId).not.toBe(tempProjectId);
      expect(store.saveStatus).not.toBe('creating');
    });

    expect(store.currentProject?.name).toBe('Broken');
    expect(store.projects.some((project) => project.id === tempProjectId)).toBe(false);
    expect(await notionClient.pendingSyncEventCount()).toBeGreaterThan(0);
  });
});

describe('optimistic startup', () => {
  test('makes the local workspace usable while session refresh is still pending', async () => {
    const sessionRefresh = deferred<Response>();
    const fetchMock = vi.fn(() => sessionRefresh.promise);
    vi.stubGlobal('fetch', fetchMock);
    const store = useInkwellStore();

    const initialization = store.initialize();

    await waitFor(() => {
      expect(store.isLoading).toBe(false);
      expect(store.currentProjectId).toBe(baseProject.id);
      expect(store.currentPage?.id).toBe(basePage.id);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    sessionRefresh.resolve(jsonResponse({
      authenticated: false,
      connected: false,
    }));
    await initialization;
  });
});

describe('local-first website highlights', () => {
  test('persists rapid highlights and queues sync without waiting for the network', async () => {
    const fetchMock = vi.fn(() => new Promise<Response>(() => undefined));
    vi.stubGlobal('fetch', fetchMock);
    const secondHighlight = {
      ...websiteHighlight,
      id: 'highlight-2',
      text: 'another passage',
    };

    const [firstProject, secondProject] = await Promise.all([
      notionClient.createWebsiteHighlight(websiteHighlight),
      notionClient.createWebsiteHighlight(secondHighlight),
    ]);

    expect(firstProject?.syncState).toBe('saving');
    expect(secondProject?.syncState).toBe('saving');
    expect(fetchMock).not.toHaveBeenCalled();
    const [storedProject] = readBrowserStorage().projects as Project[];
    expect(websiteHighlightsFromProjectState(storedProject.stateContent))
      .toEqual([websiteHighlight, secondHighlight]);
    const queued = await listPendingProjectSyncEvents();
    expect(queued).toHaveLength(1);
    expect(websiteHighlightsFromProjectState(queued[0].payload.project.stateContent))
      .toEqual([websiteHighlight, secondHighlight]);
  });

  test('removes a highlight locally before its queued sync is delivered', async () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => undefined)));
    await notionClient.createWebsiteHighlight(websiteHighlight);

    const project = await notionClient.removeWebsiteHighlights(
      [websiteHighlight.id],
      websiteHighlight.url,
    );

    expect(project?.syncState).toBe('saving');
    const [storedProject] = readBrowserStorage().projects as Project[];
    expect(websiteHighlightsFromProjectState(storedProject.stateContent)).toEqual([]);
    const queued = await listPendingProjectSyncEvents();
    expect(queued).toHaveLength(1);
    expect(websiteHighlightsFromProjectState(queued[0].payload.project.stateContent)).toEqual([]);

    const alreadyRemoved = await notionClient.removeWebsiteHighlights(
      [websiteHighlight.id],
      websiteHighlight.url,
    );
    expect(alreadyRemoved).not.toBeNull();
    expect(websiteHighlightsFromProjectState(alreadyRemoved!.stateContent)).toEqual([]);
  });
});

describe('project metadata', () => {
  test('validateNotionCache uncaches missing Notion project and page metadata', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        clearSelectedParentPage: true,
        uncachedProjectIds: ['project-inkwell'],
        uncachedPageIds: ['page-inkwell'],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    resetBrowserStorage({
      activePageIdsByProject: { 'project-inkwell': 'page-inkwell' },
      currentProjectId: 'project-inkwell',
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
      .mockResolvedValueOnce(jsonResponse({
        activePageIdsByProject: { 'project-remote': 'page-remote' },
        currentProjectId: 'missing-local-project',
        pages: [reloadedPage],
        projects: [reloadedProject],
        status: 'saved',
      }));
    vi.stubGlobal('fetch', fetchMock);
    resetBrowserStorage({
      activePageIdsByProject: { 'project-inkwell': 'page-inkwell' },
      currentProjectId: 'project-inkwell',
      hasMigratedCapturesToPages: true,
      pages: [basePage, { ...basePage, id: 'page-deleted' }],
      projects: [baseProject],
      syncConfig,
    });
    const store = useInkwellStore();

    await seedStore(store);
    store.syncConfig = syncConfig;
    await store.reloadFromNotion();
    const storage = readBrowserStorage();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(store.currentProjectId).toBe('project-remote');
    expect(store.currentPage?.id).toBe('page-remote');
    expect(store.pages.map((page) => page.id)).toEqual(['page-remote']);
    expect((storage.pages as ProjectPage[]).map((page) => page.id)).toEqual(['page-remote']);
    expect((storage.projects as Project[]).map((project) => project.id)).toEqual(['project-remote']);
    expect((storage.syncConfig as SyncConfig).selectedParentPageId).toBe('parent-page');
  });

  test('reloadFromNotion clears selected parent when server reports it invalid', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        activePageIdsByProject: {},
        clearSelectedParentPage: true,
        currentProjectId: '',
        pages: [],
        projects: [],
        status: 'saved',
      })));
    resetBrowserStorage({
      activePageIdsByProject: { 'project-inkwell': 'page-inkwell' },
      currentProjectId: 'project-inkwell',
      hasMigratedCapturesToPages: true,
      pages: [basePage],
      projects: [baseProject],
      syncConfig: {
        ...connectedConfig,
        selectedParentPageId: 'missing-parent',
        selectedParentPageTitle: 'Missing',
      },
    });

    await notionClient.reloadFromNotion({ force: true });
    const storage = readBrowserStorage();

    expect((storage.syncConfig as SyncConfig).selectedParentPageId).toBeUndefined();
    expect((storage.syncConfig as SyncConfig).selectedParentPageTitle).toBeUndefined();
    await expect(notionClient.listProjects()).resolves.toEqual([]);
  });

  test('initial hydration keeps the starter project when the remote workspace is new', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      activePageIdsByProject: {},
      currentProjectId: '',
      pages: [],
      projects: [],
      status: 'saved',
    })));
    resetBrowserStorage({
      activePageIdsByProject: { 'project-inkwell': 'page-inkwell' },
      currentProjectId: 'project-inkwell',
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

    expect(reloaded.projects.map((project) => project.id)).toEqual(['project-inkwell']);
    expect((readBrowserStorage().projects as Project[]).map((project) => project.id))
      .toEqual(['project-inkwell']);
    expect(readBrowserStorage().notionHydrationSource).toBe(
      'http://localhost:8787::workspace-new',
    );
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
        connected: true,
        workspaceId: 'workspace-main',
        workspaceName: 'Main workspace',
      }))
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
    globalThis.EventSource = class {
      onerror = null;
      onmessage = null;
      onopen = null;
      close() {}
    } as unknown as typeof EventSource;
    resetBrowserStorage({
      syncConfig: {
        serverUrl: 'http://localhost:8787',
        authenticated: false,
        connected: false,
      },
    });

    try {
      const store = useInkwellStore();
      await store.initialize();

      expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
        'http://localhost:8787/session',
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
        'project-older': 'page-inkwell',
        'project-newer': 'page-inkwell',
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
    const store = useInkwellStore();

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
    const store = useInkwellStore();

    await seedStore(store);
    await store.createPage();

    expect(store.currentPage?.id).toMatch(/^temp-page-/);
    expect(stripInkwellBlockIds(store.currentPage?.content)).toEqual(emptyDocument());
    expect(store.pages.some((page) => page.id === store.currentPage?.id)).toBe(true);
    expect(store.saveStatus).toBe('creating');
  });

  test('replays latest edit after temp page reconciliation through the local queue', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ queued: true, versions: { 'page-inkwell': 1 } }));
    vi.stubGlobal('fetch', fetchMock);
    const store = useInkwellStore();
    const editedContent = docWithText('typed while creating');

    await seedStore(store);
    await store.createPage();
    const tempPageId = store.currentPage?.id ?? '';
    await store.saveCurrentPageContent(editedContent, { preserveLocalContent: true });

    await waitFor(() => expect(store.currentPage?.id).not.toBe(tempPageId));

    expect(stripInkwellBlockIds(store.currentPage?.content)).toEqual(editedContent);
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await listPendingSyncOps()).length).toBeGreaterThan(0);
  });

  test('keeps created page locally when queue delivery fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('offline');
    }));
    const store = useInkwellStore();

    await seedStore(store);
    await store.createPage();
    const tempPageId = store.currentPage?.id ?? '';

    await waitFor(() => expect(store.currentPage?.id).not.toBe(tempPageId));

    expect(store.pages.some((page) => page.id === tempPageId)).toBe(false);
    expect((await listPendingSyncOps()).length).toBeGreaterThan(0);
  });
});

describe('page title and content saves', () => {
  test('content saves can carry the latest draft title', async () => {
    const { fetchMock, store } = await setupTimerFetchStoreTest();
    await store.saveCurrentPageContent(docWithText('body edit'), {
      preserveLocalContent: true,
      title: 'Renamed Page',
    });

    await advanceTimersToFlush(fetchMock);
    const [, requestInit] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const requestBody = JSON.parse(String(requestInit.body));

    expect(requestBody.ops.at(-1).payload.page.title).toBe('Renamed Page');
    expect(requestBody.ops.at(-1).localVersion).toEqual(expect.any(Number));
    expect(store.currentPage?.title).toBe('Renamed Page');
  });

  test('local content is persisted before queue delivery resolves', async () => {
    vi.useFakeTimers();
    const saveRequest = deferred<Response>();
    const fetchMock = vi.fn(() => saveRequest.promise);
    vi.stubGlobal('fetch', fetchMock);
    const store = useInkwellStore();
    const content = docWithText('durable draft');

    await seedStore(store);
    await store.saveCurrentPageContent(content, {
      preserveLocalContent: true,
    });

    expect(stripInkwellBlockIds((readBrowserStorage().pages as ProjectPage[])[0].content)).toEqual(content);
    expect((await listPendingSyncOps()).length).toBeGreaterThan(0);
    await advanceTimersToFlush(fetchMock);
    saveRequest.resolve(jsonResponse({ queued: true, versions: { 'page-inkwell': 1 } }));
  });

  test('content save remains pending until Notion confirms the sync', async () => {
    const { fetchMock, store } = await setupTimerFetchStoreTest();
    await store.saveCurrentPageContent(docWithText('local state is enough'), {
      preserveLocalContent: true,
    });

    expect(store.isSavingLocally).toBe(false);
    expect(store.saveStatus).toBe('saving');
    expect(store.currentPage?.syncState).toBe('saving');
    expect((await listPendingSyncOps()).length).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('tracks local persistence separately from the pending Notion sync', async () => {
    const store = useInkwellStore();
    await seedStore(store);
    const savedPage = {
      ...basePage,
      content: docWithText('locally durable'),
      syncState: 'saving' as const,
    };
    const localSave = deferred<ProjectPage>();
    vi.spyOn(notionClient, 'updateProjectPage').mockReturnValueOnce(localSave.promise);

    const save = store.saveCurrentPageContent(savedPage.content, {
      preserveLocalContent: true,
    });
    expect(store.isSavingLocally).toBe(true);

    localSave.resolve(savedPage);
    await save;

    expect(store.isSavingLocally).toBe(false);
    expect(store.saveStatus).toBe('saving');
  });

  test('reconciles a missed live sync event from the server status', async () => {
    const pendingPage = {
      ...basePage,
      notionPageId: 'notion-page-inkwell',
      syncState: 'saving' as const,
    };
    resetBrowserStorage({
      activePageIdsByProject: { 'project-inkwell': 'page-inkwell' },
      currentProjectId: 'project-inkwell',
      hasMigratedCapturesToPages: true,
      pages: [pendingPage],
      projects: [baseProject],
      syncConfig: connectedConfig,
    });
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      status: 'synced',
      localVersion: 3,
      syncedVersion: 3,
      notionBlockId: 'notion-page-inkwell',
    })));

    const page = await notionClient.waitForProjectPageSync(pendingPage.id);

    expect(page?.syncState).toBe('saved');
    expect(page?.knownSyncVersion).toBe(3);
    expect((readBrowserStorage().pages as ProjectPage[])[0].syncState).toBe('saved');
  });

  test('local queue waits 10 seconds after the latest edit before pushing compacted updates', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () =>
      jsonResponse({ queued: true, versions: { 'page-inkwell': 2 } }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const store = useInkwellStore();
    const startingPage = { ...basePage, content: docWithBlock('debounced-block', 'first') };

    await setupStoreWithPages(store, [startingPage]);
    store.currentPage = startingPage;
    await store.saveCurrentPageContent(docWithBlock('debounced-block', 'second'), {
      preserveLocalContent: true,
    });
    await vi.advanceTimersByTimeAsync(5_000);
    await store.saveCurrentPageContent(docWithBlock('debounced-block', 'third'), {
      preserveLocalContent: true,
    });

    await vi.advanceTimersByTimeAsync(9_999);
    expect(fetchMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await flushPromises(10);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, requestInit] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const requestBody = JSON.parse(String(requestInit.body));
    expect(requestBody.ops).toHaveLength(1);
    expect(requestBody.ops[0].type).toBe('block_update');
    expect(requestBody.ops[0].payload.block).toEqual(blockWithId('debounced-block', 'third'));
  });

  test('force flushing sends pending edits immediately', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () =>
      jsonResponse({ queued: true, versions: { 'page-inkwell': 1 } }),
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

    expect(fetchMock).toHaveBeenCalledTimes(1);
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
    const store = useInkwellStore();
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
    const store = useInkwellStore();
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
    const store = useInkwellStore();
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
    const store = useInkwellStore();
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
    expect(creates[0].payload.page.content).toEqual(docWithBlock('new-block', 'updated'));
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
    const store = useInkwellStore();
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
      jsonResponse({ queued: true, versions: { 'page-inkwell': 2 } }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const startingPage = { ...basePage, content: docWithBlock('force-block', 'first') };

    resetBrowserStorage({
      activePageIdsByProject: { 'project-inkwell': 'page-inkwell' },
      currentProjectId: 'project-inkwell',
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
    expect(requestBody.ops[0].payload.page.content).toEqual(docWithBlock('force-block', 'third'));
    expect(requestBody.ops[0].localVersion).toBeGreaterThan(1);
  });

  test('force flushing keeps metadata and latest block ops separate', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () =>
      jsonResponse({ queued: true, versions: { 'page-inkwell': 3 } }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const startingPage = { ...basePage, content: docWithBlock('snapshot-block', 'first') };

    resetBrowserStorage({
      activePageIdsByProject: { 'project-inkwell': 'page-inkwell' },
      currentProjectId: 'project-inkwell',
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
        'project-inkwell': 'page-inkwell',
        [secondProject.id]: secondPage.id,
      },
      currentProjectId: 'project-inkwell',
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
      'project-inkwell',
      'project-local-two',
    ]);
    expect(new Set(pageOps.map((op) => op.pageId))).toEqual(new Set([
      'page-inkwell',
      'page-local-two',
    ]));
    expect(pageOps).toHaveLength(2);
    expect(pageOps.every((op) =>
      op.type === 'block_reorder' && op.payload.replaceAll === true,
    )).toBe(true);
    expect(readBrowserStorage().notionHydrationSource).toBe(
      'http://localhost:8787::workspace-first-sync',
    );
    expect(await notionClient.needsInitialNotionHydration()).toBe(false);
    expect(await notionClient.prepareLocalWorkspaceForFirstSync()).toBe(false);
  });

  test('repairs legacy first-sync block batches into one authoritative snapshot', () => {
    const page = {
      ...basePage,
      content: docWithBlock('legacy-block', 'only once'),
    };
    const shared = {
      pageId: page.id,
      projectId: baseProject.id,
      createdAt: '2026-09-11T12:00:00.000Z',
      payload: { page, project: baseProject },
    };
    const legacyOps: SyncBlockOperation[] = [
      {
        ...shared,
        opId: 'legacy-page-upsert',
        type: 'page_upsert',
        sequence: 1,
        localVersion: 1,
      },
      {
        ...shared,
        opId: 'legacy-block-create',
        type: 'block_create',
        inkwellBlockId: 'legacy-block',
        sequence: 2,
        localVersion: 2,
        payload: {
          ...shared.payload,
          block: blockWithId('legacy-block', 'only once'),
        },
      },
    ];

    const compacted = compactPendingSyncOps(legacyOps);

    expect(compacted).toHaveLength(1);
    expect(compacted[0]).toMatchObject({
      opId: 'legacy-page-upsert',
      type: 'block_reorder',
      localVersion: 2,
      payload: {
        order: ['legacy-block'],
        replaceAll: true,
      },
    });
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
      activePageIdsByProject: { 'project-inkwell': 'page-inkwell' },
      currentProjectId: 'project-inkwell',
      hasMigratedCapturesToPages: true,
      pages: [basePage],
      projects: [baseProject],
      syncConfig: offlineConfig,
    });

    try {
      const offlineContent = docWithText('available after reload');
      await notionClient.updateProjectPage({ ...basePage, content: offlineContent });

      setActivePinia(createPinia());
      const reloadedStore = useInkwellStore();
      const initialization = reloadedStore.initialize();
      await vi.runAllTimersAsync();
      await initialization;

      expect(stripInkwellBlockIds(reloadedStore.currentPage?.content)).toEqual(offlineContent);
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
        inkwellBlockId: 'offline-image',
      })]),
    };
    resetBrowserStorage({
      activePageIdsByProject: { 'project-inkwell': 'page-inkwell' },
      currentProjectId: 'project-inkwell',
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
      return jsonResponse({ queued: true, versions: { 'page-inkwell': 1 } });
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
        : jsonResponse({ queued: true, versions: { 'page-inkwell': 1 } }),
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
      const store = useInkwellStore();
      await seedStore(store);
      store.handleOffline();

      await store.handleOnline();

      expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
        'http://localhost:8787/session',
        'http://localhost:8787/sync/project',
        'http://localhost:8787/sync/push',
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
    const store = useInkwellStore();
    await setupStoreWithPages(store, [basePage, pageTwo]);

    await store.selectPage('page-two');

    expect(stripInkwellBlockIds(store.currentPage?.content)).toEqual(docWithText('cached body'));
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
    const store = useInkwellStore();
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
    const store = useInkwellStore();

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
    expect(store.pages.find((page) => page.id === 'page-inkwell')?.content)
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
            inkwellBlockId: 'remote-image',
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
        inkwellBlockId: 'remote-image',
      }),
    ]);
    expect(store.currentPage?.remoteRevision).toBe('remote-2');
  });

  test('runtime page updates do not overwrite newer active page content', async () => {
    const store = useInkwellStore();
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
      type: 'inkwell.projectPageUpdated',
      payload: {
        page: incomingPage,
      },
    });

    expect(store.currentPage?.content).toEqual(docWithText('newer local draft'));
    expect(store.currentPage?.notionPageId).toBe('notion-page');
    expect(store.currentPage?.remoteRevision).toBe('remote-2');
  });
});

async function setupStoreWithPages(
  store: ReturnType<typeof useInkwellStore>,
  pages: ProjectPage[],
) {
  resetBrowserStorage({
    activePageIdsByProject: { 'project-inkwell': 'page-inkwell' },
    currentProjectId: 'project-inkwell',
    hasMigratedCapturesToPages: true,
    pages,
    projects: [baseProject],
    syncConfig: connectedConfig,
  });
  await seedStore(store, pages);
}

async function seedStore(
  store: ReturnType<typeof useInkwellStore>,
  pages = [basePage],
) {
  store.syncConfig = connectedConfig;
  store.projects = [baseProject];
  store.pages = pages;
  store.currentProjectId = 'project-inkwell';
  store.currentPage = basePage;
  await nextTick();
}

async function setupProjectSyncTest(projectName: string) {
  const projectSync = deferred<Response>();
  vi.stubGlobal('fetch', vi.fn(() => projectSync.promise));
  const store = useInkwellStore();
  await seedStore(store);
  await store.createProject(projectName);
  return { projectSync, store };
}

async function setupTimerFetchStoreTest() {
  vi.useFakeTimers();
  const fetchMock = vi.fn(async () =>
    jsonResponse({ queued: true, versions: { 'page-inkwell': 1 } }),
  );
  vi.stubGlobal('fetch', fetchMock);
  const store = useInkwellStore();
  await seedStore(store);
  return { fetchMock, store };
}

async function advanceTimersToFlush(fetchMock: ReturnType<typeof vi.fn>) {
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(9_999);
  expect(fetchMock).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await flushPromises(10);
  expect(fetchMock).toHaveBeenCalledTimes(1);
}

async function waitForFirstRequest(fetchMock: ReturnType<typeof vi.fn>) {
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  return JSON.parse(String(
    (fetchMock.mock.calls as unknown as Array<[string, RequestInit]>)[0][1]?.body,
  ));
}

async function flushAndReadRequest(fetchMock: ReturnType<typeof vi.fn>) {
  await notionClient.flushPendingSyncOps({ force: true });
  const [, requestInit] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  return JSON.parse(String(requestInit.body));
}

async function setupOfflineEmptyPageTest(blockId: string) {
  vi.stubGlobal('fetch', vi.fn(async () => {
    throw new TypeError('offline');
  }));
  const store = useInkwellStore();
  const startingPage = { ...basePage, content: { type: 'doc', content: [] } };
  await setupStoreWithPages(store, [startingPage]);
  store.currentPage = startingPage;
  await store.saveCurrentPageContent(docWithBlock(blockId, 'created'), {
    preserveLocalContent: true,
  });
  return { store };
}

async function saveEmptyAndCompact(store: ReturnType<typeof useInkwellStore>) {
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
  const store = useInkwellStore();
  await setupStoreWithPages(store, [syncedBasePage]);
  const refreshPromise = store.refreshSelectedPage('page-inkwell');
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

function docWithBlock(inkwellBlockId: string, text: string): DocumentContent {
  return {
    type: 'doc',
    content: [blockWithId(inkwellBlockId, text)],
  };
}

function blockWithId(inkwellBlockId: string, text: string): DocumentContent {
  return {
    type: 'paragraph',
    attrs: { inkwellBlockId },
    content: [{ type: 'text', text }],
  };
}

function docWithMarkedBlock(
  inkwellBlockId: string,
  text: string,
  marks: NonNullable<DocumentContent['marks']>,
): DocumentContent {
  return {
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        attrs: { inkwellBlockId },
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


function stripInkwellBlockIds(content: DocumentContent | undefined): DocumentContent | undefined {
  if (!content) {
    return content;
  }

  const rest = { ...content };
  const originalContent = content.content;
  delete rest.attrs;
  delete rest.content;
  const attrs = content.attrs
    ? Object.fromEntries(
        Object.entries(content.attrs).filter(([key]) => key !== 'inkwellBlockId'),
      )
    : undefined;
  const children = originalContent
    ?.map(stripInkwellBlockIds)
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
