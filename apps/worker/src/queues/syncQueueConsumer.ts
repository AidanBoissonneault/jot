/**
 * @file Consumes content-free synchronization references and records outcomes.
 * @author Aidan Boissonneault
 * @lastModified September 2026
 */

import {
  applyBlockOpsToNotionForInstallation,
  initSingletons,
  pushPageToNotionForInstallation,
  supabase,
  syncProjectToNotionForInstallation,
} from '../services/workerRuntime.js';
import type {
  SyncQueueMessage,
  SyncQueueReference,
  WorkerEnv,
} from '../types.js';
import { isUnmappedNotionContentError } from '../managedBlocks.js';
import { safeErrorMetadata, safeNotionErrorMetadata } from '../workerUtils.js';
import { notionApiHttpFailure } from '../notionRequest.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Processes and acknowledges or retries one Cloudflare Queue batch. */
export async function processSyncQueue(
  batch: MessageBatch<SyncQueueReference>,
  env: WorkerEnv,
): Promise<void> {
  initSingletons(env);

  for (const message of batch.messages) {
    const queuedJob = await readQueuedSyncJob(message, env);
    if (queuedJob) {
      await processQueuedSyncJob(message, queuedJob.jobId, queuedJob.job, env);
    }
  }
}

/** Loads a validated payload and settles references that no longer need processing. */
async function readQueuedSyncJob(
  message: Message<SyncQueueReference>,
  env: WorkerEnv,
): Promise<{ jobId: string; job: SyncQueueMessage } | undefined> {
  const jobId = message.body?.jobId;
  if (typeof jobId !== 'string' || !UUID_PATTERN.test(jobId)) {
    message.ack();
    return undefined;
  }

  try {
    const { data: payloadRow, error: payloadReadError } = await supabase
      .from('jottathing_sync_queue_payloads')
      .select('installation_id, payload, status')
      .eq('id', jobId)
      .maybeSingle();
    if (payloadReadError) throw new Error('Unable to load the queued sync payload.');

    // Account deletion cascades these payload rows. Any remaining queue
    // reference contains only a random UUID and can safely be discarded.
    if (!payloadRow) {
      message.ack();
      return undefined;
    }

    if (payloadRow.status === 'processed') {
      await removeQueuedPayload(jobId);
      await notifyQueueIdleIfDrained(env, String(payloadRow.installation_id));
      message.ack();
      return undefined;
    }

    const job = payloadRow.payload;
    if (
      !isSyncQueueMessage(job) ||
      String(payloadRow.installation_id) !== String(job.installationId)
    ) {
      await markAndRemoveQueuedPayload(jobId);
      await notifyQueueIdleIfDrained(env, String(payloadRow.installation_id));
      message.ack();
      return undefined;
    }

    return { jobId, job };
  } catch (error) {
    console.error('[queue] payload lookup failed', safeErrorMetadata(error));
    message.retry();
    return undefined;
  }
}

/** Applies one stored sync job and records its outcome. */
async function processQueuedSyncJob(
  message: Message<SyncQueueReference>,
  jobId: string,
  job: SyncQueueMessage,
  env: WorkerEnv,
): Promise<void> {
  let syncRow: { local_version: number } | null | undefined;
  let syncOperationSucceeded = false;

  try {
    const installationId = String(job.installationId);
    const queuedVersion = job.queuedVersion;
    console.log('[queue] processing', job.type, 'v', queuedVersion);

    const row = await getOrRepairSyncRow(job);
    syncRow = row;

    if (row.local_version < queuedVersion) {
      throw new Error('The queued version is missing from durable sync state.');
    }

    // Older full-page snapshots can be discarded. Incremental block batches
    // still run every chunk so the remote page is not left partially applied.
    if (job.type !== 'block_op' && row.local_version > queuedVersion) {
      console.log('[queue] skipped stale', job.type, 'v', queuedVersion, 'latest', row.local_version);
      await markAndRemoveQueuedPayload(jobId);
      await notifyQueueIdleIfDrained(env, installationId);
      message.ack();
      return;
    }

    const { error: syncingError } = await supabase
      .from('notion_block_sync')
      .update({ status: 'syncing', updated_at: new Date().toISOString() })
      .eq('installation_id', job.installationId)
      .eq('local_id', job.localId)
      .eq('local_version', queuedVersion);
    if (syncingError) throw new Error('Unable to mark the sync as active.');

    const notionBlockId = await applyQueuedSyncMutation(job, installationId);
    await markQueuedSyncAsCompleted(job, row, notionBlockId, env);

    syncOperationSucceeded = true;
    await markAndRemoveQueuedPayload(jobId);
    await notifyQueueIdleIfDrained(env, installationId);
    console.log('[queue] done', job.type);
    message.ack();
  } catch (error) {
    await handleQueuedSyncFailure(message, jobId, job, env, syncRow, syncOperationSucceeded, error);
  }
}

/** Loads durable version state and repairs a missing row without losing a concurrent update. */
async function getOrRepairSyncRow(job: SyncQueueMessage): Promise<{ local_version: number }> {
  let { data: row, error } = await supabase
    .from('notion_block_sync')
    .select('local_version')
    .eq('installation_id', job.installationId)
    .eq('local_id', job.localId)
    .maybeSingle();
  if (error) throw new Error('Unable to load the current sync version.');
  if (row) return row;

  const { error: insertError } = await supabase
    .from('notion_block_sync')
    .insert({
      installation_id: job.installationId,
      local_id: job.localId,
      entity_type: job.type,
      local_version: job.queuedVersion,
      status: 'pending',
    });
  if (!insertError) return { local_version: job.queuedVersion };

  // A concurrent queue delivery may have repaired the same row first.
  const { data: repairedRow, error: rereadError } = await supabase
    .from('notion_block_sync')
    .select('local_version')
    .eq('installation_id', job.installationId)
    .eq('local_id', job.localId)
    .maybeSingle();
  if (rereadError || !repairedRow) throw new Error('Unable to restore the sync version state.');
  return repairedRow;
}

/** Applies the Notion mutation carried by a validated queue payload. */
async function applyQueuedSyncMutation(job: SyncQueueMessage, installationId: string): Promise<string | null> {
  if (job.type === 'block_op') {
    const { page, project } = job.payload;
    if (!page || !project) throw new Error('Block queue job is missing page or project context.');
    const result = await applyBlockOpsToNotionForInstallation(installationId, {
      ops: job.payload.ops,
      page: { ...page, content: { type: 'doc', content: [] } },
      project: { ...project, stateContent: { type: 'doc', content: [] } },
      selectedParentPageId: job.payload.selectedParentPageId,
    });
    return result?.page?.notionPageId ?? null;
  }

  if (job.type === 'page') {
    const { page, project } = job.payload;
    if (!page || !project) throw new Error('Page queue job is missing page or project context.');
    const result = await pushPageToNotionForInstallation(installationId, {
      page,
      project,
      selectedParentPageId: job.payload.selectedParentPageId,
    });
    return result?.page?.notionPageId ?? null;
  }

  const { project } = job.payload;
  if (!project) throw new Error('Project queue job is missing project context.');
  await syncProjectToNotionForInstallation(installationId, {
    project,
    selectedParentPageId: job.payload.selectedParentPageId,
  });
  return null;
}

/** Marks the final current batch as synced, unless a newer edit won the race. */
async function markQueuedSyncAsCompleted(
  job: SyncQueueMessage,
  row: { local_version: number },
  notionBlockId: string | null,
  env: WorkerEnv,
): Promise<void> {
  const isFinalBatch = job.type !== 'block_op' || job.batchIndex === job.batchSize - 1;
  if (!isFinalBatch || row.local_version > job.queuedVersion) return;

  const { data: syncedRow, error } = await supabase
    .from('notion_block_sync')
    .update({
      status: 'synced',
      synced_version: job.queuedVersion,
      notion_block_id: notionBlockId,
      updated_at: new Date().toISOString(),
    })
    .eq('installation_id', job.installationId)
    .eq('local_id', job.localId)
    .eq('local_version', job.queuedVersion)
    .select('local_version')
    .maybeSingle();
  if (error) throw new Error('Unable to persist the completed sync state.');

  const installationId = String(job.installationId);
  if (syncedRow) {
    const doStub = env.SYNC_EVENTS.get(env.SYNC_EVENTS.idFromName(installationId));
    await doStub.fetch(new Request('http://do/notify', {
      method: 'POST',
      body: JSON.stringify({
        status: 'synced',
        pageId: job.localId,
        notionBlockId,
        version: job.queuedVersion,
      }),
    })).catch(() => undefined);
    return;
  }

  // A newer edit may have been queued while Notion was being updated.
  const { data: latestRow, error: latestError } = await supabase
    .from('notion_block_sync')
    .select('local_version')
    .eq('installation_id', job.installationId)
    .eq('local_id', job.localId)
    .maybeSingle();
  if (latestError || !latestRow || latestRow.local_version <= job.queuedVersion) {
    throw new Error('Unable to confirm the completed sync version.');
  }
}

/** Marks only the queued version's sync row as failed. */
function markSyncRowFailed(job: SyncQueueMessage) {
  return supabase
    .from('notion_block_sync')
    .update({ status: 'failed', updated_at: new Date().toISOString() })
    .eq('installation_id', job.installationId)
    .eq('local_id', job.localId)
    .eq('local_version', job.queuedVersion);
}

/** Applies the failure policy for a job that did not complete. */
async function handleQueuedSyncFailure(
  message: Message<SyncQueueReference>,
  jobId: string,
  job: SyncQueueMessage,
  env: WorkerEnv,
  syncRow: { local_version: number } | null | undefined,
  syncOperationSucceeded: boolean,
  error: unknown,
): Promise<void> {
  console.error(
    '[queue] failed',
    job.type,
    error && typeof error === 'object' && 'isNotionApiError' in error
      ? safeNotionErrorMetadata(error)
      : safeErrorMetadata(error),
  );

  // The Notion write and sync state succeeded. Retry cleanup without marking
  // the operation itself as failed.
  if (syncOperationSucceeded) {
    message.retry();
    return;
  }

  if (isRevokedInstallationError(error)) {
    await ackAfterPayloadCleanup(message, jobId, env, String(job.installationId));
    return;
  }

  const { error: failureStateError } = await markSyncRowFailed(job);
  if (failureStateError) {
    console.error('[queue] failed sync state could not be persisted', safeErrorMetadata(failureStateError));
    message.retry();
    return;
  }

  if (!syncRow || syncRow.local_version <= job.queuedVersion) {
    await notifyQueueJobFailed(job, error, env);
  }

  if (!isUnmappedNotionContentError(error) && !isPermanentNotionFailure(error)) {
    message.retry();
    return;
  }

  try {
    // The extension already removed accepted operations from its local outbox.
    await retainFailedQueuePayload(jobId, job);
    await notifyQueueIdleIfDrained(env, String(job.installationId));
    message.ack();
  } catch (retentionError) {
    console.error('[queue] failed sync payload could not be retained', safeErrorMetadata(retentionError));
    message.retry();
  }
}

/** Publishes a user-facing failure only if this job is still current. */
async function notifyQueueJobFailed(job: SyncQueueMessage, error: unknown, env: WorkerEnv): Promise<void> {
  const errorRecord = error && typeof error === 'object'
    ? error as { code?: unknown; status?: unknown }
    : undefined;
  const statusCode = typeof errorRecord?.status === 'number' ? errorRecord.status : undefined;
  const errorMessage = error instanceof Error ? error.message : String(error);
  const userMessage = notionApiHttpFailure(error)?.body.message ?? errorMessage;
  const doStub = env.SYNC_EVENTS.get(env.SYNC_EVENTS.idFromName(String(job.installationId)));
  await doStub.fetch(new Request('http://do/notify', {
    method: 'POST',
    body: JSON.stringify({
      status: 'failed',
      pageId: job.localId,
      message: userMessage,
      ...(typeof errorRecord?.code === 'string' ? { code: errorRecord.code } : {}),
      ...(statusCode !== undefined ? { statusCode } : {}),
    }),
  })).catch(() => undefined);
}

/** Removes a processed or discarded payload from Supabase. */
async function removeQueuedPayload(jobId: string): Promise<void> {
  const { error } = await supabase
    .from('jottathing_sync_queue_payloads')
    .delete()
    .eq('id', jobId);
  if (error) throw new Error('Unable to remove the processed sync payload.');
}

/** Marks the payload processed before removal so a cleanup retry cannot repeat its Notion mutation. */
async function markAndRemoveQueuedPayload(jobId: string): Promise<void> {
  const { error: updateError } = await supabase
    .from('jottathing_sync_queue_payloads')
    .update({ status: 'processed', updated_at: new Date().toISOString() })
    .eq('id', jobId);
  if (updateError) throw new Error('Unable to mark the sync payload as processed.');
  await removeQueuedPayload(jobId);
}

async function ackAfterPayloadCleanup(
  message: Message<SyncQueueReference>,
  jobId: string,
  env: WorkerEnv,
  installationId: string,
): Promise<void> {
  try {
    await markAndRemoveQueuedPayload(jobId);
    await notifyQueueIdleIfDrained(env, installationId);
    message.ack();
  } catch (cleanupError) {
    console.error('[queue] discarded payload cleanup failed', safeErrorMetadata(cleanupError));
    message.retry();
  }
}

/** Retains a permanently failed operation for a later explicit retry. */
async function retainFailedQueuePayload(
  jobId: string,
  job: SyncQueueMessage,
): Promise<void> {
  const failedJob: SyncQueueMessage = {
    ...job,
    deadLetteredAt: new Date().toISOString(),
  };
  delete failedJob.deliveryPendingAt;

  const { data: retained, error: retainError } = await supabase
    .from('jottathing_sync_queue_payloads')
    .update({ payload: failedJob, updated_at: new Date().toISOString() })
    .eq('id', jobId)
    .eq('status', 'pending')
    .select('id')
    .maybeSingle();
  if (retainError) throw new Error('Unable to retain the failed sync payload.');
  if (retained) return;

  const { data: current, error: readError } = await supabase
    .from('jottathing_sync_queue_payloads')
    .select('status')
    .eq('id', jobId)
    .maybeSingle();
  if (readError) throw new Error('Unable to verify the failed sync payload.');
  if (!current || current.status === 'processed') return;
  throw new Error('Unable to retain the failed sync payload.');
}

/** Dead-letter references while retaining the accepted payload for a later manual retry. */
export async function processSyncDeadLetterQueue(
  batch: MessageBatch<SyncQueueReference>,
  env: WorkerEnv,
): Promise<void> {
  initSingletons(env);
  for (const message of batch.messages) {
    const jobId = message.body?.jobId;
    if (typeof jobId !== 'string' || !UUID_PATTERN.test(jobId)) {
      message.ack();
      continue;
    }
    try {
      const { data: payloadRow, error: payloadError } = await supabase
        .from('jottathing_sync_queue_payloads')
        .select('installation_id, payload, status')
        .eq('id', jobId)
        .maybeSingle();
      if (payloadError) throw new Error('Unable to read the dead-letter sync payload.');
      if (!payloadRow) {
        message.ack();
        continue;
      }

      const job = payloadRow.payload;
      if (!isSyncQueueMessage(job)) {
        console.error('[queue] dead-letter payload is invalid; retained for inspection');
        message.ack();
        continue;
      }

      const deadLetteredJob = { ...job, deadLetteredAt: new Date().toISOString() };
      const { error: retainError } = await supabase
        .from('jottathing_sync_queue_payloads')
        .update({ payload: deadLetteredJob, updated_at: new Date().toISOString() })
        .eq('id', jobId)
        .eq('status', 'pending');
      if (retainError) throw new Error('Unable to retain the dead-letter sync payload.');

      const { error: syncStateError } = await markSyncRowFailed(job);
      if (syncStateError) throw new Error('Unable to mark the dead-letter sync as failed.');

      const doStub = env.SYNC_EVENTS.get(env.SYNC_EVENTS.idFromName(String(job.installationId)));
      await doStub.fetch(new Request('http://do/notify', {
        method: 'POST',
        body: JSON.stringify({
          status: 'failed',
          pageId: job.localId,
          deadLettered: true,
          message: 'Sync paused after repeated failures. Your local note is saved; use Sync to retry.',
        }),
      })).catch(() => undefined);
      message.ack();
    } catch (error) {
      console.error('[queue] dead-letter payload retention failed', safeErrorMetadata(error));
      message.retry();
    }
  }
}

/** Pushes a queue-idle event after the final active payload for this account is removed. */
async function notifyQueueIdleIfDrained(env: WorkerEnv, installationId: string): Promise<void> {
  try {
    const { data: pending, error } = await supabase
      .from('jottathing_sync_queue_payloads')
      .select('id')
      .eq('installation_id', installationId)
      .eq('status', 'pending')
      .is('payload->>deadLetteredAt', null)
      .limit(1);
    if (error) throw new Error('Unable to check remaining sync queue work.');
    if (pending?.length) return;

    const doStub = env.SYNC_EVENTS.get(env.SYNC_EVENTS.idFromName(installationId));
    const response = await doStub.fetch(new Request('http://do/notify', {
      method: 'POST',
      body: JSON.stringify({ status: 'queue_idle' }),
    }));
    if (!response.ok) throw new Error('Unable to publish the queue-idle event.');
  } catch (error) {
    // Clients also recheck once when an EventSource reconnects, so a failed
    // notification does not strand a waiting reload indefinitely.
    console.error('[queue] idle notification failed', safeErrorMetadata(error));
  }
}

function isSyncQueueMessage(value: unknown): value is SyncQueueMessage {
  if (!value || typeof value !== 'object') return false;
  const job = value as Partial<SyncQueueMessage>;
  const payload = job.payload;
  const hasCurrentPayload = Boolean(
    payload &&
    typeof payload === 'object' &&
    !Array.isArray(payload) &&
    (job.type !== 'block_op' || Array.isArray((payload as { ops?: unknown }).ops)),
  );
  return (
    (job.type === 'block_op' || job.type === 'page' || job.type === 'project') &&
    (typeof job.installationId === 'number' || typeof job.installationId === 'string') &&
    typeof job.localId === 'string' &&
    typeof job.queuedVersion === 'number' &&
    Number.isSafeInteger(job.queuedVersion) &&
    job.queuedVersion > 0 &&
    hasCurrentPayload
  );
}

/** Avoids retrying Notion requests that require a user or permission change. */
function isPermanentNotionFailure(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const detail = error as { isNotionApiError?: unknown; status?: unknown };
  return detail.isNotionApiError === true &&
    typeof detail.status === 'number' &&
    [400, 401, 403, 404].includes(detail.status);
}

/** Discards queue work whose installation was removed during account deletion. */
function isRevokedInstallationError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === 'object' &&
      'code' in error &&
      (error as { code?: unknown }).code === 'installation_revoked',
  );
}
