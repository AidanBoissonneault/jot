import { describe, expect, it } from 'vitest';
import { SyncEventsDO } from '@/apps/worker/src/syncEvents';

describe('installation synchronization event streams', () => {
  it('closes every stream when logout disconnects an installation', async () => {
    const events = new SyncEventsDO();
    const streams = await Promise.all([
      events.fetch(new Request('http://do/connect')),
      events.fetch(new Request('http://do/connect')),
    ]);

    const response = await events.fetch(new Request('http://do/disconnect', { method: 'POST' }));

    expect(response.status).toBe(200);
    for (const stream of streams) {
      const reader = stream.body!.getReader();
      await expect(reader.read()).resolves.toEqual({ done: true, value: undefined });
      reader.releaseLock();
    }
  });
});
