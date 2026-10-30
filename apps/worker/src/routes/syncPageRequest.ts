/** @file Reads bounded page-sync JSON bodies for push, resync, and pull routes. */
import type { SyncPageRequest } from '../../../../src/types/sync.js';
import { MAX_SYNC_JSON_REQUEST_BYTES, readLimitedJsonBody } from '../workerUtils.js';

/** Returns null for oversized bodies and an empty object for missing or invalid JSON. */
export async function readSyncPageRequestBody(
  request: Request,
): Promise<Partial<SyncPageRequest> | null> {
  const parsed = await readLimitedJsonBody<SyncPageRequest>(request, MAX_SYNC_JSON_REQUEST_BYTES);
  return parsed.tooLarge ? null : (parsed.body ?? {}) as Partial<SyncPageRequest>;
}
