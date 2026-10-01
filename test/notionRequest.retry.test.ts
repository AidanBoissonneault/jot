import { describe, expect, test, vi } from 'vitest';
import { createNotionRequester, notionApiHttpFailure, uploadFileToNotion } from '@/apps/worker/src/notionRequest';
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

  test('retries read-only Notion POST queries after transient failures', async () => {
    for (const endpoint of ['/search', '/data_sources/source-id/query']) {
      const fetchImpl = vi.fn()
        .mockResolvedValueOnce(jsonResponse({ code: 'internal_server_error' }, 500))
        .mockResolvedValueOnce(jsonResponse({ results: [] }));
      const request = createNotionRequester({
        fetchImpl: fetchImpl as typeof fetch,
        sleep: vi.fn(async () => undefined),
      });

      await request(store, endpoint, { method: 'POST', body: { page_size: 10 } });

      expect(fetchImpl).toHaveBeenCalledTimes(2);
    }
  });

  test('does not retry a create POST after an ambiguous server error', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ code: 'internal_server_error' }, 500));
    const request = createNotionRequester({
      fetchImpl: fetchImpl as typeof fetch,
      sleep: vi.fn(async () => undefined),
    });

    await expect(request(store, '/pages', { method: 'POST', body: { parent: {} } })).rejects.toThrow();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('maps a Notion 403 to an actionable access error', async () => {
    const request = createNotionRequester({
      fetchImpl: vi.fn(async () => jsonResponse({ code: 'restricted_resource', message: 'Access denied.' }, 403)) as typeof fetch,
      sleep: vi.fn(async () => undefined),
    });

    let failure;
    try {
      await request(store, '/blocks/block-id', { method: 'DELETE' });
    } catch (error) {
      failure = notionApiHttpFailure(error);
    }

    expect(failure?.status).toBe(403);
    expect(failure?.body.code).toBe('notion_access_denied');
    expect(failure?.body.message).toContain('shared with Inkwell');
  });

  test('refuses endpoints that can leave the Notion API route tree', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ id: 'should-not-run' }));
    const request = createNotionRequester({
      fetchImpl: fetchImpl as typeof fetch,
      sleep: vi.fn(async () => undefined),
    });

    await expect(request(store, '/blocks/../pages/page-id')).rejects.toThrow('invalid path segment');
    await expect(request(store, 'https://attacker.example/collect')).rejects.toThrow('endpoint is invalid');
    await expect(request(store, '/pages/page-id?redirect=https://attacker.example')).rejects.toThrow('supported API route');

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('does not follow authenticated Notion API redirects', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ id: 'page-id' }));
    const request = createNotionRequester({
      fetchImpl: fetchImpl as typeof fetch,
      sleep: vi.fn(async () => undefined),
    });

    await request(store, '/pages/page-id');

    expect(fetchImpl.mock.calls[0]?.[1]?.redirect).toBe('manual');
  });

  test('keeps both Notion file-upload requests on the API host', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ id: 'upload-id' }))
      .mockResolvedValueOnce(jsonResponse({ status: 'uploaded' }));

    await uploadFileToNotion(
      store,
      { data: new Uint8Array([1, 2, 3]), mimeType: 'image/png', filename: 'image.png' },
      { fetchImpl: fetchImpl as typeof fetch },
    );

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls.map((call) => call[1]?.redirect)).toEqual(['manual', 'manual']);
  });

  test('pins the bearer token transport to the official Notion API host', () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}));

    expect(() => createNotionRequester({
      baseUrl: 'https://attacker.example/v1',
      fetchImpl: fetchImpl as typeof fetch,
    })).toThrow('https://api.notion.com/v1');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('uses exponential backoff when a rate-limit response omits Retry-After', async () => {
    let now = 0;
    const sleep = vi.fn(async (milliseconds: number) => {
      now += milliseconds;
    });
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ code: 'rate_limited' }, 429))
      .mockResolvedValueOnce(jsonResponse({ id: 'page-id' }));
    const request = createNotionRequester({
      fetchImpl: fetchImpl as typeof fetch,
      now: () => now,
      requestsPerSecond: 1,
      sleep,
    });

    await request(store, '/pages/page-id');

    expect(sleep.mock.calls[0]?.[0]).toBe(250);
  });

  test('caps a server-supplied Retry-After delay', async () => {
    let now = 0;
    const sleep = vi.fn(async (milliseconds: number) => {
      now += milliseconds;
    });
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 'rate_limited' }), {
        status: 429,
        headers: { 'Retry-After': '600' },
      }))
      .mockResolvedValueOnce(jsonResponse({ id: 'page-id' }));
    const request = createNotionRequester({
      fetchImpl: fetchImpl as typeof fetch,
      now: () => now,
      requestsPerSecond: 1,
      sleep,
    });

    await request(store, '/pages/page-id');

    expect(sleep.mock.calls[0]?.[0]).toBe(2_000);
  });
});
