/**
 * @file Registers page, block, project, and project-source synchronization mutation routes.
 * @author Aidan Boissonneault
 * @lastModified September 2026
 */

import type { Hono } from 'hono';
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
  requireConnectedStore,
  syncProjectToNotion,
  withFreshInstallationStore,
  writeStore,
} from '../services/workerRuntime.js';
import { stringValue } from '../workerUtils.js';
import type { WorkerEnv } from '../types.js';

/**
 * Registers mutation routes that push local pages and projects to Notion.
 * @param app - Worker Hono application.
 * @returns Nothing.
 */
export function registerSyncMutationRoutes(app: Hono<{ Bindings: WorkerEnv }>): void {
  // ─── Sync routes ───────────────────────────────────────────────────────────────
  
  /** Queues page or block synchronization work. @param c - Hono context. @returns JSON response. */
  app.post('/sync/push', async (c) => {
    const body: Partial<SyncPageRequest> = await c.req.json<SyncPageRequest>().catch(() => ({}));
    const { page, project, selectedParentPageId } = body ?? {};
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
            message: `A single block is too large to queue (${oversized?.inkwellBlockId ?? oversized?.type ?? 'unknown block'}).`,
          }, 413);
        }
        const jobs = chunks.map((chunk, batchIndex) => ({
          ...jobBase,
          batchIndex,
          batchSize: chunks.length,
          payload: { ...jobBase.payload, ops: chunk },
        }));
  
        let version = group.version;
        for (const job of jobs) {
          version = await enqueueSync(c.env, job, group.version);
        }
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
    }, page.localSyncVersion ?? page.knownSyncVersion ?? 0);
  
    return c.json({ queued: true, version });
  });
  
  /** Synchronizes project metadata immediately. @param c - Hono context. @returns JSON response. */
  app.post('/sync/project', async (c) => {
    const body: Partial<SyncProjectRequest> = await c.req.json<SyncProjectRequest>().catch(() => ({}));
    const { project, selectedParentPageId } = body ?? {};
  
    if (!project?.id) {
      return c.json({ status: 'error', message: 'Missing project.' });
    }
  
    try {
      return c.json(await syncProjectToNotion({ c, project, selectedParentPageId }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[sync/project] failed:', message, error);
      return c.json({ status: 'error', message }, 500);
    }
  });
  
  /** Synchronizes one project-state source block. @param c - Hono context. @returns JSON response. */
  app.post('/sync/project/source', async (c) => {
    const body: Partial<SyncProjectSourceRequest> = await c.req.json<SyncProjectSourceRequest>().catch(() => ({}));
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
        await applyManagedBlockOps(
          freshStore,
          projectStateKey(project.id),
          container.id,
          [{
            type: 'block_update',
            inkwellBlockId: stringValue(block.attrs?.inkwellBlockId)
              ?? `source:${encodeURIComponent(blockId)}`,
            payload: { block },
          }],
          { type: 'doc', content: [block] },
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
        return { status: 'saved', project };
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[sync/project/source] failed:', message, error);
      return c.json({ status: 'error', message }, 500);
    }
  });
}

