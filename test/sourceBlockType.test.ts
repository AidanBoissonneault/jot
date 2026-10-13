import { describe, expect, it } from 'vitest';
import { captureSourceBlockFromAncestors } from '@/src/lib/sourceBlockType';

describe('captureSourceBlockFromAncestors', () => {
  it.each([1, 2, 3, 4, 5, 6] as const)(
    'preserves semantic H%d heading levels',
    (level) => {
      expect(captureSourceBlockFromAncestors([
        { tagName: `H${level}` },
        { tagName: 'BODY' },
      ])).toEqual({ type: 'heading', level });
    },
  );

  it('preserves an accessible role heading level', () => {
    expect(captureSourceBlockFromAncestors([
      { tagName: 'DIV', role: 'heading', ariaLevel: '2' },
    ])).toEqual({ type: 'heading', level: 2 });
  });

  it('keeps a paragraph a paragraph even when it is styled like a heading', () => {
    expect(captureSourceBlockFromAncestors([
      { tagName: 'P' },
      { tagName: 'BODY' },
    ])).toEqual({ type: 'paragraph' });
  });

  it('preserves quote and preformatted code block semantics', () => {
    expect(captureSourceBlockFromAncestors([
      { tagName: 'P' },
      { tagName: 'BLOCKQUOTE' },
    ])).toEqual({ type: 'blockquote' });
    expect(captureSourceBlockFromAncestors([
      { tagName: 'CODE' },
      { tagName: 'PRE' },
    ])).toEqual({ type: 'codeBlock' });
  });

  it('does not infer a heading from an invalid ARIA level or a generic element', () => {
    expect(captureSourceBlockFromAncestors([
      { tagName: 'DIV', role: 'heading', ariaLevel: '99' },
      { tagName: 'DIV' },
    ])).toBeUndefined();
  });
});
