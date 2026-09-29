/**
 * @file Normalizes worker state and reads/writes installation state in Supabase.
 * @author Aidan Boissonneault
 * @lastModified September 2026
 */
import type { Identifier, WorkerStore, WorkerSupabaseClient } from '../types.js';

/** Creates persistence operations bound to the worker's Supabase client. */
export function createWorkerStorePersistence(supabase: WorkerSupabaseClient) {
  /** Fills all state collections and nullable connection values. */
  function normalizeStore(store: Partial<WorkerStore>): WorkerStore {
    return {
      ignoredInkwellDatabaseIds: store.ignoredInkwellDatabaseIds ?? new Set<string>(),
      installationId: store.installationId,
      parentPages: store.parentPages ?? {},
      projectPages: store.projectPages ?? {},
      projectBlocks: store.projectBlocks ?? {},
      threadBlocks: store.threadBlocks ?? {},
      inkwellRootPage: store.inkwellRootPage,
      inkwellDatabase: store.inkwellDatabase,
      notePages: store.notePages ?? {},
      blockMappings: store.blockMappings ?? {},
      logs: store.logs ?? [],
      tokens: store.tokens,
    };
  }

  /** Creates an empty normalized worker store. */
  function readStore(): WorkerStore {
    return normalizeStore({});
  }

  /** Persists normalized state for its connected installation. */
  async function writeStore(store: WorkerStore): Promise<void> {
    if (store.installationId) {
      await writeInkwellSyncState(store.installationId, store);
    }
  }

  /** Appends a bounded diagnostic event to worker state. */
  function appendLog(store: WorkerStore, event: string, message: string): void {
    store.logs.push({ at: new Date().toISOString(), event, message });
    store.logs = store.logs.slice(-250);
  }

  /** Ensures persisted synchronization state exists. */
  async function ensureInkwellSyncStateRow(installationId: Identifier): Promise<void> {
    await supabase
      .from('inkwell_sync_state')
      .upsert(
        { installation_id: installationId },
        { onConflict: 'installation_id', ignoreDuplicates: true },
      );
  }

  /** Loads and normalizes persisted synchronization state. */
  async function readInkwellSyncState(installationId: Identifier): Promise<WorkerStore> {
    await ensureInkwellSyncStateRow(installationId);

    const { data: row } = await supabase
      .from('inkwell_sync_state')
      .select('*')
      .eq('installation_id', installationId)
      .single();

    if (!row) return normalizeStore({});

    return normalizeStore({
      inkwellRootPage:
        row.inkwell_database_id && !row.inkwell_data_source_id
          ? {
              id: row.inkwell_database_id,
              parentPageId: row.inkwell_parent_page_id,
              title: row.inkwell_database_title,
            }
          : undefined,
      inkwellDatabase: row.inkwell_database_id
        ? {
            databaseId: row.inkwell_database_id,
            dataSourceId: row.inkwell_data_source_id,
            parentPageId: row.inkwell_parent_page_id,
            title: row.inkwell_database_title,
            propertyIds: {},
            url: undefined,
            views: {},
          }
        : undefined,
      // Supabase returns JSONB columns as parsed objects already.
      notePages: row.note_pages_json ?? {},
      blockMappings: row.block_mappings_json ?? {},
      parentPages: row.parent_pages_json ?? {},
      projectPages: row.project_pages_json ?? {},
      projectBlocks: row.project_blocks_json ?? {},
      threadBlocks: row.thread_blocks_json ?? {},
    });
  }

  /** Serializes worker state into the installation persistence row. */
  async function writeInkwellSyncState(
    installationId: Identifier,
    store: WorkerStore,
  ): Promise<void> {
    await ensureInkwellSyncStateRow(installationId);
    await supabase
      .from('inkwell_sync_state')
      .update({
        inkwell_database_id: store.inkwellDatabase?.databaseId ?? store.inkwellRootPage?.id ?? null,
        inkwell_data_source_id: store.inkwellDatabase?.dataSourceId ?? null,
        inkwell_parent_page_id:
          store.inkwellDatabase?.parentPageId ??
          store.inkwellRootPage?.id ??
          store.inkwellRootPage?.parentPageId ??
          null,
        inkwell_database_title:
          store.inkwellDatabase?.title ?? store.inkwellRootPage?.title ?? null,
        note_pages_json: store.notePages ?? {},
        block_mappings_json: store.blockMappings ?? {},
        parent_pages_json: store.parentPages ?? {},
        project_pages_json: store.projectPages ?? {},
        project_blocks_json: store.projectBlocks ?? {},
        thread_blocks_json: store.threadBlocks ?? {},
        updated_at: new Date().toISOString(),
      })
      .eq('installation_id', installationId);
  }

  return {
    appendLog,
    ensureInkwellSyncStateRow,
    readInkwellSyncState,
    readStore,
    writeInkwellSyncState,
    writeStore,
  };
}
