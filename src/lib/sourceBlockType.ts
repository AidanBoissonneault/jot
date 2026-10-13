/** Semantic block types that can be preserved when capturing webpage text. */
export type CaptureSourceBlockType = 'heading' | 'paragraph' | 'blockquote' | 'codeBlock';

export type CaptureSourceBlock =
  | { type: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6 }
  | { type: 'paragraph' | 'blockquote' | 'codeBlock' };

/** The semantic attributes of one ancestor in a webpage selection. */
export interface CaptureSourceAncestor {
  tagName: string;
  role?: string | null;
  ariaLevel?: string | null;
}

/**
 * Finds the source block type without guessing from visual style.
 * Ancestors must be ordered from the selection element out toward the root.
 */
export function captureSourceBlockFromAncestors(
  ancestors: readonly CaptureSourceAncestor[],
): CaptureSourceBlock | undefined {
  for (const ancestor of ancestors) {
    const tagName = ancestor.tagName.toUpperCase();
    const level = headingLevelFromAncestor(ancestor, tagName);
    if (level) return { type: 'heading', level };
  }

  if (ancestors.some(({ tagName }) => tagName.toUpperCase() === 'PRE')) {
    return { type: 'codeBlock' };
  }

  if (ancestors.some(({ tagName }) => tagName.toUpperCase() === 'BLOCKQUOTE')) {
    return { type: 'blockquote' };
  }

  if (ancestors.some(({ tagName }) => tagName.toUpperCase() === 'P')) {
    return { type: 'paragraph' };
  }

  return undefined;
}

function headingLevelFromAncestor(
  ancestor: CaptureSourceAncestor,
  tagName: string,
): 1 | 2 | 3 | 4 | 5 | 6 | undefined {
  if (/^H[1-6]$/.test(tagName)) {
    return Number(tagName.slice(1)) as 1 | 2 | 3 | 4 | 5 | 6;
  }

  if (ancestor.role?.toLowerCase() !== 'heading') return undefined;
  const level = Number(ancestor.ariaLevel);
  return Number.isInteger(level) && level >= 1 && level <= 6
    ? level as 1 | 2 | 3 | 4 | 5 | 6
    : undefined;
}
