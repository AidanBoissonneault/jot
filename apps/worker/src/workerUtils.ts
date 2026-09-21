/**
 * @file Provides stateless URL, token, error, Notion block, media, and collection helpers for the API worker.
 * @author Aidan Boissonneault
 * @lastModified September 2026
 */

import { createHash, randomBytes } from 'node:crypto';
import type { NotionParentPage } from '../../../src/types/capture.js';
import type { JsonObject, NotionBlock, NotionBlockPayload, NotionObject, WorkerEnv, WorkerStore } from './types.js';

/** Describes a Notion child insertion position. */
export interface BlockPosition {
  after_block?: { id: string };
  type: 'after_block' | 'start';
}

/** Checks whether a request origin is trusted. @param env - Worker bindings. @param origin - Request origin. @returns Trust decision. */
export function isTrustedOrigin(env: WorkerEnv, origin: string | undefined): boolean {
  if (!origin || origin.startsWith('chrome-extension://')) return true;
  const trusted = [env.WORKER_URL, env.INKWELL_EXTENSION_ORIGIN, ...(env.TRUSTED_ORIGINS?.split(',') ?? [])]
    .map((value: string | undefined): string | undefined => value?.trim())
    .filter((value: string | undefined): value is string => Boolean(value));
  return trusted.includes(origin);
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

/** Detects a missing Notion object error. @param error - Unknown error. @returns Match result. */
export function isNotionObjectNotFound(error: unknown): boolean {
  return numberProperty(error, 'status') === 404 || stringProperty(error, 'code') === 'object_not_found';
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
export function isSupportedMediaMimeType(mimeType: string): boolean {
  const normalized = mimeType.toLowerCase();
  return normalized.startsWith('image/') || normalized.startsWith('audio/');
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
    'image/svg+xml': 'svg', 'image/avif': 'avif', 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3',
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
