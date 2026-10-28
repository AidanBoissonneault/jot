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
  readJottathingSyncState: vi.fn(),
  reloadProjectDatabaseFromNotion: vi.fn(),
  retrieveNotionPageOrBlock: vi.fn(),
  validateNotionCache: vi.fn(),
  withFreshInstallationStore: vi.fn(),
  writeStore: vi.fn(),
}));

import {
  failedSyncQueuePayloadCount,
  hasPendingSyncQueuePayload,
  pendingSyncQueuePayloadCount,
} from '../apps/worker/src/routes/syncQueryRoutes';

function makeQueueQuery(rows: Array<{ id: string }>, count = rows.length) {
  const query: Record<string, ReturnType<typeof vi.fn>> = {};
  query.select = vi.fn(() => query);
  query.eq = vi.fn(() => query);
  query.is = vi.fn(() => query);
  query.not = vi.fn(() => query);
  query.limit = vi.fn(() => query);
  query.then = vi.fn((resolve: (value: { data: typeof rows; error: null }) => unknown) =>
    Promise.resolve({ data: rows, count, error: null }).then(resolve),
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
    expect(runtime.supabase.from).toHaveBeenCalledWith('jottathing_sync_queue_payloads');
    expect(query.select).toHaveBeenCalledWith('id');
    expect(query.eq).toHaveBeenCalledWith('installation_id', 42);
    expect(query.eq).toHaveBeenCalledWith('status', 'pending');
    expect(query.is).toHaveBeenCalledWith('payload->>deadLetteredAt', null);
    expect(query.limit).toHaveBeenCalledWith(1);
  });

  it('reports pending while the installation still has an unprocessed payload', async () => {
    runtime.supabase.from.mockReturnValue(makeQueueQuery([{ id: 'job-1' }]));
    await expect(hasPendingSyncQueuePayload(42)).resolves.toBe(true);
  });

  it('keeps parked failures out of the active upload count', async () => {
    const pendingQuery = makeQueueQuery([], 0);
    runtime.supabase.from.mockReturnValue(pendingQuery);
    await expect(pendingSyncQueuePayloadCount(42)).resolves.toBe(0);
    expect(pendingQuery.is).toHaveBeenCalledWith('payload->>deadLetteredAt', null);

    const failedQuery = makeQueueQuery([], 1);
    runtime.supabase.from.mockReturnValue(failedQuery);
    await expect(failedSyncQueuePayloadCount(42)).resolves.toBe(1);
    expect(failedQuery.not).toHaveBeenCalledWith('payload->>deadLetteredAt', 'is', null);
  });
});
