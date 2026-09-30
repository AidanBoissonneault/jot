/** @file Compares Notion block request payloads with their API response shapes. */
import type { NotionBlock, NotionBlockPayload } from './types.js';

/** Builds a stable comparison key from request and response shapes of one block. */
export function managedBlockSignature(block: NotionBlock | NotionBlockPayload): string {
  const type = block.type;
  if (type === 'image' || type === 'audio') {
    const body = objectProperty(block[type]);
    const url = nestedString(objectProperty(body?.external)?.url) ??
      nestedString(objectProperty(body?.file)?.url);
    if (url) return JSON.stringify({ type, mediaUrl: stableNotionFileUrl(url) });
    const uploadId = nestedString(objectProperty(body?.file_upload)?.id);
    if (uploadId) return JSON.stringify({ type, uploadId });
  }
  return JSON.stringify({ type, body: comparableValue(block[type]) });
}

function objectProperty(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function nestedString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** Removes response-only rich-text fields while retaining authored block data. */
function comparableValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(comparableValue).filter((nested) => !isEmptyText(nested));
  }
  if (!value || typeof value !== 'object') return value;

  const responseOnlyFields = new Set(['expiry_time', 'href', 'plain_text']);
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key, nested]) =>
        !responseOnlyFields.has(key) &&
        nested !== null &&
        nested !== undefined &&
        !(key === 'color' && nested === 'default') &&
        !(key === 'caption' && Array.isArray(nested) && nested.length === 0) &&
        !(key === 'annotations' && isDefaultAnnotations(nested)),
      )
      .sort(([first], [second]) => first.localeCompare(second))
      .map(([key, nested]) => [
        key,
        key === 'url' ? stableNotionFileUrl(nested) : comparableValue(nested),
      ]),
  );
}

/** Treats a zero-width plain-text segment like Notion's empty rich_text array. */
function isEmptyText(value: unknown): boolean {
  const item = objectProperty(value);
  if (item?.type !== 'text') return false;
  const text = objectProperty(item.text);
  return text?.content === '' &&
    Object.keys(item).every((key) => key === 'type' || key === 'text') &&
    Object.keys(text).every((key) => key === 'content');
}

/** Treats Notion's default annotations like omitted annotations in an append payload. */
function isDefaultAnnotations(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const annotations = value as Record<string, unknown>;
  return Object.values(annotations).every((annotation) =>
    annotation === false || annotation === 'default',
  );
}

/** Ignores rotating credentials in Notion-hosted, time-limited media URLs. */
function stableNotionFileUrl(value: unknown): unknown {
  if (typeof value !== 'string') return comparableValue(value);
  try {
    const url = new URL(value);
    if (
      url.searchParams.has('X-Amz-Signature') ||
      url.hostname.startsWith('prod-files-secure.s3.')
    ) {
      return `${url.origin}${url.pathname}`;
    }
  } catch {
    // Retain malformed or non-URL values exactly for the normal comparison.
  }
  return comparableValue(value);
}
