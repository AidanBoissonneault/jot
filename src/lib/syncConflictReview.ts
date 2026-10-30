import type { DocumentContent } from '../types/capture.js';
import type { SyncContentConflict } from '../types/sync.js';
import { normalizeJottathingBlockIds } from '../extensions/jottathingBlockIds.js';
import { isProjectStateMetadataNode } from '../extensions/sourceRegistry.js';

const SYNC_CONFLICT_BLOCK_TYPE = 'jottathingSyncConflict';

export type SyncConflictChoice = 'local' | 'notion' | 'both' | '';

export type SyncConflictRow = {
  id: string;
  base?: DocumentContent;
  local?: DocumentContent;
  notion?: DocumentContent;
  duplicate?: boolean;
  internal?: boolean;
  bothEdited?: boolean;
  changed: boolean;
  choice?: SyncConflictChoice;
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

type ConflictReviewContext = {
  conflict: SyncContentConflict;
  baseById: Map<string, DocumentContent>;
  localChangedIds?: Set<string>;
  remoteChangedIds?: Set<string>;
  hasRemoteContent: boolean;
};

type RemoteBlockIndex = {
  blocks: DocumentContent[];
  indexById: Map<string, number>;
  consumed: Set<number>;
};

function changedFromBase(
  id: string | undefined,
  block: DocumentContent | undefined,
  base: DocumentContent | undefined,
  changedIds: Set<string> | undefined,
): boolean {
  if (id && changedIds) return changedIds.has(id);
  return Boolean(block && base && syncConflictBlockSignature(block) !== syncConflictBlockSignature(base));
}

function createConflictReviewContext(conflict: SyncContentConflict): ConflictReviewContext {
  const baseById = new Map<string, DocumentContent>();
  for (const block of conflict.baseContent?.content ?? []) {
    const id = syncConflictBlockId(block);
    if (id) baseById.set(id, block);
  }
  return {
    conflict,
    baseById,
    localChangedIds: conflict.localChangedBlockIds && new Set(conflict.localChangedBlockIds),
    remoteChangedIds: conflict.remoteChangedBlockIds && new Set(conflict.remoteChangedBlockIds),
    hasRemoteContent: conflict.remoteContent !== null,
  };
}

function indexRemoteBlocks(conflict: SyncContentConflict): RemoteBlockIndex {
  const blocks = conflict.remoteContent?.content ?? [];
  const indexById = new Map<string, number>();
  blocks.forEach((block, index) => {
    const id = syncConflictBlockId(block);
    if (id && !indexById.has(id)) indexById.set(id, index);
  });
  return { blocks, indexById, consumed: new Set() };
}

function isInternalProjectBlock(conflict: SyncContentConflict, block: DocumentContent): boolean {
  return conflict.targetType === 'project' && isProjectStateMetadataNode(block);
}

function localRowChoice(
  internal: boolean,
  bothEdited: boolean,
  localChanged: boolean,
  notionChanged: boolean,
  notionDeleted: boolean,
): SyncConflictChoice {
  if (internal) return notionChanged && !localChanged ? 'notion' : 'local';
  if (bothEdited || (localChanged && notionDeleted)) return '';
  return notionChanged && !localChanged ? 'notion' : 'local';
}

function createLocalConflictRow(
  local: DocumentContent,
  index: number,
  context: ConflictReviewContext,
  remote: RemoteBlockIndex,
): SyncConflictRow {
  const localId = syncConflictBlockId(local);
  const remoteIndex = localId ? remote.indexById.get(localId) : undefined;
  const notion = remoteIndex === undefined ? undefined : remote.blocks[remoteIndex];
  if (remoteIndex !== undefined) remote.consumed.add(remoteIndex);

  const base = localId ? context.baseById.get(localId) : undefined;
  const localChanged = changedFromBase(localId, local, base, context.localChangedIds);
  const notionChanged = changedFromBase(localId, notion, base, context.remoteChangedIds);
  const changed = Boolean(notion && syncConflictBlockSignature(local) !== syncConflictBlockSignature(notion));
  const bothEdited = Boolean(base && localChanged && notionChanged && changed);
  const notionDeleted = Boolean(context.hasRemoteContent && base && !notion);
  const internal = isInternalProjectBlock(context.conflict, local);

  return {
    id: localId ?? `local-${index}`,
    base,
    local,
    notion,
    internal,
    bothEdited,
    choice: localRowChoice(internal, bothEdited, localChanged, notionChanged, notionDeleted),
    changed,
    needsChoice: !internal && (changed
      ? Boolean(base && localChanged && notionChanged)
      : Boolean(context.hasRemoteContent && base && !notion && localChanged)),
    localChanged,
    notionChanged,
    notionDeleted,
  };
}

function findIdenticalLocalRow(
  rows: SyncConflictRow[],
  notion: DocumentContent,
  notionId: string | undefined,
  internal: boolean,
  baseById: Map<string, DocumentContent>,
): SyncConflictRow | undefined {
  const signature = syncConflictBlockSignature(notion);
  return rows.find((row) => {
    if (!row.local || row.notion || row.internal !== internal) return false;
    if (syncConflictBlockSignature(row.local) !== signature) return false;
    if (internal) return true;
    const localId = syncConflictBlockId(row.local);
    return !baseById.has(localId ?? '') && !baseById.has(notionId ?? '');
  });
}

function createRemoteConflictRow(
  notion: DocumentContent,
  index: number,
  context: ConflictReviewContext,
): SyncConflictRow {
  const notionId = syncConflictBlockId(notion);
  const base = notionId ? context.baseById.get(notionId) : undefined;
  const notionChanged = changedFromBase(notionId, notion, base, context.remoteChangedIds);
  const internal = isInternalProjectBlock(context.conflict, notion);
  const localDeleted = Boolean(base && context.conflict.remoteContent);

  return {
    id: notionId ?? `notion-${index}`,
    notion,
    base,
    internal,
    changed: Boolean(base && notionChanged),
    needsChoice: !internal && Boolean(base && notionChanged),
    localDeleted,
    notionChanged,
    choice: internal || !localDeleted || !notionChanged ? 'notion' : '',
  };
}

function addRemoteConflictRows(
  rows: SyncConflictRow[],
  context: ConflictReviewContext,
  remote: RemoteBlockIndex,
): void {
  remote.blocks.forEach((notion, index) => {
    if (remote.consumed.has(index)) return;
    const notionId = syncConflictBlockId(notion);
    const internal = isInternalProjectBlock(context.conflict, notion);
    const notionChanged = changedFromBase(
      notionId,
      notion,
      notionId ? context.baseById.get(notionId) : undefined,
      context.remoteChangedIds,
    );
    const identicalLocal = findIdenticalLocalRow(rows, notion, notionId, internal, context.baseById);
    if (identicalLocal) {
      identicalLocal.notion = notion;
      identicalLocal.notionChanged = notionChanged;
      if (!internal) {
        identicalLocal.duplicate = true;
        identicalLocal.choice = '';
        identicalLocal.needsChoice = true;
      }
      return;
    }
    rows.push(createRemoteConflictRow(notion, index, context));
  });
}

/** Builds ordered review rows and default choices for page and project conflicts. */
export function createSyncConflictRows(conflict: SyncContentConflict): SyncConflictRow[] {
  const context = createConflictReviewContext(conflict);
  const remote = indexRemoteBlocks(conflict);
  const rows = (conflict.localContent.content ?? []).map((local, index) =>
    createLocalConflictRow(local, index, context, remote),
  );
  addRemoteConflictRows(rows, context, remote);
  return rows;
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
  const deleteNotionBlockIds: string[] = [];
  rows.forEach((row) => chosen.push(
    ...resolvedConflictRow(row, choices[row.id], deleteNotionBlockIds),
  ));

  return normalizeJottathingBlockIds({
    type: conflict.localContent.type ?? 'doc',
    attrs: {
      jottathingConflictResolution: true,
      jottathingPreserveRemoteBlocks: Boolean(conflict.remoteContent),
      ...(deleteNotionBlockIds.length ? { jottathingDeleteNotionBlockIds: deleteNotionBlockIds } : {}),
    },
    content: chosen.map((block) => ({
      ...block,
      attrs: { ...block.attrs, jottathingConflictResolution: true },
    })),
  });
}

/** Resolves one row while keeping deletion bookkeeping separate from content. */
function resolvedConflictRow(
  row: SyncConflictRow,
  choice: SyncConflictChoice,
  deleteNotionBlockIds: string[],
): DocumentContent[] {
  if (row.duplicate && row.local && row.notion) {
    return duplicateConflictBlocks(row.local, row.notion, choice);
  }
  if (row.localDeleted) return locallyDeletedConflictBlocks(row, choice, deleteNotionBlockIds);
  if (row.notionDeleted) return remotelyDeletedConflictBlocks(row, choice);
  if (row.local && row.notion && row.changed) {
    return changedConflictBlocks(row.local, row.notion, row.notionChanged, choice);
  }
  const unchanged = row.local ?? row.notion;
  return unchanged ? [unchanged] : [];
}

/** Applies the local, remote, or both choice for duplicate additions. */
function duplicateConflictBlocks(
  local: DocumentContent,
  notion: DocumentContent,
  choice: SyncConflictChoice,
): DocumentContent[] {
  if (choice === 'local') return [markBlock(local, remoteBlockId(notion))];
  if (choice === 'notion') return [markBlock(notion, remoteBlockId(notion))];
  if (choice === 'both') return [markBlock(local), markBlock(notion, remoteBlockId(notion))];
  return [];
}

/** Applies the user's choice to a block deleted locally. */
function locallyDeletedConflictBlocks(
  row: SyncConflictRow,
  choice: SyncConflictChoice,
  deleteNotionBlockIds: string[],
): DocumentContent[] {
  if (choice === 'notion' && row.notion) return [row.notion];
  if (choice === 'local' && row.notion) {
    const notionId = remoteBlockId(row.notion);
    if (notionId) deleteNotionBlockIds.push(notionId);
  }
  return [];
}

/** Keeps a remotely deleted block only when the user selects the local copy. */
function remotelyDeletedConflictBlocks(
  row: SyncConflictRow,
  choice: SyncConflictChoice,
): DocumentContent[] {
  return choice === 'local' && row.local ? [row.local] : [];
}

/** Applies an explicit choice or prefers the side that changed from the base. */
function changedConflictBlocks(
  local: DocumentContent,
  notion: DocumentContent,
  notionChanged: boolean | undefined,
  choice: SyncConflictChoice,
): DocumentContent[] {
  const selected = choice || (notionChanged ? 'notion' : 'local');
  if (selected === 'local') return [markBlock(local, remoteBlockId(notion))];
  if (selected === 'notion') return [markBlock(notion, remoteBlockId(notion))];
  return [];
}

/** Builds a readable token diff, falling back to replacement for large comparisons. */
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

/** Reads a block's stable Jottathing identity for conflict matching. */
export function syncConflictBlockId(block: DocumentContent): string | undefined {
  const value = block.attrs?.jottathingBlockId;
  return typeof value === 'string' && value ? value : undefined;
}

/** Compares block content while ignoring sync identity and volatile upload fields. */
export function syncConflictBlockSignature(block: DocumentContent): string {
  return JSON.stringify(withoutIdentity(block));
}

/** Formats block text and media labels for the conflict review interface. */
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

function withoutIdentity(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutIdentity);
  if (!value || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  const isFileUpload = Boolean(record.notionFileUploadId);
  return Object.fromEntries(Object.entries(record)
    .filter(([key]) => key !== 'jottathingBlockId' && key !== 'notionBlockId' &&
      key !== 'jottathingConflictResolution' && key !== 'jottathingPreserveRemoteBlocks' &&
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
      jottathingConflictResolution: true,
    },
  };
}
