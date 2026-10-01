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
    { ...validPayload, highlightMeta: { ...validPayload.highlightMeta, isHeading: 'yes' } },
    { ...validPayload, highlightMeta: { ...validPayload.highlightMeta, headingLevel: 99 } },
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
});
