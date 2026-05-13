import type { DocumentContent, Project, ProjectPage } from '@/src/types/capture';
import { idbGet, idbSet } from '@/src/services/idbStore';

const PENDING_SYNC_OPS_KEY = 'pending_sync_ops';
const SYNC_SEQUENCE_KEY = 'pending_sync_sequence';
const INKWELL_BLOCK_ID_ATTR = 'inkwellBlockId';

export type BlockSyncOpType =
  | 'page_upsert'
  | 'page_archive'
  | 'block_create'
  | 'block_update'
  | 'block_delete'
  | 'block_reorder';

export type BlockSyncOp = {
  opId: string;
  type: BlockSyncOpType;
  pageId: string;
  projectId: string;
  inkwellBlockId?: string;
  sequence: number;
  createdAt: string;
  baseKnownSyncVersion?: number;
  payload: {
    page: ProjectPage;
    project: Project;
    block?: DocumentContent;
    previousBlock?: DocumentContent;
    order?: string[];
    selectedParentPageId?: string;
  };
};

export async function addPendingSyncOps(ops: Omit<BlockSyncOp, 'opId' | 'sequence' | 'createdAt'>[]): Promise<BlockSyncOp[]> {
  if (!ops.length) return [];

  const pending = await listPendingSyncOps();
  let sequence = await nextSequence(ops.length);
  const now = new Date().toISOString();
  const created = ops.map((op) => ({
    ...op,
    opId: crypto.randomUUID(),
    sequence: sequence++,
    createdAt: now,
  }));

  await idbSet(PENDING_SYNC_OPS_KEY, [...pending, ...created]);
  return created;
}

export async function replacePendingSyncOps(ops: BlockSyncOp[]): Promise<void> {
  await idbSet(PENDING_SYNC_OPS_KEY, ops);
}

export async function removePendingSyncOps(opIds: string[]): Promise<void> {
  if (!opIds.length) return;
  const ids = new Set(opIds);
  const ops = await listPendingSyncOps();
  await idbSet(PENDING_SYNC_OPS_KEY, ops.filter((op) => !ids.has(op.opId)));
}

export async function listPendingSyncOps(): Promise<BlockSyncOp[]> {
  return ((await idbGet<BlockSyncOp[]>(PENDING_SYNC_OPS_KEY)) ?? [])
    .slice()
    .sort((first, second) => first.sequence - second.sequence);
}

export function buildPageSyncOps({
  previousPage,
  page,
  project,
  selectedParentPageId,
}: {
  previousPage?: ProjectPage;
  page: ProjectPage;
  project: Project;
  selectedParentPageId?: string;
}): Omit<BlockSyncOp, 'opId' | 'sequence' | 'createdAt'>[] {
  const base = {
    pageId: page.id,
    projectId: project.id,
    baseKnownSyncVersion: page.knownSyncVersion,
    payload: { page, project, selectedParentPageId },
  };

  if (page.status === 'archived') {
    return [{ ...base, type: 'page_archive' }];
  }

  const ops: Omit<BlockSyncOp, 'opId' | 'sequence' | 'createdAt'>[] = [];
  const previousBlocks = blocksById(previousPage?.content);
  const nextBlocks = blocksById(page.content);
  const previousOrder = Array.from(previousBlocks.keys());
  const nextOrder = Array.from(nextBlocks.keys());

  if (!previousPage || pageMetadataChanged(previousPage, page)) {
    ops.push({ ...base, type: 'page_upsert' });
  }

  for (const [inkwellBlockId, block] of nextBlocks) {
    const previousBlock = previousBlocks.get(inkwellBlockId);
    if (!previousBlock) {
      ops.push({
        ...base,
        type: 'block_create',
        inkwellBlockId,
        payload: { ...base.payload, block },
      });
    } else if (stableJson(previousBlock) !== stableJson(block)) {
      ops.push({
        ...base,
        type: 'block_update',
        inkwellBlockId,
        payload: { ...base.payload, block, previousBlock },
      });
    }
  }

  for (const [inkwellBlockId, previousBlock] of previousBlocks) {
    if (!nextBlocks.has(inkwellBlockId)) {
      ops.push({
        ...base,
        type: 'block_delete',
        inkwellBlockId,
        payload: { ...base.payload, previousBlock },
      });
    }
  }

  if (previousOrder.length && nextOrder.length && previousOrder.join('\n') !== nextOrder.join('\n')) {
    ops.push({
      ...base,
      type: 'block_reorder',
      payload: { ...base.payload, order: nextOrder },
    });
  }

  return ops.length ? ops : [{ ...base, type: 'page_upsert' }];
}

export function compactPendingSyncOps(ops: BlockSyncOp[]): BlockSyncOp[] {
  const sorted = ops.slice().sort((first, second) => first.sequence - second.sequence);
  const keep = new Set(sorted.map((op) => op.opId));
  const latestUpdateByBlock = new Map<string, string>();

  for (const op of sorted) {
    const key = opBlockKey(op);

    if (op.type === 'block_update' && key) {
      const previous = latestUpdateByBlock.get(key);
      if (previous) keep.delete(previous);
      latestUpdateByBlock.set(key, op.opId);
      continue;
    }

    if (op.type === 'block_delete' && key) {
      const previous = latestUpdateByBlock.get(key);
      if (previous) {
        keep.delete(previous);
        latestUpdateByBlock.delete(key);
      }
    }
  }

  return sorted.filter((op) => keep.has(op.opId));
}

function blocksById(content: DocumentContent | undefined): Map<string, DocumentContent> {
  const result = new Map<string, DocumentContent>();

  for (const block of content?.content ?? []) {
    const id = blockId(block);
    if (id) result.set(id, block);
  }

  return result;
}

function blockId(block: DocumentContent): string {
  const value = block.attrs?.[INKWELL_BLOCK_ID_ATTR];
  return typeof value === 'string' ? value : '';
}

function opBlockKey(op: BlockSyncOp): string {
  return op.inkwellBlockId ? `${op.pageId}:${op.inkwellBlockId}` : '';
}

function pageMetadataChanged(previousPage: ProjectPage, page: ProjectPage): boolean {
  return previousPage.title !== page.title ||
    previousPage.status !== page.status ||
    previousPage.notionPageId !== page.notionPageId ||
    previousPage.notionParentPageId !== page.notionParentPageId;
}

function stableJson(value: unknown): string {
  return JSON.stringify(value);
}

async function nextSequence(count: number): Promise<number> {
  const current = (await idbGet<number>(SYNC_SEQUENCE_KEY)) ?? 0;
  await idbSet(SYNC_SEQUENCE_KEY, current + count);
  return current + 1;
}
