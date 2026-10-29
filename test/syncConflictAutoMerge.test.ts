import { describe, expect, it } from 'vitest';
import { autoMergeUniquePageAdditions } from '@/src/lib/syncConflictAutoMerge';
import type { DocumentContent } from '@/src/types/capture';
import type { SyncContentConflict } from '@/src/types/sync';

const block = (id: string, text: string): DocumentContent => ({
  type: 'paragraph',
  attrs: { jottathingBlockId: id },
  content: [{ type: 'text', text }],
});

const document = (content: DocumentContent[]): DocumentContent => ({ type: 'doc', content });

function conflict(overrides: Partial<SyncContentConflict> = {}): SyncContentConflict {
  const shared = block('shared', 'same on both sides');
  return {
    targetType: 'page',
    targetId: 'page-1',
    targetTitle: 'Notes',
    baseContent: document([shared]),
    localContent: document([shared, block('local-addition', 'local')]),
    remoteContent: document([shared, block('remote-addition', 'remote')]),
    ...overrides,
  };
}

describe('automatic merge of independent page additions', () => {
  it('keeps local content and appends a distinct remote addition', () => {
    const result = autoMergeUniquePageAdditions(conflict());

    expect(result?.content).toEqual([
      block('shared', 'same on both sides'),
      block('local-addition', 'local'),
      block('remote-addition', 'remote'),
    ]);
    expect(result?.attrs).toMatchObject({
      jottathingConflictResolution: true,
      jottathingPreserveRemoteBlocks: true,
    });
  });

  it('does not auto-merge projects, missing remote content, or unchanged snapshots', () => {
    expect(autoMergeUniquePageAdditions(conflict({ targetType: 'project' }))).toBeUndefined();
    expect(autoMergeUniquePageAdditions(conflict({ remoteContent: null }))).toBeUndefined();
    expect(autoMergeUniquePageAdditions(conflict({
      remoteContent: document([block('shared', 'same on both sides')]),
    }))).toBeUndefined();
  });

  it('sends deleted or edited shared blocks to conflict review', () => {
    expect(autoMergeUniquePageAdditions(conflict({
      localContent: document([block('local-addition', 'local')]),
    }))).toBeUndefined();
    expect(autoMergeUniquePageAdditions(conflict({
      remoteContent: document([block('shared', 'remote edit'), block('remote-addition', 'remote')]),
    }))).toBeUndefined();
    expect(autoMergeUniquePageAdditions(conflict({ localChangedBlockIds: ['shared'] }))).toBeUndefined();
  });

  it('does not merge identical additions from either side', () => {
    expect(autoMergeUniquePageAdditions(conflict({
      localContent: document([block('shared', 'same on both sides'), block('local-addition', 'duplicate')]),
      remoteContent: document([block('shared', 'same on both sides'), block('remote-addition', 'duplicate')]),
    }))).toBeUndefined();
    expect(autoMergeUniquePageAdditions(conflict({
      remoteContent: document([
        block('shared', 'same on both sides'),
        block('remote-1', 'duplicate'),
        block('remote-2', 'duplicate'),
      ]),
    }))).toBeUndefined();
  });

  it('treats expiring signed media URLs as the same addition', () => {
    const image = (id: string, signature: string): DocumentContent => ({
      type: 'image',
      attrs: {
        jottathingBlockId: id,
        src: `https://prod-files-secure.s3.us-east-1.amazonaws.com/image.png?X-Amz-Signature=${signature}`,
      },
    });
    const shared = block('shared', 'same on both sides');

    expect(autoMergeUniquePageAdditions(conflict({
      localContent: document([shared, image('local-image', 'old')]),
      remoteContent: document([shared, image('remote-image', 'new')]),
    }))).toBeUndefined();
  });

  it('rejects content duplicates when remote blocks lack a stable ID', () => {
    const shared = block('shared', 'same on both sides');
    expect(autoMergeUniquePageAdditions(conflict({
      localContent: document([shared, block('local-addition', 'duplicate')]),
      remoteContent: document([shared, { type: 'paragraph', content: [{ type: 'text', text: 'duplicate' }] }]),
    }))).toBeUndefined();
  });
});
