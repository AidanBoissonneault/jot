import { describe, expect, it } from 'vitest';
import { normalizeJottathingBlockIds } from '@/src/extensions/jottathingBlockIds';
import {
  decodeJottathingSource,
  encodeJottathingSource,
  isAccessibleJottathingSource,
  storeJottathingSource,
} from '@/src/extensions/jottathingLink';
import {
  addSourceToProjectState,
  capturedBlockId,
  isProjectStateMetadataNode,
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
import { SOURCE_REGISTRY_PREFIX } from '@/src/lib/projectStateSources';
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
    expect(storeJottathingSource(source)).toEqual({
      u: source.sourceUrl,
      t: 'selected text',
      l: '#:~:text=selected%20text',
      x: '/html[1]/body[1]/p[2]/text()[1]',
      o: 7,
      p: 'before ',
      s: ' after',
    });

    expect(decodeJottathingSource(encodeJottathingSource(source))).toMatchObject({
      sourceUrl: source.sourceUrl,
      highlightMeta: source.highlightMeta,
    });
  });

  it('only exposes web URLs as accessible sources', () => {
    expect(isAccessibleJottathingSource(source)).toBe(true);
    expect(isAccessibleJottathingSource({
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
    expect(content[0].attrs?.jottathingSource).toEqual(storeJottathingSource(source));
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

  it('does not resolve a source through a prototype-polluted Notion registry', () => {
    const state = {
      type: 'doc',
      content: [{
        type: 'codeBlock',
        content: [{
          type: 'text',
          text: `${SOURCE_REGISTRY_PREFIX}{"__proto__":{"forged":{"u":"https://example.com/attacker","t":"forged source"}}}`,
        }],
      }],
    };

    expect(sourceFromProjectState(state, 'forged')).toBeNull();
  });

  it('ignores retired Inkwell source metadata formats', () => {
    const legacyEntry = {
      type: 'codeBlock',
      content: [{
        type: 'text',
        text: `inkwell_source_v1:${JSON.stringify({ blockId: 'block-1', source })}`,
      }],
    };
    const legacyRegistry = {
      type: 'codeBlock',
      content: [{
        type: 'text',
        text: `inkwell_sources_v1:${JSON.stringify({ 'block-1': storeJottathingSource(source) })}`,
      }],
    };

    expect(sourceFromProjectState({ type: 'doc', content: [legacyEntry] }, 'block-1')).toBeNull();
    expect(isProjectStateMetadataNode(legacyEntry)).toBe(false);
    expect(sourceFromProjectState({ type: 'doc', content: [legacyRegistry] }, 'block-1')).toBeNull();
    expect(isProjectStateMetadataNode(legacyRegistry)).toBe(false);
  });

  it('stores each origin as its own stable state block and replaces retries', () => {
    const first = addSourceToProjectState(undefined, 'block-1', source);
    const retried = addSourceToProjectState(first, 'block-1', source);
    const withSecond = addSourceToProjectState(retried, 'block-2', {
      ...source,
      highlightMeta: { ...source.highlightMeta, text: 'another selection' },
    });

    const sourceBlocks = withSecond.content?.filter((node) =>
      String(node.content?.[0]?.text).startsWith('jottathing_source_v1:'),
    );
    expect(sourceBlocks).toHaveLength(2);
    expect(sourceBlocks?.map((node) => node.attrs?.jottathingBlockId)).toEqual([
      'source:block-1',
      'source:block-2',
    ]);
    expect(sourceFromProjectState(withSecond, 'block-1')).toMatchObject({
      sourceUrl: source.sourceUrl,
      highlightMeta: source.highlightMeta,
    });
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
    const normalized = normalizeJottathingBlockIds({
      type: 'doc',
      content: [
        {
          type: 'blockquote',
          attrs: { jottathingBlockId: 'quote-1', jottathingSource: null },
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'selected text' }] }],
        },
        {
          type: 'paragraph',
          attrs: { jottathingBlockId: 'source-1', jottathingSource: null },
          content: [{
            type: 'text',
            text: `Source: Example documentation - ${source.sourceUrl}`,
            marks: [{ type: 'link', attrs: { href: source.sourceUrl, jottathingSource: legacySource } }],
          }],
        },
      ],
    });

    expect(normalized.content?.[0].attrs?.jottathingSource).toEqual(storeJottathingSource(source));
    expect(normalized.content?.[1].attrs).toEqual({ jottathingBlockId: 'source-1' });

    const migrated = migratePageSourcesToProjectState(normalized, undefined);
    expect(migrated.content.content).toHaveLength(1);
    expect(migrated.content.content?.[0].attrs?.jottathingSource).toEqual(
      storeJottathingSource(source),
    );
    expect(sourceFromProjectState(migrated.stateContent, 'quote-1')).not.toBeNull();
  });

  it('recovers source navigation from a Notion-preserved source link', () => {
    const normalized = normalizeJottathingBlockIds({
      type: 'doc',
      content: [
        {
          type: 'codeBlock',
          attrs: { jottathingBlockId: 'code-1' },
          content: [{ type: 'text', text: 'selected text' }],
        },
        {
          type: 'paragraph',
          attrs: { jottathingBlockId: 'source-1' },
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

    expect(normalized.content?.[0].attrs?.jottathingSource).toEqual({
      u: 'https://example.com/docs?version=2',
      t: 'selected text',
    });
  });
});
