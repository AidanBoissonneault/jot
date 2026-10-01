/**
 * @file Composes the Inkwell API feature routes and Cloudflare Worker entry points.
 * @author Aidan Boissonneault
 * @lastModified September 2026
 */

import { Hono } from 'hono';
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
import { notionApiErrorResponse } from './workerUtils.js';

export { SyncEventsDO } from './syncEvents.js';

/** Hono application containing every public Inkwell API feature. */
export const app = new Hono<{ Bindings: WorkerEnv }>();

app.use('*', async (c, next) => {
  try {
    await next();
  } catch (error) {
    const response = notionApiErrorResponse(c, error);
    if (response) return response;
    throw error;
  }
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
    return batch.queue === 'inkwell-sync-dlq'
      ? processSyncDeadLetterQueue(batch, env)
      : processSyncQueue(batch, env);
  },
};

export default worker;
