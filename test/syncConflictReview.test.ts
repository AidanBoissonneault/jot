import { describe, expect, it } from 'vitest';
import {
  buildSyncConflictMerge,
  createSyncConflictRows,
  hasUnresolvedSyncConflictRows,
  syncConflictBlockText,
  syncConflictDiffParts,
  type SyncConflictRow,
} from '@/src/lib/syncConflictReview';
import type { DocumentContent } from '@/src/types/capture';
import type { SyncContentConflict } from '@/src/types/sync';

describe('buildSyncConflictMerge', () => {
  it('resolves duplicate, delete, changed, and unchanged rows in display order', () => {
    const rows: SyncConflictRow[] = [
      {
        id: 'duplicate',
        local: block('local-duplicate', 'local copy'),
        notion: block('remote-duplicate', 'remote copy', 'notion-duplicate'),
        duplicate: true,
        changed: true,
      },
      {
        id: 'local-deleted',
        notion: block('remote-kept', 'remote kept'),
        localDeleted: true,
        changed: true,
      },
      {
        id: 'notion-deleted',
        local: block('local-restored', 'local restored'),
        notionDeleted: true,
        changed: true,
      },
      {
        id: 'changed',
        local: block('local-change', 'local text'),
        notion: block('remote-change', 'remote text', 'notion-change'),
        changed: true,
        notionChanged: true,
      },
      {
        id: 'unchanged',
        local: block('local-unchanged', 'unchanged'),
        changed: false,
      },
    ];

    const merged = buildSyncConflictMerge(conflict(), rows, {
      duplicate: 'both',
      'local-deleted': 'notion',
      'notion-deleted': 'local',
    });

    expect(merged.attrs).toMatchObject({
      jottathingConflictResolution: true,
      jottathingPreserveRemoteBlocks: true,
    });
    expect(merged.content?.map((node) => node.content?.[0]?.text)).toEqual([
      'local copy',
      'remote copy',
      'remote kept',
      'local restored',
      'remote text',
      'unchanged',
    ]);
    expect(merged.content?.every((node) => node.attrs?.jottathingConflictResolution === true))
      .toBe(true);
    expect(merged.content?.[1].attrs?.notionBlockId).toBe('notion-duplicate');
    expect(merged.content?.[4].attrs?.notionBlockId).toBe('notion-change');
  });

  it('records local deletions and leaves unchosen duplicates out', () => {
    const rows: SyncConflictRow[] = [
      {
        id: 'delete-remote',
        notion: block('remote-delete', 'remote delete', 'notion-delete'),
        localDeleted: true,
        changed: true,
      },
      {
        id: 'duplicate',
        local: block('local-duplicate', 'local copy'),
        notion: block('remote-duplicate', 'remote copy', 'notion-duplicate'),
        duplicate: true,
        changed: true,
      },
    ];

    const merged = buildSyncConflictMerge(conflict(), rows, { 'delete-remote': 'local' });

    expect(merged.attrs?.jottathingDeleteNotionBlockIds).toEqual(['notion-delete']);
    expect(merged.content).toEqual([]);
  });
});

describe('createSyncConflictRows', () => {
  it('requires choices for two-sided edits and either-side deletion conflicts', () => {
    const baseContent = document([
      block('both-edited', 'base text'),
      block('remote-deleted', 'base text'),
    ]);
    const rows = createSyncConflictRows({
      ...conflict(),
      baseContent,
      localContent: document([
        block('both-edited', 'local text'),
        block('remote-deleted', 'local text'),
      ]),
      remoteContent: document([block('both-edited', 'Notion text')]),
    });

    expect(rows[0]).toMatchObject({
      bothEdited: true,
      needsChoice: true,
      choice: '',
    });
    expect(rows[1]).toMatchObject({
      notionDeleted: true,
      needsChoice: true,
      choice: '',
    });
    expect(hasUnresolvedSyncConflictRows(rows, {})).toBe(true);
  });

  it('prompts on a changed remote version of a locally deleted block', () => {
    const rows = createSyncConflictRows({
      ...conflict(),
      baseContent: document([block('deleted-local', 'base text')]),
      localContent: document([]),
      remoteContent: document([block('deleted-local', 'Notion edit')]),
    });

    expect(rows[0]).toMatchObject({
      localDeleted: true,
      notionChanged: true,
      needsChoice: true,
      choice: '',
    });
  });

  it('marks identical new additions as duplicates requiring an explicit choice', () => {
    const rows = createSyncConflictRows({
      ...conflict(),
      localContent: document([block('local-new', 'same text')]),
      remoteContent: document([block('notion-new', 'same text', 'notion-new')]),
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ duplicate: true, needsChoice: true, choice: '' });
  });

  it('automatically preserves project source metadata when only the remote copy remains', () => {
    const base = projectSource('base');
    const remote = projectSource('Notion edit');
    const conflictValue: SyncContentConflict = {
      ...conflict(),
      targetType: 'project',
      baseContent: document([base]),
      localContent: document([]),
      remoteContent: document([remote]),
    };
    const rows = createSyncConflictRows(conflictValue);

    expect(rows[0]).toMatchObject({
      internal: true,
      localDeleted: true,
      notionChanged: true,
      needsChoice: false,
      choice: 'notion',
    });
    expect(hasUnresolvedSyncConflictRows(rows, {})).toBe(false);
    const merged = buildSyncConflictMerge(
      conflictValue,
      rows,
      Object.fromEntries(rows.map((row) => [row.id, row.choice ?? ''])),
    );
    expect(merged.content?.[0].content?.[0].text).toContain('Notion edit');
  });
});

describe('syncConflictDiffParts', () => {
  it('keeps identical content as one context part', () => {
    expect(syncConflictDiffParts(block('same', 'same text'), block('same', 'same text')))
      .toEqual([{ kind: 'context', text: 'same text' }]);
  });

  it('preserves surrounding words and spaces around a replacement', () => {
    expect(syncConflictDiffParts(block('local', 'The quick fox'), block('notion', 'The brave fox')))
      .toEqual([
        { kind: 'context', text: 'The ' },
        { kind: 'removed', text: 'quick' },
        { kind: 'added', text: 'brave' },
        { kind: 'context', text: ' fox' },
      ]);
  });

  it('bounds large comparisons by showing a whole-block replacement', () => {
    const localText = 'old '.repeat(401);
    const notionText = 'new '.repeat(401);
    expect(syncConflictDiffParts(block('local', localText), block('notion', notionText))).toEqual([
      { kind: 'removed', text: localText.trim() },
      { kind: 'added', text: notionText.trim() },
    ]);
  });
});

describe('sync conflict block matching', () => {
  it('uses only non-empty string IDs when building review rows', () => {
    const rows = createSyncConflictRows({
      ...conflict(),
      localContent: document([
        block('block-1', 'text'),
        { type: 'paragraph', attrs: { jottathingBlockId: '' } },
        { type: 'paragraph', attrs: { jottathingBlockId: 12 } },
      ]),
      remoteContent: null,
    });

    expect(rows.map(({ id }) => id)).toEqual(['block-1', 'local-1', 'local-2']);
  });

  it('matches uploads without comparing changing identity or upload state', () => {
    const uploaded = (id: string, src: string) => ({
      type: 'image',
      attrs: {
        jottathingBlockId: id,
        notionBlockId: `notion-${id}`,
        notionFileUploadId: 'upload-1',
        uploadState: id,
        src,
      },
    });
    const rows = createSyncConflictRows({
      ...conflict(),
      localContent: document([uploaded('local', 'blob:old')]),
      remoteContent: document([uploaded('remote', 'https://files.example/image.png')]),
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ duplicate: true, needsChoice: true, choice: '' });
  });

  it('keeps ordinary media URL changes as separate review rows', () => {
    const rows = createSyncConflictRows({
      ...conflict(),
      localContent: document([{
        type: 'image',
        attrs: { jottathingBlockId: 'local', src: 'https://files.example/a.png' },
      }]),
      remoteContent: document([{
        type: 'image',
        attrs: { jottathingBlockId: 'remote', src: 'https://files.example/b.png' },
      }]),
    });

    expect(rows).toHaveLength(2);
  });

  it('formats missing blocks and media using stable, readable labels', () => {
    expect(syncConflictBlockText()).toBe('Block deleted');
    expect(syncConflictBlockText({ type: 'paragraph' })).toBe('Empty paragraph');
    expect(syncConflictBlockText({
      type: 'image',
      attrs: { src: 'https://files.example.test/page/image.png?expires=old' },
    })).toBe('image: page/image.png');
  });
});

function block(id: string, text: string, notionBlockId?: string) {
  return {
    type: 'paragraph',
    attrs: {
      jottathingBlockId: id,
      ...(notionBlockId ? { notionBlockId } : {}),
    },
    content: [{ type: 'text', text }],
  };
}

function document(content: NonNullable<DocumentContent['content']>): DocumentContent {
  return { type: 'doc', content };
}

function projectSource(text: string): DocumentContent {
  return {
    type: 'codeBlock',
    attrs: { jottathingBlockId: 'source:block-1' },
    content: [{ type: 'text', text: `jottathing_source_v1:${text}` }],
  };
}

function conflict(): SyncContentConflict {
  return {
    targetType: 'page',
    targetId: 'page-1',
    targetTitle: 'Page',
    localContent: { type: 'doc', content: [] },
    remoteContent: { type: 'doc', content: [] },
  };
}
