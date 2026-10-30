import type { DocumentContent } from '../types/capture.js';
import type { SyncContentConflict } from '../types/sync.js';
import { autoMergeUniquePageAdditions } from './syncConflictAutoMerge.js';

export type SyncConflictReviewBatch = {
  inlineConflicts: SyncContentConflict[];
  projectConflicts: SyncContentConflict[];
  autoMergedAdditions: number;
  autoMergeError: string;
};

export type SyncResyncSummary = {
  blockedMessage?: string;
  blockedProjectCount: number;
  reloadedFromNotion: boolean;
  failedUploadCount: number;
  remainingCount: number;
};

/** Auto-merges safe page additions and retains everything else for review. */
export async function reviewSyncConflicts(
  conflicts: SyncContentConflict[],
  resolveConflict: (
    targetType: SyncContentConflict['targetType'],
    targetId: string,
    content: DocumentContent,
  ) => Promise<void>,
): Promise<SyncConflictReviewBatch> {
  const batch: SyncConflictReviewBatch = {
    inlineConflicts: [],
    projectConflicts: [],
    autoMergedAdditions: 0,
    autoMergeError: '',
  };

  for (const conflict of conflicts) {
    const mergedContent = autoMergeUniquePageAdditions(conflict);
    if (!mergedContent) {
      retainForReview(batch, conflict);
      continue;
    }

    try {
      await resolveConflict(conflict.targetType, conflict.targetId, mergedContent);
      batch.autoMergedAdditions += 1;
    } catch (error) {
      retainForReview(batch, conflict);
      batch.autoMergeError ||= error instanceof Error
        ? error.message
        : 'Unable to sync the new blocks automatically. Your local changes remain saved.';
    }
  }
  return batch;
}

function retainForReview(batch: SyncConflictReviewBatch, conflict: SyncContentConflict): void {
  const target = conflict.targetType === 'page' ? batch.inlineConflicts : batch.projectConflicts;
  target.push(conflict);
}

/** Keeps resync status wording and conflict-modal error state in one place. */
export function getSyncResyncFeedback(
  result: SyncResyncSummary,
  hadPendingLocalChanges: boolean,
  review: SyncConflictReviewBatch,
  storeErrorMessage: string,
): { message: string; conflictError?: string } {
  const projectCount = review.projectConflicts.length;
  const pageCount = review.inlineConflicts.length;
  const reviewFeedback = projectCount
    ? {
      message: review.autoMergeError || `${pageCount ? 'Page sync reviews are ready inside their documents. ' : ''}Review ${projectCount} project sync ${plural(projectCount, 'item', 'items')}.`,
      conflictError: review.autoMergeError,
    }
    : pageCount
      ? {
        message: review.autoMergeError || `${pageCount} page sync ${plural(pageCount, 'review is', 'reviews are')} ready inside ${plural(pageCount, 'the affected document', 'their affected documents')}.`,
        conflictError: review.autoMergeError,
      }
      : undefined;

  const statusMessage = review.autoMergedAdditions
    ? 'New Notion blocks were merged with local content and synced.'
    : getSyncStatusMessage(result, hadPendingLocalChanges, storeErrorMessage);
  const message = reviewFeedback?.message ?? statusMessage;
  const withUploadWarning = result.failedUploadCount
    ? `${message} ${result.failedUploadCount} Notion upload${result.failedUploadCount === 1 ? ' needs' : 's need'} attention. Other sync work continued; your local notes remain saved.`
    : message;
  const conflictError = reviewFeedback?.conflictError ?? (review.autoMergedAdditions ? '' : undefined);

  return {
    message: withUploadWarning,
    ...(conflictError === undefined ? {} : { conflictError }),
  };
}

function getSyncStatusMessage(
  result: SyncResyncSummary,
  hadPendingLocalChanges: boolean,
  storeErrorMessage: string,
): string {
  if (result.blockedProjectCount) {
    return result.blockedMessage
      ? `${result.blockedMessage} Your local snapshot remains saved on this device.`
      : 'Notion still has content that needs review. Your local snapshot remains saved on this device.';
  }
  if (result.remainingCount) {
    return storeErrorMessage || 'Some changes remain saved locally and are waiting to sync.';
  }
  if (result.reloadedFromNotion && hadPendingLocalChanges) {
    return 'Notion content was merged with your local changes and resynced.';
  }
  return hadPendingLocalChanges
    ? 'Changes sent to Notion. They may take a moment to appear.'
    : 'Up to date with Notion.';
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}
