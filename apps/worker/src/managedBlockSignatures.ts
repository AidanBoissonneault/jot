/** @file Compares Notion block request payloads with their API response shapes. */
import type { NotionBlock, NotionBlockPayload } from './types.js';

/** Builds a stable comparison key from request and response shapes of one block. */
export function managedBlockSignature(block: NotionBlock | NotionBlockPayload): string {
  const type = block.type;
  return JSON.stringify({ type, body: comparableValue(block[type]) });
}

/** Removes response-only rich-text fields while retaining authored block data. */
function comparableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(comparableValue);
  if (!value || typeof value !== 'object') return value;

  const responseOnlyFields = new Set(['href', 'plain_text']);
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key, nested]) => !responseOnlyFields.has(key) && nested !== null && nested !== undefined)
      .sort(([first], [second]) => first.localeCompare(second))
      .map(([key, nested]) => [key, comparableValue(nested)]),
  );
}
