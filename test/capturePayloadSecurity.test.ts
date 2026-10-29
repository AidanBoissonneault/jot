import { describe, expect, it } from 'vitest';
import { parseCaptureSelectionPayload } from '@/src/lib/capturePayload';

const validPayload = {
  text: 'selected text',
  sourceUrl: 'https://example.com/article?part=1',
  pageTitle: 'Article',
  highlightMeta: {
    text: 'selected text',
    sourceLink: 'https://example.com/article?part=1#:~:text=selected',
    xpath: '/html[1]/body[1]/p[1]/text()[1]',
    offset: 12,
    prefix: 'before',
    suffix: 'after',
  },
};

describe('parseCaptureSelectionPayload', () => {
  it('accepts a well-formed web capture and retains a same-page source link', () => {
    expect(parseCaptureSelectionPayload(validPayload)).toEqual(validPayload);
  });

  it.each([
    null,
    [],
    { ...validPayload, highlightMeta: null },
    { ...validPayload, highlightMeta: { text: 'different text' } },
    { ...validPayload, text: 'x'.repeat(256 * 1024 + 1) },
    { ...validPayload, sourceUrl: 'javascript:alert(1)' },
    { ...validPayload, sourceUrl: 'https://user:pass@example.com/article' },
    { ...validPayload, highlightMeta: { ...validPayload.highlightMeta, offset: -1 } },
    { ...validPayload, highlightMeta: { ...validPayload.highlightMeta, offset: Number.MAX_SAFE_INTEGER + 1 } },
    { ...validPayload, highlightMeta: { ...validPayload.highlightMeta, isHeading: 'yes' } },
    { ...validPayload, highlightMeta: { ...validPayload.highlightMeta, headingLevel: 99 } },
    { ...validPayload, highlightMeta: { ...validPayload.highlightMeta, sourceBlockType: 'h7' } },
    { ...validPayload, highlightMeta: { ...validPayload.highlightMeta, xpath: 'x'.repeat(4097) } },
    { ...validPayload, highlightMeta: { ...validPayload.highlightMeta, prefix: 'x'.repeat(257) } },
    { ...validPayload, highlightMeta: { ...validPayload.highlightMeta, suffix: 'x'.repeat(257) } },
    { ...validPayload, highlightMeta: { ...validPayload.highlightMeta, codeLanguage: 'x'.repeat(129) } },
    { ...validPayload, pageTitle: 'x'.repeat(4097) },
    { ...validPayload, sourceUrl: 'https://example.com/'.concat('x'.repeat(8192)) },
    { ...validPayload, text: ' '.repeat(10) },
  ])('rejects malformed or unsafe capture data', (value) => {
    expect(parseCaptureSelectionPayload(value)).toBeNull();
  });

  it('drops cross-page source links while preserving the safe capture', () => {
    const result = parseCaptureSelectionPayload({
      ...validPayload,
      highlightMeta: {
        ...validPayload.highlightMeta,
        sourceLink: 'https://attacker.example/redirect',
      },
    });

    expect(result?.sourceUrl).toBe(validPayload.sourceUrl);
    expect(result?.highlightMeta.sourceLink).toBeUndefined();
  });

  it('copies only supported metadata and drops links to a different page', () => {
    const result = parseCaptureSelectionPayload({
      ...validPayload,
      highlightMeta: {
        ...validPayload.highlightMeta,
        sourceBlockType: 'codeBlock',
        codeLanguage: 'typescript',
        headingLevel: 6,
        sourceLink: 'https://example.com/other?part=1#selection',
        unexpected: 'ignored',
      },
    });

    expect(result?.highlightMeta).toMatchObject({
      sourceBlockType: 'codeBlock',
      codeLanguage: 'typescript',
      headingLevel: 6,
    });
    expect(result?.highlightMeta.sourceLink).toBeUndefined();
    expect(result?.highlightMeta).not.toHaveProperty('unexpected');
  });
});
