/**
 * @file Consumes synchronization queue messages and records success, staleness, retry, and durable-event outcomes.
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
import type { ManagedBlockOperation, SyncQueueMessage, WorkerEnv } from '../types.js';
import { isUnmappedNotionContentError } from '../managedBlocks.js';

/**
 * Processes and acknowledges or retries one Cloudflare Queue batch.
 * @param batch - Synchronization messages delivered by Cloudflare Queue.
 * @param env - Worker environment bindings.
 * @returns Completion after every message has been handled.
 */
export async function processSyncQueue(
  batch: MessageBatch<SyncQueueMessage>,
  env: WorkerEnv,
): Promise<void> {
      initSingletons(env);
  
      for (const msg of batch.messages) {
        const job = msg.body;
        const installationId = String(job.installationId);
        const queuedVersion = job.queuedVersion ?? 0;
        let syncRow;
        console.log('[queue] processing', job.type, job.localId, 'v', queuedVersion);
        try {
          const { data: row } = await supabase
            .from('notion_block_sync')
            .select('local_version')
            .eq('installation_id', job.installationId)
            .eq('local_id', job.localId)
            .maybeSingle();
          syncRow = row;
  
          // Stale check — a newer edit was enqueued after this one
          // A block batch may span multiple Queue messages. Every chunk must run
          // or the remote page would be left only partially applied.
          if (job.type !== 'block_op' && row && row.local_version > queuedVersion) {
            console.log('[queue] skipped stale', job.type, job.localId, 'v', queuedVersion, 'latest', row.local_version);
            msg.ack();
            continue;
          }
  
          await supabase
            .from('notion_block_sync')
            .update({ status: 'syncing', updated_at: new Date().toISOString() })
            .eq('installation_id', job.installationId)
            .eq('local_id', job.localId);
  
          let notionBlockId = null;
  
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
          } else if (job.type === 'project') {
            const queuedProject = job.payload.project;
            if (!queuedProject) throw new Error('Project queue job is missing project context.');
            await syncProjectToNotionForInstallation(installationId, {
              project: { ...queuedProject, stateContent: queuedProject.stateContent ?? { type: 'doc', content: [] } },
              selectedParentPageId: job.payload.selectedParentPageId,
            });
          }
  
          const isFinalBatchMessage = job.type !== 'block_op' || job.batchIndex === job.batchSize - 1;
          const isCurrentVersion = !row || row.local_version <= queuedVersion;
          if (isFinalBatchMessage && isCurrentVersion) {
            await supabase
              .from('notion_block_sync')
              .update({
                status: 'synced',
                synced_version: queuedVersion,
                notion_block_id: notionBlockId,
                updated_at: new Date().toISOString(),
              })
              .eq('installation_id', job.installationId)
              .eq('local_id', job.localId);
  
            const doStub = env.SYNC_EVENTS.get(env.SYNC_EVENTS.idFromName(installationId));
            await doStub.fetch(new Request('http://do/notify', {
              method: 'POST',
              body: JSON.stringify({ status: 'synced', pageId: job.localId, notionBlockId, version: queuedVersion }),
            })).catch(() => undefined);
          }
  
          console.log('[queue] done', job.type, job.localId);
          msg.ack();
        } catch (err) {
          console.error('[queue] failed', job.type, job.localId, err);
          await Promise.resolve(supabase
            .from('notion_block_sync')
            .update({ status: 'failed', updated_at: new Date().toISOString() })
            .eq('installation_id', job.installationId)
            .eq('local_id', job.localId)
            .eq('local_version', queuedVersion))
            .then((): void => undefined)
            .catch((): void => undefined);
  
          if (!syncRow || syncRow.local_version <= queuedVersion) {
            const doStub = env.SYNC_EVENTS.get(env.SYNC_EVENTS.idFromName(installationId));
            const errorRecord = err && typeof err === 'object'
              ? err as { code?: unknown; message?: unknown; status?: unknown }
              : undefined;
            const statusCode = typeof errorRecord?.status === 'number' ? errorRecord.status : undefined;
            const errorMessage = err instanceof Error ? err.message : String(err);
            const message = statusCode === 403
              ? `${errorMessage} Check that Inkwell has access to this Notion page, then use Resync.`
              : errorMessage;
            await doStub.fetch(new Request('http://do/notify', {
              method: 'POST',
              body: JSON.stringify({
                status: 'failed',
                pageId: job.localId,
                message,
                ...(typeof errorRecord?.code === 'string' ? { code: errorRecord.code } : {}),
                ...(statusCode !== undefined ? { statusCode } : {}),
              }),
            })).catch(() => undefined);
          }

          if (isUnmappedNotionContentError(err) || isPermanentNotionFailure(err)) {
            msg.ack();
          } else {
            msg.retry();
  }
}

/** Avoids retrying Notion requests that require a user or permission change. */
function isPermanentNotionFailure(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const detail = error as { isNotionApiError?: unknown; status?: unknown };
  return detail.isNotionApiError === true &&
    typeof detail.status === 'number' &&
    [400, 401, 403, 404].includes(detail.status);
}
      }
}

