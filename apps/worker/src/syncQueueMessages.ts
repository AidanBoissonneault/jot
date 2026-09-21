/**
 * @file Groups, compacts, sizes, and chunks local block operations for Cloudflare Queue messages.
 * @author Aidan Boissonneault
 * @lastModified September 2026
 */

import type { SyncBlockOperation } from '../../../src/types/sync.js';
import { compactPendingSyncOps } from '../../../src/services/syncQueue.js';
import type { Identifier } from './types.js';

export const MAX_SYNC_QUEUE_MESSAGE_BYTES = 120 * 1024;

/** Describes a queue operation with repeated page context removed. */
export type ContextFreeSyncOperation = Omit<SyncBlockOperation, 'payload'> & {
  inkwellBlockId: string | undefined;
  payload: Omit<SyncBlockOperation['payload'], 'page' | 'project' | 'selectedParentPageId'>;
};

/** Describes compacted operations and version information for one page. */
export interface SyncOperationGroup {
  ops: SyncBlockOperation[];
  pageId: string;
  version: number;
}

/** Describes the shared envelope used while chunking block queue messages. */
export interface QueueJobBase {
  batchId: string;
  installationId: Identifier;
  localId: string;
  pageId: string;
  payload: {
    page: SyncBlockOperation['payload']['page'];
    project: SyncBlockOperation['payload']['project'];
    selectedParentPageId: string | undefined;
  };
  projectId: string;
  type: 'block_op';
}

/**
 * Groups pending operations by page, compacts them, and orders groups by version.
 * @param operations - Pending local synchronization operations.
 * @returns Compact page-specific operation groups.
 */
export function syncOpGroupsByPage(operations: SyncBlockOperation[]): SyncOperationGroup[] {
  const groups = new Map<string, SyncBlockOperation[]>();
  for (const operation of operations) {
    if (!operation.pageId || !operation.opId) continue;
    const group = groups.get(operation.pageId) ?? [];
    group.push(operation);
    groups.set(operation.pageId, group);
  }

  return Array.from(groups.entries())
    .map(([pageId, pageOperations]: [string, SyncBlockOperation[]]): SyncOperationGroup => {
      const compacted = compactPendingSyncOps(pageOperations);
      return {
        pageId,
        ops: compacted,
        version: Math.max(...compacted.map(syncOpSortValue)),
      };
    })
    .filter((group: SyncOperationGroup): boolean => group.ops.length > 0)
    .sort((first: SyncOperationGroup, second: SyncOperationGroup): number => first.version - second.version);
}

/**
 * Removes page and project snapshots already carried by the queue job envelope.
 * @param operation - Full local synchronization operation.
 * @returns Context-free operation suitable for queue transport.
 */
export function syncOpWithoutRepeatedContext(operation: SyncBlockOperation): ContextFreeSyncOperation {
  const { page: _page, project: _project, selectedParentPageId: _parent, ...payload } = operation.payload;
  return { ...operation, inkwellBlockId: operation.inkwellBlockId, payload };
}

/**
 * Measures a value after the same JSON and UTF-8 encoding used by Queue.
 * @param value - Queue payload candidate.
 * @returns Encoded byte length.
 */
export function queueMessageBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

/**
 * Partitions block operations into Queue-safe message chunks.
 * @param jobBase - Shared queue job envelope.
 * @param operations - Context-free operations to partition.
 * @param queuedVersion - Local version represented by the batch.
 * @returns Queue-safe chunks, or null when one operation is too large.
 */
export function chunkSyncOpsForQueue(
  jobBase: QueueJobBase,
  operations: ContextFreeSyncOperation[],
  queuedVersion: number,
): ContextFreeSyncOperation[][] | null {
  const chunks: ContextFreeSyncOperation[][] = [];
  let current: ContextFreeSyncOperation[] = [];

  for (const operation of operations) {
    const singleJob = {
      ...jobBase,
      queuedVersion,
      batchIndex: chunks.length,
      batchSize: operations.length,
      payload: { ...jobBase.payload, ops: [operation] },
    };
    if (queueMessageBytes(singleJob) > MAX_SYNC_QUEUE_MESSAGE_BYTES) return null;

    const candidate = [...current, operation];
    const candidateJob = {
      ...jobBase,
      queuedVersion,
      batchIndex: chunks.length,
      batchSize: operations.length,
      payload: { ...jobBase.payload, ops: candidate },
    };
    if (queueMessageBytes(candidateJob) <= MAX_SYNC_QUEUE_MESSAGE_BYTES) {
      current = candidate;
      continue;
    }
    chunks.push(current);
    current = [operation];
  }

  if (current.length) chunks.push(current);
  return chunks;
}

/**
 * Reads the stable local ordering value for an operation.
 * @param operation - Local synchronization operation.
 * @returns Local version with sequence fallback.
 */
function syncOpSortValue(operation: SyncBlockOperation): number {
  return Number(operation.localVersion ?? operation.sequence ?? 0);
}
