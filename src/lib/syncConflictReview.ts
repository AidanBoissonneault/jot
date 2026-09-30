import type { DocumentContent } from '../types/capture.js';
import type { SyncContentConflict } from '../types/sync.js';
import { normalizeInkwellBlockIds } from '../extensions/inkwellBlockIds.js';

export const SYNC_CONFLICT_BLOCK_TYPE = 'inkwellSyncConflict';

export type SyncConflictChoice = 'local' | 'notion' | 'both' | '';

export type SyncConflictRow = {
  id: string;
  base?: DocumentContent;
  local?: DocumentContent;
  notion?: DocumentContent;
  duplicate?: boolean;
  changed: boolean;
  needsChoice?: boolean;
  localDeleted?: boolean;
  notionDeleted?: boolean;
  localChanged?: boolean;
  notionChanged?: boolean;
};

export type SyncConflictDiffPart = {
  kind: 'added' | 'context' | 'removed';
  text: string;
};

/** Adds transient review nodes for conflicts that belong to this page. */
export function contentWithSyncConflictBlocks(
  content: DocumentContent,
  pageId: string,
  conflicts: SyncContentConflict[] | undefined,
): DocumentContent {
  const pageConflicts = (conflicts ?? []).filter((conflict) =>
    conflict.targetType === 'page' && conflict.targetId === pageId,
  );
  const cleanContent = stripSyncConflictBlocks(content);
  if (!pageConflicts.length) return cleanContent;

  return {
    ...cleanContent,
    type: cleanContent.type ?? 'doc',
    content: [
      ...pageConflicts.map((conflict) => ({
        type: SYNC_CONFLICT_BLOCK_TYPE,
        attrs: { conflict, choices: {} },
      })),
      ...(cleanContent.content ?? []),
    ],
  };
}

/** Removes editor-only conflict blocks before page snapshots are saved or synced. */
export function stripSyncConflictBlocks(content: DocumentContent): DocumentContent {
  return {
    ...content,
    ...(content.content
      ? { content: content.content
          .filter((node) => node.type !== SYNC_CONFLICT_BLOCK_TYPE)
          .map(stripSyncConflictBlocks) }
      : {}),
  };
}

export function isSyncConflictBlock(node: DocumentContent): boolean {
  return node.type === SYNC_CONFLICT_BLOCK_TYPE;
}

export function createSyncConflictRows(conflict: SyncContentConflict): SyncConflictRow[] {
  const localBlocks = conflict.localContent.content ?? [];
  const notionBlocks = conflict.remoteContent?.content ?? [];
  const hasRemoteContent = conflict.remoteContent !== null;
  const localChangedIds = conflict.localChangedBlockIds
    ? new Set(conflict.localChangedBlockIds)
    : undefined;
  const remoteChangedIds = conflict.remoteChangedBlockIds
    ? new Set(conflict.remoteChangedBlockIds)
    : undefined;
  const baseById = new Map((conflict.baseContent?.content ?? [])
    .map((block) => [stableBlockId(block), block] as const)
    .filter((entry): entry is readonly [string, DocumentContent] => Boolean(entry[0])));
  const notionIndexById = new Map<string, number>();
  notionBlocks.forEach((block, index) => {
    const id = stableBlockId(block);
    if (id && !notionIndexById.has(id)) notionIndexById.set(id, index);
  });
  const consumedNotion = new Set<number>();
  const result: SyncConflictRow[] = localBlocks.map((local, index) => {
    const localId = stableBlockId(local);
    const notionIndex = localId ? notionIndexById.get(localId) : undefined;
    const notion = notionIndex === undefined ? undefined : notionBlocks[notionIndex];
    if (notionIndex !== undefined) consumedNotion.add(notionIndex);
    const base = localId ? baseById.get(localId) : undefined;
    const localChanged = localId && localChangedIds
      ? localChangedIds.has(localId)
      : Boolean(base && signature(local) !== signature(base));
    const notionChanged = localId && remoteChangedIds
      ? remoteChangedIds.has(localId)
      : Boolean(base && notion && signature(notion) !== signature(base));
    const changed = Boolean(notion && signature(local) !== signature(notion));

    return {
      id: localId ?? `local-${index}`,
      base,
      local,
      notion,
      changed,
      needsChoice: changed
        ? !base || Boolean(localChanged && notionChanged)
        : Boolean(hasRemoteContent && base && !notion && localChanged),
      localChanged,
      notionChanged,
      notionDeleted: Boolean(hasRemoteContent && base && !notion),
    };
  });

  notionBlocks.forEach((notion, index) => {
    if (consumedNotion.has(index)) return;
    const notionId = stableBlockId(notion);
    const base = notionId ? baseById.get(notionId) : undefined;
    const notionChanged = notionId && remoteChangedIds
      ? remoteChangedIds.has(notionId)
      : Boolean(base && signature(notion) !== signature(base));
    const identicalLocal = result.find((row) =>
      row.local && !row.notion && signature(row.local) === signature(notion) &&
      !baseById.has(stableBlockId(row.local) ?? '') && !baseById.has(notionId ?? ''),
    );
    if (identicalLocal) {
      identicalLocal.notion = notion;
      identicalLocal.duplicate = true;
      identicalLocal.needsChoice = true;
      return;
    }

    result.push({
      id: notionId ?? `notion-${index}`,
      notion,
      base,
      changed: Boolean(base && notionChanged),
      needsChoice: Boolean(base && notionChanged),
      localDeleted: Boolean(base),
      notionChanged,
    });
  });
  return result;
}

export function hasUnresolvedSyncConflictRows(
  rows: SyncConflictRow[],
  choices: Record<string, SyncConflictChoice>,
): boolean {
  return rows.some((row) => row.needsChoice && !choices[row.id]);
}

export function buildSyncConflictMerge(
  conflict: SyncContentConflict,
  rows: SyncConflictRow[],
  choices: Record<string, SyncConflictChoice>,
): DocumentContent {
  const chosen: DocumentContent[] = [];
  for (const row of rows) {
    const choice = choices[row.id];
    if (row.duplicate && row.local && row.notion) {
      if (choice === 'local') chosen.push(markBlock(row.local, remoteBlockId(row.notion)));
      else if (choice === 'both') chosen.push(markBlock(row.local));
      if (choice === 'notion' || choice === 'both') {
        chosen.push(markBlock(row.notion, remoteBlockId(row.notion)));
      }
      continue;
    }
    if (row.localDeleted) {
      if (choice === 'notion' && row.notion) chosen.push(row.notion);
      continue;
    }
    if (row.notionDeleted) {
      if (choice === 'local' && row.local) chosen.push(row.local);
      continue;
    }
    if (row.local && row.notion && row.changed) {
      const selected = choice || (row.notionChanged ? 'notion' : 'local');
      if (selected === 'local') chosen.push(markBlock(row.local, remoteBlockId(row.notion)));
      else if (selected === 'notion') chosen.push(markBlock(row.notion, remoteBlockId(row.notion)));
      continue;
    }
    if (row.local) chosen.push(row.local);
    else if (row.notion) chosen.push(row.notion);
  }

  return normalizeInkwellBlockIds({
    type: conflict.localContent.type ?? 'doc',
    attrs: {
      inkwellConflictResolution: true,
      inkwellPreserveRemoteBlocks: Boolean(conflict.remoteContent),
    },
    content: chosen.map((block) => ({
      ...block,
      attrs: { ...block.attrs, inkwellConflictResolution: true },
    })),
  });
}

export function syncConflictDiffParts(
  local?: DocumentContent,
  notion?: DocumentContent,
): SyncConflictDiffPart[] {
  const before = displayBlock(local);
  const after = displayBlock(notion);
  if (before === after) return [{ kind: 'context', text: before }];

  const left = before.match(/\s+|[^\s]+/g) ?? [];
  const right = after.match(/\s+|[^\s]+/g) ?? [];
  if (left.length * right.length > 160_000) {
    return [{ kind: 'removed', text: before }, { kind: 'added', text: after }];
  }

  const width = right.length + 1;
  const table = new Uint32Array((left.length + 1) * width);
  for (let row = left.length - 1; row >= 0; row -= 1) {
    for (let column = right.length - 1; column >= 0; column -= 1) {
      const cell = row * width + column;
      table[cell] = left[row] === right[column]
        ? table[(row + 1) * width + column + 1] + 1
        : Math.max(table[(row + 1) * width + column], table[row * width + column + 1]);
    }
  }

  const operations: SyncConflictDiffPart[] = [];
  let row = 0;
  let column = 0;
  while (row < left.length || column < right.length) {
    let kind: SyncConflictDiffPart['kind'];
    let text: string;
    if (row < left.length && column < right.length && left[row] === right[column]) {
      kind = 'context';
      text = left[row++];
      column += 1;
    } else if (
      row < left.length &&
      (column >= right.length || table[(row + 1) * width + column] >= table[row * width + column + 1])
    ) {
      kind = 'removed';
      text = left[row++];
    } else {
      kind = 'added';
      text = right[column++];
    }
    const previous = operations.at(-1);
    if (previous?.kind === kind) previous.text += text;
    else operations.push({ kind, text });
  }
  return operations;
}

export function syncConflictBlockText(block?: DocumentContent): string {
  return displayBlock(block);
}

function displayBlock(block?: DocumentContent): string {
  if (!block) return 'Block deleted';
  const type = block.type ?? 'Block';
  if (type === 'image' || type === 'audio' || type === 'youtube') {
    const src = String(block.attrs?.src ?? block.attrs?.url ?? '');
    if (type !== 'youtube' && src) {
      try {
        const url = new URL(src);
        const path = decodeURIComponent(url.pathname.split('/').slice(-2).join('/'));
        return `${type}: ${path || 'Notion media'}`;
      } catch {
        return `${type}: Notion media`;
      }
    }
    return `${type}: ${src || 'media'}`;
  }
  const text = textFrom(block).trim();
  return text || (type === 'horizontalRule' ? 'Divider' : type);
}

function textFrom(block: DocumentContent): string {
  return (block.text ?? '') + (block.content ?? []).map(textFrom).join('');
}

function stableBlockId(block: DocumentContent): string | undefined {
  const value = block.attrs?.inkwellBlockId;
  return typeof value === 'string' && value ? value : undefined;
}

function signature(block: DocumentContent): string {
  return JSON.stringify(withoutIdentity(block));
}

function withoutIdentity(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutIdentity);
  if (!value || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  const isFileUpload = Boolean(record.notionFileUploadId);
  return Object.fromEntries(Object.entries(record)
    .filter(([key]) => key !== 'inkwellBlockId' && key !== 'notionBlockId' &&
      key !== 'inkwellConflictResolution' && key !== 'inkwellPreserveRemoteBlocks' &&
      key !== 'uploadState' && !(isFileUpload && key === 'src'))
    .sort(([first], [second]) => first.localeCompare(second))
    .map(([key, nested]) => [key, key === 'src' ? stableMediaUrl(nested) : withoutIdentity(nested)]));
}

function stableMediaUrl(value: unknown): unknown {
  if (typeof value !== 'string') return withoutIdentity(value);
  try {
    const url = new URL(value);
    if (url.searchParams.has('X-Amz-Signature') || url.hostname.startsWith('prod-files-secure.s3.')) {
      return `${url.origin}${url.pathname}`;
    }
  } catch {
    // Keep non-URL media values exact.
  }
  return value;
}

function remoteBlockId(block: DocumentContent): string | undefined {
  const id = block.attrs?.notionBlockId;
  return typeof id === 'string' && id ? id : undefined;
}

function markBlock(block: DocumentContent, notionBlockId?: string): DocumentContent {
  return {
    ...block,
    attrs: {
      ...block.attrs,
      ...(notionBlockId ? { notionBlockId } : {}),
      inkwellConflictResolution: true,
    },
  };
}
