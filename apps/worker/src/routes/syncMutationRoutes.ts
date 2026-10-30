/**
 * @file Registers page, block, project, and project-source synchronization mutation routes.
 * @author Aidan Boissonneault
 * @lastModified September 2026
 */

import type { Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { Project } from '../../../../src/types/capture.js';
import type {
  SyncPageRequest,
  SyncProjectRequest,
  SyncProjectSourceRequest,
} from '../../../../src/types/sync.js';
import { projectStateKey } from '../projectDatabase.js';
import {
  MAX_SYNC_QUEUE_MESSAGE_BYTES,
  chunkSyncOpsForQueue,
  queueMessageBytes,
  syncOpGroupsByPage,
  syncOpWithoutRepeatedContext,
} from '../syncQueueMessages.js';
import type { QueueJobBase } from '../syncQueueMessages.js';
import {
  appendLog,
  applyManagedBlockOps,
  enqueueSync,
  ensureProjectPage,
  ensureProjectStateContainer,
  notionRequest,
  pushPageToNotion,
  requireConnectedStore,
  supabase,
  syncProjectToNotion,
  withFreshInstallationStore,
  writeStore,
} from '../services/workerRuntime.js';
import {
  MAX_SYNC_JSON_REQUEST_BYTES,
  MAX_CONTROL_JSON_REQUEST_BYTES,
  notionApiErrorResponse,
  readLimitedJsonBody,
  safeErrorMetadata,
  stringValue,
} from '../workerUtils.js';
import type { SyncQueueMessage, WorkerEnv } from '../types.js';
import { readSyncPageRequestBody } from './syncPageRequest.js';
import {
  isUnmappedNotionContentError,
  UNMAPPED_NOTION_CONTENT_CODE,
} from '../managedBlocks.js';

/**
 * Registers mutation routes that push local pages and projects to Notion.
 * @param app - Worker Hono application.
 * @returns Nothing.
 */
export function registerSyncMutationRoutes(app: Hono<{ Bindings: WorkerEnv }>): void {
  // ─── Sync routes ───────────────────────────────────────────────────────────────
  
  /** Queues page or block synchronization work. @param c - Hono context. @returns JSON response. */
  app.post('/sync/push', async (c) => {
    const body = await readSyncPageRequestBody(c.req.raw);
    if (!body) return c.json({ error: 'Sync request is too large.' }, 413);
    const { page, project, selectedParentPageId } = body;
    const ops = Array.isArray(body?.ops) ? body.ops : [];
  
    if (!ops.length && (!page?.id || !project?.id)) {
      return c.json({ status: 'error', message: 'Missing page or project.' });
    }
  
    const store = await requireConnectedStore(c);
    const versions: Record<string, number> = {};
    const opVersions: Record<string, number> = {};
  
    if (ops.length) {
      const groups = syncOpGroupsByPage(ops);
  
      for (const group of groups) {
        const latestOp = group.ops.at(-1);
        if (!latestOp?.opId || !latestOp?.pageId || !latestOp?.payload?.page || !latestOp?.payload?.project) {
          return c.json({ status: 'error', message: 'Invalid sync operation.' }, 400);
        }
  
        const queuedOps = group.ops.map(syncOpWithoutRepeatedContext);
        const jobBase: QueueJobBase = {
          type: 'block_op',
          localId: latestOp.pageId,
          pageId: latestOp.pageId,
          projectId: latestOp.projectId,
          installationId: store.installationId,
          batchId: `${latestOp.pageId}:${group.version}`,
          payload: {
            page: latestOp.payload.page,
            project: latestOp.payload.project,
            selectedParentPageId: latestOp.payload.selectedParentPageId,
          },
        };
        const chunks = chunkSyncOpsForQueue(jobBase, queuedOps, group.version);
        if (!chunks) {
          const oversized = queuedOps.find((op) =>
            queueMessageBytes({
              ...jobBase,
              queuedVersion: group.version,
              batchIndex: 0,
              batchSize: 1,
              payload: { ...jobBase.payload, ops: [op] },
            }) > MAX_SYNC_QUEUE_MESSAGE_BYTES,
          );
          return c.json({
            status: 'error',
            message: `A single block is too large to queue (${oversized?.jottathingBlockId ?? oversized?.type ?? 'unknown block'}).`,
          }, 413);
        }
        const jobs = chunks.map((chunk, batchIndex) => ({
          ...jobBase,
          batchIndex,
          batchSize: chunks.length,
          payload: { ...jobBase.payload, ops: chunk },
        }));
  
        let version: number | undefined;
        for (const job of jobs) {
          version = await enqueueSync(c.env, job, version);
        }
        if (version === undefined) return c.json({ status: 'error', message: 'Unable to assign a sync version.' }, 500);
        versions[latestOp.pageId] = version;
        for (const op of group.ops) {
          opVersions[op.opId] = version;
        }
      }
  
      return c.json({ queued: true, versions, opVersions });
    }
  
    if (!page || !project) {
      return c.json({ status: 'error', message: 'Missing page or project.' }, 400);
    }
  
    const version = await enqueueSync(c.env, {
      type: 'page',
      localId: page.id,
      pageId: page.id,
      projectId: project.id,
      installationId: store.installationId,
      payload: { page, project, selectedParentPageId },
    });
  
    return c.json({ queued: true, version });
  });

  /** Redrives accepted Queue payloads whose references reached the dead-letter queue. */
  app.post('/sync/retry', async (c) => {
    const parsed = await readLimitedJsonBody<{ opIds?: unknown[] }>(c.req.raw, MAX_CONTROL_JSON_REQUEST_BYTES);
    if (parsed.tooLarge) return c.json({ error: 'Sync retry request is too large.' }, 413);
    const requestedOpIds = new Set(
      Array.isArray(parsed.body?.opIds)
        ? parsed.body.opIds.filter((opId): opId is string => typeof opId === 'string')
        : [],
    );
    const store = await requireConnectedStore(c);
    const deliveryPendingOnly = c.req.query('deliveryPendingOnly') === 'true';
    const pageSize = 25;
    let requeuedCount = 0;
    const requeuedOperationIds = new Set<string>();
    const versions: Record<string, number> = {};
    const opVersions: Record<string, number> = {};

    const retryMarkers = deliveryPendingOnly
      ? ['deliveryPendingAt'] as const
      : ['deadLetteredAt', 'deliveryPendingAt'] as const;
    for (const retryMarker of retryMarkers) {
      let afterId: string | undefined;
      while (true) {
        let query = supabase
          .from('jottathing_sync_queue_payloads')
          .select('id, payload')
          .eq('installation_id', store.installationId)
          .eq('status', 'pending')
          .not(`payload->>${retryMarker}`, 'is', null)
          .order('id', { ascending: true })
          .range(0, pageSize - 1);
        if (afterId) query = query.gt('id', afterId);
        const { data: rows, error } = await query;
        if (error) return c.json({ error: 'Unable to read saved sync jobs for retry.' }, 503);
        if (!rows?.length) break;

        for (const row of rows) {
          if (!isRetryableQueueMessage(row.payload, retryMarker)) continue;
          const job = row.payload;
          const { error: resetError } = await supabase
            .from('notion_block_sync')
            .update({ status: 'pending', updated_at: new Date().toISOString() })
            .eq('installation_id', job.installationId)
            .eq('local_id', job.localId)
            .eq('local_version', job.queuedVersion);
          if (resetError) return c.json({ error: 'Unable to prepare the saved sync job for retry.' }, 503);

          try {
            await c.env.SYNC_QUEUE.send({ jobId: String(row.id) });
          } catch {
            return c.json({ error: 'Unable to restart a saved sync job. Your note remains saved.' }, 503);
          }

          const retryPayload = { ...job };
          delete retryPayload.deadLetteredAt;
          delete retryPayload.deliveryPendingAt;
          const { error: clearError } = await supabase
            .from('jottathing_sync_queue_payloads')
            .update({ payload: retryPayload, updated_at: new Date().toISOString() })
            .eq('id', row.id)
            .eq('status', 'pending')
            // A retry may fail again before this request finishes. Only clear
            // the marker that this request observed; never overwrite a newer
            // dead-letter marker written by the Queue consumer.
            .eq(`payload->>${retryMarker}`, job[retryMarker]);
          if (clearError) return c.json({ error: 'A saved sync job was restarted, but its retry marker could not be cleared.' }, 503);
          requeuedCount += 1;
          if (job.type === 'block_op' && requestedOpIds.size) {
            for (const operation of job.payload.ops ?? []) {
              if (!operation.opId || !requestedOpIds.has(operation.opId)) continue;
              requeuedOperationIds.add(operation.opId);
              opVersions[operation.opId] = job.queuedVersion;
              versions[job.localId] = Math.max(versions[job.localId] ?? 0, job.queuedVersion);
            }
          }
        }

        afterId = String(rows.at(-1)?.id ?? '');
        if (rows.length < pageSize) break;
      }
    }

    return c.json({
      requeuedCount,
      requeuedOperationIds: [...requeuedOperationIds],
      versions,
      opVersions,
    });
  });

  /** Runs a user-requested page reconciliation immediately so its content diff can be returned. */
  app.post('/sync/page/resync', async (c) => {
    const body = await readSyncPageRequestBody(c.req.raw);
    if (!body) return c.json({ error: 'Sync request is too large.' }, 413);
    const { page, project, selectedParentPageId } = body;
    if (!page?.id || !project?.id) {
      return c.json({ status: 'error', message: 'Missing page or project.' }, 400);
    }

    try {
      const store = await requireConnectedStore(c);
      const { data: assignedVersion, error: versionError } = await supabase.rpc('increment_block_version', {
        p_installation_id: store.installationId,
        p_local_id: page.id,
        p_entity_type: 'page',
      });
      const serverVersion = Number(assignedVersion);
      if (versionError || !Number.isSafeInteger(serverVersion) || serverVersion < 1) {
        throw new Error('Unable to assign a server sync version.');
      }

      const result = await pushPageToNotion({
        c,
        page,
        project,
        selectedParentPageId,
      });
      const isSynced = result.status === 'saved';
      const { data: savedSyncState, error: stateError } = await supabase
        .from('notion_block_sync')
        .update({
          ...(isSynced ? { synced_version: serverVersion, is_stale: false } : {}),
          status: isSynced ? 'synced' : result.status,
          notion_block_id: result?.page?.notionPageId ?? page.notionPageId ?? null,
          updated_at: new Date().toISOString(),
        })
        .eq('installation_id', store.installationId)
        .eq('local_id', page.id)
        .eq('local_version', serverVersion)
        .select('local_version')
        .maybeSingle();
      if (stateError) throw new Error('Unable to save the page sync version.');

      if (savedSyncState && (isSynced || result.status === 'stale')) {
        const doStub = c.env.SYNC_EVENTS.get(c.env.SYNC_EVENTS.idFromName(String(store.installationId)));
        await doStub.fetch(new Request('http://do/notify', {
          method: 'POST',
          body: JSON.stringify({
            status: isSynced ? 'synced' : 'stale',
            pageId: page.id,
            notionBlockId: result?.page?.notionPageId ?? page.notionPageId ?? null,
            version: serverVersion,
          }),
        })).catch(() => undefined);
      }

      return c.json({
        ...result,
        ...(result.page ? {
          page: {
            ...result.page,
            knownSyncVersion: serverVersion,
            serverSyncVersion: serverVersion,
          },
        } : {}),
      });
    } catch (error) {
      return syncMutationErrorResponse(c, error, 'sync/page/resync');
    }
  });

  /** Synchronizes project metadata immediately. @param c - Hono context. @returns JSON response. */
  app.post('/sync/project', async (c) => {
    const parsed = await readLimitedJsonBody<SyncProjectRequest>(c.req.raw, MAX_SYNC_JSON_REQUEST_BYTES);
    if (parsed.tooLarge) return c.json({ error: 'Sync request is too large.' }, 413);
    const body = (parsed.body ?? {}) as Partial<SyncProjectRequest>;
    const { project, selectedParentPageId } = body ?? {};
  
    if (!project?.id) {
      return c.json({ status: 'error', message: 'Missing project.' });
    }
  
    try {
      return c.json(await syncProjectToNotion({ c, project, selectedParentPageId }));
    } catch (error) {
      return syncMutationErrorResponse(c, error, 'sync/project');
    }
  });
  
  /** Synchronizes one project-state source block. @param c - Hono context. @returns JSON response. */
  app.post('/sync/project/source', async (c) => {
    const parsed = await readLimitedJsonBody<SyncProjectSourceRequest>(c.req.raw, MAX_SYNC_JSON_REQUEST_BYTES);
    if (parsed.tooLarge) return c.json({ error: 'Sync request is too large.' }, 413);
    const body = (parsed.body ?? {}) as Partial<SyncProjectSourceRequest>;
    const { project, blockId, block, selectedParentPageId } = body ?? {};
  
    if (!project?.id || !blockId || !block) {
      return c.json({ status: 'error', message: 'Missing project source.' }, 400);
    }
  
    try {
      const store = await requireConnectedStore(c);
      return c.json(await withFreshInstallationStore(store, async (freshStore) => {
        const completeProject: Project = { ...project, stateContent: { type: 'doc', content: [] } };
        const projectPage = await ensureProjectPage(freshStore, completeProject, {
          selectedParentPageId,
          syncState: false,
        });
        const container = await ensureProjectStateContainer(
          freshStore,
          projectPage.id,
          project.id,
        );
        const replacement = await applyManagedBlockOps(
          freshStore,
          projectStateKey(project.id),
          container.id,
          [{
            type: 'block_update',
            jottathingBlockId: stringValue(block.attrs?.jottathingBlockId)
              ?? `source:${encodeURIComponent(blockId)}`,
            payload: { block },
          }],
          { type: 'doc', content: [block] },
          project.stateSyncBaselineContent,
        );
        const refreshed = await notionRequest(freshStore, `/blocks/${container.id}`)
          .catch(() => container);
        freshStore.projectBlocks[projectStateKey(project.id)] = {
          ...freshStore.projectBlocks[projectStateKey(project.id)],
          blockId: container.id,
          lastEditedTime: refreshed.last_edited_time,
          parentPageId: projectPage.id,
          title: 'Project State',
        };
        await writeStore(freshStore);
        return {
          status: 'saved',
          project: {
            ...project,
            stateSyncBaselineContent: replacement?.baselineContent ?? project.stateSyncBaselineContent,
          },
        };
      }));
    } catch (error) {
      return syncMutationErrorResponse(c, error, 'sync/project/source');
    }
  });
}

/** Maps sync transport, Notion API, merge, and unexpected failures to route responses. */
function syncMutationErrorResponse(
  context: Context<{ Bindings: WorkerEnv }>,
  error: unknown,
  route: string,
) {
  if (error instanceof HTTPException) {
    const response = error.getResponse();
    return context.newResponse(response.body, response);
  }

  const notionResponse = notionApiErrorResponse(context, error);
  if (notionResponse) return notionResponse;

  const message = error instanceof Error ? error.message : String(error);
  console.error(`[${route}] failed:`, safeErrorMetadata(error));
  if (isUnmappedNotionContentError(error)) {
    // The client presents this conflict body as a normal sync result at HTTP 200.
    return context.json({
      status: 'error',
      code: UNMAPPED_NOTION_CONTENT_CODE,
      message,
      diff: error.diff,
    });
  }
  return context.json({ status: 'error', message }, 500);
}

function isRetryableQueueMessage(
  value: unknown,
  retryMarker: 'deadLetteredAt' | 'deliveryPendingAt',
): value is SyncQueueMessage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Partial<SyncQueueMessage> & {
    deadLetteredAt?: unknown;
    deliveryPendingAt?: unknown;
  };
  return (
    (candidate.type === 'block_op' || candidate.type === 'page' || candidate.type === 'project') &&
    (typeof candidate.installationId === 'number' || typeof candidate.installationId === 'string') &&
    typeof candidate.localId === 'string' &&
    typeof candidate.queuedVersion === 'number' &&
    (retryMarker === 'deliveryPendingAt'
      ? typeof candidate.deliveryPendingAt === 'string'
      : typeof candidate.deadLetteredAt === 'string')
  );
}

