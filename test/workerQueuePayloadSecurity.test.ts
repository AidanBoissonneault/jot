import { describe, expect, it, vi } from 'vitest';
import {
  createWorkerQueueOperations,
  type EnqueueJob,
} from '../apps/worker/src/services/workerQueueOperations';

function createQueueHarness() {
  const payloadRows: Array<Record<string, unknown>> = [];
  const deletions: string[] = [];
  const query: Record<string, ReturnType<typeof vi.fn>> = {};
  query.select = vi.fn(() => query);
  query.eq = vi.fn(() => query);
  query.maybeSingle = vi.fn(async () => ({ data: null, error: null }));
  query.upsert = vi.fn(async () => ({ error: null }));
  query.insert = vi.fn(async (row: Record<string, unknown>) => {
    payloadRows.push(row);
    return { error: null };
  });
  query.delete = vi.fn(() => query);

  const supabase = {
    from: vi.fn((table: string) => {
      if (table === 'inkwell_sync_queue_payloads') {
        return {
          insert: query.insert,
          delete: vi.fn(() => ({
            eq: vi.fn(async (_key: string, id: string) => {
              deletions.push(id);
              return { error: null };
            }),
          })),
        };
      }
      return query;
    }),
  };
  const enqueue = createWorkerQueueOperations({ supabase } as never).enqueueSync;
  const send = vi.fn(async (_reference: { jobId: string }) => undefined);
  const env = { SYNC_QUEUE: { send } } as never;
  const job = {
    installationId: 42,
    localId: 'local-page-id',
    pageId: 'local-page-id',
    projectId: 'local-project-id',
    type: 'page',
    payload: {
      page: { id: 'local-page-id', content: 'PRIVATE DOCUMENT BODY' },
      project: { id: 'local-project-id', name: 'PRIVATE PROJECT NAME' },
      selectedParentPageId: 'notion-parent-id',
    },
  } as EnqueueJob;

  return { deletions, enqueue, env, job, payloadRows, send };
}

describe('Cloudflare sync queue payload privacy', () => {
  it('sends only an opaque job reference and keeps document data in the cascading account table', async () => {
    const { enqueue, env, job, payloadRows, send } = createQueueHarness();

    await enqueue(env, job, 7);

    expect(send).toHaveBeenCalledOnce();
    const reference = send.mock.calls[0][0];
    expect(reference).toEqual({ jobId: expect.stringMatching(/^[0-9a-f-]{36}$/i) });
    expect(JSON.stringify(reference)).not.toContain('PRIVATE DOCUMENT BODY');
    expect(JSON.stringify(reference)).not.toContain('PRIVATE PROJECT NAME');
    expect(payloadRows[0]).toMatchObject({
      installation_id: 42,
      status: 'pending',
      payload: { payload: { page: { content: 'PRIVATE DOCUMENT BODY' } }, queuedVersion: 7 },
    });
  });

  it('removes the stored document payload if publishing its reference fails', async () => {
    const { deletions, enqueue, env, job, payloadRows, send } = createQueueHarness();
    send.mockRejectedValueOnce(new Error('queue unavailable'));

    await expect(enqueue(env, job, 7)).rejects.toThrow('Unable to publish the pending sync job.');

    expect(payloadRows).toHaveLength(1);
    expect(deletions).toEqual([payloadRows[0].id as string]);
  });

  it('rechecks installation activity under its mutation lock before using a queued token', async () => {
    let installationReads = 0;
    const from = vi.fn((table: string) => {
      const query: Record<string, ReturnType<typeof vi.fn>> = {};
      query.select = vi.fn(() => query);
      query.eq = vi.fn(() => query);
      query.limit = vi.fn(() => query);
      query.maybeSingle = vi.fn(async () => {
        if (table === 'notion_installations') {
          installationReads += 1;
          return {
            data: installationReads === 1 ? { id: 42, user_id: 'notion-user' } : null,
            error: null,
          };
        }
        return { data: { accessToken: 'secret-test-token' }, error: null };
      });
      return query;
    });
    const pushPageCore = vi.fn(async () => undefined);
    const operations = createWorkerQueueOperations({
      supabase: { from },
      readStore: () => ({}),
      freshConnectedStore: async (store: unknown) => store,
      withFreshInstallationStore: async (store: unknown, operation: (value: never) => Promise<unknown>) =>
        operation(store as never),
      pushPageToNotionCore: pushPageCore,
    } as never);

    await expect(operations.pushPageToNotionForInstallation(42, {} as never))
      .rejects.toMatchObject({ code: 'installation_revoked' });

    expect(installationReads).toBe(2);
    expect(pushPageCore).not.toHaveBeenCalled();
  });
});
