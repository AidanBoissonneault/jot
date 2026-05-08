const JOT_BLOCK_ID_ATTR = 'jotBlockId';
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
  const existingByJotId = mappingsByJotId(existingMappings);
  const desiredIds = new Set(desiredBlocks.map((entry) => entry.jotBlockId));
  const nextMappings = [];
  const createdByOrder = [];
  let previousNotionBlockId;

  for (const entry of desiredBlocks) {
    const existing = existingByJotId.get(entry.jotBlockId);

    if (!existing?.notionBlockId) {
      const [createdBlock] = await appendManagedBlocks(
        store,
        notionPageId,
        [entry.notionBlock],
        positionAfter(previousNotionBlockId),
      );
      createdByOrder[entry.order] = createdBlock;
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
    const [createdBlock] = await appendManagedBlocks(
      store,
      notionPageId,
      [entry.notionBlock],
      positionAfter(previousNotionBlockId),
    );
    createdByOrder[entry.order] = createdBlock;
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
  const existingByJotId = mappingsByJotId(existingMappings);
  const affectedDesired = desiredBlocks.slice(range.start, range.end + 1);
  const affectedIds = new Set(affectedDesired.map((entry) => entry.jotBlockId));
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
    .map((entry) => existingByJotId.get(entry.jotBlockId))
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
    rebuiltMappings.set(entry.jotBlockId, mappingFromDesired(entry, createdBlock?.id));
  });

  store.blockMappings[localPageId] = desiredBlocks
    .map((entry) => {
      const rebuilt = rebuiltMappings.get(entry.jotBlockId);
      if (rebuilt) return rebuilt;
      return mappingFromDesired(entry, existingByJotId.get(entry.jotBlockId)?.notionBlockId, existingByJotId.get(entry.jotBlockId));
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
    const jotBlockId = jotBlockIdFromNode(nodes[index], index);
    return {
      jotBlockId,
      localNodeId: jotBlockId,
      localPageId,
      notionBlock,
      kind: kindFromNotionBlock(notionBlock),
      lastSyncedHash: hash(JSON.stringify(notionBlock ?? {})),
      order: index,
    };
  });
}

function jotBlockIdFromNode(node, index) {
  const value = node?.attrs?.[JOT_BLOCK_ID_ATTR];
  return typeof value === 'string' && value ? value : `block-${index}`;
}

function mappingFromDesired(entry, notionBlockId, previous = {}) {
  return {
    localPageId: entry.localPageId,
    jotBlockId: entry.jotBlockId,
    localNodeId: entry.localNodeId,
    notionBlockId,
    kind: entry.kind,
    order: entry.order,
    lastSyncedHash: entry.lastSyncedHash,
    oldState: previous.newState ?? previous.oldState ?? null,
    newState: entry.notionBlock,
  };
}

function mappingsByJotId(mappings) {
  const result = new Map();

  for (const mapping of mappings) {
    result.set(mappingKey(mapping), mapping);
  }

  return result;
}

function mappingKey(mapping) {
  return mapping.jotBlockId ?? mapping.localNodeId;
}

function hasReorderedManagedBlocks(existingMappings, desiredBlocks) {
  const desiredIds = new Set(desiredBlocks.map((entry) => entry.jotBlockId));
  const existingIds = new Set(existingMappings.map(mappingKey));
  const oldCommon = existingMappings
    .map(mappingKey)
    .filter((id) => desiredIds.has(id));
  const newCommon = desiredBlocks
    .map((entry) => entry.jotBlockId)
    .filter((id) => existingIds.has(id));

  return oldCommon.length > 1 && oldCommon.join('\n') !== newCommon.join('\n');
}

function reorderedRange(existingMappings, desiredBlocks) {
  const desiredIds = new Set(desiredBlocks.map((entry) => entry.jotBlockId));
  const existingIds = new Set(existingMappings.map(mappingKey));
  const oldCommon = existingMappings
    .map(mappingKey)
    .filter((id) => desiredIds.has(id));
  const newCommon = desiredBlocks
    .map((entry) => entry.jotBlockId)
    .filter((id) => existingIds.has(id));
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
    .map((entry, index) => affectedIds.has(entry.jotBlockId) ? index : -1)
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
