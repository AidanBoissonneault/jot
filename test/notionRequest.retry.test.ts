import { describe, expect, test, vi } from 'vitest';
import { createNotionRequester } from '@/apps/worker/src/notionRequest';
import type { WorkerStore } from '@/apps/worker/src/types';

const store = { tokens: { access_token: 'test-token' } } as WorkerStore;

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status });
}

describe('Notion request retry policy', () => {
  test('does not replay a block-create PATCH after an ambiguous server error', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ code: 'internal_server_error' }, 500));
    const request = createNotionRequester({
      fetchImpl: fetchImpl as typeof fetch,
      sleep: vi.fn(async () => undefined),
    });

    await expect(request(store, '/blocks/page-id/children', {
      method: 'PATCH',
      body: { children: [{ object: 'block', type: 'paragraph', paragraph: {} }] },
    })).rejects.toThrow();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('does not replay a block-create PATCH after a network failure', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('Connection closed after request was sent.');
    });
    const request = createNotionRequester({
      fetchImpl: fetchImpl as typeof fetch,
      sleep: vi.fn(async () => undefined),
    });

    await expect(request(store, '/blocks/page-id/children', {
      method: 'PATCH',
      body: { children: [{ object: 'block', type: 'paragraph', paragraph: {} }] },
    })).rejects.toThrow('Connection closed');

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('retries an explicit Notion rate-limit response for a create request', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ code: 'rate_limited' }, 429))
      .mockResolvedValueOnce(jsonResponse({ object: 'block', id: 'created-block' }));
    const request = createNotionRequester({
      fetchImpl: fetchImpl as typeof fetch,
      sleep: vi.fn(async () => undefined),
    });

    const result = await request(store, '/blocks/page-id/children', {
      method: 'PATCH',
      body: { children: [{ object: 'block', type: 'paragraph', paragraph: {} }] },
    });

    expect(result.id).toBe('created-block');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  test('retains retries for idempotent reads', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ code: 'internal_server_error' }, 500))
      .mockResolvedValueOnce(jsonResponse({ object: 'block', id: 'loaded-block' }));
    const request = createNotionRequester({
      fetchImpl: fetchImpl as typeof fetch,
      sleep: vi.fn(async () => undefined),
    });

    const result = await request(store, '/blocks/block-id');

    expect(result.id).toBe('loaded-block');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
