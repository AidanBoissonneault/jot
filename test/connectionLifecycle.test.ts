import { afterEach, describe, expect, it, vi } from 'vitest';
import { notionClient } from '@/src/services/notionClient';
import {
  idbClear,
  idbSet,
  pauseIdbWrites,
  resumeIdbWrites,
} from '@/src/services/idbStore';
import type { Project, ProjectPage, SyncConfig } from '@/src/types/capture';
import { addPendingSyncOps, buildPageSyncOps } from '@/src/services/syncQueue';
import {
  readBrowserStorage,
  readExtensionStorage,
  resetIdbStorage,
  resetBrowserStorage,
} from './setup';

const originalFetch = globalThis.fetch;

const project: Project = {
  id: 'project-local-test',
  name: 'Keep this project on logout',
  status: 'active',
  category: 'Test',
  createdAt: '2026-09-30T12:00:00.000Z',
  updatedAt: '2026-09-30T12:00:00.000Z',
  stateContent: { type: 'doc', content: [{ type: 'paragraph' }] },
  tags: ['Test'],
};

const page: ProjectPage = {
  id: 'page-local-test',
  projectId: project.id,
  kind: 'page',
  title: 'Local document',
  status: 'active',
  content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Keep me' }] }] },
  createdAt: project.createdAt,
  updatedAt: project.updatedAt,
  localRevision: 'local-revision-1',
  syncState: 'saved',
};

const connectedConfig: SyncConfig = {
  serverUrl: 'https://sync.example.test',
  authenticated: true,
  userId: 'notion:original-account',
  syncQueueOwnerUserId: 'notion:original-account',
  connected: true,
  userName: 'Test user',
  userEmail: 'user@example.test',
  workspaceId: 'workspace-test',
  workspaceName: 'Test workspace',
  selectedParentPageId: 'notion-parent-test',
  selectedParentPageTitle: 'Private workspace page',
};

function seedLocalWorkspace(syncConfig: SyncConfig = connectedConfig) {
  resetBrowserStorage({
    activePageIdsByProject: { [project.id]: page.id },
    captures: [],
    currentProjectId: project.id,
    hasMigratedCapturesToPages: true,
    notionHydrationSource: '',
    pages: [page],
    projects: [project],
    syncConfig,
    jottathingUserPreferences: { interfaceScale: 110 },
  });
}

function stubJsonResponse(payload: unknown) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })));
}

function expectSeededDocumentsPreserved() {
  const stored = readBrowserStorage();
  const storedProject = (stored.projects as Project[]).find(({ id }) => id === project.id);
  const storedPage = (stored.pages as ProjectPage[]).find(({ id }) => id === page.id);

  expect(storedProject).toMatchObject({
    id: project.id,
    name: project.name,
    stateContent: project.stateContent,
  });
  expect(storedPage).toMatchObject({
    id: page.id,
    projectId: page.projectId,
    title: page.title,
  });
  expect(storedPage?.content.content?.[0]).toMatchObject({
    type: 'paragraph',
    content: [{ type: 'text', text: 'Keep me' }],
  });
}

afterEach(() => {
  vi.stubGlobal('fetch', originalFetch);
  resetBrowserStorage();
});

describe('Jottathing connection data lifecycle', () => {
  it('clears the connection on logout while preserving documents and queued local data', async () => {
    seedLocalWorkspace({
      ...connectedConfig,
      accessToken: 'legacy-local-access-token',
      refresh_token: 'legacy-local-refresh-token',
    } as SyncConfig);
    await addPendingSyncOps(buildPageSyncOps({ page, project }));
    stubJsonResponse({
      connected: false,
      loggedOut: true,
      notionTokenRevoked: true,
      serverDataCleanupComplete: true,
    });

    const result = await notionClient.logoutSyncSession();
    const stored = readBrowserStorage();

    expect(result.syncConfig).toMatchObject({ authenticated: false, connected: false });
    expect(result.syncConfig.logoutCleanupPending).toBe(false);
    expect(result.notionTokenRevoked).toBe(true);
    expectSeededDocumentsPreserved();
    expect(await notionClient.pendingSyncEventCount()).toBeGreaterThan(0);
    expect((stored.syncConfig as SyncConfig).authenticated).toBe(false);
    expect((stored.syncConfig as SyncConfig).connected).toBe(false);
    expect(stored.syncConfig).not.toHaveProperty('selectedParentPageId');
    expect(stored.syncConfig).not.toHaveProperty('selectedParentPageTitle');
    expect(stored.syncConfig).not.toHaveProperty('accessToken');
    expect(stored.syncConfig).not.toHaveProperty('refresh_token');
  });

  it('scrubs nested legacy credential fields from both local stores before returning config', async () => {
    seedLocalWorkspace({
      ...connectedConfig,
      legacyAuth: {
        accessToken: 'legacy-indexeddb-access-token',
        nested: { authorization: 'legacy-nested-authorization' },
      },
    } as SyncConfig);

    const syncConfig = await notionClient.getSyncConfig() as SyncConfig & Record<string, unknown>;
    const indexedDbConfig = readBrowserStorage().syncConfig as Record<string, unknown>;
    const extensionConfig = readExtensionStorage().syncConfig as Record<string, unknown>;

    expect(syncConfig).not.toHaveProperty('legacyAuth.accessToken');
    expect(syncConfig).not.toHaveProperty('legacyAuth.nested.authorization');
    expect(indexedDbConfig).not.toHaveProperty('legacyAuth.accessToken');
    expect(indexedDbConfig).not.toHaveProperty('legacyAuth.nested.authorization');
    expect(extensionConfig).not.toHaveProperty('legacyAuth.accessToken');
    expect(extensionConfig).not.toHaveProperty('legacyAuth.nested.authorization');
    expectSeededDocumentsPreserved();
  });

  it('scrubs legacy extension token copies on logout when the credential scrub marker already exists', async () => {
    seedLocalWorkspace({ ...connectedConfig, connected: false });
    await idbSet('__legacy_sync_credentials_scrubbed__', true);
    await browser.storage.local.set({
      syncConfig: {
        ...connectedConfig,
        legacyCredentials: {
          notionAccessToken: 'legacy-extension-access-token',
          nested: { authorization: 'legacy-nested-authorization' },
        },
      },
    });
    stubJsonResponse({
      connected: false,
      loggedOut: true,
      notionTokenRevoked: true,
      serverDataCleanupComplete: true,
    });

    await notionClient.logoutSyncSession();

    const extensionConfig = readExtensionStorage().syncConfig as Record<string, unknown>;
    const indexedDbConfig = readBrowserStorage().syncConfig as Record<string, unknown>;
    expect(extensionConfig).not.toHaveProperty('legacyCredentials.notionAccessToken');
    expect(extensionConfig).not.toHaveProperty('legacyCredentials.nested.authorization');
    expect(indexedDbConfig).not.toHaveProperty('accessToken');
    expect(indexedDbConfig).not.toHaveProperty('legacyCredentials');
    expect(readBrowserStorage().projects).toContainEqual(expect.objectContaining({
      id: project.id,
      name: project.name,
    }));
    expect(readBrowserStorage().pages).toContainEqual(expect.objectContaining({ id: page.id }));
  });

  it('removes all local Jottathing data after the server confirms connection deletion', async () => {
    seedLocalWorkspace();
    stubJsonResponse({ deleted: true, notionTokenRevoked: true });

    await expect(notionClient.deleteConnection()).resolves.toEqual({ notionTokenRevoked: true });

    expect(readBrowserStorage()).toEqual({});
    expect(readExtensionStorage()).toEqual({});
  });

  it('retries a deletion with the same request ID after an uncertain server response', async () => {
    seedLocalWorkspace();
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error('response lost'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ deleted: true, notionTokenRevoked: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(notionClient.deleteConnection()).rejects.toThrow('response lost');
    const pendingDeletion = readExtensionStorage().jottathingPendingConnectionDeletion as {
      requestId: string;
    };
    expect(pendingDeletion.requestId).toMatch(/^[A-Za-z0-9_-]{40,128}$/);
    expectSeededDocumentsPreserved();

    await expect(notionClient.deleteConnection()).resolves.toEqual({ notionTokenRevoked: true });

    const firstRequest = JSON.parse(fetchMock.mock.calls[0][1].body as string) as { requestId: string };
    const retryRequest = JSON.parse(fetchMock.mock.calls[1][1].body as string) as { requestId: string };
    expect(retryRequest.requestId).toBe(firstRequest.requestId);
    expect(readBrowserStorage()).toEqual({});
    expect(readExtensionStorage()).toEqual({});
  });

  it('retries an idempotent local wipe if extension storage clearing fails after server deletion', async () => {
    seedLocalWorkspace();
    stubJsonResponse({ deleted: true, notionTokenRevoked: true });
    vi.mocked(browser.storage.local.clear).mockRejectedValueOnce(
      new Error('extension storage is temporarily unavailable'),
    );

    await expect(notionClient.deleteConnection()).rejects.toThrow(
      'extension storage is temporarily unavailable',
    );
    expect(readBrowserStorage()).toEqual({});
    expect(readExtensionStorage()).toHaveProperty('jottathingPendingConnectionDeletion');

    await expect(notionClient.deleteConnection()).resolves.toEqual({ notionTokenRevoked: true });
    expect(readBrowserStorage()).toEqual({});
    expect(readExtensionStorage()).toEqual({});
  });

  it('finishes a previously confirmed deletion on startup before restoring the session', async () => {
    seedLocalWorkspace();
    const requestId = 'startup-retry-request-id-0123456789-abcdefghijklmnopqrstuvwxyz';
    await browser.storage.local.set({
      jottathingPendingConnectionDeletion: {
        requestId,
        serverUrl: connectedConfig.serverUrl,
        userEmail: connectedConfig.userEmail,
        workspaceId: connectedConfig.workspaceId,
      },
    });
    stubJsonResponse({ deleted: true, notionTokenRevoked: true });

    const config = await notionClient.refreshSyncSession();

    expect(config).toMatchObject({ authenticated: false, connected: false });
    expect(readBrowserStorage().projects).not.toMatchObject([project]);
    expect(readExtensionStorage()).toEqual({});
  });

  it('does not reuse a pending deletion receipt for a different signed-in account', async () => {
    seedLocalWorkspace();
    await idbSet('syncConfig', { ...connectedConfig, userId: 'notion:other-account' });
    await browser.storage.local.set({
      jottathingPendingConnectionDeletion: {
        requestId: 'different-account-request-id-0123456789-abcdefghijklmnopqrstuvwxyz',
        serverUrl: connectedConfig.serverUrl,
        userId: connectedConfig.userId,
        userEmail: connectedConfig.userEmail,
        workspaceId: connectedConfig.workspaceId,
      },
    });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(notionClient.deleteConnection()).rejects.toThrow('pending for another connection');

    expect(fetchMock).not.toHaveBeenCalled();
    expectSeededDocumentsPreserved();
  });

  it('requires the owning account before starting a deletion', async () => {
    seedLocalWorkspace();
    await notionClient.updateSyncConfig({
      authenticated: true,
      userId: 'notion:other-account',
      connected: true,
    });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(notionClient.deleteConnection()).rejects.toThrow('owns this local data');

    expect(fetchMock).not.toHaveBeenCalled();
    expectSeededDocumentsPreserved();
    expect(readExtensionStorage()).not.toHaveProperty('jottathingPendingConnectionDeletion');
  });

  it('keeps local documents when deletion is requested while signed out', async () => {
    seedLocalWorkspace();
    await notionClient.updateSyncConfig({ authenticated: false, connected: false });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(notionClient.deleteConnection()).rejects.toThrow('Sign in to the Notion account');

    expect(fetchMock).not.toHaveBeenCalled();
    expectSeededDocumentsPreserved();
    expect(readExtensionStorage()).not.toHaveProperty('jottathingPendingConnectionDeletion');
  });

  it('blocks stale IndexedDB writes while connection data is being deleted', async () => {
    seedLocalWorkspace();
    let finishRequest!: (response: Response) => void;
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => {
      finishRequest = resolve;
    }));
    vi.stubGlobal('fetch', fetchMock);

    const deletion = notionClient.deleteConnection();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    await idbSet('stale-editor-save', { text: 'must not return after deletion' });
    finishRequest(new Response(JSON.stringify({ deleted: true, notionTokenRevoked: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    await expect(deletion).resolves.toEqual({ notionTokenRevoked: true });

    expect(readBrowserStorage()).toEqual({});
  });

  it('fences a writer from another extension context after a completed wipe', async () => {
    resetBrowserStorage();
    await idbSet('before-delete', { text: 'will be wiped' });

    await pauseIdbWrites();
    await idbClear();
    // A retry after the server deletion succeeded may repeat the local wipe.
    await idbClear();
    // Resume global writes without adopting the new generation, as a stale
    // background or sidepanel context would after deletion.
    await resumeIdbWrites();

    await idbSet('stale-context-write', { text: 'must stay deleted' });
    expect(readBrowserStorage()).toEqual({});

    await pauseIdbWrites();
    await resumeIdbWrites({ adoptCurrentEpoch: true });
    await idbSet('fresh-context-write', { text: 'new data is allowed' });
    expect(readBrowserStorage()).toEqual({
      'fresh-context-write': { text: 'new data is allowed' },
    });
  });

  it('refuses to clear local data while IndexedDB writes are active', async () => {
    const localData = { text: 'keep until the write fence is paused' };
    await idbSet('protected-local-state', localData);

    await expect(idbClear()).rejects.toThrow(
      'IndexedDB must be paused by the current context before clearing data.',
    );
    expect(readBrowserStorage()).toEqual({ 'protected-local-state': localData });
  });

  it('clears local authentication when the server cannot be reached and preserves local documents', async () => {
    seedLocalWorkspace();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));

    const result = await notionClient.logoutSyncSession();
    const stored = readBrowserStorage();

    expect(result.notionTokenRevoked).toBe(false);
    expect(result.serverDataCleanupComplete).toBe(false);
    expect(result.syncConfig).toMatchObject({
      authenticated: false,
      connected: false,
      logoutCleanupPending: true,
    });
    expect(stored.syncConfig).toMatchObject({ authenticated: false, connected: false });
    expectSeededDocumentsPreserved();
  });

  it('keeps logout retryable until the server confirms cleanup without deleting local work', async () => {
    seedLocalWorkspace();
    let requestCount = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      requestCount += 1;
      return requestCount === 1
        ? new Response(JSON.stringify({
            connected: false,
            loggedOut: false,
            notionTokenRevoked: false,
            serverDataCleanupComplete: false,
            retryable: true,
          }), { status: 503, headers: { 'Content-Type': 'application/json' } })
        : new Response(JSON.stringify({
            connected: false,
            loggedOut: true,
            notionTokenRevoked: true,
            serverDataCleanupComplete: true,
            retryable: false,
          }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));

    const first = await notionClient.logoutSyncSession();
    expect(first.syncConfig.logoutCleanupPending).toBe(true);
    expectSeededDocumentsPreserved();

    const retry = await notionClient.logoutSyncSession();
    expect(retry.serverDataCleanupComplete).toBe(true);
    expect(retry.syncConfig.logoutCleanupPending).toBe(false);
    expect(requestCount).toBe(2);
    expectSeededDocumentsPreserved();
  });

  it('does not restore a signed-out device from a lingering server cookie', async () => {
    seedLocalWorkspace();
    stubJsonResponse({
      connected: false,
      loggedOut: true,
      notionTokenRevoked: false,
      serverDataCleanupComplete: false,
    });
    await notionClient.logoutSyncSession();
    expect((readBrowserStorage().syncConfig as SyncConfig).logoutCleanupPending).toBe(false);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const config = await notionClient.refreshSyncSession();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(config).toMatchObject({ authenticated: false, connected: false });
  });

  it('keeps previously persisted signed-out state', async () => {
    resetBrowserStorage({
      syncConfig: {
        serverUrl: 'https://sync.example.test',
        authenticated: false,
        connected: false,
      },
    });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const config = await notionClient.refreshSyncSession();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(config).toMatchObject({ authenticated: false, connected: false });
  });

  it('does not import app state from extension storage', async () => {
    resetIdbStorage();
    await browser.storage.local.set({ projects: [project], syncConfig: connectedConfig });

    const config = await notionClient.getSyncConfig();
    const projects = await notionClient.listWorkspaceProjects();

    expect(config).toMatchObject({ authenticated: false, connected: false });
    expect(projects).not.toContainEqual(expect.objectContaining({ id: project.id }));
  });

  it('allows session polling after the user explicitly starts Notion sign-in', async () => {
    seedLocalWorkspace();
    await notionClient.updateSyncConfig({ authenticated: false, connected: false });
    stubJsonResponse({
      authenticated: true,
      userId: 'notion:original-account',
      connected: true,
      userName: 'Test user',
      userEmail: 'user@example.test',
      workspaceId: 'workspace-test',
      workspaceName: 'Test workspace',
    });

    const config = await notionClient.refreshSyncSession(true);

    expect(config).toMatchObject({ authenticated: true, connected: true });
  });

  it('keeps a pending queue bound to its original account after another account signs in', async () => {
    seedLocalWorkspace();
    await addPendingSyncOps(buildPageSyncOps({ page, project }));
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      authenticated: true,
      userId: 'notion:other-account',
      userName: 'Other user',
      userEmail: 'other@example.test',
      connected: true,
      workspaceId: 'other-workspace',
      workspaceName: 'Other workspace',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    const config = await notionClient.refreshSyncSession(true);

    expect(config).toMatchObject({
      userId: 'notion:other-account',
      syncQueueOwnerUserId: 'notion:original-account',
      connected: true,
    });
    await expect(notionClient.validateNotionCache()).rejects.toThrow('locked to its original Notion account');
    await expect(notionClient.resyncPendingChanges()).rejects.toThrow('locked to its original Notion account');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await notionClient.pendingSyncEventCount()).toBeGreaterThan(0);
  });

  it('moves an empty queue to a newly signed-in account', async () => {
    resetBrowserStorage({
      notionHydrationSource: '',
      pages: [],
      projects: [],
      syncConfig: connectedConfig,
      workspaces: [],
    });
    stubJsonResponse({
      authenticated: true,
      userId: 'notion:other-account',
      userName: 'Other user',
      userEmail: 'other@example.test',
      connected: true,
      workspaceId: 'other-workspace',
    });

    const config = await notionClient.refreshSyncSession(true);

    expect(config).toMatchObject({
      userId: 'notion:other-account',
      syncQueueOwnerUserId: 'notion:other-account',
      syncQueueOwnerWorkspaceId: 'other-workspace',
    });
  });

  it('keeps previously synced local documents with their original account', async () => {
    seedLocalWorkspace();
    const workspaceId = 'workspace-notion-original-account';
    await idbSet('workspaces', [{
      id: workspaceId,
      name: 'Original workspace',
      kind: 'notion',
      accountId: 'notion:original-account',
      notionWorkspaceId: 'workspace-test',
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
    }]);
    await idbSet('projects', [{ ...project, workspaceId, syncMode: 'notion' }]);
    await idbSet('pages', [{
      ...page,
      workspaceId,
      syncMode: 'notion',
      syncAccountId: 'notion:original-account',
      syncWorkspaceId: 'workspace-test',
    }]);
    stubJsonResponse({
      authenticated: true,
      userId: 'notion:other-account',
      userName: 'Other user',
      userEmail: 'other@example.test',
      connected: true,
      workspaceId: 'other-workspace',
    });

    const config = await notionClient.refreshSyncSession(true);

    expect(config.syncQueueOwnerUserId).toBe('notion:original-account');
    expect(await notionClient.needsInitialNotionHydration()).toBe(false);
    await expect(notionClient.validateNotionCache()).rejects.toThrow('locked to its original Notion account');
    expectSeededDocumentsPreserved();
  });

  it('does not recover workspace ownership from the retired hydration marker format', async () => {
    seedLocalWorkspace({ ...connectedConfig, workspaceId: undefined });
    await idbSet('notionHydrationSource', 'https://sync.example.test::workspace-test');

    await notionClient.getSyncConfig();

    expect((readBrowserStorage().pages as ProjectPage[])[0]?.syncWorkspaceId).toBeUndefined();
  });

  it('does not assign ownerless work by matching an old email address', async () => {
    seedLocalWorkspace({
      ...connectedConfig,
      authenticated: true,
      userId: undefined,
      syncQueueOwnerUserId: undefined,
    });
    await addPendingSyncOps(buildPageSyncOps({ page, project }));
    stubJsonResponse({
      authenticated: true,
      userId: 'notion:original-account',
      userEmail: 'user@example.test',
      workspaceId: 'workspace-test',
      connected: true,
    });

    const config = await notionClient.refreshSyncSession(true);

    expect(config.syncQueueOwnerUserId).toBeNull();
    expect(await notionClient.pendingSyncEventCount()).toBeGreaterThan(0);
    await expect(notionClient.validateNotionCache()).rejects.toThrow('locked to its original Notion account');
  });

  it('quarantines legacy queued edits until the user assigns them to an account', async () => {
    seedLocalWorkspace();
    await addPendingSyncOps(buildPageSyncOps({ page, project }));
    await notionClient.updateSyncConfig({
      userId: undefined,
      syncQueueOwnerUserId: undefined,
      userEmail: undefined,
      workspaceId: undefined,
      authenticated: false,
      connected: false,
    });
    stubJsonResponse({
      connected: false,
      loggedOut: true,
      notionTokenRevoked: true,
      serverDataCleanupComplete: true,
    });
    await notionClient.logoutSyncSession();
    stubJsonResponse({
      authenticated: true,
      userId: 'notion:new-account',
      userName: 'New user',
      userEmail: 'new@example.test',
      connected: true,
      workspaceId: 'new-workspace',
    });

    const config = await notionClient.refreshSyncSession(true);

    expect(config.syncQueueOwnerUserId).toBeNull();
    expect(config.userId).toBe('notion:new-account');
    expect(await notionClient.pendingSyncEventCount()).toBeGreaterThan(0);

    await expect(notionClient.validateNotionCache()).rejects.toThrow('locked to its original Notion account');
    const assigned = await notionClient.assignUnmatchedPendingQueueToCurrentAccount();
    expect(assigned.syncQueueOwnerUserId).toBe('notion:new-account');
  });

  it('recovers the IndexedDB write fence after a completed wipe and app restart', async () => {
    seedLocalWorkspace();
    await idbSet('before-crash', { text: 'must be erased' });
    await pauseIdbWrites();
    await idbClear();
    await browser.storage.local.clear();

    // A new extension context has fresh module state but shares the same IDB.
    vi.resetModules();
    const restartedClient = await import('@/src/services/notionClient');
    const restartedIdb = await import('@/src/services/idbStore');

    await restartedClient.notionClient.getSyncConfig();
    await restartedIdb.idbSet('after-restart', { text: 'new local data persists' });

    expect(readBrowserStorage()).not.toHaveProperty('before-crash');
    expect(readBrowserStorage()).toMatchObject({
      'after-restart': { text: 'new local data persists' },
    });
  });

  it('scrubs legacy extension-storage token copies during logout and preserves documents', async () => {
    seedLocalWorkspace({ ...connectedConfig, connected: false });
    await browser.storage.local.set({
      syncConfig: {
        ...connectedConfig,
        accessToken: 'legacy-extension-access-token',
        refresh_token: 'legacy-extension-refresh-token',
      },
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      connected: false,
      loggedOut: true,
      notionTokenRevoked: true,
      serverDataCleanupComplete: true,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })));
    vi.resetModules();
    const { notionClient: migratedClient } = await import('@/src/services/notionClient');

    await migratedClient.logoutSyncSession();

    const legacyStorage = await browser.storage.local.get('syncConfig');
    expect(legacyStorage.syncConfig).not.toHaveProperty('accessToken');
    expect(legacyStorage.syncConfig).not.toHaveProperty('refresh_token');
    expect(readBrowserStorage().projects).toContainEqual(expect.objectContaining({
      id: project.id,
      name: project.name,
    }));
    expect(readBrowserStorage().pages).toContainEqual(expect.objectContaining({
      id: page.id,
      content: expect.objectContaining({
        content: [expect.objectContaining({
          content: [expect.objectContaining({ text: 'Keep me' })],
        })],
      }),
    }));
  });
});
