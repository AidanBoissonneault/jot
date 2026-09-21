/**
 * @file Registers YouTube presentation and Notion workspace-page discovery and creation routes.
 * @author Aidan Boissonneault
 * @lastModified September 2026
 */

import type { Hono } from 'hono';
import { youtubeEmbedUrl } from '../../../../src/lib/youtubeUtils.js';
import { youtubeEmbedPage } from '../htmlPages.js';
import {
  appendLog,
  createWorkspacePage,
  notionRequest,
  requireConnectedStore,
  writeStore,
} from '../services/workerRuntime.js';
import { titleFromPage } from '../workerUtils.js';
import type { WorkerEnv } from '../types.js';
import type { CreateNotionPageRequest } from '../../../../src/types/sync.js';

/**
 * Registers media presentation and workspace page routes.
 * @param app - Worker Hono application.
 * @returns Nothing.
 */
export function registerNotionRoutes(app: Hono<{ Bindings: WorkerEnv }>): void {
  // ─── Notion routes ─────────────────────────────────────────────────────────────
  
  /** Serves the restricted YouTube embed wrapper. @param c - Hono context. @returns HTML response. */
  app.get('/youtube/embed', (c) => {
    const src = c.req.query('src') ?? '';
    const embedUrl = youtubeEmbedUrl(src);
  
    if (!embedUrl) {
      return c.text('Invalid YouTube URL.', 400);
    }
  
    c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    c.header(
      'Content-Security-Policy',
      "default-src 'none'; frame-src https://www.youtube.com https://www.youtube-nocookie.com; style-src 'unsafe-inline';",
    );
  
    return c.html(youtubeEmbedPage(embedUrl));
  });
  
  /** Lists selectable Notion parent pages. @param c - Hono context. @returns JSON response. */
  app.get('/notion/pages', async (c) => {
    const query = c.req.query('query') ?? '';
    const store = await requireConnectedStore(c);
    const response = await notionRequest(store, '/search', {
      method: 'POST',
      body: {
        query,
        page_size: 25,
        filter: { property: 'object', value: 'page' },
      },
    });
  
    return c.json({
      pages: response.results.map((page) => ({
        id: page.id,
        title: titleFromPage(page),
        url: page.url,
      })),
    });
  });
  
  /** Creates a selectable Notion workspace page. @param c - Hono context. @returns JSON response. */
  app.post('/notion/pages', async (c) => {
    const body: Partial<CreateNotionPageRequest> = await c.req.json<CreateNotionPageRequest>().catch(() => ({}));
    const title = String(body?.title ?? '').trim() || 'Inkwell';
    const store = await requireConnectedStore(c);
    const page = await createWorkspacePage(store, title);
  
    appendLog(store, 'parent_page_created', title);
    await writeStore(store);
  
    return c.json({ page: { id: page.id, title: titleFromPage(page), url: page.url } });
  });
}

