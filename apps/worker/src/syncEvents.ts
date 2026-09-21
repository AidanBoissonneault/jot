/**
 * @file Broadcasts synchronization status events to connected clients through server-sent events.
 * @author Aidan Boissonneault
 * @lastModified September 2026
 */

interface SyncEventSession {
  encoder: TextEncoder;
  writer: WritableStreamDefaultWriter<Uint8Array>;
}

/** Describes the durable event-stream coordinator for synchronization updates. */
export class SyncEventsDO {
  private readonly sessions = new Map<string, SyncEventSession>();

  /**
   * Handles SSE connections and status broadcasts for this installation.
   * @param request - Durable Object request.
   * @returns Streaming, acknowledgment, or not-found response.
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/connect') {
      const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
      const writer = writable.getWriter();
      const encoder = new TextEncoder();
      const id = crypto.randomUUID();
      this.sessions.set(id, { writer, encoder });
      const heartbeat = setInterval((): void => {
        writer.write(encoder.encode(': heartbeat\n\n')).catch((): void => {
          clearInterval(heartbeat);
          this.sessions.delete(id);
        });
      }, 25_000);
      writer.closed.finally((): void => {
        clearInterval(heartbeat);
        this.sessions.delete(id);
      });
      return new Response(readable, {
        headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' },
      });
    }

    if (url.pathname === '/notify' && request.method === 'POST') {
      const event: unknown = await request.json();
      const payload = `data: ${JSON.stringify(event)}\n\n`;
      const dead: string[] = [];
      for (const [id, { writer, encoder }] of this.sessions) {
        try {
          await writer.write(encoder.encode(payload));
        } catch {
          dead.push(id);
        }
      }
      dead.forEach((id: string): boolean => this.sessions.delete(id));
      return new Response('ok');
    }

    return new Response('not found', { status: 404 });
  }
}
