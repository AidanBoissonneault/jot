import { beforeEach, describe, expect, it, vi } from 'vitest';

const runtime = vi.hoisted(() => ({
  applyBlockOpsToNotionForInstallation: vi.fn(),
  initSingletons: vi.fn(),
  legacyQueueOperation: vi.fn(),
  pushPageToNotionForInstallation: vi.fn(),
  supabase: { from: vi.fn() },
  syncProjectToNotionForInstallation: vi.fn(),
}));

vi.mock('../apps/worker/src/services/workerRuntime.js', () => runtime);

import { processSyncQueue } from '../apps/worker/src/queues/syncQueueConsumer';

function makeQuery(data: unknown) {
  const query: Record<string, ReturnType<typeof vi.fn>> = {};
  query.select = vi.fn(() => query);
  query.eq = vi.fn(() => query);
  query.maybeSingle = vi.fn(async () => ({ data, error: null }));
  query.delete = vi.fn(() => query);
  query.update = vi.fn(() => query);
  return query;
}

function makeMessage(jobId = '1b4f2a8a-4ed5-4d81-baaa-3d3c5d0d2e12') {
  return {
    ack: vi.fn(),
    body: { jobId },
    retry: vi.fn(),
  };
}

describe('content-free sync queue references', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('acks an orphaned reference after account deletion cascades its payload row', async () => {
    const message = makeMessage();
    runtime.supabase.from.mockReturnValue(makeQuery(null));

    await processSyncQueue({ messages: [message] } as never, {
      SYNC_EVENTS: { get: vi.fn() },
    } as never);

    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
    expect(runtime.applyBlockOpsToNotionForInstallation).not.toHaveBeenCalled();
    expect(runtime.pushPageToNotionForInstallation).not.toHaveBeenCalled();
  });

  it('cleans a processed payload without replaying its Notion mutation', async () => {
    const message = makeMessage();
    const query = makeQuery({ status: 'processed' });
    runtime.supabase.from.mockReturnValue(query);

    await processSyncQueue({ messages: [message] } as never, {
      SYNC_EVENTS: { get: vi.fn() },
    } as never);

    expect(query.delete).toHaveBeenCalledOnce();
    expect(message.ack).toHaveBeenCalledOnce();
    expect(runtime.applyBlockOpsToNotionForInstallation).not.toHaveBeenCalled();
    expect(runtime.pushPageToNotionForInstallation).not.toHaveBeenCalled();
  });

  it('drains a legacy queue message as revoked without retrying deleted user content', async () => {
    const message = {
      ack: vi.fn(),
      body: {
        installationId: 42,
        localId: 'old-local-page',
        queuedVersion: 1,
        type: 'page',
        payload: { page: {}, project: {} },
      },
      retry: vi.fn(),
    };
    runtime.supabase.from.mockReturnValue(makeQuery(null));
    runtime.pushPageToNotionForInstallation.mockRejectedValueOnce(
      Object.assign(new Error('Installation is no longer active.'), { code: 'installation_revoked' }),
    );

    await processSyncQueue({ messages: [message] } as never, {
      SYNC_EVENTS: { get: vi.fn() },
    } as never);

    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
    expect(runtime.supabase.from).not.toHaveBeenCalledWith('inkwell_sync_queue_payloads');
  });
});
