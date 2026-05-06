export async function replaceManagedBlocks({
  store,
  localPageId,
  notionPageId,
  content,
  listAllBlockChildren,
  deleteManagedBlock,
  appendManagedBlocks,
  tiptapDocumentToNotionBlocks,
  kindFromNotionBlock,
  hash,
}) {
  const notionBlocks = tiptapDocumentToNotionBlocks(content);
  const existingBlocks = await listAllBlockChildren(store, notionPageId);

  for (const block of existingBlocks) {
    await deleteManagedBlock(store, block.id);
  }

  const createdBlocks = await appendManagedBlocks(store, notionPageId, notionBlocks);

  store.blockMappings[localPageId] = createdBlocks.map((block, index) => ({
    localPageId,
    localNodeId: `block-${index}`,
    notionBlockId: block.id,
    kind: kindFromNotionBlock(notionBlocks[index]),
    lastSyncedHash: hash(JSON.stringify(notionBlocks[index] ?? {})),
  }));
}
