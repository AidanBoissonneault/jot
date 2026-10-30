import { describe, expect, it, vi } from 'vitest';
import {
  getSyncResyncFeedback,
  reviewSyncConflicts,
  type SyncConflictReviewBatch,
  type SyncResyncSummary,
} from '@/src/lib/syncResync';
import type { DocumentContent } from '@/src/types/capture';
import type { SyncContentConflict } from '@/src/types/sync';

describe('reviewSyncConflicts', () => {
  it('auto-merges unique page additions and routes other conflicts to review', async () => {
    const uniquePage = conflict('unique-page', 'page', ['local note'], ['remote note']);
    const duplicatePage = conflict('duplicate-page', 'page', ['same note'], ['same note']);
    const project = conflict('project-1', 'project', [], ['project state']);
    const resolve = vi.fn(async () => undefined);

    const batch = await reviewSyncConflicts([uniquePage, duplicatePage, project], resolve);

    expect(batch).toMatchObject({
      inlineConflicts: [duplicatePage],
      projectConflicts: [project],
      autoMergedAdditions: 1,
      autoMergeError: '',
    });
    expect(resolve).toHaveBeenCalledOnce();
    expect(resolve.mock.calls[0]).toEqual([
      'page',
      'unique-page',
      expect.objectContaining({
        content: [block('local note'), block('remote note')],
      }),
    ]);
  });

  it('keeps a failed auto-merge in page review and reports the write error', async () => {
    const page = conflict('page-write-failure', 'page', ['local note'], ['remote note']);
    const resolve = vi.fn(async () => { throw new Error('write failed'); });

    const batch = await reviewSyncConflicts([page], resolve);

    expect(batch.inlineConflicts).toEqual([page]);
    expect(batch.autoMergedAdditions).toBe(0);
    expect(batch.autoMergeError).toBe('write failed');
  });

  it('uses the safe fallback when a conflict write rejects without an Error', async () => {
    const page = conflict('page-write-failure', 'page', ['local note'], ['remote note']);

    const batch = await reviewSyncConflicts([page], async () => Promise.reject('offline'));

    expect(batch.autoMergeError)
      .toBe('Unable to sync the new blocks automatically. Your local changes remain saved.');
  });
});

describe('getSyncResyncFeedback', () => {
  it('prioritizes project review, mentions page review, and appends upload warnings', () => {
    const review = reviewBatch({
      inlineConflicts: [conflict('page-1', 'page', [], [])],
      projectConflicts: [conflict('project-1', 'project', [], [])],
      autoMergeError: 'One addition could not be saved.',
    });

    expect(getSyncResyncFeedback(summary({ failedUploadCount: 2 }), false, review, ''))
      .toEqual({
        message: 'One addition could not be saved. 2 Notion uploads need attention. Other sync work continued; your local notes remain saved.',
        conflictError: 'One addition could not be saved.',
      });
  });

  it('clears an old conflict error when page review is ready', () => {
    const review = reviewBatch({ inlineConflicts: [conflict('page-1', 'page', [], [])] });

    expect(getSyncResyncFeedback(summary(), false, review, ''))
      .toEqual({
        message: '1 page sync review is ready inside the affected document.',
        conflictError: '',
      });
  });

  it('prioritizes an automatic merge over a blocked project result', () => {
    const review = reviewBatch({ autoMergedAdditions: 1 });

    expect(getSyncResyncFeedback(summary({ blockedProjectCount: 1 }), false, review, ''))
      .toEqual({
        message: 'New Notion blocks were merged with local content and synced.',
        conflictError: '',
      });
  });

  it.each([
    [summary({ blockedProjectCount: 1, blockedMessage: 'A project is blocked.' }), false, '', 'A project is blocked. Your local snapshot remains saved on this device.'],
    [summary({ blockedProjectCount: 1 }), false, '', 'Notion still has content that needs review. Your local snapshot remains saved on this device.'],
    [summary({ remainingCount: 2 }), false, 'Try again.', 'Try again.'],
    [summary({ remainingCount: 2 }), false, '', 'Some changes remain saved locally and are waiting to sync.'],
    [summary({ reloadedFromNotion: true }), true, '', 'Notion content was merged with your local changes and resynced.'],
    [summary(), true, '', 'Changes sent to Notion. They may take a moment to appear.'],
    [summary(), false, '', 'Up to date with Notion.'],
  ])('selects the expected status message', (result, hadPendingLocalChanges, storeError, message) => {
    expect(getSyncResyncFeedback(result, hadPendingLocalChanges, reviewBatch(), storeError).message)
      .toBe(message);
  });

  it('pluralizes page review and single upload warnings', () => {
    const review = reviewBatch({
      inlineConflicts: [conflict('page-1', 'page', [], []), conflict('page-2', 'page', [], [])],
    });

    expect(getSyncResyncFeedback(summary({ failedUploadCount: 1 }), false, review, '').message)
      .toBe('2 page sync reviews are ready inside their affected documents. 1 Notion upload needs attention. Other sync work continued; your local notes remain saved.');
  });
});

function conflict(
  id: string,
  targetType: SyncContentConflict['targetType'],
  localTexts: string[],
  remoteTexts: string[],
): SyncContentConflict {
  return {
    targetType,
    targetId: id,
    targetTitle: id,
    baseContent: document([]),
    localContent: document(localTexts.map(block)),
    remoteContent: document(remoteTexts.map(block)),
  };
}

function block(text: string): DocumentContent {
  return {
    type: 'paragraph',
    attrs: { jottathingBlockId: `${text}-id` },
    content: [{ type: 'text', text }],
  };
}

function document(content: DocumentContent[]): DocumentContent {
  return { type: 'doc', content };
}

function summary(overrides: Partial<SyncResyncSummary> = {}): SyncResyncSummary {
  return {
    blockedProjectCount: 0,
    reloadedFromNotion: false,
    failedUploadCount: 0,
    remainingCount: 0,
    ...overrides,
  };
}

function reviewBatch(overrides: Partial<SyncConflictReviewBatch> = {}): SyncConflictReviewBatch {
  return {
    inlineConflicts: [],
    projectConflicts: [],
    autoMergedAdditions: 0,
    autoMergeError: '',
    ...overrides,
  };
}
