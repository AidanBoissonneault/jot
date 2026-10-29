import { beforeEach, describe, expect, it, vi } from 'vitest';

const runtime = vi.hoisted(() => ({
  applyBlockOpsToNotionForInstallation: vi.fn(),
  initSingletons: vi.fn(),
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
  query.is = vi.fn(() => query);
  query.update = vi.fn(() => query);
  query.insert = vi.fn(() => query);
  query.limit = vi.fn(() => query);
  return query;
}

function makeSyncEventsBinding(fetch = vi.fn(async (_request: Request) => new Response('ok'))) {
  return {
    get: vi.fn(() => ({ fetch })),
    idFromName: vi.fn((id: string) => id),
  };
}

function makeMessage(jobId = '1b4f2a8a-4ed5-4d81-baaa-3d3c5d0d2e12') {
  return {
    ack: vi.fn(),
    body: { jobId },
    retry: vi.fn(),
  };
}

async function expectInvalidStoredPayloadToBeDiscarded(payload: unknown) {
  const message = makeMessage();
  const payloadRead = makeQuery({ installation_id: 42, status: 'pending', payload });
  const processedUpdate = makeQuery(null);
  const payloadDelete = makeQuery(null);
  runtime.supabase.from
    .mockReturnValueOnce(payloadRead)
    .mockReturnValueOnce(processedUpdate)
    .mockReturnValueOnce(payloadDelete)
    .mockReturnValueOnce(makeQuery([]));

  await processSyncQueue({ messages: [message] } as never, {
    SYNC_EVENTS: makeSyncEventsBinding(),
  } as never);

  expect(processedUpdate.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'processed' }));
  expect(payloadDelete.delete).toHaveBeenCalledOnce();
  expect(message.ack).toHaveBeenCalledOnce();
  expect(message.retry).not.toHaveBeenCalled();
  expect(runtime.applyBlockOpsToNotionForInstallation).not.toHaveBeenCalled();
  expect(runtime.pushPageToNotionForInstallation).not.toHaveBeenCalled();
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
    const query = makeQuery({ status: 'processed', installation_id: 42 });
    runtime.supabase.from.mockReturnValue(query);
    const notify = vi.fn(async (_request: Request) => new Response('ok'));
    const syncEvents = makeSyncEventsBinding(notify);

    await processSyncQueue({ messages: [message] } as never, {
      SYNC_EVENTS: syncEvents,
    } as never);

    expect(query.delete).toHaveBeenCalledOnce();
    expect(message.ack).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenCalledOnce();
    const event = await notify.mock.calls[0]?.[0]?.clone().json() as { status: string };
    expect(event).toEqual({ status: 'queue_idle' });
    expect(runtime.applyBlockOpsToNotionForInstallation).not.toHaveBeenCalled();
    expect(runtime.pushPageToNotionForInstallation).not.toHaveBeenCalled();
  });

  it('acknowledges obsolete inline payloads without replaying document content', async () => {
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
    await processSyncQueue({ messages: [message] } as never, {} as never);

    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
    expect(runtime.supabase.from).not.toHaveBeenCalled();
    expect(runtime.pushPageToNotionForInstallation).not.toHaveBeenCalled();
  });

  it('discards a stored payload with a zero server version', async () => {
    await expectInvalidStoredPayloadToBeDiscarded({
      installationId: 42,
      localId: 'page-one',
      queuedVersion: 0,
      type: 'page',
      payload: { page: {}, project: {} },
    });
  });

  it('discards old single-operation block payloads', async () => {
    await expectInvalidStoredPayloadToBeDiscarded({
      installationId: 42,
      localId: 'page-one',
      queuedVersion: 1,
      type: 'block_op',
      payload: {
        op: { type: 'block_update', payload: {} },
        page: {},
        project: {},
      },
    });
  });

  it('retains a permanent Notion failure in the durable outbox for explicit retry', async () => {
    const jobId = '1b4f2a8a-4ed5-4d81-baaa-3d3c5d0d2e12';
    const message = makeMessage(jobId);
    const job = {
      batchId: 'page-one:1',
      batchIndex: 0,
      batchSize: 1,
      installationId: 42,
      localId: 'page-one',
      pageId: 'page-one',
      projectId: 'project-one',
      queuedVersion: 1,
      type: 'block_op',
      payload: { page: { id: 'page-one' }, project: { id: 'project-one' }, ops: [{ opId: 'op-one' }] },
    };
    const payloadRead = makeQuery({ installation_id: 42, payload: job, status: 'pending' });
    const syncRead = makeQuery({ local_version: 1 });
    const markSyncing = makeQuery(null);
    const markFailed = makeQuery(null);
    const retainPayload = makeQuery({ id: jobId });
    runtime.supabase.from
      .mockReturnValueOnce(payloadRead)
      .mockReturnValueOnce(syncRead)
      .mockReturnValueOnce(markSyncing)
      .mockReturnValueOnce(markFailed)
      .mockReturnValueOnce(retainPayload);
    runtime.applyBlockOpsToNotionForInstallation.mockRejectedValueOnce(
      Object.assign(new Error('Invalid Notion page ID.'), {
        code: 'validation_error',
        isNotionApiError: true,
        status: 400,
      }),
    );
    const notify = vi.fn(async (_request: Request) => new Response('ok'));

    await processSyncQueue({ messages: [message] } as never, {
      SYNC_EVENTS: makeSyncEventsBinding(notify),
    } as never);

    expect(markFailed.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed' }));
    expect(retainPayload.update).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({ deadLetteredAt: expect.any(String) }),
    }));
    expect(retainPayload.delete).not.toHaveBeenCalled();
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
  });
});
