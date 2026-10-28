/**
 * @file Consumes content-free synchronization references and records outcomes.
 * @author Aidan Boissonneault
 * @lastModified September 2026
 */

import {
  applyBlockOpsToNotionForInstallation,
  initSingletons,
  legacyQueueOperation,
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
import { safeErrorMetadata } from '../workerUtils.js';
import { notionApiHttpFailure } from '../notionRequest.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Processes and acknowledges or retries one Cloudflare Queue batch. */
export async function processSyncQueue(
  batch: MessageBatch<SyncQueueReference>,
  env: WorkerEnv,
): Promise<void> {
  initSingletons(env);

  for (const message of batch.messages) {
    const referenceId = message.body?.jobId;
    const jobId = typeof referenceId === 'string' && UUID_PATTERN.test(referenceId)
      ? referenceId
      : undefined;
    // Drain jobs created by older releases without dropping accepted local edits.
    const legacyJob = !jobId && isSyncQueueMessage(message.body)
      ? message.body
      : undefined;
    if (!jobId && !legacyJob) {
      message.ack();
      continue;
    }

    let job: SyncQueueMessage | undefined = legacyJob;
    let syncRow: { local_version: number } | null | undefined;
    let syncOperationSucceeded = false;

    if (jobId) {
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
        continue;
      }

      if (payloadRow.status === 'processed') {
        await removeQueuedPayload(jobId);
        await notifyQueueIdleIfDrained(env, String(payloadRow.installation_id));
        message.ack();
        continue;
      }

      const storedJob = payloadRow.payload;
      if (
        !isSyncQueueMessage(storedJob) ||
        String(payloadRow.installation_id) !== String(storedJob.installationId)
      ) {
        await markAndRemoveQueuedPayload(jobId);
        await notifyQueueIdleIfDrained(env, String(payloadRow.installation_id));
        message.ack();
        continue;
      }
      job = storedJob;
      } catch (error) {
        console.error('[queue] payload lookup failed', safeErrorMetadata(error));
        message.retry();
        continue;
      }
    }

    try {
      if (!job) {
        message.ack();
        continue;
      }
      job = await ensureServerAssignedQueueVersion(job, jobId);
      const installationId = String(job.installationId);
      const queuedVersion = job.queuedVersion;
      console.log('[queue] processing', job.type, 'v', queuedVersion);

      let { data: row, error: syncRowError } = await supabase
        .from('notion_block_sync')
        .select('local_version')
        .eq('installation_id', job.installationId)
        .eq('local_id', job.localId)
        .maybeSingle();
      if (syncRowError) throw new Error('Unable to load the current sync version.');
      syncRow = row;

      // The RPC that assigned this version should already have created the
      // state row. Repair it if an older deployment accepted a job without
      // doing so, and never let a missing row look like a successful sync.
      if (!row) {
        const { error: insertError } = await supabase
          .from('notion_block_sync')
          .insert({
            installation_id: job.installationId,
            local_id: job.localId,
            entity_type: job.type,
            local_version: queuedVersion,
            status: 'pending',
          });
        if (insertError) {
          // A concurrent queue delivery may have repaired the same row first.
          const { data: repairedRow, error: rereadError } = await supabase
            .from('notion_block_sync')
            .select('local_version')
            .eq('installation_id', job.installationId)
            .eq('local_id', job.localId)
            .maybeSingle();
          if (rereadError || !repairedRow) {
            throw new Error('Unable to restore the sync version state.');
          }
          row = repairedRow;
        } else {
          row = { local_version: queuedVersion };
        }
        syncRow = row;
      }

      if (row.local_version < queuedVersion) {
        throw new Error('The queued version is missing from durable sync state.');
      }

      // Older full-page snapshots can be discarded. Incremental block batches
      // still run every chunk so the remote page is not left partially applied.
      if (job.type !== 'block_op' && row && row.local_version > queuedVersion) {
        console.log('[queue] skipped stale', job.type, 'v', queuedVersion, 'latest', row.local_version);
        if (jobId) await markAndRemoveQueuedPayload(jobId);
        await notifyQueueIdleIfDrained(env, installationId);
        message.ack();
        continue;
      }

      const { error: syncingError } = await supabase
        .from('notion_block_sync')
        .update({ status: 'syncing', updated_at: new Date().toISOString() })
        .eq('installation_id', job.installationId)
        .eq('local_id', job.localId)
        .eq('local_version', queuedVersion);
      if (syncingError) throw new Error('Unable to mark the sync as active.');

      let notionBlockId: string | null = null;

      if (job.type === 'block_op') {
        const queuedPage = job.payload.page;
        const queuedProject = job.payload.project;
        if (!queuedPage || !queuedProject) throw new Error('Block queue job is missing page or project context.');
        const legacyOperation = legacyQueueOperation(job.payload);
        const result = await applyBlockOpsToNotionForInstallation(installationId, {
          ops: job.payload.ops?.length ? job.payload.ops : legacyOperation ? [legacyOperation] : [],
          page: { ...queuedPage, content: queuedPage.content ?? { type: 'doc', content: [] } },
          project: { ...queuedProject, stateContent: queuedProject.stateContent ?? { type: 'doc', content: [] } },
          selectedParentPageId: job.payload.selectedParentPageId,
        });
        notionBlockId = result?.page?.notionPageId ?? null;
      } else if (job.type === 'page') {
        const queuedPage = job.payload.page;
        const queuedProject = job.payload.project;
        if (!queuedPage || !queuedProject) throw new Error('Page queue job is missing page or project context.');
        const result = await pushPageToNotionForInstallation(installationId, {
          page: { ...queuedPage, content: queuedPage.content ?? { type: 'doc', content: [] } },
          project: { ...queuedProject, stateContent: queuedProject.stateContent ?? { type: 'doc', content: [] } },
          selectedParentPageId: job.payload.selectedParentPageId,
        });
        notionBlockId = result?.page?.notionPageId ?? null;
      } else {
        const queuedProject = job.payload.project;
        if (!queuedProject) throw new Error('Project queue job is missing project context.');
        await syncProjectToNotionForInstallation(installationId, {
          project: { ...queuedProject, stateContent: queuedProject.stateContent ?? { type: 'doc', content: [] } },
          selectedParentPageId: job.payload.selectedParentPageId,
        });
      }

      const isFinalBatchMessage = job.type !== 'block_op' || job.batchIndex === job.batchSize - 1;
      const isCurrentVersion = row.local_version <= queuedVersion;
      if (isFinalBatchMessage && isCurrentVersion) {
        const { data: syncedRow, error: syncedStateError } = await supabase
          .from('notion_block_sync')
          .update({
            status: 'synced',
            synced_version: queuedVersion,
            notion_block_id: notionBlockId,
            updated_at: new Date().toISOString(),
          })
          .eq('installation_id', job.installationId)
          .eq('local_id', job.localId)
          .eq('local_version', queuedVersion)
          .select('local_version')
          .maybeSingle();
        if (syncedStateError) throw new Error('Unable to persist the completed sync state.');

        if (syncedRow) {
          const doStub = env.SYNC_EVENTS.get(env.SYNC_EVENTS.idFromName(installationId));
          await doStub.fetch(new Request('http://do/notify', {
            method: 'POST',
            body: JSON.stringify({ status: 'synced', pageId: job.localId, notionBlockId, version: queuedVersion }),
          })).catch(() => undefined);
        } else {
          // A newer edit may have been queued while Notion was being updated.
          // Do not publish a stale "synced" event over its pending state.
          const { data: latestRow, error: latestRowError } = await supabase
            .from('notion_block_sync')
            .select('local_version')
            .eq('installation_id', job.installationId)
            .eq('local_id', job.localId)
            .maybeSingle();
          if (latestRowError || !latestRow || latestRow.local_version <= queuedVersion) {
            throw new Error('Unable to confirm the completed sync version.');
          }
        }
      }

      syncOperationSucceeded = true;
      if (jobId) await markAndRemoveQueuedPayload(jobId);
      await notifyQueueIdleIfDrained(env, installationId);
      console.log('[queue] done', job.type);
      message.ack();
    } catch (error) {
      console.error('[queue] failed', job?.type ?? 'payload', safeErrorMetadata(error));

      // A remote mutation already succeeded; retry only the content-free
      // reference cleanup, never replay the Notion write for this row.
      if (syncOperationSucceeded) {
        if (jobId) message.retry();
        else message.ack();
        continue;
      }

      if (job && isRevokedInstallationError(error)) {
        await ackAfterPayloadCleanup(message, jobId, env, String(job.installationId));
        continue;
      }

      if (job) {
        const { error: failureStateError } = await supabase
          .from('notion_block_sync')
          .update({ status: 'failed', updated_at: new Date().toISOString() })
          .eq('installation_id', job.installationId)
          .eq('local_id', job.localId)
          .eq('local_version', job.queuedVersion);
        if (failureStateError) {
          console.error('[queue] failed sync state could not be persisted', safeErrorMetadata(failureStateError));
          message.retry();
          continue;
        }

        if (!syncRow || syncRow.local_version <= job.queuedVersion) {
          const installationId = String(job.installationId);
          const doStub = env.SYNC_EVENTS.get(env.SYNC_EVENTS.idFromName(installationId));
          const errorRecord = error && typeof error === 'object'
            ? error as { code?: unknown; message?: unknown; status?: unknown }
            : undefined;
          const statusCode = typeof errorRecord?.status === 'number' ? errorRecord.status : undefined;
          const errorMessage = error instanceof Error ? error.message : String(error);
          const userMessage = notionApiHttpFailure(error)?.body.message ?? errorMessage;
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
      }

      if (job && (isUnmappedNotionContentError(error) || isPermanentNotionFailure(error))) {
        try {
          // The extension removes operations from its local outbox as soon as
          // this durable payload is accepted. Retain permanent failures in the
          // server outbox so an explicit Sync retry can replay the exact edits.
          await retainFailedQueuePayload(jobId, job);
          message.ack();
        } catch (retentionError) {
          console.error('[queue] failed sync payload could not be retained', safeErrorMetadata(retentionError));
          message.retry();
        }
      } else {
        message.retry();
      }
    }
  }
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
  jobId: string | undefined,
  env: WorkerEnv,
  installationId?: string,
): Promise<void> {
  if (!jobId) {
    message.ack();
    if (installationId) await notifyQueueIdleIfDrained(env, installationId);
    return;
  }
  try {
    await markAndRemoveQueuedPayload(jobId);
    if (installationId) await notifyQueueIdleIfDrained(env, installationId);
    message.ack();
  } catch (cleanupError) {
    console.error('[queue] discarded payload cleanup failed', safeErrorMetadata(cleanupError));
    message.retry();
  }
}

/** Retains a permanently failed operation for a later explicit retry. */
async function retainFailedQueuePayload(
  jobId: string | undefined,
  job: SyncQueueMessage,
): Promise<void> {
  const failedJob: SyncQueueMessage = {
    ...job,
    deadLetteredAt: new Date().toISOString(),
  };
  delete failedJob.deliveryPendingAt;

  if (jobId) {
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
    if (current?.status === 'processed') return;
  }

  // Older Queue messages carried the job itself instead of a payload UUID. If
  // one of those fails, move its full body into the durable outbox before ack.
  const recoveredJobId = jobId ?? crypto.randomUUID();
  const { error: insertError } = await supabase
    .from('jottathing_sync_queue_payloads')
    .insert({
      id: recoveredJobId,
      installation_id: job.installationId,
      payload: failedJob,
      status: 'pending',
    });
  if (insertError) throw new Error('Unable to recover the failed sync payload.');
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

      const { error: syncStateError } = await supabase
        .from('notion_block_sync')
        .update({ status: 'failed', updated_at: new Date().toISOString() })
        .eq('installation_id', job.installationId)
        .eq('local_id', job.localId)
        .eq('local_version', job.queuedVersion);
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

/** Assigns a durable server revision to legacy jobs that were queued at version zero. */
async function ensureServerAssignedQueueVersion(
  job: SyncQueueMessage,
  jobId: string | undefined,
): Promise<SyncQueueMessage> {
  if (Number.isSafeInteger(job.queuedVersion) && job.queuedVersion >= 1) return job;

  const { data, error } = await supabase.rpc('increment_block_version', {
    p_installation_id: job.installationId,
    p_local_id: job.localId,
    p_entity_type: job.type,
  });
  const queuedVersion = Number(data);
  if (error || !Number.isSafeInteger(queuedVersion) || queuedVersion < 1) {
    throw new Error('Unable to assign a durable version to the queued sync job.');
  }

  const upgradedJob: SyncQueueMessage = { ...job, queuedVersion };
  if (!jobId) return upgradedJob;

  const { data: upgradedRow, error: upgradeError } = await supabase
    .from('jottathing_sync_queue_payloads')
    .update({ payload: upgradedJob, updated_at: new Date().toISOString() })
    .eq('id', jobId)
    .eq('status', 'pending')
    .eq('payload->>queuedVersion', String(job.queuedVersion))
    .select('payload')
    .maybeSingle();
  if (upgradeError) throw new Error('Unable to persist the queued sync version.');
  if (upgradedRow && isSyncQueueMessage(upgradedRow.payload)) return upgradedRow.payload;

  // Another delivery may have repaired this legacy reference concurrently.
  const { data: latestRow, error: latestError } = await supabase
    .from('jottathing_sync_queue_payloads')
    .select('payload')
    .eq('id', jobId)
    .eq('status', 'pending')
    .maybeSingle();
  if (latestError) throw new Error('Unable to verify the queued sync version.');
  if (latestRow && isSyncQueueMessage(latestRow.payload) && latestRow.payload.queuedVersion >= 1) {
    return latestRow.payload;
  }
  throw new Error('Unable to persist the queued sync version.');
}

function isSyncQueueMessage(value: unknown): value is SyncQueueMessage {
  if (!value || typeof value !== 'object') return false;
  const job = value as Partial<SyncQueueMessage>;
  return (
    (job.type === 'block_op' || job.type === 'page' || job.type === 'project') &&
    (typeof job.installationId === 'number' || typeof job.installationId === 'string') &&
    typeof job.localId === 'string' &&
    typeof job.queuedVersion === 'number' &&
    Boolean(job.payload && typeof job.payload === 'object')
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
