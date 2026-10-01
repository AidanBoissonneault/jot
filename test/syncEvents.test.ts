import { describe, expect, it } from 'vitest';
import { SyncEventsDO } from '@/apps/worker/src/syncEvents';

describe('SyncEventsDO', () => {
  it('removes a disconnected stream without leaving an unhandled rejection', async () => {
    const events = new SyncEventsDO();
    const response = await events.fetch(new Request('http://do/connect'));

    expect(response.headers.get('content-type')).toBe('text/event-stream');
    await response.body?.cancel();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect((events as unknown as { sessions: Map<string, unknown> }).sessions.size).toBe(0);
  });
});
