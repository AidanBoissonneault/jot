import { beforeEach, describe, expect, it, vi } from 'vitest';

const runtime = vi.hoisted(() => ({
  requireConnectedStore: vi.fn(),
  supabase: { from: vi.fn() },
}));

vi.mock('../apps/worker/src/services/workerRuntime.js', () => ({
  ...runtime,
  appendLog: vi.fn(),
  importManagedBlocks: vi.fn(),
  readProjectDatabaseStructure: vi.fn(),
  readInkwellSyncState: vi.fn(),
  reloadProjectDatabaseFromNotion: vi.fn(),
  retrieveNotionPageOrBlock: vi.fn(),
  validateNotionCache: vi.fn(),
  withFreshInstallationStore: vi.fn(),
  writeStore: vi.fn(),
}));

import { hasPendingSyncQueuePayload } from '../apps/worker/src/routes/syncQueryRoutes';

function makeQueueQuery(rows: Array<{ id: string }>) {
  const query: Record<string, ReturnType<typeof vi.fn>> = {};
  query.select = vi.fn(() => query);
  query.eq = vi.fn(() => query);
  query.limit = vi.fn(() => query);
  query.then = vi.fn((resolve: (value: { data: typeof rows; error: null }) => unknown) =>
    Promise.resolve({ data: rows, error: null }).then(resolve),
  );
  return query;
}

describe('sync queue status', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runtime.requireConnectedStore.mockResolvedValue({ installationId: 42 });
  });

  it('uses queued payloads as the active-work source of truth', async () => {
    const query = makeQueueQuery([]);
    runtime.supabase.from.mockReturnValue(query);
    await expect(hasPendingSyncQueuePayload(42)).resolves.toBe(false);
    expect(runtime.supabase.from).toHaveBeenCalledWith('inkwell_sync_queue_payloads');
    expect(query.select).toHaveBeenCalledWith('id');
    expect(query.eq).toHaveBeenCalledWith('installation_id', 42);
    expect(query.eq).toHaveBeenCalledWith('status', 'pending');
    expect(query.limit).toHaveBeenCalledWith(1);
  });

  it('reports pending while the installation still has an unprocessed payload', async () => {
    runtime.supabase.from.mockReturnValue(makeQueueQuery([{ id: 'job-1' }]));
    await expect(hasPendingSyncQueuePayload(42)).resolves.toBe(true);
  });
});
