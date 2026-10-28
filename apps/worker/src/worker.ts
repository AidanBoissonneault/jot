/**
 * @file Composes the Jottathing API feature routes and Cloudflare Worker entry points.
 * @author Aidan Boissonneault
 * @lastModified September 2026
 */

import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import {
  processSyncDeadLetterQueue,
  processSyncQueue,
} from './queues/syncQueueConsumer.js';
import { registerAuthRoutes } from './routes/authRoutes.js';
import { registerMediaRoutes } from './routes/mediaRoutes.js';
import { registerNotionRoutes } from './routes/notionRoutes.js';
import { registerSyncMutationRoutes } from './routes/syncMutationRoutes.js';
import { registerSyncQueryRoutes } from './routes/syncQueryRoutes.js';
import { registerWebhookRoutes } from './routes/webhookRoutes.js';
import { initSingletons } from './services/workerRuntime.js';
import type { SyncQueueReference, WorkerEnv } from './types.js';
import { notionApiErrorResponse, safeErrorMetadata } from './workerUtils.js';

export { SyncEventsDO } from './syncEvents.js';

/** Hono application containing every public Jottathing API feature. */
export const app = new Hono<{ Bindings: WorkerEnv }>();

app.onError((error, c) => {
  if (error instanceof HTTPException) return error.getResponse();

  const notionResponse = notionApiErrorResponse(c, error);
  if (notionResponse) return notionResponse;

  const metadata = safeErrorMetadata(error);
  const isTransientDatabaseFailure =
    metadata.status === 503 ||
    metadata.status === 504 ||
    ['PGRST000', 'PGRST001', 'PGRST002', 'PGRST003', 'sync_storage_timeout']
      .includes(String(metadata.code ?? ''));
  console.error(JSON.stringify({
    event: 'worker_request_failed',
    method: c.req.method,
    path: new URL(c.req.url).pathname,
    ...metadata,
  }));

  if (isTransientDatabaseFailure) {
    c.header('Retry-After', '10');
    return c.json({
      status: 'error',
      code: 'sync_storage_unavailable',
      message: 'Sync storage is temporarily unavailable. Please try again shortly.',
    }, 503);
  }

  return c.json({
    status: 'error',
    code: 'internal_error',
    message: 'The sync service hit an unexpected error. Please try again.',
  }, 500);
});

registerAuthRoutes(app);
registerNotionRoutes(app);
registerSyncMutationRoutes(app);
registerSyncQueryRoutes(app);
registerWebhookRoutes(app);
registerMediaRoutes(app);

/** Cloudflare Worker handlers for HTTP and synchronization Queue traffic. */
const worker: ExportedHandler<WorkerEnv, SyncQueueReference> = {
  /**
   * Initializes request services and dispatches an HTTP request.
   * @param request - Incoming HTTP request.
   * @param env - Worker environment bindings.
   * @param context - Cloudflare execution context.
   * @returns Hono's HTTP response.
   */
  async fetch(request, env, context): Promise<Response> {
    initSingletons(env);
    return app.fetch(request, env, context);
  },

  /** Processes a synchronization Queue batch. */
  queue(batch, env) {
    return batch.queue === 'jottathing-sync-dlq'
      ? processSyncDeadLetterQueue(batch, env)
      : processSyncQueue(batch, env);
  },
};

export default worker;
