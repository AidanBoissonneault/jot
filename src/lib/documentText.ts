/** @file Converts editor document nodes into plain project metadata text. */
import type { DocumentContent } from '@/src/types/capture';

/** Converts a Tiptap document tree into the text used by project metadata fields. */
export function plainTextFromDocument(document: DocumentContent | undefined): string {
  return (document?.content ?? [])
    .map((node) => textFromNode(node))
    .join('\n')
    .trim();
}

function textFromNode(node: DocumentContent): string {
  if (node.text) return node.text;
  if (node.type === 'hardBreak') return '\n';
  return (node.content ?? []).map(textFromNode).join('');
}
