import type { DocumentContent } from '../types/capture.js';
import { stableNotionFileUrl } from './notionFileUrl.js';

/** Builds a stable block signature without sync identities or transient upload state. */
export function syncConflictContentSignature(
  block: DocumentContent,
  omitEmptyAttributes = false,
): string {
  return JSON.stringify(withoutIdentity(block, omitEmptyAttributes));
}

function withoutIdentity(value: unknown, omitEmptyAttributes: boolean): unknown {
  if (Array.isArray(value)) return value.map((entry) => withoutIdentity(entry, omitEmptyAttributes));
  if (!value || typeof value !== 'object') return value;

  const record = value as Record<string, unknown>;
  const isFileUpload = Boolean(record.notionFileUploadId);
  const normalized = Object.fromEntries(Object.entries(record)
    .filter(([key]) => key !== 'jottathingBlockId' && key !== 'notionBlockId' &&
      key !== 'jottathingConflictResolution' && key !== 'jottathingPreserveRemoteBlocks' &&
      key !== 'uploadState' && !(isFileUpload && key === 'src'))
    .sort(([first], [second]) => first.localeCompare(second))
    .map(([key, nested]) => [
      key,
      key === 'src'
        ? typeof nested === 'string'
          ? stableNotionFileUrl(nested)
          : withoutIdentity(nested, omitEmptyAttributes)
        : withoutIdentity(nested, omitEmptyAttributes),
    ]));

  if (omitEmptyAttributes && isEmptyRecord(normalized.attrs)) delete normalized.attrs;
  return normalized;
}

function isEmptyRecord(value: unknown): value is Record<string, never> {
  return value !== null && typeof value === 'object' &&
    !Array.isArray(value) && Object.keys(value).length === 0;
}
