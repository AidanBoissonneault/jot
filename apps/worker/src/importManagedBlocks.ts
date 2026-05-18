// @ts-nocheck
import { randomUUID, createHash } from 'node:crypto';
import {
  kindFromNotionBlock,
  notionBlocksToTiptapDocumentStrict,
  tiptapDocumentToNotionBlocks,
} from './blockConversion.js';

const INKWELL_BLOCK_ID_ATTR = 'inkwellBlockId';

export async function importManagedBlocks({
  store,
  page,
  listAllBlockChildren,
  hash = defaultHash,
}) {
  const children = await listAllBlockChildren(store, page.notionPageId);
  const imported = notionBlocksToTiptapDocumentStrict(children);

  if (!imported) {
    return null;
  }

  const mapped = rebuildImportedBlockMappings({
    hash,
    imported,
    localPageId: page.id,
    notionBlocks: children,
    store,
  });

  return mapped.content?.length ? mapped : null;
}

function rebuildImportedBlockMappings({
  hash = defaultHash,
  imported,
  localPageId,
  notionBlocks,
  store,
}) {
  const existingByNotionId = new Map(
    (store.blockMappings[localPageId] ?? [])
      .filter((mapping) => mapping.notionBlockId)
      .map((mapping) => [mapping.notionBlockId, mapping]),
  );
  const content = imported.content.map((node, index) => {
    const existing = existingByNotionId.get(notionBlocks[index]?.id);
    const inkwellBlockId =
      existing?.inkwellBlockId ?? existing?.localNodeId ?? `inkwell-block-${randomUUID()}`;

    return {
      ...node,
      attrs: {
        ...(node.attrs ?? {}),
        [INKWELL_BLOCK_ID_ATTR]: inkwellBlockId,
      },
    };
  });
  const mapped = {
    ...imported,
    content,
  };
  const outboundBlocks = tiptapDocumentToNotionBlocks(mapped);

  store.blockMappings[localPageId] = outboundBlocks.map((notionBlock, index) => {
    const importedBlock = notionBlocks[index];
    const node = content[index];
    const existing = existingByNotionId.get(importedBlock?.id);

    return {
      localPageId,
      inkwellBlockId: node.attrs[INKWELL_BLOCK_ID_ATTR],
      localNodeId: node.attrs[INKWELL_BLOCK_ID_ATTR],
      notionBlockId: importedBlock.id,
      kind: kindFromNotionBlock(notionBlock),
      order: index,
      lastSyncedHash: hash(JSON.stringify(notionBlock ?? {})),
      oldState: existing?.newState ?? existing?.oldState ?? null,
      newState: notionBlock,
    };
  });

  return mapped;
}

function defaultHash(value) {
  return createHash('sha256').update(value).digest('hex');
}
