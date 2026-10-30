import { describe, expect, it } from 'vitest';
import { readSyncPageRequestBody } from '@/apps/worker/src/routes/syncPageRequest';
import { MAX_SYNC_JSON_REQUEST_BYTES } from '@/apps/worker/src/workerUtils';

describe('readSyncPageRequestBody', () => {
  it('parses a page-sync body', async () => {
    const request = new Request('https://worker.example/sync/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ page: { id: 'page-1' } }),
    });

    await expect(readSyncPageRequestBody(request)).resolves.toEqual({ page: { id: 'page-1' } });
  });

  it('normalizes missing and invalid bodies to an empty object', async () => {
    await expect(readSyncPageRequestBody(new Request('https://worker.example/sync/pull')))
      .resolves.toEqual({});
    await expect(readSyncPageRequestBody(new Request('https://worker.example/sync/pull', {
      method: 'POST',
      body: '{invalid',
    }))).resolves.toEqual({});
  });

  it('returns null for oversized content-length before reading the body', async () => {
    const request = new Request('https://worker.example/sync/push', {
      method: 'POST',
      headers: { 'Content-Length': String(MAX_SYNC_JSON_REQUEST_BYTES + 1) },
    });

    await expect(readSyncPageRequestBody(request)).resolves.toBeNull();
  });
});
