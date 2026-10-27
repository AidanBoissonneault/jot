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
      ignoredJottathingDatabaseIds: store.ignoredJottathingDatabaseIds ?? new Set<string>(),
      installationId: store.installationId,
      parentPages: safeRecord(store.parentPages),
      projectPages: safeRecord(store.projectPages),
      projectBlocks: safeRecord(store.projectBlocks),
      threadBlocks: safeRecord(store.threadBlocks),
      jottathingRootPage: store.jottathingRootPage,
      jottathingDatabase: store.jottathingDatabase,
      notePages: safeRecord(store.notePages),
      blockMappings: normalizeBlockMappings(store.blockMappings),
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
      await writeJottathingSyncState(store.installationId, store);
    }
  }

  /** Appends a bounded diagnostic event to worker state. */
  function appendLog(store: WorkerStore, event: string, message: string): void {
    store.logs.push({ at: new Date().toISOString(), event, message });
    store.logs = store.logs.slice(-250);
  }

  /** Ensures persisted synchronization state exists. */
  async function ensureJottathingSyncStateRow(installationId: Identifier): Promise<void> {
    const { error } = await supabase
      .from('jottathing_sync_state')
      .upsert(
        { installation_id: installationId },
        { onConflict: 'installation_id', ignoreDuplicates: true },
      );
    if (error) throw new Error('Unable to ensure Jottathing synchronization state.');
  }

  /** Copies JSON-backed dictionaries into prototype-free maps before key lookups or writes. */
  function safeRecord<Value>(value: unknown): Record<string, Value> {
    const record = Object.create(null) as Record<string, Value>;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return record;

    for (const key of Object.keys(value)) {
      record[key] = (value as Record<string, Value>)[key];
    }
    return record;
  }

  /** Renames a persisted identity field while retaining the exact opaque block ID value. */
  function normalizeBlockMappings(value: unknown): WorkerStore['blockMappings'] {
    const mappings = safeRecord<unknown>(value);
    return Object.fromEntries(Object.entries(mappings).map(([pageId, entries]) => [
      pageId,
      Array.isArray(entries)
        ? entries.map((entry) => {
            if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry;
            const mapping = entry as Record<string, unknown>;
            const blockId = mapping.jottathingBlockId ?? mapping.inkwellBlockId;
            if (typeof blockId !== 'string' || !blockId) return mapping;
            const { inkwellBlockId: _legacyId, ...remaining } = mapping;
            return { ...remaining, jottathingBlockId: blockId };
          })
        : entries,
    ])) as WorkerStore['blockMappings'];
  }

  /** Loads and normalizes persisted synchronization state. */
  async function readJottathingSyncState(installationId: Identifier): Promise<WorkerStore> {
    await ensureJottathingSyncStateRow(installationId);

    const { data: row, error } = await supabase
      .from('jottathing_sync_state')
      .select('*')
      .eq('installation_id', installationId)
      .single();

    if (error) throw new Error('Unable to read Jottathing synchronization state.');
    if (!row) return normalizeStore({});

    return normalizeStore({
      jottathingRootPage:
        row.jottathing_database_id && !row.jottathing_data_source_id
          ? {
              id: row.jottathing_database_id,
              parentPageId: row.jottathing_parent_page_id,
              title: row.jottathing_database_title,
            }
          : undefined,
      jottathingDatabase: row.jottathing_database_id
        ? {
            databaseId: row.jottathing_database_id,
            dataSourceId: row.jottathing_data_source_id,
            parentPageId: row.jottathing_parent_page_id,
            title: row.jottathing_database_title,
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
  async function writeJottathingSyncState(
    installationId: Identifier,
    store: WorkerStore,
  ): Promise<void> {
    await ensureJottathingSyncStateRow(installationId);
    const { error } = await supabase
      .from('jottathing_sync_state')
      .update({
        jottathing_database_id: store.jottathingDatabase?.databaseId ?? store.jottathingRootPage?.id ?? null,
        jottathing_data_source_id: store.jottathingDatabase?.dataSourceId ?? null,
        jottathing_parent_page_id:
          store.jottathingDatabase?.parentPageId ??
          store.jottathingRootPage?.id ??
          store.jottathingRootPage?.parentPageId ??
          null,
        jottathing_database_title:
          store.jottathingDatabase?.title ?? store.jottathingRootPage?.title ?? null,
        note_pages_json: safeRecord(store.notePages),
        block_mappings_json: safeRecord(store.blockMappings),
        parent_pages_json: safeRecord(store.parentPages),
        project_pages_json: safeRecord(store.projectPages),
        project_blocks_json: safeRecord(store.projectBlocks),
        thread_blocks_json: safeRecord(store.threadBlocks),
        updated_at: new Date().toISOString(),
      })
      .eq('installation_id', installationId);
    if (error) throw new Error('Unable to save Jottathing synchronization state.');
  }

  return {
    appendLog,
    ensureJottathingSyncStateRow,
    readJottathingSyncState,
    readStore,
    writeJottathingSyncState,
    writeStore,
  };
}
