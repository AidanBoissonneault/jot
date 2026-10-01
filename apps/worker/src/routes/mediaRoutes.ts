/**
 * @file Registers validated Notion media upload and signed-URL refresh routes.
 * @author Aidan Boissonneault
 * @lastModified September 2026
 */

import type { Hono } from 'hono';
import { uploadFileToNotion } from '../notionRequest.js';
import {
  notionRequest,
  requireConnectedStore,
} from '../services/workerRuntime.js';
import {
  MAX_CONTROL_JSON_REQUEST_BYTES,
  findMappedNotionBlockId,
  findNotionBlockIdByFileUploadId,
  isBase64,
  isSupportedMediaMimeType,
  mediaUrlFromNotionBlock,
  readLimitedJsonBody,
  sanitizeMediaFilename,
} from '../workerUtils.js';
import type { WorkerEnv } from '../types.js';
import type { MediaRefreshRequest, MediaUploadRequest } from '../../../../src/types/sync.js';

const MAX_MEDIA_UPLOAD_BYTES = 20 * 1024 * 1024;
const MAX_MEDIA_UPLOAD_BASE64_LENGTH = Math.ceil(MAX_MEDIA_UPLOAD_BYTES / 3) * 4;
const MAX_MEDIA_UPLOAD_REQUEST_BYTES = MAX_MEDIA_UPLOAD_BASE64_LENGTH + 64 * 1024;

/**
 * Registers media upload and refresh routes.
 * @param app - Worker Hono application.
 * @returns Nothing.
 */
export function registerMediaRoutes(app: Hono<{ Bindings: WorkerEnv }>): void {
  // ─── Media upload ──────────────────────────────────────────────────────────────
  
  /** Uploads validated local media to Notion. @param c - Hono context. @returns JSON upload metadata. */
  app.post('/media/upload', async (c) => {
    const contentLength = Number(c.req.header('content-length'));
    if (Number.isFinite(contentLength) && contentLength > MAX_MEDIA_UPLOAD_REQUEST_BYTES) {
      return c.json({ error: 'Media files must be 20 MB or smaller.' }, 413);
    }
    const rawBody = await readLimitedBody(c.req.raw, MAX_MEDIA_UPLOAD_REQUEST_BYTES);
    if (rawBody === null) {
      return c.json({ error: 'Media files must be 20 MB or smaller.' }, 413);
    }
    let body: Partial<MediaUploadRequest>;
    try {
      body = JSON.parse(rawBody) as Partial<MediaUploadRequest>;
    } catch {
      return c.json({ error: 'Invalid upload request.' }, 400);
    }
    const { dataBase64, mimeType, filename } = body ?? {};
    if (typeof dataBase64 !== 'string' || typeof mimeType !== 'string') {
      return c.json({ error: 'Invalid upload request.' }, 400);
    }
  
    if (!dataBase64 || !mimeType) return c.json({ error: 'Missing dataBase64 or mimeType.' }, 400);
    if (!isSupportedMediaMimeType(mimeType)) return c.json({ error: 'Only image and audio uploads are supported.' }, 400);
    if (dataBase64.length > MAX_MEDIA_UPLOAD_BASE64_LENGTH) {
      return c.json({ error: 'Media files must be 20 MB or smaller.' }, 413);
    }
    if (!isBase64(dataBase64)) return c.json({ error: 'Invalid upload data.' }, 400);
  
    const store = await requireConnectedStore(c);
    const buffer = Buffer.from(dataBase64, 'base64');
  
    if (buffer.byteLength > MAX_MEDIA_UPLOAD_BYTES) {
      return c.json({ error: 'Media files must be 20 MB or smaller.' }, 413);
    }
  
    const fileUploadId = await uploadFileToNotion(
      store,
      { data: buffer, mimeType, filename: sanitizeMediaFilename(filename, mimeType) },
      { notionVersion: c.env.NOTION_VERSION ?? '2026-03-11' },
    );
  
    return c.json({ fileUploadId });
  });
  
  /** Refreshes the signed URL for uploaded Notion media. @param c - Hono context. @returns JSON response. */
  app.post('/media/refresh', async (c) => {
    const parsed = await readLimitedJsonBody<MediaRefreshRequest>(c.req.raw, MAX_CONTROL_JSON_REQUEST_BYTES);
    if (parsed.tooLarge) return c.json({ error: 'Request is too large.' }, 413);
    const body = (parsed.body ?? {}) as Partial<MediaRefreshRequest>;
    const fileUploadId = String(body?.fileUploadId ?? '').trim();
    const requestedBlockId = String(body?.notionBlockId ?? '').trim();
    if (!fileUploadId && !requestedBlockId) {
      return c.json({ error: 'Missing media identity.' }, 400);
    }
  
    const store = await requireConnectedStore(c);
    const notionBlockId =
      (fileUploadId ? findNotionBlockIdByFileUploadId(store, fileUploadId) : null) ??
      findMappedNotionBlockId(store, requestedBlockId);
    if (!notionBlockId) return c.json({ error: 'Media block is not synced yet.' }, 404);
  
    const block = await notionRequest(store, `/blocks/${notionBlockId}`);
    const url = mediaUrlFromNotionBlock(block);
    if (!url) return c.json({ error: 'Unable to refresh this media URL.' }, 404);
  
    return c.json({ url });
  });
}

/** Reads a request body without buffering more than the configured upload limit. */
async function readLimitedBody(request: Request, maxBytes: number): Promise<string | null> {
  if (!request.body) return '';

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

