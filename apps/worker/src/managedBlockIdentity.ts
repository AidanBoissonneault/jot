/** @file Builds stable local identities and ordered mappings for managed Notion blocks. */
import type { DocumentContent } from '../../../src/types/capture.js';
import type { BlockMapping, HashValue, NotionBlockPayload } from './types.js';

const INKWELL_BLOCK_ID_ATTR = 'inkwellBlockId';

/** Notion child insertion position used while reconciling an ordered block list. */
export interface BlockPosition {
  after_block?: { id: string };
  type: 'after_block' | 'start';
}

/** Desired local identity, serialized payload, and sync hash for one block. */
export interface DesiredManagedBlock {
  inkwellBlockId: string;
  kind: string;
  lastSyncedHash: string;
  localNodeId: string;
  localPageId: string;
  notionBlock: NotionBlockPayload;
  order: number;
}

/** Inputs needed to pair document nodes with their outbound Notion blocks. */
export interface DesiredManagedBlocksOptions {
  content: DocumentContent;
  hash: HashValue;
  kindFromNotionBlock: (block: Pick<NotionBlockPayload, 'type'>) => string;
  localPageId: string;
  notionBlocks: NotionBlockPayload[];
}

/** Notion block types that preserve identity when updated in place. */
const UPDATEABLE_NOTION_TYPES = new Set([
  'paragraph',
  'quote',
  'code',
  'heading_1',
  'heading_2',
  'heading_3',
]);

/** Pairs outbound Notion payloads with stable local identities and hashes. */
export function desiredManagedBlocks({
  content,
  hash,
  kindFromNotionBlock,
  localPageId,
  notionBlocks,
}: DesiredManagedBlocksOptions): DesiredManagedBlock[] {
  const nodes = content?.content ?? [];

  return notionBlocks.map((notionBlock, index) => {
    const inkwellBlockId = inkwellBlockIdFromNode(nodes[index], index);
    return {
      inkwellBlockId,
      localNodeId: inkwellBlockId,
      localPageId,
      notionBlock,
      kind: kindFromNotionBlock(notionBlock),
      lastSyncedHash: hash(JSON.stringify(notionBlock ?? {})),
      order: index,
    };
  });
}

/** Reads a node's stable Inkwell identifier or derives a positional fallback. */
function inkwellBlockIdFromNode(node: DocumentContent | undefined, index: number): string {
  const value = node?.attrs?.[INKWELL_BLOCK_ID_ATTR];
  return typeof value === 'string' && value ? value : `block-${index}`;
}

/** Converts desired state into a persisted block mapping. */
export function mappingFromDesired(
  entry: DesiredManagedBlock,
  notionBlockId: string | undefined,
  previous: Partial<BlockMapping> = {},
): BlockMapping {
  return {
    localPageId: entry.localPageId,
    inkwellBlockId: entry.inkwellBlockId,
    localNodeId: entry.localNodeId,
    notionBlockId,
    kind: entry.kind,
    order: entry.order,
    lastSyncedHash: entry.lastSyncedHash,
    oldState: previous.newState ?? previous.oldState ?? null,
    newState: entry.notionBlock,
  };
}

/** Indexes persisted mappings by stable local identity. */
export function mappingsByInkwellId(mappings: BlockMapping[]): Map<string, BlockMapping> {
  const result = new Map<string, BlockMapping>();
  for (const mapping of mappings) result.set(mappingKey(mapping), mapping);
  return result;
}

/** Returns the stable local key for a current or legacy mapping. */
export function mappingKey(mapping: BlockMapping): string {
  return mapping.inkwellBlockId ?? mapping.localNodeId;
}

/** Computes the shared mapping identifiers in old and desired order. */
function commonOrderedIds(
  existingMappings: BlockMapping[],
  desiredBlocks: DesiredManagedBlock[],
): { newCommon: string[]; oldCommon: string[] } {
  const desiredIds = new Set(desiredBlocks.map((entry) => entry.inkwellBlockId));
  const existingIds = new Set(existingMappings.map(mappingKey));
  const oldCommon = existingMappings.map(mappingKey).filter((id) => desiredIds.has(id));
  const newCommon = desiredBlocks
    .map((entry) => entry.inkwellBlockId)
    .filter((id) => existingIds.has(id));
  return { oldCommon, newCommon };
}

/** Detects whether shared managed blocks changed relative order. */
export function hasReorderedManagedBlocks(
  existingMappings: BlockMapping[],
  desiredBlocks: DesiredManagedBlock[],
): boolean {
  const { oldCommon, newCommon } = commonOrderedIds(existingMappings, desiredBlocks);
  return oldCommon.length > 1 && oldCommon.join('\n') !== newCommon.join('\n');
}

/** Finds the desired index range affected by a reorder. */
export function reorderedRange(
  existingMappings: BlockMapping[],
  desiredBlocks: DesiredManagedBlock[],
): { end: number; start: number } {
  const { oldCommon, newCommon } = commonOrderedIds(existingMappings, desiredBlocks);
  let first = 0;
  let last = newCommon.length - 1;

  while (first <= last && oldCommon[first] === newCommon[first]) first += 1;
  while (last >= first && oldCommon[last] === newCommon[last]) last -= 1;

  const affectedIds = new Set(newCommon.slice(first, last + 1));
  const indexes = desiredBlocks
    .map((entry, index) => (affectedIds.has(entry.inkwellBlockId) ? index : -1))
    .filter((index) => index >= 0);

  return { start: Math.min(...indexes), end: Math.max(...indexes) };
}

/** Checks whether Notion can update a mapped block in place. */
export function isUpdateCompatible(existing: BlockMapping, entry: DesiredManagedBlock): boolean {
  return existing.kind === entry.kind && UPDATEABLE_NOTION_TYPES.has(entry.notionBlock.type);
}

/** Builds a Notion insertion position after a block or at the start. */
export function positionAfter(blockId: string | undefined): BlockPosition {
  return blockId ? { type: 'after_block', after_block: { id: blockId } } : { type: 'start' };
}

/** Finds the nearest preceding desired block with a remote mapping. */
export function previousMappedBlockId(
  desiredBlocks: DesiredManagedBlock[],
  mappingsById: Map<string, BlockMapping>,
  order: number,
): string | undefined {
  for (let index = order - 1; index >= 0; index -= 1) {
    const mapping = mappingsById.get(desiredBlocks[index]?.inkwellBlockId);
    if (mapping?.notionBlockId) return mapping.notionBlockId;
  }
  return undefined;
}
