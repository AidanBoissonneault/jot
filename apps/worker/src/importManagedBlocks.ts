/**
 * @file Imports supported Notion children and rebuilds stable local-to-remote block mappings.
 * @author Aidan Boissonneault
 * @lastModified September 2026
 */

import { randomUUID, createHash } from 'node:crypto';
import type { DocumentContent } from '../../../src/types/capture.js';
import {
  kindFromNotionBlock,
  notionBlocksToTiptapDocumentStrict,
  tiptapDocumentToNotionBlocks,
} from './blockConversion.js';
import type {
  BlockMapping,
  HashValue,
  ListAllBlockChildren,
  NotionBlock,
  WorkerStore,
} from './types.js';

const INKWELL_BLOCK_ID_ATTR = 'inkwellBlockId';

/** Describes the import managed blocks options contract used by this API feature. */
interface ImportManagedBlocksOptions {
  hash: HashValue;
  listAllBlockChildren: ListAllBlockChildren;
  page: { id: string; notionPageId: string };
  store: WorkerStore;
}

/** Describes the rebuild mappings options contract used by this API feature. */
interface RebuildMappingsOptions {
  hash: HashValue;
  imported: DocumentContent;
  localPageId: string;
  notionBlocks: NotionBlock[];
  store: WorkerStore;
}

/**
 * Imports every supported child block for one linked page.
 * @param options - Store, page identity, child loader, and hashing dependency.
 * @returns A mapped Tiptap document, or null when import cannot be performed safely.
 */
export async function importManagedBlocks({
  store,
  page,
  listAllBlockChildren,
  hash = defaultHash,
}: Omit<ImportManagedBlocksOptions, 'hash'> & Partial<Pick<ImportManagedBlocksOptions, 'hash'>>): Promise<DocumentContent | null> {
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

/**
 * Reuses stable block identities and records the newly imported Notion state.
 * @param options - Imported document, source blocks, store, page identity, and hasher.
 * @returns The imported document with mapping metadata attached.
 */
function rebuildImportedBlockMappings({
  hash = defaultHash,
  imported,
  localPageId,
  notionBlocks,
  store,
}: RebuildMappingsOptions): DocumentContent {
  const existingByNotionId = new Map(
    (store.blockMappings[localPageId] ?? [])
      .filter((mapping) => mapping.notionBlockId)
      .map((mapping) => [mapping.notionBlockId, mapping]),
  );
  const content = (imported.content ?? []).map((node: DocumentContent, index: number) => {
    const notionBlock = notionBlocks[index];
    const existing = existingByNotionId.get(notionBlock?.id);
    const inkwellBlockId =
      existing?.inkwellBlockId ?? existing?.localNodeId ?? `inkwell-block-${randomUUID()}`;
    const fileUploadId = fileUploadIdFromMapping(existing);

    return {
      ...node,
      attrs: {
        ...(node.attrs ?? {}),
        [INKWELL_BLOCK_ID_ATTR]: inkwellBlockId,
        ...(notionBlock?.id && isMediaNode(node) ? { notionBlockId: notionBlock.id } : {}),
        ...(fileUploadId ? { notionFileUploadId: fileUploadId, uploadState: 'done' } : {}),
      },
    };
  });
  const mapped = {
    ...imported,
    content,
  };
  const outboundBlocks = tiptapDocumentToNotionBlocks(mapped);

  store.blockMappings[localPageId] = outboundBlocks.map((notionBlock, index): BlockMapping => {
    const importedBlock = notionBlocks[index];
    const node = content[index];
    const existing = existingByNotionId.get(importedBlock?.id);

    return {
      localPageId,
      inkwellBlockId: String(node.attrs?.[INKWELL_BLOCK_ID_ATTR]),
      localNodeId: String(node.attrs?.[INKWELL_BLOCK_ID_ATTR]),
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

/**
 * Finds a persisted Notion upload identifier in a block mapping.
 * @param mapping - Existing mapping, when one exists.
 * @returns The upload identifier or undefined.
 */
function fileUploadIdFromMapping(mapping: BlockMapping | undefined): string | undefined {
  for (const state of [mapping?.newState, mapping?.oldState]) {
    const type = state?.type;
    const blockContent = type ? state?.[type] : undefined;
    const fileUpload = objectProperty(blockContent, 'file_upload');
    const fileUploadId = stringProperty(fileUpload, 'id');
    if (fileUploadId) return fileUploadId;
  }

  return undefined;
}

/**
 * Checks whether a Tiptap node is media with a refreshable Notion identity.
 * @param node - Tiptap node to inspect.
 * @returns Whether the node is an image or audio node.
 */
function isMediaNode(node: DocumentContent): boolean {
  return node?.type === 'image' || node?.type === 'audio';
}

/**
 * Produces the default stable content hash for imported mappings.
 * @param value - Serialized value to hash.
 * @returns A hexadecimal SHA-256 digest.
 */
function defaultHash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Reads an object property from an unknown value.
 * @param value - Candidate object.
 * @param key - Property name.
 * @returns The nested object or undefined.
 */
function objectProperty(value: unknown, key: string): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const property: unknown = (value as Record<string, unknown>)[key];
  return property && typeof property === 'object' && !Array.isArray(property)
    ? property as Record<string, unknown>
    : undefined;
}

/**
 * Reads a string property from a possibly absent object.
 * @param value - Candidate object.
 * @param key - Property name.
 * @returns The string value or undefined.
 */
function stringProperty(value: Record<string, unknown> | undefined, key: string): string | undefined {
  const property: unknown = value?.[key];
  return typeof property === 'string' ? property : undefined;
}
