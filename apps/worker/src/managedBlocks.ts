// @ts-nocheck
const INKWELL_BLOCK_ID_ATTR = 'inkwellBlockId';

async function appendAndTrackBlock(appendManagedBlocks, store, notionPageId, notionBlock, position, createdByOrder, order) {
  const [createdBlock] = await appendManagedBlocks(store, notionPageId, [notionBlock], position);
  createdByOrder[order] = createdBlock;
  return createdBlock;
}
const UPDATEABLE_NOTION_TYPES = new Set([
  'paragraph',
  'quote',
  'code',
  'heading_1',
  'heading_2',
  'heading_3',
]);

export async function replaceManagedBlocks({
  store,
  localPageId,
  notionPageId,
  content,
  listAllBlockChildren,
  deleteManagedBlock,
  appendManagedBlocks,
  updateManagedBlock,
  tiptapDocumentToNotionBlocks,
  kindFromNotionBlock,
  hash,
}) {
  const notionBlocks = tiptapDocumentToNotionBlocks(content);
  const desiredBlocks = desiredManagedBlocks({
    content,
    hash,
    kindFromNotionBlock,
    localPageId,
    notionBlocks,
  });
  const existingMappings = store.blockMappings[localPageId] ?? [];

  if (!existingMappings.length) {
    return replaceAllManagedBlocks({
      appendManagedBlocks,
      deleteManagedBlock,
      desiredBlocks,
      listAllBlockChildren,
      localPageId,
      notionBlocks,
      notionPageId,
      store,
    });
  }

  if (hasReorderedManagedBlocks(existingMappings, desiredBlocks)) {
    return rebuildReorderedRange({
      appendManagedBlocks,
      deleteManagedBlock,
      desiredBlocks,
      existingMappings,
      localPageId,
      notionBlocks,
      notionPageId,
      store,
    });
  }

  return reconcileManagedBlocks({
    appendManagedBlocks,
    deleteManagedBlock,
    desiredBlocks,
    existingMappings,
    localPageId,
    notionBlocks,
    notionPageId,
    store,
    updateManagedBlock,
  });
}

async function replaceAllManagedBlocks({
  appendManagedBlocks,
  deleteManagedBlock,
  desiredBlocks,
  listAllBlockChildren,
  localPageId,
  notionBlocks,
  notionPageId,
  store,
}) {
  const existingBlocks = await listAllBlockChildren(store, notionPageId);

  for (const block of existingBlocks) {
    await deleteManagedBlock(store, block.id);
  }

  const createdBlocks = await appendManagedBlocks(store, notionPageId, notionBlocks);
  const createdByOrder = [];

  store.blockMappings[localPageId] = desiredBlocks.map((entry, index) => {
    const createdBlock = createdBlocks[index];
    createdByOrder[index] = createdBlock;
    return mappingFromDesired(entry, createdBlock?.id);
  }).filter((mapping) => mapping.notionBlockId);

  return {
    createdBlocks: createdByOrder,
    notionBlocks,
  };
}

export async function applyManagedBlockOps({
  store,
  localPageId,
  notionPageId,
  ops,
  content,
  appendManagedBlocks,
  deleteManagedBlock,
  updateManagedBlock,
  replaceManagedBlocks,
  tiptapDocumentToNotionBlocks,
  kindFromNotionBlock,
  hash,
}) {
  if (ops.some((op) => op.type === 'block_reorder')) {
    return replaceManagedBlocks(store, localPageId, notionPageId, content);
  }

  const notionBlocks = tiptapDocumentToNotionBlocks(content);
  const desiredBlocks = desiredManagedBlocks({
    content,
    hash,
    kindFromNotionBlock,
    localPageId,
    notionBlocks,
  });
  const desiredById = new Map(desiredBlocks.map((entry) => [entry.inkwellBlockId, entry]));
  const existingMappings = store.blockMappings[localPageId] ?? [];
  const existingById = mappingsByInkwellId(existingMappings);
  const nextById = new Map(existingMappings.map((mapping) => [mappingKey(mapping), mapping]));
  const createdByOrder = [];

  for (const op of ops) {
    const inkwellBlockId = op.inkwellBlockId;
    if (!inkwellBlockId) continue;

    if (op.type === 'block_delete') {
      const existing = nextById.get(inkwellBlockId);
      if (existing?.notionBlockId) {
        await deleteManagedBlock(store, existing.notionBlockId);
      }
      nextById.delete(inkwellBlockId);
      continue;
    }

    if (op.type !== 'block_create' && op.type !== 'block_update') {
      continue;
    }

    const desired = desiredById.get(inkwellBlockId);
    if (!desired) continue;

    const existing = nextById.get(inkwellBlockId) ?? existingById.get(inkwellBlockId);
    if (!existing?.notionBlockId) {
      const createdBlock = await appendAndTrackBlock(appendManagedBlocks, store, notionPageId, desired.notionBlock, positionAfter(previousMappedBlockId(desiredBlocks, nextById, desired.order)), createdByOrder, desired.order);
      nextById.set(inkwellBlockId, mappingFromDesired(desired, createdBlock?.id));
      continue;
    }

    if (existing.lastSyncedHash === desired.lastSyncedHash) {
      nextById.set(inkwellBlockId, mappingFromDesired(desired, existing.notionBlockId, existing));
      continue;
    }

    if (isUpdateCompatible(existing, desired)) {
      await updateManagedBlock(store, existing.notionBlockId, desired.notionBlock);
      nextById.set(inkwellBlockId, mappingFromDesired(desired, existing.notionBlockId, existing));
      continue;
    }

    await deleteManagedBlock(store, existing.notionBlockId);
    const createdBlock = await appendAndTrackBlock(appendManagedBlocks, store, notionPageId, desired.notionBlock, positionAfter(previousMappedBlockId(desiredBlocks, nextById, desired.order)), createdByOrder, desired.order);
    nextById.set(inkwellBlockId, mappingFromDesired(desired, createdBlock?.id, existing));
  }

  store.blockMappings[localPageId] = desiredBlocks
    .map((entry) => nextById.get(entry.inkwellBlockId))
    .filter((mapping) => mapping?.notionBlockId);

  return {
    createdBlocks: createdByOrder,
    notionBlocks,
  };
}

async function reconcileManagedBlocks({
  appendManagedBlocks,
  deleteManagedBlock,
  desiredBlocks,
  existingMappings,
  localPageId,
  notionBlocks,
  notionPageId,
  store,
  updateManagedBlock,
}) {
  const existingByInkwellId = mappingsByInkwellId(existingMappings);
  const desiredIds = new Set(desiredBlocks.map((entry) => entry.inkwellBlockId));
  const nextMappings = [];
  const createdByOrder = [];
  let previousNotionBlockId;

  for (const entry of desiredBlocks) {
    const existing = existingByInkwellId.get(entry.inkwellBlockId);

    if (!existing?.notionBlockId) {
      const createdBlock = await appendAndTrackBlock(appendManagedBlocks, store, notionPageId, entry.notionBlock, positionAfter(previousNotionBlockId), createdByOrder, entry.order);
      nextMappings.push(mappingFromDesired(entry, createdBlock?.id));
      previousNotionBlockId = createdBlock?.id ?? previousNotionBlockId;
      continue;
    }

    if (existing.lastSyncedHash === entry.lastSyncedHash) {
      nextMappings.push(mappingFromDesired(entry, existing.notionBlockId, existing));
      previousNotionBlockId = existing.notionBlockId;
      continue;
    }

    if (isUpdateCompatible(existing, entry)) {
      await updateManagedBlock(store, existing.notionBlockId, entry.notionBlock);
      nextMappings.push(mappingFromDesired(entry, existing.notionBlockId, existing));
      previousNotionBlockId = existing.notionBlockId;
      continue;
    }

    await deleteManagedBlock(store, existing.notionBlockId);
    const createdBlock = await appendAndTrackBlock(appendManagedBlocks, store, notionPageId, entry.notionBlock, positionAfter(previousNotionBlockId), createdByOrder, entry.order);
    nextMappings.push(mappingFromDesired(entry, createdBlock?.id, existing));
    previousNotionBlockId = createdBlock?.id ?? previousNotionBlockId;
  }

  for (const mapping of existingMappings) {
    if (!desiredIds.has(mappingKey(mapping)) && mapping.notionBlockId) {
      await deleteManagedBlock(store, mapping.notionBlockId);
    }
  }

  store.blockMappings[localPageId] = nextMappings.filter((mapping) => mapping.notionBlockId);

  return {
    createdBlocks: createdByOrder,
    notionBlocks,
  };
}

async function rebuildReorderedRange({
  appendManagedBlocks,
  deleteManagedBlock,
  desiredBlocks,
  existingMappings,
  localPageId,
  notionBlocks,
  notionPageId,
  store,
}) {
  const range = reorderedRange(existingMappings, desiredBlocks);
  const existingByInkwellId = mappingsByInkwellId(existingMappings);
  const affectedDesired = desiredBlocks.slice(range.start, range.end + 1);
  const affectedIds = new Set(affectedDesired.map((entry) => entry.inkwellBlockId));
  const oldAffectedOrders = existingMappings
    .filter((mapping) => affectedIds.has(mappingKey(mapping)))
    .map((mapping) => mapping.order ?? Number.MAX_SAFE_INTEGER);
  const minOldOrder = Math.min(...oldAffectedOrders);
  const maxOldOrder = Math.max(...oldAffectedOrders);
  const mappingsToDelete = existingMappings.filter((mapping) => {
    const key = mappingKey(mapping);
    const order = mapping.order ?? Number.MAX_SAFE_INTEGER;
    return affectedIds.has(key) || (order >= minOldOrder && order <= maxOldOrder);
  });
  const previousMapping = desiredBlocks
    .slice(0, range.start)
    .reverse()
    .map((entry) => existingByInkwellId.get(entry.inkwellBlockId))
    .find((mapping) => mapping?.notionBlockId);
  const createdByOrder = [];

  for (const mapping of mappingsToDelete) {
    if (mapping.notionBlockId) {
      await deleteManagedBlock(store, mapping.notionBlockId);
    }
  }

  const createdBlocks = await appendManagedBlocks(
    store,
    notionPageId,
    affectedDesired.map((entry) => entry.notionBlock),
    positionAfter(previousMapping?.notionBlockId),
  );
  const rebuiltMappings = new Map();

  affectedDesired.forEach((entry, index) => {
    const createdBlock = createdBlocks[index];
    createdByOrder[entry.order] = createdBlock;
    rebuiltMappings.set(entry.inkwellBlockId, mappingFromDesired(entry, createdBlock?.id));
  });

  store.blockMappings[localPageId] = desiredBlocks
    .map((entry) => {
      const rebuilt = rebuiltMappings.get(entry.inkwellBlockId);
      if (rebuilt) return rebuilt;
      return mappingFromDesired(entry, existingByInkwellId.get(entry.inkwellBlockId)?.notionBlockId, existingByInkwellId.get(entry.inkwellBlockId));
    })
    .filter((mapping) => mapping.notionBlockId);

  return {
    createdBlocks: createdByOrder,
    notionBlocks,
  };
}

function desiredManagedBlocks({
  content,
  hash,
  kindFromNotionBlock,
  localPageId,
  notionBlocks,
}) {
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

function inkwellBlockIdFromNode(node, index) {
  const value = node?.attrs?.[INKWELL_BLOCK_ID_ATTR];
  return typeof value === 'string' && value ? value : `block-${index}`;
}

function mappingFromDesired(entry, notionBlockId, previous = {}) {
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

function mappingsByInkwellId(mappings) {
  const result = new Map();

  for (const mapping of mappings) {
    result.set(mappingKey(mapping), mapping);
  }

  return result;
}

function mappingKey(mapping) {
  return mapping.inkwellBlockId ?? mapping.localNodeId;
}

function commonOrderedIds(existingMappings, desiredBlocks) {
  const desiredIds = new Set(desiredBlocks.map((entry) => entry.inkwellBlockId));
  const existingIds = new Set(existingMappings.map(mappingKey));
  const oldCommon = existingMappings.map(mappingKey).filter((id) => desiredIds.has(id));
  const newCommon = desiredBlocks.map((entry) => entry.inkwellBlockId).filter((id) => existingIds.has(id));
  return { oldCommon, newCommon };
}

function hasReorderedManagedBlocks(existingMappings, desiredBlocks) {
  const { oldCommon, newCommon } = commonOrderedIds(existingMappings, desiredBlocks);
  return oldCommon.length > 1 && oldCommon.join('\n') !== newCommon.join('\n');
}

function reorderedRange(existingMappings, desiredBlocks) {
  const { oldCommon, newCommon } = commonOrderedIds(existingMappings, desiredBlocks);
  let first = 0;
  let last = newCommon.length - 1;

  while (first <= last && oldCommon[first] === newCommon[first]) {
    first += 1;
  }

  while (last >= first && oldCommon[last] === newCommon[last]) {
    last -= 1;
  }

  const affectedIds = new Set(newCommon.slice(first, last + 1));
  const indexes = desiredBlocks
    .map((entry, index) => affectedIds.has(entry.inkwellBlockId) ? index : -1)
    .filter((index) => index >= 0);

  return {
    start: Math.min(...indexes),
    end: Math.max(...indexes),
  };
}

function isUpdateCompatible(existing, entry) {
  return existing.kind === entry.kind && UPDATEABLE_NOTION_TYPES.has(entry.notionBlock.type);
}

function positionAfter(blockId) {
  return blockId
    ? {
        type: 'after_block',
        after_block: { id: blockId },
      }
    : { type: 'start' };
}

function previousMappedBlockId(desiredBlocks, mappingsById, order) {
  for (let index = order - 1; index >= 0; index -= 1) {
    const mapping = mappingsById.get(desiredBlocks[index]?.inkwellBlockId);
    if (mapping?.notionBlockId) {
      return mapping.notionBlockId;
    }
  }

  return undefined;
}
