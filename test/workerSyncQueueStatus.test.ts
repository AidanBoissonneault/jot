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

import { registerSyncQueryRoutes } from '../apps/worker/src/routes/syncQueryRoutes';

function makeQueueQuery(rows: Array<{ id: string }>, count = rows.length, error: Error | null = null) {
  const query: Record<string, ReturnType<typeof vi.fn>> = {};
  query.select = vi.fn(() => query);
  query.eq = vi.fn(() => query);
  query.is = vi.fn(() => query);
  query.not = vi.fn(() => query);
  query.limit = vi.fn(() => query);
  query.then = vi.fn((resolve: (value: { data: typeof rows; count: number; error: Error | null }) => unknown) =>
    Promise.resolve({ data: rows, count, error }).then(resolve),
  );
  return query;
}

async function requestQueueStatus() {
  type Context = {
    req: { query: (name: string) => string | undefined };
    json: (body: unknown, status?: number) => { body: unknown; status: number };
  };
  type Handler = (context: Context) => unknown | Promise<unknown>;
  const handlers = new Map<string, Handler>();
  const app = {
    get: (path: string, handler: Handler) => handlers.set(`GET ${path}`, handler),
    post: (path: string, handler: Handler) => handlers.set(`POST ${path}`, handler),
  };
  registerSyncQueryRoutes(app as unknown as Parameters<typeof registerSyncQueryRoutes>[0]);

  const handler = handlers.get('GET /sync/status');
  if (!handler) throw new Error('Sync status route was not registered.');
  const result = await handler({
    req: { query: () => undefined },
    json: (body, status = 200) => ({ body, status }),
  });
  const response = result as { body: unknown; status: number };
  return { response: { status: response.status }, body: response.body };
}

describe('sync queue status', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runtime.requireConnectedStore.mockResolvedValue({ installationId: 42 });
  });

  it('uses queued payloads as the active-work source of truth', async () => {
    const pendingQuery = makeQueueQuery([{ id: 'job-1' }], 1);
    const failedQuery = makeQueueQuery([], 0);
    runtime.supabase.from.mockReturnValueOnce(pendingQuery).mockReturnValueOnce(failedQuery);

    const { response, body } = await requestQueueStatus();

    expect(response.status).toBe(200);
    expect(body).toEqual({ hasPending: true, pendingCount: 1, failedCount: 0 });
    expect(runtime.supabase.from).toHaveBeenCalledWith('jottathing_sync_queue_payloads');
    expect(pendingQuery.select).toHaveBeenCalledWith('id', { count: 'exact', head: true });
    expect(pendingQuery.eq).toHaveBeenCalledWith('installation_id', 42);
    expect(pendingQuery.eq).toHaveBeenCalledWith('status', 'pending');
    expect(pendingQuery.is).toHaveBeenCalledWith('payload->>deadLetteredAt', null);
    expect(failedQuery.not).toHaveBeenCalledWith('payload->>deadLetteredAt', 'is', null);
  });

  it('returns no active work when only retained failures remain', async () => {
    const pendingQuery = makeQueueQuery([], 0);
    const failedQuery = makeQueueQuery([], 2);
    runtime.supabase.from.mockReturnValueOnce(pendingQuery).mockReturnValueOnce(failedQuery);

    const { body } = await requestQueueStatus();

    expect(body).toEqual({ hasPending: false, pendingCount: 0, failedCount: 2 });
  });

  it('returns an error response when a queue count cannot be read', async () => {
    runtime.supabase.from.mockReturnValueOnce(makeQueueQuery([], 0, new Error('database offline')));

    const { response, body } = await requestQueueStatus();

    expect(response.status).toBe(500);
    expect(body).toEqual({ error: 'Unable to read queued synchronization status.' });
  });
});
