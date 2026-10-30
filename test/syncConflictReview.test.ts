import { describe, expect, it } from 'vitest';
import {
  buildSyncConflictMerge,
  syncConflictDiffParts,
  type SyncConflictRow,
} from '@/src/lib/syncConflictReview';
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

function conflict(): SyncContentConflict {
  return {
    targetType: 'page',
    targetId: 'page-1',
    targetTitle: 'Page',
    localContent: { type: 'doc', content: [] },
    remoteContent: { type: 'doc', content: [] },
  };
}
