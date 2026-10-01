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
    inkwellUserPreferences: { interfaceScale: 110 },
  });
}

function stubJsonResponse(payload: unknown) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })));
}

afterEach(() => {
  vi.stubGlobal('fetch', originalFetch);
  resetBrowserStorage();
});

describe('Inkwell connection data lifecycle', () => {
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
    expect(result.notionTokenRevoked).toBe(true);
    expect(stored.projects).toMatchObject([project]);
    expect(stored.pages).toEqual([page]);
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
    expect(readBrowserStorage().projects).toMatchObject([project]);
    expect(readBrowserStorage().pages).toEqual([page]);
  });

  it('scrubs legacy extension token copies on logout when the migration marker already exists', async () => {
    seedLocalWorkspace();
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
    expect(readBrowserStorage().projects).toMatchObject([project]);
    expect(readBrowserStorage().pages).toEqual([page]);
  });

  it('removes all local Inkwell data after the server confirms connection deletion', async () => {
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
    const pendingDeletion = readExtensionStorage().inkwellPendingConnectionDeletion as {
      requestId: string;
    };
    expect(pendingDeletion.requestId).toMatch(/^[A-Za-z0-9_-]{40,128}$/);
    expect(readBrowserStorage().pages).toEqual([page]);

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
    expect(readExtensionStorage()).toHaveProperty('inkwellPendingConnectionDeletion');

    await expect(notionClient.deleteConnection()).resolves.toEqual({ notionTokenRevoked: true });
    expect(readBrowserStorage()).toEqual({});
    expect(readExtensionStorage()).toEqual({});
  });

  it('finishes a previously confirmed deletion on startup before restoring the session', async () => {
    seedLocalWorkspace();
    const requestId = 'startup-retry-request-id-0123456789-abcdefghijklmnopqrstuvwxyz';
    await browser.storage.local.set({
      inkwellPendingConnectionDeletion: {
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
      inkwellPendingConnectionDeletion: {
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
    expect(readBrowserStorage().pages).toEqual([page]);
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
    expect(readBrowserStorage().pages).toEqual([page]);
    expect(readExtensionStorage()).not.toHaveProperty('inkwellPendingConnectionDeletion');
  });

  it('keeps local documents when deletion is requested while signed out', async () => {
    seedLocalWorkspace();
    await notionClient.updateSyncConfig({ authenticated: false, connected: false });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(notionClient.deleteConnection()).rejects.toThrow('Sign in to the Notion account');

    expect(fetchMock).not.toHaveBeenCalled();
    expect(readBrowserStorage().pages).toMatchObject([{ id: page.id, title: page.title }]);
    expect(readExtensionStorage()).not.toHaveProperty('inkwellPendingConnectionDeletion');
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

  it('clears local authentication when the server cannot be reached and preserves local documents', async () => {
    seedLocalWorkspace();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));

    const result = await notionClient.logoutSyncSession();
    const stored = readBrowserStorage();

    expect(result.notionTokenRevoked).toBe(false);
    expect(result.serverDataCleanupComplete).toBe(false);
    expect(result.syncConfig).toMatchObject({ authenticated: false, connected: false });
    expect(stored.syncConfig).toMatchObject({ authenticated: false, connected: false });
    expect(readBrowserStorage().projects).toMatchObject([project]);
    expect(stored.pages).toEqual([page]);
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
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const config = await notionClient.refreshSyncSession();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(config).toMatchObject({ authenticated: false, connected: false });
  });

  it('recognizes previously persisted signed-out state after upgrading', async () => {
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

  it('keeps previously synced local documents with their original account', async () => {
    seedLocalWorkspace();
    await idbSet('notionHydrationSource', 'https://sync.example.test::workspace-test');
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
    expect(readBrowserStorage().pages).toEqual([page]);
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

  it('scrubs legacy extension-storage token copies during logout migration and preserves documents', async () => {
    resetBrowserStorage();
    resetIdbStorage();
    await browser.storage.local.set({
      activePageIdsByProject: { [project.id]: page.id },
      currentProjectId: project.id,
      hasMigratedCapturesToPages: true,
      pages: [page],
      projects: [project],
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
    expect(readBrowserStorage().projects).toMatchObject([project]);
    expect(readBrowserStorage().pages).toMatchObject([page]);
  });
});
