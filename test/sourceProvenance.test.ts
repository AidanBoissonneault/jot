import { describe, expect, it } from 'vitest';
import { normalizeInkwellBlockIds } from '@/src/extensions/inkwellBlockIds';
import {
  decodeInkwellSource,
  encodeInkwellSource,
  isAccessibleInkwellSource,
  storeInkwellSource,
} from '@/src/extensions/inkwellLink';
import {
  addSourceToProjectState,
  capturedBlockId,
  mergeVisibleProjectState,
  migratePageSourcesToProjectState,
  sourceFromProjectState,
  visibleProjectStateContent,
} from '@/src/extensions/sourceRegistry';
import { createCapturedContent } from '@/src/services/notionClient';
import { cloneableProjectState } from '@/src/services/idbStore';
import {
  notionBlocksToTiptapDocument,
  tiptapDocumentToNotionBlocks,
} from '@/apps/worker/src/blockConversion';
import type { SourceOpenPayload } from '@/src/types/messages';

const source: SourceOpenPayload = {
  sourceUrl: 'https://example.com/docs?version=2#old',
  pageTitle: 'Example documentation',
  highlightMeta: {
    text: 'selected text',
    sourceLink: 'https://example.com/docs?version=2#:~:text=selected%20text',
    xpath: '/html[1]/body[1]/p[2]/text()[1]',
    offset: 7,
    prefix: 'before ',
    suffix: ' after',
  },
};

describe('captured source provenance', () => {
  it('unwraps reactive-style proxies before IndexedDB persistence', () => {
    const proxied = new Proxy({ nested: { source: 'https://example.com' } }, {});
    const cloneable = cloneableProjectState(proxied);

    expect(cloneable).toEqual(proxied);
    expect(() => structuredClone(cloneable)).not.toThrow();
  });

  it('stores a compact source record and expands its relative locator', () => {
    expect(storeInkwellSource(source)).toEqual({
      u: source.sourceUrl,
      t: 'selected text',
      l: '#:~:text=selected%20text',
      x: '/html[1]/body[1]/p[2]/text()[1]',
      o: 7,
      p: 'before ',
      s: ' after',
    });

    expect(decodeInkwellSource(encodeInkwellSource(source))).toMatchObject({
      sourceUrl: source.sourceUrl,
      highlightMeta: source.highlightMeta,
    });
  });

  it('only exposes web URLs as accessible sources', () => {
    expect(isAccessibleInkwellSource(source)).toBe(true);
    expect(isAccessibleInkwellSource({
      sourceUrl: 'javascript:alert(1)',
      highlightMeta: { text: 'unsafe' },
    })).toBe(false);
  });

  it('stores provenance in project state without rendering a source row', () => {
    const content = createCapturedContent({
      text: source.highlightMeta.text,
      sourceUrl: source.sourceUrl,
      pageTitle: source.pageTitle ?? '',
      highlightMeta: source.highlightMeta,
    });
    const blockId = capturedBlockId(content);
    expect(blockId).toEqual(expect.any(String));
    expect(content).toHaveLength(2);
    expect(content[0].attrs?.inkwellSource).toBeUndefined();
    expect(content[1]).toEqual({ type: 'paragraph' });

    const state = addSourceToProjectState(undefined, blockId!, source);
    expect(sourceFromProjectState(state, blockId)).toMatchObject({
      sourceUrl: source.sourceUrl,
      highlightMeta: source.highlightMeta,
    });
    expect(visibleProjectStateContent(state)).toEqual({
      type: 'doc',
      content: [{ type: 'paragraph' }],
    });
  });

  it('preserves the source registry when visible project state is edited', () => {
    const state = addSourceToProjectState(undefined, 'block-1', source);
    const merged = mergeVisibleProjectState({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'User notes' }] }],
    }, state);

    expect(sourceFromProjectState(merged, 'block-1')).not.toBeNull();
    expect(visibleProjectStateContent(merged).content?.[0].content?.[0].text)
      .toBe('User notes');
  });

  it('round-trips the source registry through the generated Notion state page', () => {
    const state = addSourceToProjectState(undefined, 'block-1', source);
    const notionBlocks = tiptapDocumentToNotionBlocks(state);
    const pulledState = notionBlocksToTiptapDocument(notionBlocks.map((block: {
      type: string;
      [key: string]: any;
    }) => ({
      ...block,
      [block.type]: {
        ...block[block.type],
        rich_text: block[block.type].rich_text.map((item: { text?: { content?: string } }) => ({
          ...item,
          plain_text: item.text?.content ?? '',
        })),
      },
    })));

    expect(sourceFromProjectState(pulledState, 'block-1')).toMatchObject({
      sourceUrl: source.sourceUrl,
      highlightMeta: { text: source.highlightMeta.text },
    });
  });

  it('migrates legacy source-link metadata to its preceding capture block', () => {
    const legacySource = JSON.stringify(source);
    const normalized = normalizeInkwellBlockIds({
      type: 'doc',
      content: [
        {
          type: 'blockquote',
          attrs: { inkwellBlockId: 'quote-1', inkwellSource: null },
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'selected text' }] }],
        },
        {
          type: 'paragraph',
          attrs: { inkwellBlockId: 'source-1', inkwellSource: null },
          content: [{
            type: 'text',
            text: `Source: Example documentation - ${source.sourceUrl}`,
            marks: [{ type: 'link', attrs: { href: source.sourceUrl, inkwellSource: legacySource } }],
          }],
        },
      ],
    });

    expect(normalized.content?.[0].attrs?.inkwellSource).toEqual(storeInkwellSource(source));
    expect(normalized.content?.[1].attrs).toEqual({ inkwellBlockId: 'source-1' });

    const migrated = migratePageSourcesToProjectState(normalized, undefined);
    expect(migrated.content.content).toHaveLength(1);
    expect(migrated.content.content?.[0].attrs?.inkwellSource).toBeUndefined();
    expect(sourceFromProjectState(migrated.stateContent, 'quote-1')).not.toBeNull();
  });

  it('recovers source navigation from a Notion-preserved source link', () => {
    const normalized = normalizeInkwellBlockIds({
      type: 'doc',
      content: [
        {
          type: 'codeBlock',
          attrs: { inkwellBlockId: 'code-1' },
          content: [{ type: 'text', text: 'selected text' }],
        },
        {
          type: 'paragraph',
          attrs: { inkwellBlockId: 'source-1' },
          content: [{
            type: 'text',
            text: 'Source: Example documentation',
            marks: [{
              type: 'link',
              attrs: { href: source.highlightMeta.sourceLink },
            }],
          }],
        },
      ],
    });

    expect(normalized.content?.[0].attrs?.inkwellSource).toEqual({
      u: 'https://example.com/docs?version=2',
      t: 'selected text',
    });
  });
});
