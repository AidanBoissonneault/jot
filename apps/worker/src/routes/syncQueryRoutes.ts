/**
 * @file Registers synchronization status, validation, reload, pull, event-stream, and stale-state routes.
 * @author Aidan Boissonneault
 * @lastModified September 2026
 */

import type { Hono } from 'hono';
import type { ProjectPage } from '../../../../src/types/capture.js';
import type {
  SyncPageRequest,
  SyncReloadRequest,
  SyncValidationRequest,
} from '../../../../src/types/sync.js';
import {
  appendLog,
  importManagedBlocks,
  readProjectDatabaseStructure,
  readInkwellSyncState,
  reloadProjectDatabaseFromNotion,
  requireConnectedStore,
  retrieveNotionPageOrBlock,
  supabase,
  validateNotionCache,
  withFreshInstallationStore,
  writeStore,
} from '../services/workerRuntime.js';
import {
  MAX_CONTROL_JSON_REQUEST_BYTES,
  MAX_SYNC_JSON_REQUEST_BYTES,
  isBlockNotPageError,
  readLimitedJsonBody,
} from '../workerUtils.js';
import {
  hasWorkspaceStructureChanged,
  isUnrepresentedSyncedPage,
} from '../syncWorkspaceInventory.js';
import type { WorkerEnv } from '../types.js';

const SYNC_STATUS_PAGE_SIZE = 500;

/**
 * Registers read, validation, reload, and recovery routes for synchronization.
 * @param app - Worker Hono application.
 * @returns Nothing.
 */
export function registerSyncQueryRoutes(app: Hono<{ Bindings: WorkerEnv }>): void {
  /** Returns local synchronization versions and statuses. @param c - Hono context. @returns JSON response. */
  app.get('/sync/status', async (c) => {
    const pageId = c.req.query('pageId');
    const store = await requireConnectedStore(c);

    if (!pageId) {
      try {
        return c.json({ hasPending: await hasPendingSyncQueuePayload(store.installationId) });
      } catch {
        return c.json({ error: 'Unable to read queued synchronization status.' }, 500);
      }
    }

    const { data: row, error } = await supabase
      .from('notion_block_sync')
      .select('local_version, synced_version, status, notion_block_id')
      .eq('installation_id', store.installationId)
      .eq('local_id', pageId)
      .maybeSingle();
    if (error) return c.json({ error: 'Unable to read synchronization status.' }, 500);
    if (!row) {
      return c.json({ status: 'synced', localVersion: 0, syncedVersion: 0 });
    }

    return c.json({
      status: row.status,
      localVersion: row.local_version,
      syncedVersion: row.synced_version,
      notionBlockId: row.notion_block_id ?? null,
    });
  });
  
  /** Proxies the installation event stream from its durable object. @param c - Hono context. @returns Streaming response. */
  app.get('/sync/events', async (c) => {
    const store = await requireConnectedStore(c);
    const doId = c.env.SYNC_EVENTS.idFromName(String(store.installationId));
    const stub = c.env.SYNC_EVENTS.get(doId);
    return stub.fetch(new Request('http://do/connect'));
  });
  
  /** Compares client state with persisted versions and remote cache validity. @param c - Hono context. @returns JSON response. */
  app.post('/sync/validate', async (c) => {
    const parsed = await readLimitedJsonBody<SyncValidationRequest>(c.req.raw, MAX_SYNC_JSON_REQUEST_BYTES);
    if (parsed.tooLarge) return c.json({ error: 'Sync request is too large.' }, 413);
    const body = (parsed.body ?? {}) as Partial<SyncValidationRequest>;
    const {
      pages = [],
      projects = [],
      knownVersions = {},
      selectedParentPageId,
    } = body ?? {};
    const store = await requireConnectedStore(c);
    const localPages = Array.isArray(pages) ? pages : [];
    const localProjects = Array.isArray(projects) ? projects : [];
    // Scan once, then reuse the resulting Notion IDs to validate cached page
    // links. Per-page GET checks here multiplied Notion latency before the same
    // project rows were scanned a second time for cross-instance changes.
    const remoteStructure = await readProjectDatabaseStructure(store, { selectedParentPageId });
    const result = await validateNotionCache(store, {
      pages: localPages,
      projects: localProjects,
      remoteStructure,
      databaseVerified: true,
    });

    // Supabase sync rows are scoped to one installation. Enumerate the remote
    // database structure as well so another installation's page/project
    // creation or deletion is visible during startup validation.
    const workspaceChanged = hasWorkspaceStructureChanged(remoteStructure, localProjects, localPages);

    if (result.changed || workspaceChanged) {
      if (result.changed) {
        appendLog(
          store,
          'sync_cache_uncached',
          `${result.uncachedProjectIds.length} projects, ${result.uncachedPageIds.length} pages`,
        );
      }
      await writeStore(store);
    }
  
    // Fetch stale + version info from notion_block_sync
    const knownPageIds = new Set(
      localPages
        .map((page) => page?.id)
        .filter((id): id is string => typeof id === 'string'),
    );
    const syncRows: Array<{
      local_id: string;
      local_version: number;
      is_stale: boolean;
      status: string;
      entity_type: string;
      notion_block_id: string | null;
    }> = [];
    let syncRowsOffset = 0;
    while (true) {
      const { data: rows, error } = await supabase
        .from('notion_block_sync')
        .select('local_id, local_version, is_stale, status, entity_type, notion_block_id')
        .eq('installation_id', store.installationId)
        .order('local_id', { ascending: true })
        .range(syncRowsOffset, syncRowsOffset + SYNC_STATUS_PAGE_SIZE - 1);
      if (error) return c.json({ error: 'Unable to validate synchronization state.' }, 500);
      syncRows.push(...(rows ?? []));
      if ((rows?.length ?? 0) < SYNC_STATUS_PAGE_SIZE) break;
      syncRowsOffset += SYNC_STATUS_PAGE_SIZE;
    }
  
    const stalePageIds: string[] = [];
    const aheadPageIds: string[] = [];
    const failedPageIds: string[] = [];
    const newPageIds: string[] = [];
    const serverVersions: Record<string, number> = {};
    const remoteThreadBlockIds = new Set(remoteStructure.pageIds);
  
    for (const row of syncRows) {
      serverVersions[row.local_id] = row.local_version;
      if (row.is_stale) {
        stalePageIds.push(row.local_id);
      }
      if (row.status === 'failed') {
        failedPageIds.push(row.local_id);
      } else if (
        typeof knownVersions[row.local_id] === 'number' &&
        row.local_version > knownVersions[row.local_id]
      ) {
        aheadPageIds.push(row.local_id);
      }
      if (isUnrepresentedSyncedPage(row, knownPageIds, remoteThreadBlockIds)) {
        newPageIds.push(row.local_id);
      }
    }
  
    return c.json({
      status: 'saved',
      clearSelectedParentPage: result.clearSelectedParentPage,
      uncachedProjectIds: result.uncachedProjectIds,
      uncachedPageIds: result.uncachedPageIds,
      failedPageIds,
      newPageIds,
      workspaceChanged,
      stalePageIds,
      aheadPageIds,
      serverVersions,
    });
  });
  
  /** Reloads database-backed project state from Notion. @param c - Hono context. @returns JSON response. */
  app.post('/sync/reload', async (c) => {
    const parsed = await readLimitedJsonBody<SyncReloadRequest>(c.req.raw, MAX_CONTROL_JSON_REQUEST_BYTES);
    if (parsed.tooLarge) return c.json({ error: 'Request is too large.' }, 413);
    const body = (parsed.body ?? {}) as Partial<SyncReloadRequest>;
    const { selectedParentPageId } = body ?? {};
    const store = await requireConnectedStore(c);
  
    const result = await withFreshInstallationStore(store, async (freshStore) => {
      const reloaded = await reloadProjectDatabaseFromNotion(freshStore, { selectedParentPageId });
      appendLog(freshStore, 'sync_reload', `${reloaded.projects.length} projects, ${reloaded.pages.length} pages`);
      await writeStore(freshStore);
      return reloaded;
    });
  
    return c.json({ status: 'saved', ...result });
  });
  
  /** Pulls a linked page from Notion. @param c - Hono context. @returns JSON response. */
  app.post('/sync/pull', async (c) => {
    const parsed = await readLimitedJsonBody<SyncPageRequest>(c.req.raw, MAX_SYNC_JSON_REQUEST_BYTES);
    if (parsed.tooLarge) return c.json({ error: 'Sync request is too large.' }, 413);
    const body = (parsed.body ?? {}) as Partial<SyncPageRequest>;
    const { page } = body ?? {};
  
    if (!page?.id || !page.notionPageId) {
      return c.json({ page, status: 'saved', message: 'No Notion page is linked yet.' });
    }
  
    const store = await requireConnectedStore(c);
  
    // Keep notion_block_id in sync so webhooks can route back to this local page
    await Promise.all([
      supabase.from('notion_block_sync').upsert(
        { installation_id: store.installationId, local_id: page.id, notion_block_id: page.notionPageId, entity_type: 'page' },
        { onConflict: 'installation_id,local_id', ignoreDuplicates: true },
      ),
      supabase.from('notion_block_sync')
        .update({ notion_block_id: page.notionPageId })
        .eq('installation_id', store.installationId)
        .eq('local_id', page.id)
        .is('notion_block_id', null),
    ]).catch(() => {});
  
    const notionContainer = await retrieveNotionPageOrBlock(store, page);
  
    if (page.remoteRevision && notionContainer.last_edited_time === page.remoteRevision) {
      return c.json({
        page: {
          ...page,
          notionLastEditedTime: notionContainer.last_edited_time,
          remoteRevision: notionContainer.last_edited_time,
          syncState: 'saved',
        },
        status: 'saved',
        message: 'Already current.',
      });
    }
  
    console.log('[sync/pull] importing blocks after a Notion revision change');
    const pulledContent = await importManagedBlocks(store, page);
  
    if (!pulledContent) {
      return c.json({
        page: {
          ...page,
          notionLastEditedTime: notionContainer.last_edited_time,
          remoteRevision: notionContainer.last_edited_time,
          syncState: 'stale',
        },
        status: 'stale',
        message: 'Notion changed this page in a way Inkwell cannot safely import automatically.',
      });
    }
  
    appendLog(store, 'sync_pull', page.title);
    await writeStore(store);
  
    return c.json({
      page: {
        ...page,
        content: pulledContent,
        notionLastEditedTime: notionContainer.last_edited_time,
        remoteRevision: notionContainer.last_edited_time,
        syncState: 'saved',
      },
      status: 'saved',
      message: 'Imported simple Notion edits.',
    });
  });
  
  /** Marks a stale synchronization row as current. @param c - Hono context. @returns JSON response. */
  app.post('/sync/clear-stale', async (c) => {
    const parsed = await readLimitedJsonBody<{ pageIds?: string[] }>(c.req.raw, MAX_CONTROL_JSON_REQUEST_BYTES);
    if (parsed.tooLarge) return c.json({ error: 'Request is too large.' }, 413);
    const body = parsed.body ?? {};
    const pageIds = Array.isArray(body?.pageIds) ? body.pageIds : [];
    if (!pageIds.length) return c.json({ cleared: true });
  
    const store = await requireConnectedStore(c);
    await supabase
      .from('notion_block_sync')
      .update({ is_stale: false, stale_since: null })
      .eq('installation_id', store.installationId)
      .in('local_id', pageIds);
  
    return c.json({ cleared: true });
  });
}

/** Uses persisted queue payloads as the source of truth for active server work. */
export async function hasPendingSyncQueuePayload(installationId: string | number): Promise<boolean> {
  const { data, error } = await supabase
    .from('inkwell_sync_queue_payloads')
    .select('id')
    .eq('installation_id', installationId)
    .eq('status', 'pending')
    .limit(1);
  if (error) throw new Error('Unable to read queued synchronization status.');
  return Boolean(data?.length);
}
