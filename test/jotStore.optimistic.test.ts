import { setActivePinia, createPinia } from 'pinia';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { nextTick } from 'vue';
import { notionClient } from '@/src/services/notionClient';
import { compactPendingSyncOps, listPendingSyncOps } from '@/src/services/syncQueue';
import { useJotStore } from '@/src/stores/jot';
import type { DocumentContent, Project, ProjectPage, SyncConfig } from '@/src/types/capture';
import { readBrowserStorage, resetBrowserStorage } from './setup';

type Deferred<T> = {
  promise: Promise<T>;
  reject: (error: unknown) => void;
  resolve: (value: T) => void;
};

const baseProject: Project = {
  id: 'project-jot',
  name: 'Jot',
  status: 'active',
  category: 'General',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  stateContent: emptyDocument(),
  tags: ['jot'],
  syncState: 'saved',
};
const basePage: ProjectPage = {
  id: 'page-jot',
  projectId: 'project-jot',
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

beforeEach(() => {
  setActivePinia(createPinia());
  resetBrowserStorage({
    activePageIdsByProject: { 'project-jot': 'page-jot' },
    currentProjectId: 'project-jot',
    hasMigratedCapturesToPages: true,
    pages: [basePage],
    projects: [baseProject],
    syncConfig: connectedConfig,
  });
  vi.clearAllMocks();
});

describe('optimistic project creation', () => {
  test('sync payload includes project database metadata defaults', async () => {
    const projectSync = deferred<Response>();
    const fetchMock = vi.fn(() => projectSync.promise);
    vi.stubGlobal('fetch', fetchMock);
    const store = useJotStore();

    await seedStore(store);
    await store.createProject('Roadmap');
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const requestBody = JSON.parse(String(
      (fetchMock.mock.calls as unknown as Array<[string, RequestInit]>)[0][1]?.body,
    ));

    expect(requestBody.project.category).toBe('');
    expect(requestBody.project.createdAt).toEqual(expect.any(String));
    expect(requestBody.project.updatedAt).toEqual(expect.any(String));
    expect(stripJotBlockIds(requestBody.project.stateContent)).toEqual(emptyDocument());
  });

  test('appears and is selected before project sync settles', async () => {
    const projectSync = deferred<Response>();
    vi.stubGlobal('fetch', vi.fn(() => projectSync.promise));
    const store = useJotStore();

    await seedStore(store);
    await store.createProject('Roadmap');

    expect(store.currentProjectId).toMatch(/^temp-project-/);
    expect(store.currentPage?.id).toMatch(/^temp-page-/);
    expect(store.projects.at(-1)?.name).toBe('Roadmap');
    expect(store.saveStatus).toBe('creating');
  });

  test('reconciles temp ids and preserves a project switch during sync', async () => {
    const projectSync = deferred<Response>();
    vi.stubGlobal('fetch', vi.fn(() => projectSync.promise));
    const store = useJotStore();

    await seedStore(store);
    await store.createProject('Roadmap');
    const tempProjectId = store.currentProjectId;
    await store.selectProject('project-jot');

    projectSync.resolve(jsonResponse({ status: 'saved' }));
    await waitFor(() =>
      expect(store.projects.some((project) => project.id === tempProjectId)).toBe(false),
    );

    expect(store.currentProjectId).toBe('project-jot');
    expect(readBrowserStorage().currentProjectId).toBe('project-jot');
    expect((readBrowserStorage().projects as Project[]).some((project) =>
      project.id.startsWith('temp-project-'),
    )).toBe(false);
  });

  test('rolls back temp records and restores selection when sync fails', async () => {
    const projectSync = deferred<Response>();
    vi.stubGlobal('fetch', vi.fn(() => projectSync.promise));
    const store = useJotStore();

    await seedStore(store);
    await store.createProject('Broken');
    const tempProjectId = store.currentProjectId;

    projectSync.reject(new Error('Notion unavailable'));
    await waitFor(() => {
      expect(store.currentProjectId).toBe('project-jot');
      expect(store.errorMessage).toBe('Notion unavailable');
    });

    expect(store.currentProjectId).toBe('project-jot');
    expect(store.projects.some((project) => project.id === tempProjectId)).toBe(false);
    expect(store.errorMessage).toBe('Notion unavailable');
  });
});

describe('project metadata', () => {
  test('validateNotionCache uncaches missing Notion project and page metadata', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        clearSelectedParentPage: true,
        uncachedProjectIds: ['project-jot'],
        uncachedPageIds: ['page-jot'],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    resetBrowserStorage({
      activePageIdsByProject: { 'project-jot': 'page-jot' },
      currentProjectId: 'project-jot',
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
        stalePageIds: [],
        aheadPageIds: ['page-jot'],
        serverVersions: { 'page-jot': 2 },
      }))
      .mockResolvedValueOnce(jsonResponse({
        activePageIdsByProject: { 'project-remote': 'page-remote' },
        currentProjectId: 'missing-local-project',
        pages: [reloadedPage],
        projects: [reloadedProject],
        status: 'saved',
      }));
    vi.stubGlobal('fetch', fetchMock);
    resetBrowserStorage({
      activePageIdsByProject: { 'project-jot': 'page-jot' },
      currentProjectId: 'project-jot',
      hasMigratedCapturesToPages: true,
      pages: [basePage, { ...basePage, id: 'page-deleted' }],
      projects: [baseProject],
      syncConfig,
    });
    const store = useJotStore();

    await seedStore(store);
    store.syncConfig = syncConfig;
    await store.reloadFromNotion();
    const storage = readBrowserStorage();

    expect(fetchMock).toHaveBeenCalledTimes(2);
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
        stalePageIds: [],
        aheadPageIds: ['page-jot'],
        serverVersions: { 'page-jot': 2 },
      }))
      .mockResolvedValueOnce(jsonResponse({
        activePageIdsByProject: {},
        clearSelectedParentPage: true,
        currentProjectId: '',
        pages: [],
        projects: [],
        status: 'saved',
      })));
    resetBrowserStorage({
      activePageIdsByProject: { 'project-jot': 'page-jot' },
      currentProjectId: 'project-jot',
      hasMigratedCapturesToPages: true,
      pages: [basePage],
      projects: [baseProject],
      syncConfig: {
        ...connectedConfig,
        selectedParentPageId: 'missing-parent',
        selectedParentPageTitle: 'Missing',
      },
    });

    await notionClient.reloadFromNotion();
    const storage = readBrowserStorage();

    expect((storage.syncConfig as SyncConfig).selectedParentPageId).toBeUndefined();
    expect((storage.syncConfig as SyncConfig).selectedParentPageTitle).toBeUndefined();
    await expect(notionClient.listProjects()).resolves.toEqual([]);
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
        'project-older': 'page-jot',
        'project-newer': 'page-jot',
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
    const store = useJotStore();

    await seedStore(store);
    const updatePromise = store.updateCurrentProjectMetadata({
      category: 'Research',
      stateText: 'Todo\nShip database sync',
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const requestBody = JSON.parse(String(
      (fetchMock.mock.calls as unknown as Array<[string, RequestInit]>)[0][1]?.body,
    ));

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
    const store = useJotStore();

    await seedStore(store);
    await store.createPage();

    expect(store.currentPage?.id).toMatch(/^temp-page-/);
    expect(stripJotBlockIds(store.currentPage?.content)).toEqual(emptyDocument());
    expect(store.pages.some((page) => page.id === store.currentPage?.id)).toBe(true);
    expect(store.saveStatus).toBe('creating');
  });

  test('replays latest edit after temp page reconciliation through the local queue', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ queued: true, versions: { 'page-jot': 1 } }));
    vi.stubGlobal('fetch', fetchMock);
    const store = useJotStore();
    const editedContent = docWithText('typed while creating');

    await seedStore(store);
    await store.createPage();
    const tempPageId = store.currentPage?.id ?? '';
    await store.saveCurrentPageContent(editedContent, { preserveLocalContent: true });

    await waitFor(() =>
      expect(store.currentPage?.id).not.toBe(tempPageId),
    );

    expect(stripJotBlockIds(store.currentPage?.content)).toEqual(editedContent);
    await waitFor(async () => expect(await listPendingSyncOps()).toEqual([]));
    expect(fetchMock).toHaveBeenCalled();
  });

  test('keeps created page locally when queue delivery fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('offline');
    }));
    const store = useJotStore();

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
    const fetchMock = vi.fn(async () =>
      jsonResponse({ queued: true, versions: { 'page-jot': 1 } }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const store = useJotStore();

    await seedStore(store);
    await store.saveCurrentPageContent(docWithText('body edit'), {
      preserveLocalContent: true,
      title: 'Renamed Page',
    });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [, requestInit] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const requestBody = JSON.parse(String(requestInit.body));

    expect(requestBody.ops.at(-1).payload.page.title).toBe('Renamed Page');
    expect(store.currentPage?.title).toBe('Renamed Page');
  });

  test('local content is persisted before queue delivery resolves', async () => {
    const saveRequest = deferred<Response>();
    const fetchMock = vi.fn(() => saveRequest.promise);
    vi.stubGlobal('fetch', fetchMock);
    const store = useJotStore();
    const content = docWithText('durable draft');

    await seedStore(store);
    await store.saveCurrentPageContent(content, {
      preserveLocalContent: true,
    });

    expect(stripJotBlockIds((readBrowserStorage().pages as ProjectPage[])[0].content)).toEqual(content);
    expect((await listPendingSyncOps()).length).toBeGreaterThan(0);
    saveRequest.resolve(jsonResponse({ queued: true, versions: { 'page-jot': 1 } }));
  });

  test('multiple unsent edits to the same block compact to the final update', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('offline');
    }));
    const store = useJotStore();

    await seedStore(store, [{ ...basePage, content: docWithBlock('same-block', 'first') }]);
    store.currentPage = { ...basePage, content: docWithBlock('same-block', 'first') };
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

  test('a create followed by update keeps the complete latest block snapshot', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('offline');
    }));
    const store = useJotStore();

    await seedStore(store, [{ ...basePage, content: { type: 'doc', content: [] } }]);
    store.currentPage = { ...basePage, content: { type: 'doc', content: [] } };
    await store.saveCurrentPageContent(docWithBlock('new-block', 'created'), {
      preserveLocalContent: true,
    });
    await store.saveCurrentPageContent(docWithBlock('new-block', 'updated'), {
      preserveLocalContent: true,
    });

    const compacted = compactPendingSyncOps(await listPendingSyncOps());
    expect(compacted.some((op) => op.type === 'block_create')).toBe(true);
    expect(compacted.at(-1)?.payload.page.content).toEqual(docWithBlock('new-block', 'updated'));
  });

  test('an update followed by delete drops the redundant update', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('offline');
    }));
    const store = useJotStore();

    await seedStore(store, [{ ...basePage, content: docWithBlock('removed-block', 'before') }]);
    store.currentPage = { ...basePage, content: docWithBlock('removed-block', 'before') };
    await store.saveCurrentPageContent(docWithBlock('removed-block', 'after'), {
      preserveLocalContent: true,
    });
    await store.saveCurrentPageContent({ type: 'doc', content: [] }, {
      preserveLocalContent: true,
    });

    const compacted = compactPendingSyncOps(await listPendingSyncOps());
    expect(compacted.some((op) => op.type === 'block_update')).toBe(false);
    expect(compacted.some((op) => op.type === 'block_delete')).toBe(true);
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
    const store = useJotStore();
    resetBrowserStorage({
      activePageIdsByProject: { 'project-jot': 'page-jot' },
      currentProjectId: 'project-jot',
      hasMigratedCapturesToPages: true,
      pages: [basePage, pageTwo],
      projects: [baseProject],
      syncConfig: connectedConfig,
    });
    await seedStore(store, [basePage, pageTwo]);

    await store.selectPage('page-two');

    expect(stripJotBlockIds(store.currentPage?.content)).toEqual(docWithText('cached body'));
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
    const store = useJotStore();
    resetBrowserStorage({
      activePageIdsByProject: { 'project-jot': 'page-jot' },
      currentProjectId: 'project-jot',
      hasMigratedCapturesToPages: true,
      pages: [basePage, pageTwo],
      projects: [baseProject],
      syncConfig: connectedConfig,
    });
    await seedStore(store, [basePage, pageTwo]);

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
    const store = useJotStore();

    resetBrowserStorage({
      activePageIdsByProject: { 'project-jot': 'page-jot' },
      currentProjectId: 'project-jot',
      hasMigratedCapturesToPages: true,
      pages: [basePage, pageTwo],
      projects: [baseProject],
      syncConfig: connectedConfig,
    });
    await seedStore(store, [basePage, pageTwo]);

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
    expect(store.pages.find((page) => page.id === 'page-jot')?.content)
      .toEqual(docWithText('old page edit'));
  });

  test('refreshing a selected page does not overwrite newer local content', async () => {
    const pagePull = deferred<Response>();
    vi.stubGlobal('fetch', vi.fn(() => pagePull.promise));
    const syncedBasePage = {
      ...basePage,
      localRevision: 'local-1',
      notionPageId: 'notion-page',
      remoteRevision: 'remote-1',
      knownSyncVersion: 1,
      serverSyncVersion: 2,
    };
    const store = useJotStore();

    resetBrowserStorage({
      activePageIdsByProject: { 'project-jot': 'page-jot' },
      currentProjectId: 'project-jot',
      hasMigratedCapturesToPages: true,
      pages: [syncedBasePage],
      projects: [baseProject],
      syncConfig: connectedConfig,
    });
    await seedStore(store, [syncedBasePage]);

    const refreshPromise = store.refreshSelectedPage('page-jot');
    store.currentPage = {
      ...store.currentPage!,
      content: docWithText('newer local draft'),
      localRevision: 'local-2',
    };

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
    const pagePull = deferred<Response>();
    vi.stubGlobal('fetch', vi.fn(() => pagePull.promise));
    const syncedBasePage = {
      ...basePage,
      localRevision: 'local-1',
      notionPageId: 'notion-page',
      remoteRevision: 'remote-1',
      knownSyncVersion: 1,
      serverSyncVersion: 2,
    };
    const store = useJotStore();

    resetBrowserStorage({
      activePageIdsByProject: { 'project-jot': 'page-jot' },
      currentProjectId: 'project-jot',
      hasMigratedCapturesToPages: true,
      pages: [syncedBasePage],
      projects: [baseProject],
      syncConfig: connectedConfig,
    });
    await seedStore(store, [syncedBasePage]);

    const refreshPromise = store.refreshSelectedPage('page-jot');
    store.currentPage = {
      ...store.currentPage!,
      content: docWithText('newer local draft'),
      localRevision: 'local-2',
    };

    pagePull.resolve(jsonResponse({
      status: 'saved',
      page: {
        ...syncedBasePage,
        content: docWithNodes([
          paragraph('remote content'),
          image({
            src: 'https://secure.notion-static.com/image.png',
            jotBlockId: 'remote-image',
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
        jotBlockId: 'remote-image',
      }),
    ]);
    expect(store.currentPage?.remoteRevision).toBe('remote-2');
  });

  test('runtime page updates do not overwrite newer active page content', async () => {
    const store = useJotStore();
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
      type: 'jot.projectPageUpdated',
      payload: {
        page: incomingPage,
      },
    });

    expect(store.currentPage?.content).toEqual(docWithText('newer local draft'));
    expect(store.currentPage?.notionPageId).toBe('notion-page');
    expect(store.currentPage?.remoteRevision).toBe('remote-2');
  });
});

async function seedStore(
  store: ReturnType<typeof useJotStore>,
  pages = [basePage],
) {
  store.syncConfig = connectedConfig;
  store.projects = [baseProject];
  store.pages = pages;
  store.currentProjectId = 'project-jot';
  store.currentPage = basePage;
  await nextTick();
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

function docWithBlock(jotBlockId: string, text: string): DocumentContent {
  return {
    type: 'doc',
    content: [blockWithId(jotBlockId, text)],
  };
}

function blockWithId(jotBlockId: string, text: string): DocumentContent {
  return {
    type: 'paragraph',
    attrs: { jotBlockId },
    content: [{ type: 'text', text }],
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

function docWithNodes(content: DocumentContent[]): DocumentContent {
  return {
    type: 'doc',
    content,
  };
}

function paragraph(text: string): DocumentContent {
  return {
    type: 'paragraph',
    content: [{ type: 'text', text }],
  };
}

function image(attrs: Record<string, unknown>): DocumentContent {
  return {
    type: 'image',
    attrs,
  };
}

function stripJotBlockIds(content: DocumentContent | undefined): DocumentContent | undefined {
  if (!content) {
    return content;
  }

  const rest = { ...content };
  const originalContent = content.content;
  delete rest.attrs;
  delete rest.content;
  const attrs = content.attrs
    ? Object.fromEntries(
        Object.entries(content.attrs).filter(([key]) => key !== 'jotBlockId'),
      )
    : undefined;
  const children = originalContent
    ?.map(stripJotBlockIds)
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
