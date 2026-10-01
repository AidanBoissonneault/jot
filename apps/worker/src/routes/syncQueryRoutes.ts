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
import type { WorkerEnv } from '../types.js';

/**
 * Registers read, validation, reload, and recovery routes for synchronization.
 * @param app - Worker Hono application.
 * @returns Nothing.
 */
export function registerSyncQueryRoutes(app: Hono<{ Bindings: WorkerEnv }>): void {
  /** Returns local synchronization versions and statuses. @param c - Hono context. @returns JSON response. */
  app.get('/sync/status', async (c) => {
    const pageId = c.req.query('pageId');
  
    if (!pageId) return c.json({ error: 'Missing pageId' }, 400);
  
    const store = await requireConnectedStore(c);
    const { data: row } = await supabase
      .from('notion_block_sync')
      .select('local_version, synced_version, status, notion_block_id')
      .eq('installation_id', store.installationId)
      .eq('local_id', pageId)
      .maybeSingle();
  
    if (!row) return c.json({ status: 'synced', localVersion: 0, syncedVersion: 0 });
  
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
    const { pages = [], projects = [], knownVersions = {} } = body ?? {};
    const store = await requireConnectedStore(c);
    const result = await validateNotionCache(store, {
      pages: Array.isArray(pages) ? pages : [],
      projects: Array.isArray(projects) ? projects : [],
    });
  
    if (result.changed) {
      appendLog(
        store,
        'sync_cache_uncached',
        `${result.uncachedProjectIds.length} projects, ${result.uncachedPageIds.length} pages`,
      );
      await writeStore(store);
    }
  
    // Fetch stale + version info from notion_block_sync
    const { data: syncRows } = await supabase
      .from('notion_block_sync')
      .select('local_id, local_version, is_stale, status')
      .eq('installation_id', store.installationId);
  
    const stalePageIds: string[] = [];
    const aheadPageIds: string[] = [];
    const failedPageIds: string[] = [];
    const serverVersions: Record<string, number> = {};
  
    for (const row of syncRows ?? []) {
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
    }
  
    return c.json({
      status: 'saved',
      clearSelectedParentPage: result.clearSelectedParentPage,
      uncachedProjectIds: result.uncachedProjectIds,
      uncachedPageIds: result.uncachedPageIds,
      failedPageIds,
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
