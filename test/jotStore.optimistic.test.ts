import { setActivePinia, createPinia } from 'pinia';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { nextTick } from 'vue';
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

describe('optimistic page creation', () => {
  test('appears and is selected immediately with an empty document', async () => {
    const pageSync = deferred<Response>();
    vi.stubGlobal('fetch', vi.fn(() => pageSync.promise));
    const store = useJotStore();

    await seedStore(store);
    await store.createPage();

    expect(store.currentPage?.id).toMatch(/^temp-page-/);
    expect(store.currentPage?.content).toEqual(emptyDocument());
    expect(store.pages.some((page) => page.id === store.currentPage?.id)).toBe(true);
    expect(store.saveStatus).toBe('creating');
  });

  test('replays latest edit after temp page reconciliation', async () => {
    const pageCreate = deferred<Response>();
    const pageReplay = deferred<Response>();
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => pageCreate.promise)
      .mockImplementationOnce(() => pageReplay.promise);
    vi.stubGlobal('fetch', fetchMock);
    const store = useJotStore();
    const editedContent = docWithText('typed while creating');

    await seedStore(store);
    await store.createPage();
    const tempPageId = store.currentPage?.id ?? '';
    await store.saveCurrentPageContent(editedContent, { preserveLocalContent: true });

    const createBody = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    const realPageId = createBody.page.id;
    pageCreate.resolve(jsonResponse({
      status: 'saved',
      page: {
        ...createBody.page,
        id: realPageId,
        notionPageId: 'notion-page',
        remoteRevision: 'rev-1',
        syncState: 'saved',
      },
    }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const replayBody = JSON.parse(String(fetchMock.mock.calls[1][1]?.body));
    pageReplay.resolve(jsonResponse({
      status: 'saved',
      page: {
        ...replayBody.page,
        notionPageId: 'notion-page',
        remoteRevision: 'rev-2',
        syncState: 'saved',
      },
    }));

    await waitFor(() =>
      expect(store.currentPage?.id).not.toBe(tempPageId),
    );

    expect(store.currentPage?.content).toEqual(editedContent);
    expect(store.currentPage?.notionPageId).toBe('notion-page');
  });

  test('removes the temp page and surfaces an error when creation fails', async () => {
    const pageSync = deferred<Response>();
    vi.stubGlobal('fetch', vi.fn(() => pageSync.promise));
    const store = useJotStore();

    await seedStore(store);
    await store.createPage();
    const tempPageId = store.currentPage?.id ?? '';

    pageSync.reject(new Error('Page sync failed'));
    await waitFor(() => expect(store.currentPage?.id).toBe('page-jot'));

    expect(store.currentPage?.id).toBe('page-jot');
    expect(store.pages.some((page) => page.id === tempPageId)).toBe(false);
    expect(store.errorMessage).toBe('Page sync failed');
  });
});

describe('page title and content saves', () => {
  test('content saves can carry the latest draft title', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        status: 'saved',
        page: {
          ...basePage,
          title: 'Old Page',
          content: docWithText('body edit'),
          syncState: 'saved',
        },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const store = useJotStore();

    await seedStore(store);
    await store.saveCurrentPageContent(docWithText('body edit'), {
      preserveLocalContent: true,
      title: 'Renamed Page',
    });

    const [, requestInit] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const requestBody = JSON.parse(String(requestInit.body));

    expect(requestBody.page.title).toBe('Renamed Page');
    expect(store.currentPage?.title).toBe('Renamed Page');
  });
});

describe('project page caching', () => {
  test('selecting a cached page returns immediately and refreshes it in the background', async () => {
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

    expect(store.currentPage?.content).toEqual(docWithText('cached body'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    pagePull.resolve(jsonResponse({
      status: 'saved',
      page: {
        ...pageTwo,
        content: docWithText('fresh body'),
        remoteRevision: 'rev-2',
        syncState: 'saved',
      },
    }));

    await waitFor(() =>
      expect(store.currentPage?.content).toEqual(docWithText('fresh body')),
    );
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
