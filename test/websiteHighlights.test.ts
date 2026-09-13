import { describe, expect, it } from 'vitest';
import {
  addSourceToProjectState,
  addWebsiteHighlightToProjectState,
  mergeVisibleProjectState,
  removeWebsiteHighlightsFromProjectState,
  sourceFromProjectState,
  visibleProjectStateContent,
  websiteHighlightsFromProjectState,
} from '@/src/extensions/sourceRegistry';
import type { SourceOpenPayload, WebsiteHighlight } from '@/src/types/messages';

const highlight: WebsiteHighlight = {
  id: 'highlight-1',
  url: 'https://example.com/article?edition=2',
  text: 'a precise passage',
  color: 'yellow',
  note: 'Useful context',
  createdAt: '2026-09-12T12:00:00.000Z',
  anchor: {
    startXPath: '/html[1]/body[1]/article[1]/p[2]/text()[1]',
    startOffset: 4,
    endXPath: '/html[1]/body[1]/article[1]/p[2]/text()[1]',
    endOffset: 21,
    blockXPath: '/html[1]/body[1]/article[1]/p[2]',
    blockText: 'The a precise passage remains here.',
  },
};

const source: SourceOpenPayload = {
  sourceUrl: highlight.url,
  highlightMeta: { text: highlight.text },
};

describe('persistent website highlight project state', () => {
  it('stores highlights by site without exposing the registry in visible state', () => {
    const state = addWebsiteHighlightToProjectState(undefined, highlight);

    expect(websiteHighlightsFromProjectState(state, highlight.url)).toEqual([highlight]);
    expect(websiteHighlightsFromProjectState(state, 'https://example.com/other')).toEqual([]);
    expect(visibleProjectStateContent(state)).toEqual({
      type: 'doc',
      content: [{ type: 'paragraph' }],
    });
  });

  it('preserves source and highlight registries when either one is updated', () => {
    const withHighlight = addWebsiteHighlightToProjectState(undefined, highlight);
    const withBoth = addSourceToProjectState(withHighlight, 'block-1', source);
    const updatedHighlight = { ...highlight, color: 'blue' as const };
    const updated = addWebsiteHighlightToProjectState(withBoth, updatedHighlight);

    expect(sourceFromProjectState(updated, 'block-1')).not.toBeNull();
    expect(websiteHighlightsFromProjectState(updated)).toEqual([updatedHighlight]);

    const edited = mergeVisibleProjectState({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Project note' }] }],
    }, updated);
    expect(websiteHighlightsFromProjectState(edited)).toEqual([updatedHighlight]);
  });

  it('declares repeated links once and keeps each state record independently editable', () => {
    const second = { ...highlight, id: 'highlight-2', text: 'another passage' };
    const initial = addWebsiteHighlightToProjectState(
      addSourceToProjectState(
        addWebsiteHighlightToProjectState(undefined, highlight),
        'block-1',
        source,
      ),
      second,
    );
    const serialized = JSON.stringify(initial);

    expect(serialized.split(highlight.url)).toHaveLength(2);
    expect(initial.content?.map((node) => node.attrs?.inkwellBlockId)).toEqual([
      'inkwell-links',
      'inkwell-source:block-1',
      'inkwell-highlight:highlight-1',
      'inkwell-highlight:highlight-2',
    ]);

    const updated = addWebsiteHighlightToProjectState(initial, {
      ...highlight,
      color: 'blue',
    });
    const initialById = new Map(initial.content?.map((node) => [node.attrs?.inkwellBlockId, node]));
    const updatedById = new Map(updated.content?.map((node) => [node.attrs?.inkwellBlockId, node]));

    expect(updatedById.get('inkwell-links')).toEqual(initialById.get('inkwell-links'));
    expect(updatedById.get('inkwell-source:block-1')).toEqual(initialById.get('inkwell-source:block-1'));
    expect(updatedById.get('inkwell-highlight:highlight-2'))
      .toEqual(initialById.get('inkwell-highlight:highlight-2'));
    expect(updatedById.get('inkwell-highlight:highlight-1'))
      .not.toEqual(initialById.get('inkwell-highlight:highlight-1'));
  });

  it('removes only confirmed stale highlight ids', () => {
    const second = { ...highlight, id: 'highlight-2', text: 'another passage' };
    const state = addWebsiteHighlightToProjectState(
      addWebsiteHighlightToProjectState(undefined, highlight),
      second,
    );
    const pruned = removeWebsiteHighlightsFromProjectState(state, [highlight.id, 'unknown']);

    expect(websiteHighlightsFromProjectState(pruned)).toEqual([second]);
  });
});
