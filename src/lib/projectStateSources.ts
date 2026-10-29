import type { DocumentContent } from '../types/capture.js';

export const SOURCE_ENTRY_PREFIX = 'jottathing_source_v1:';
export const SOURCE_BLOCK_ID_PREFIX = 'source:';

/** Removes current source entries for captured blocks that no longer exist. */
export function pruneOrphanedProjectStateSources(
  stateContent: DocumentContent,
  existingJottathingBlockIds: ReadonlySet<string>,
): DocumentContent {
  let changed = false;
  const content = (stateContent.content ?? []).filter((node) => {
    const text = codeBlockText(node);
    if (!text?.startsWith(SOURCE_ENTRY_PREFIX)) return true;

    const blockId = sourceEntryBlockId(text.slice(SOURCE_ENTRY_PREFIX.length));
    if (!blockId || existingJottathingBlockIds.has(blockId)) return true;

    changed = true;
    return false;
  });

  return changed
    ? { ...stateContent, type: stateContent.type ?? 'doc', content }
    : stateContent;
}

/** Reads the captured block ID stored in a current project-state source entry. */
export function projectStateSourceBlockIds(node: DocumentContent): string[] {
  const text = codeBlockText(node);
  if (!text?.startsWith(SOURCE_ENTRY_PREFIX)) return [];

  const blockId = sourceEntryBlockId(text.slice(SOURCE_ENTRY_PREFIX.length));
  return blockId ? [blockId] : [];
}

function sourceEntryBlockId(payload: string): string | undefined {
  try {
    const value = JSON.parse(payload) as { blockId?: unknown } | null;
    const blockId = value?.blockId;
    return typeof blockId === 'string' && blockId ? blockId : undefined;
  } catch {
    return undefined;
  }
}

function codeBlockText(node: DocumentContent): string | undefined {
  return node.type === 'codeBlock'
    ? (node.content ?? []).map((child) => child.text ?? '').join('')
    : undefined;
}
