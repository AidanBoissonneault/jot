/**
 * @file Provides stateless URL, token, error, Notion block, media, and collection helpers for the API worker.
 * @author Aidan Boissonneault
 * @lastModified September 2026
 */

import { createHash, randomBytes } from 'node:crypto';
import type { Context } from 'hono';
import type { NotionParentPage } from '../../../src/types/capture.js';
import { notionApiHttpFailure } from './notionRequest.js';
import type { JsonObject, NotionBlock, NotionBlockPayload, NotionObject, WorkerEnv, WorkerStore } from './types.js';

export const MAX_SYNC_JSON_REQUEST_BYTES = 16 * 1024 * 1024;
export const MAX_CONTROL_JSON_REQUEST_BYTES = 256 * 1024;

/** Reads and parses JSON while enforcing a limit even when Content-Length is absent. */
export async function readLimitedJsonBody<T>(
  request: Request,
  maxBytes: number,
): Promise<{ body: T | null; tooLarge: boolean }> {
  const contentLength = Number(request.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    return { body: null, tooLarge: true };
  }
  if (!request.body) return { body: null, tooLarge: false };

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return { body: null, tooLarge: true };
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return { body: JSON.parse(new TextDecoder().decode(bytes)) as T, tooLarge: false };
  } catch {
    return { body: null, tooLarge: false };
  }
}

/** Describes a Notion child insertion position. */
export interface BlockPosition {
  after_block?: { id: string };
  type: 'after_block' | 'start';
}

/** Checks whether a request origin is trusted. @param env - Worker bindings. @param origin - Request origin. @returns Trust decision. */
export function isTrustedOrigin(env: WorkerEnv, origin: string | undefined): boolean {
  if (!origin) return false;
  const trusted = [env.WORKER_URL, env.JOTTATHING_EXTENSION_ORIGIN ?? env.INKWELL_EXTENSION_ORIGIN, ...(env.TRUSTED_ORIGINS?.split(',') ?? [])]
    .map((value: string | undefined): string | undefined => value?.trim())
    .filter((value: string | undefined): value is string => Boolean(value))
    .map(originKey)
    .filter((value: string | undefined): value is string => Boolean(value));
  const requestOrigin = originKey(origin);
  return Boolean(requestOrigin && trusted.includes(requestOrigin));
}

/** Normalizes an HTTP or extension origin without allowing arbitrary schemes. */
function originKey(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.username || url.password) return undefined;
    if (url.protocol === 'chrome-extension:' && url.host) {
      return `${url.protocol}//${url.host}`;
    }
    return ['http:', 'https:'].includes(url.protocol) ? url.origin : undefined;
  } catch {
    return undefined;
  }
}

/** Resolves the public worker base URL. @param env - Worker bindings. @returns Worker URL. */
export function serverBaseUrl(env: WorkerEnv): string {
  return env.WORKER_URL ?? 'http://localhost:8787';
}

/** Generates a cryptographically secure URL-safe token. @param byteLength - Random byte count. @returns Token. */
export function randomToken(byteLength = 32): string {
  return randomBytes(byteLength).toString('base64url');
}

/** Hashes a string with SHA-256. @param value - Input text. @returns Hex digest. */
export function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Returns only bounded, non-message error metadata for persistent server logs. */
export function safeErrorMetadata(error: unknown): Record<string, string | number> {
  if (!error || typeof error !== 'object') return { type: typeof error };
  const record = error as { cause?: unknown; code?: unknown; name?: unknown; status?: unknown };
  const cause = record.cause && typeof record.cause === 'object'
    ? record.cause as { code?: unknown; status?: unknown }
    : undefined;
  const result: Record<string, string | number> = {
    type: typeof record.name === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(record.name)
      ? record.name
      : 'Error',
  };
  const status = typeof record.status === 'number' ? record.status : cause?.status;
  const code = typeof record.code === 'string' ? record.code : cause?.code;
  if (typeof status === 'number' && Number.isInteger(status)) {
    result.status = status;
  }
  if (typeof code === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(code)) {
    result.code = code;
  }
  return result;
}

/** Builds a safe client response for a typed Notion API failure. */
export function notionApiErrorResponse(
  context: Context<{ Bindings: WorkerEnv }>,
  error: unknown,
): Response | undefined {
  const failure = notionApiHttpFailure(error);
  if (!failure) return undefined;
  const notionError = error as {
    code?: unknown;
    endpoint?: unknown;
    status?: unknown;
  };
  const endpoint = typeof notionError.endpoint === 'string'
    ? notionError.endpoint
        .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi, ':id')
        .replace(/[0-9a-f]{32}/gi, ':id')
        .slice(0, 160)
    : 'unknown';
  console.error(JSON.stringify({
    event: 'notion_api_request_failed',
    workerRoute: context.req.path,
    endpoint,
    status: notionError.status,
    code: notionError.code,
  }));
  if (failure.retryAfter !== undefined) {
    context.header('Retry-After', String(Math.ceil(failure.retryAfter)));
  }
  return context.json(failure.body, failure.status);
}

/** Detects a missing Notion object error. @param error - Unknown error. @returns Match result. */
export function isNotionObjectNotFound(error: unknown): boolean {
  return numberProperty(error, 'status') === 404 || stringProperty(error, 'code') === 'object_not_found';
}

/** Detects a forbidden Notion object lookup so regular sync can try rediscovery. */
export function isNotionObjectForbidden(error: unknown): boolean {
  return numberProperty(error, 'status') === 403 || stringProperty(error, 'code') === 'restricted_resource';
}

/** Detects a cached page identifier that Notion rejects as an invalid page path. */
export function isNotionPageIdValidationError(error: unknown): boolean {
  const endpoint = stringProperty(error, 'endpoint');
  return numberProperty(error, 'status') === 400 &&
    stringProperty(error, 'code') === 'validation_error' &&
    Boolean(endpoint && /(?:^|\/)pages\/[^/?]+(?:\?.*)?$/.test(endpoint));
}

/** Detects a block/page endpoint mismatch. @param error - Unknown error. @returns Match result. */
export function isBlockNotPageError(error: unknown): boolean {
  return stringProperty(error, 'code') === 'validation_error'
    && /is a block, not a page|retrieve block API/i.test(stringProperty(error, 'message') ?? '');
}

/** Builds the PATCH body for a typed Notion block. @param block - Outbound block. @returns PATCH payload. */
export function updateBodyFromNotionBlock(block: NotionBlockPayload): JsonObject {
  return { [block.type]: block[block.type] ?? {} };
}

/** Advances an insertion position past created blocks. @param position - Previous position. @param createdBlocks - Created blocks. @returns Next position. */
export function positionAfterCreatedBlocks(
  position: BlockPosition | undefined,
  createdBlocks: NotionBlock[],
): BlockPosition | undefined {
  const lastBlock = createdBlocks[createdBlocks.length - 1];
  return lastBlock?.id ? { type: 'after_block', after_block: { id: lastBlock.id } } : position;
}

/** Converts unsupported media to a durable linked paragraph. @param block - Media block. @returns Fallback block. */
export function mediaFallbackBlock(block: NotionBlockPayload): NotionBlockPayload {
  const url = mediaUrlFromNotionBlock(block);
  const isLinkable = Boolean(url && !url.startsWith('data:'));
  return {
    object: 'block',
    type: 'paragraph',
    paragraph: {
      rich_text: isLinkable
        ? [{ type: 'text', text: { content: url, link: { url } } }]
        : [{ type: 'text', text: { content: '[Image - not synced]' } }],
      color: 'default',
    },
  };
}

/** Reads a media URL from a Notion block. @param block - Response or outbound block. @returns Media URL. */
export function mediaUrlFromNotionBlock(block: NotionObject | NotionBlockPayload): string | undefined {
  if (block.type === 'image') return nestedString(block, 'image', 'external', 'url') ?? nestedString(block, 'image', 'file', 'url') ?? nestedString(block, 'image', 'file_upload', 'url');
  if (block.type === 'video') return nestedString(block, 'video', 'external', 'url') ?? nestedString(block, 'video', 'file', 'url');
  if (block.type === 'audio') return nestedString(block, 'audio', 'external', 'url') ?? nestedString(block, 'audio', 'file', 'url');
  if (block.type === 'embed') return nestedString(block, 'embed', 'url');
  if (block.type === 'file') return nestedString(block, 'file', 'external', 'url') ?? nestedString(block, 'file', 'file', 'url');
  return undefined;
}

/** Finds a mapped block for a Notion upload. @param store - Worker state. @param fileUploadId - Upload ID. @returns Block ID. */
export function findNotionBlockIdByFileUploadId(store: WorkerStore, fileUploadId: string): string | undefined {
  for (const mappings of Object.values(store.blockMappings)) {
    for (const mapping of mappings) {
      for (const state of [mapping.newState, mapping.oldState]) {
        const uploadedId = state ? nestedString(state, state.type, 'file_upload', 'id') : undefined;
        if (uploadedId === fileUploadId && mapping.notionBlockId) return mapping.notionBlockId;
      }
    }
  }
  return undefined;
}

/** Confirms a block ID occurs in persisted mappings. @param store - Worker state. @param notionBlockId - Block ID. @returns The ID when mapped. */
export function findMappedNotionBlockId(store: WorkerStore, notionBlockId: string): string | undefined {
  for (const mappings of Object.values(store.blockMappings)) {
    if (mappings.some((mapping) => mapping.notionBlockId === notionBlockId)) return notionBlockId;
  }
  return undefined;
}

/** Extracts plain title text from a page-like object. @param page - Notion page or summary. @returns Page title. */
export function titleFromPage(page: NotionObject | NotionParentPage): string {
  if ('properties' in page) {
    const properties = page.properties;
    const titleProperty = Object.values(properties).find((property: JsonObject) => stringProperty(property, 'type') === 'title');
    const titleItems: unknown = titleProperty?.title;
    if (Array.isArray(titleItems)) {
      const title = titleItems.map((item: unknown): string => stringProperty(item, 'plain_text') ?? '').join('');
      if (title) return title;
    }
  }
  return typeof page.title === 'string' ? page.title : 'Untitled';
}

/** Splits an array into bounded batches. @param values - Values. @param size - Batch size. @returns Batches. */
export function chunks<Value>(values: Value[], size: number): Value[][] {
  const result: Value[][] = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}

/** Validates canonical base64 text. @param value - Candidate text. @returns Validity. */
export function isBase64(value: string): boolean {
  return /^[A-Za-z0-9+/]*={0,2}$/.test(value) && value.length % 4 === 0;
}

/** Checks whether a MIME type is supported media. @param mimeType - MIME type. @returns Support decision. */
const SUPPORTED_MEDIA_MIME_TYPES = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif', 'image/heic',
  'image/svg+xml', 'image/tiff', 'image/vnd.microsoft.icon', 'image/x-icon', 'image/bmp', 'image/apng',
  'audio/mpeg', 'audio/mp3', 'audio/mp4', 'audio/aac', 'audio/wav',
  'audio/x-wav', 'audio/ogg', 'audio/opus', 'audio/webm',
]);

export function isSupportedMediaMimeType(mimeType: string): boolean {
  return SUPPORTED_MEDIA_MIME_TYPES.has(mimeType.trim().toLowerCase());
}

/** Confirms image bytes carry the file signature declared by the upload request. */
export function hasValidImageSignature(data: Uint8Array, mimeType: string): boolean {
  const mime = mimeType.trim().toLowerCase();
  const ascii = (start: number, end: number) =>
    String.fromCharCode(...data.subarray(start, end));
  const startsWith = (...bytes: number[]) =>
    bytes.every((byte, index) => data[index] === byte);

  if (mime === 'image/jpeg') return data.length >= 3 && startsWith(0xff, 0xd8, 0xff);
  if (mime === 'image/png') {
    return data.length >= 8 && startsWith(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
  }
  if (mime === 'image/apng') {
    return hasPngSignature(data) && hasPngAnimationControlChunk(data);
  }
  if (mime === 'image/gif') return data.length >= 6 && ['GIF87a', 'GIF89a'].includes(ascii(0, 6));
  if (mime === 'image/webp') {
    return data.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP';
  }
  if (mime === 'image/avif') return hasIsoBmffBrand(data, ['avif', 'avis']);
  if (mime === 'image/heic') {
    return hasIsoBmffBrand(data, ['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs']);
  }
  if (mime === 'image/bmp') return data.length >= 2 && ascii(0, 2) === 'BM';
  if (mime === 'image/tiff') {
    return data.length >= 4 && (
      ascii(0, 4) === 'II*\u0000' || ascii(0, 4) === 'MM\u0000*' ||
      ascii(0, 4) === 'II+\u0000' || ascii(0, 4) === 'MM\u0000+'
    );
  }
  if (mime === 'image/vnd.microsoft.icon' || mime === 'image/x-icon') {
    return data.length >= 4 && startsWith(0x00, 0x00, 0x01, 0x00);
  }
  if (mime === 'image/svg+xml') {
    return /<svg(?:\s|>)/i.test(new TextDecoder().decode(data.subarray(0, 4096)));
  }
  return false;
}

function hasPngSignature(data: Uint8Array): boolean {
  return data.length >= 8 &&
    data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47 &&
    data[4] === 0x0d && data[5] === 0x0a && data[6] === 0x1a && data[7] === 0x0a;
}

function hasPngAnimationControlChunk(data: Uint8Array): boolean {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let offset = 8;
  const maxOffset = Math.min(data.length, 4096);
  while (offset + 12 <= maxOffset) {
    const chunkLength = view.getUint32(offset);
    const chunkType = String.fromCharCode(...data.subarray(offset + 4, offset + 8));
    if (chunkType === 'acTL') return chunkLength === 8 && offset + 20 <= data.length;
    if (chunkType === 'IDAT' || chunkType === 'IEND') return false;
    const nextOffset = offset + 12 + chunkLength;
    if (!Number.isSafeInteger(nextOffset) || nextOffset <= offset || nextOffset > maxOffset) return false;
    offset = nextOffset;
  }
  return false;
}

function hasIsoBmffBrand(data: Uint8Array, brands: string[]): boolean {
  if (data.length < 16 || String.fromCharCode(...data.subarray(4, 8)) !== 'ftyp') return false;
  const boxLength = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(0);
  const ftypEnd = Math.min(data.length, boxLength >= 16 ? boxLength : 16);
  for (let offset = 8; offset + 4 <= ftypEnd; offset += 4) {
    if (brands.includes(String.fromCharCode(...data.subarray(offset, offset + 4)))) return true;
  }
  return false;
}

/** Produces a safe upload filename with an extension. @param filename - Requested filename. @param mimeType - MIME type. @returns Safe filename. */
export function sanitizeMediaFilename(filename: string | undefined, mimeType: string): string {
  const safeName = String(filename ?? '').trim().replace(/[\\/:"*?<>|]+/g, '-').replace(/\s+/g, ' ').slice(0, 180);
  const mediaKind = mimeType.toLowerCase().startsWith('audio/') ? 'audio' : 'image';
  const extension = mediaExtensionFromMimeType(mimeType);
  const name = safeName || `${mediaKind}.${extension}`;
  return /\.[A-Za-z0-9]+$/.test(name) ? name : `${name}.${extension}`;
}

/** Maps a media MIME type to a safe extension. @param mimeType - MIME type. @returns Extension. */
export function mediaExtensionFromMimeType(mimeType: string): string {
  const extensions: Record<string, string> = {
    'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp',
    'image/svg+xml': 'svg', 'image/avif': 'avif', 'image/heic': 'heic', 'image/tiff': 'tiff',
    'image/vnd.microsoft.icon': 'ico', 'image/x-icon': 'ico', 'image/bmp': 'bmp',
    'image/apng': 'apng', 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3',
    'audio/mp4': 'm4a', 'audio/aac': 'aac', 'audio/wav': 'wav', 'audio/x-wav': 'wav',
    'audio/ogg': 'ogg', 'audio/opus': 'opus', 'audio/webm': 'webm',
  };
  return extensions[mimeType.toLowerCase()] ?? (mimeType.toLowerCase().startsWith('audio/') ? 'mp3' : 'png');
}

/** Converts an unknown value to a string only when already textual. @param value - Unknown value. @returns String value. */
export function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** Reads a nested string from an unknown object. @param value - Unknown root value. @param path - Property path. @returns String value when present. */
function nestedString(value: unknown, ...path: string[]): string | undefined {
  let current: unknown = value;
  for (const key of path) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined;
    current = (current as JsonObject)[key];
  }
  return typeof current === 'string' ? current : undefined;
}

/** Reads a string property from an unknown object. @param value - Unknown object. @param key - Property name. @returns String value when present. */
function stringProperty(value: unknown, key: string): string | undefined {
  return nestedString(value, key);
}

/** Reads a numeric property from an unknown object. @param value - Unknown object. @param key - Property name. @returns Number value when present. */
function numberProperty(value: unknown, key: string): number | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const property: unknown = (value as JsonObject)[key];
  return typeof property === 'number' ? property : undefined;
}
