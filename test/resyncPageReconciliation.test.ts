import { beforeEach, describe, expect, test, vi } from 'vitest';
import { notionClient } from '@/src/services/notionClient';
import { listPendingSyncOps } from '@/src/services/syncQueue';
import type { Project, ProjectPage, SyncConfig, Workspace } from '@/src/types/capture';
import { doc, paragraph } from './helpers/docBuilders';
import { readBrowserStorage, resetBrowserStorage } from './setup';

const timestamp = '2026-01-01T00:00:00.000Z';
const workspace: Workspace = {
  id: 'workspace-notion-resync-pages',
  name: 'Notion',
  kind: 'notion',
  accountId: 'notion:resync-test',
  notionWorkspaceId: 'notion-workspace-resync-pages',
  createdAt: timestamp,
  updatedAt: timestamp,
};
const project: Project = {
  id: 'project-resync-pages',
  name: 'Resync pages',
  workspaceId: workspace.id,
  syncMode: 'notion',
  status: 'active',
  createdAt: timestamp,
  updatedAt: timestamp,
  stateContent: doc([]),
  stateSyncBaselineContent: doc([]),
  tags: [],
};
const page: ProjectPage = {
  id: 'page-resync-pages',
  projectId: project.id,
  workspaceId: workspace.id,
  kind: 'page',
  title: 'Local edit',
  status: 'active',
  content: doc([paragraph('local edit')]),
  syncBaselineContent: doc([]),
  syncMode: 'notion',
  syncAccountId: workspace.accountId,
  syncWorkspaceId: workspace.notionWorkspaceId,
  syncState: 'error',
  createdAt: timestamp,
  updatedAt: timestamp,
};
const syncConfig: SyncConfig = {
  serverUrl: 'http://localhost:8787',
  authenticated: true,
  connected: true,
  userId: workspace.accountId,
  workspaceId: workspace.notionWorkspaceId,
  workspaceName: workspace.name,
  syncQueueOwnerUserId: workspace.accountId,
  syncQueueOwnerWorkspaceId: workspace.notionWorkspaceId,
};

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function seedResyncStorage() {
  resetBrowserStorage({
    activePageIdsByProject: { [project.id]: page.id },
    currentProjectId: project.id,
    currentProjectIdByWorkspace: { [workspace.id]: project.id },
    currentWorkspaceId: workspace.id,
    hasMigratedCapturesToPages: true,
    pages: [page],
    projects: [project],
    syncConfig,
    workspaces: [workspace],
  });
}

function installFetchMock(pageResponse: unknown, onReload?: () => void) {
  const fetchMock = vi.fn(async (input: string | URL) => {
    const route = String(input).replace(syncConfig.serverUrl, '');
    if (route.startsWith('/sync/retry')) {
      return jsonResponse({ requeuedCount: 0, requeuedOperationIds: [] });
    }
    if (route === '/sync/status') return jsonResponse({ hasPending: false, pendingCount: 0, failedCount: 0 });
    if (route === '/sync/validate') {
      return jsonResponse({ aheadPageIds: [], failedPageIds: [], newPageIds: [], stalePageIds: [] });
    }
    if (route === '/sync/project') return jsonResponse({ status: 'saved' });
    if (route === '/sync/page/resync') return pageResponse instanceof Response
      ? pageResponse
      : jsonResponse(pageResponse);
    if (route === '/sync/reload') {
      onReload?.();
      return jsonResponse({
        activePageIdsByProject: { [project.id]: page.id },
        currentProjectId: project.id,
        pages: [page],
        projects: [project],
        status: 'saved',
      });
    }
    throw new Error(`Unexpected sync request: ${route}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(() => {
  seedResyncStorage();
});

describe('manual page resync', () => {
  test('keeps a stale page marked while the final workspace reload begins', async () => {
    let pageStateAtReload: ProjectPage['syncState'];
    const fetchMock = installFetchMock(
      { status: 'stale', message: 'Notion changed while syncing.' },
      () => {
        pageStateAtReload = (readBrowserStorage().pages as ProjectPage[])
          .find((entry) => entry.id === page.id)?.syncState;
      },
    );

    const result = await notionClient.resyncPendingChanges();

    expect(pageStateAtReload).toBe('stale');
    expect(result.reloadedFromNotion).toBe(true);
    expect(fetchMock.mock.calls.map(([url]) => String(url)))
      .toContain('http://localhost:8787/sync/page/resync');
  });

  test('returns one conflict and leaves its page operations blocked for review', async () => {
    const diff = {
      baseContent: doc([]),
      localContent: page.content,
      remoteContent: doc([paragraph('remote edit')]),
      reason: 'merge',
      localChangedBlockIds: [],
      remoteChangedBlockIds: [],
    };
    const fetchMock = installFetchMock(jsonResponse({
      code: 'unmapped_notion_content',
      message: 'Notion and local content differ in blocks that could not be matched.',
      diff,
    }, 409));

    const result = await notionClient.resyncPendingChanges();
    const storedPage = (readBrowserStorage().pages as ProjectPage[])
      .find((entry) => entry.id === page.id);
    const blockedOps = await listPendingSyncOps();

    expect(result.reloadedFromNotion).toBe(false);
    expect(result.remoteReloadPending).toBe(true);
    expect(result.conflicts.filter((conflict) => conflict.targetType === 'page')).toEqual([
      expect.objectContaining({ targetId: page.id, targetTitle: page.title }),
    ]);
    expect(storedPage?.syncState).toBe('error');
    expect(blockedOps.length).toBeGreaterThan(0);
    expect(blockedOps.every((op) => op.deliveryBlocked?.code === 'unmapped_notion_content')).toBe(true);
    expect(fetchMock.mock.calls.map(([url]) => String(url)))
      .not.toContain('http://localhost:8787/sync/reload');
  });
});
