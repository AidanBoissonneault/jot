import { describe, expect, test } from 'vitest';
import {
  addPendingProjectSyncEvent,
  addPendingProjectSourceSyncEvent,
  blockPendingProjectSyncEvents,
  buildPageSyncOps,
  listPendingProjectSyncEvents,
  rebaseBlockedProjectSyncEvents,
} from '@/src/services/syncQueue';
import { readIdbStorage, resetBrowserStorage } from './setup';
import type { Project, ProjectPage } from '@/src/types/capture';

const block = (id: string, text: string) => ({
  type: 'paragraph',
  attrs: { inkwellBlockId: id },
  content: [{ type: 'text', text }],
});

const project: Project = {
  id: 'project',
  name: 'Project',
  status: 'active',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  stateContent: { type: 'doc', content: [block('state', 'large project state'.repeat(10_000))] },
  tags: [],
};

const page = (content: ReturnType<typeof block>[]): ProjectPage => ({
  id: 'page',
  projectId: project.id,
  title: 'Page',
  status: 'active',
  content: { type: 'doc', content },
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
});

describe('block sync queue payloads', () => {
  test('a small edit does not copy the page or project state into the operation', () => {
    const oldBlocks = Array.from({ length: 100 }, (_, index) =>
      block(`block-${index}`, `unchanged-${index}-${'x'.repeat(2_000)}`));
    const nextBlocks = oldBlocks.map((entry, index) =>
      index === 50 ? block('block-50', 'changed') : entry);

    const ops = buildPageSyncOps({
      previousPage: page(oldBlocks),
      page: page(nextBlocks),
      project,
    });

    expect(ops).toHaveLength(1);
    expect(ops[0].type).toBe('block_update');
    expect(ops[0].payload.block).toEqual(nextBlocks[50]);
    expect(ops[0].payload.page.content).toBeUndefined();
    expect(ops[0].payload.project.stateContent).toBeUndefined();
    expect(JSON.stringify(ops).length).toBeLessThan(5_000);
  });

  test('queues each source independently without copying project state or duplicate retries', async () => {
    resetBrowserStorage();
    const sourceBlock = block('source:capture-1', 'inkwell_source_v1:{}');

    await addPendingProjectSourceSyncEvent(project, 'capture-1', sourceBlock);
    await addPendingProjectSourceSyncEvent(project, 'capture-1', sourceBlock);

    const events = await listPendingProjectSyncEvents();
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('project_source_upsert');
    if (events[0].type !== 'project_source_upsert') throw new Error('Unexpected event');
    expect(events[0].payload.block).toEqual(sourceBlock);
    expect(events[0].payload.project).not.toHaveProperty('stateContent');
  });

  test('rebases a durable conflict by merging local and Notion content before unblocking delivery', async () => {
    resetBrowserStorage();
    const localProject: Project = {
      ...project,
      stateContent: { type: 'doc', content: [block('local', 'local block')] },
    };
    const remoteProject: Project = {
      ...project,
      stateRemoteRevision: 'remote-revision',
      stateContent: { type: 'doc', content: [block('remote', 'Notion block')] },
    };
    const original = await addPendingProjectSyncEvent(localProject, 'parent');
    await blockPendingProjectSyncEvents(localProject.id, {
      code: 'unmapped_notion_content',
      message: 'Notion has content without matching Inkwell block mappings.',
    });

    const persisted: Project[] = [];
    const rebased = await rebaseBlockedProjectSyncEvents(
      [remoteProject],
      [localProject],
      async (projects) => { persisted.push(...projects); },
      'parent',
    );
    const queue = await listPendingProjectSyncEvents();
    const backup = readIdbStorage().project_sync_conflict_backups as Array<{
      events: Array<{ eventId: string }>;
    }>;

    expect(rebased).toHaveLength(1);
    expect(persisted).toHaveLength(1);
    expect(rebased[0].stateContent?.content?.map((entry) => entry.content?.[0]?.text)).toEqual([
      'Notion block',
      'local block',
    ]);
    expect(queue).toHaveLength(1);
    expect(queue[0].deliveryBlocked).toBeUndefined();
    expect(queue[0].type).toBe('project_upsert');
    expect(backup.flatMap((entry) => entry.events.map((event) => event.eventId))).toContain(original.eventId);
  });

  test('releases a blocked project absent from the reload using its durable local snapshot', async () => {
    resetBrowserStorage();
    const localProject: Project = {
      ...project,
      stateContent: { type: 'doc', content: [block('local', 'keep me')] },
    };
    await addPendingProjectSyncEvent(localProject, 'parent');
    await blockPendingProjectSyncEvents(localProject.id, {
      code: 'unmapped_notion_content',
      message: 'Notion has content without matching Inkwell block mappings.',
    });

    const rebased = await rebaseBlockedProjectSyncEvents(
      [],
      [localProject],
      async () => undefined,
      'parent',
    );
    const queue = await listPendingProjectSyncEvents();

    expect(rebased[0].stateContent?.content?.[0]?.content?.[0]?.text).toBe('keep me');
    expect(queue[0].deliveryBlocked).toBeUndefined();
  });

  test('appending blocks emits one bounded create per block without a full reorder', () => {
    const first = block('first', 'first');
    const added = [block('second', 'second'), block('third', 'third'), block('fourth', 'fourth')];
    const ops = buildPageSyncOps({
      previousPage: page([first]),
      page: page([first, ...added]),
      project,
    });

    expect(ops.map((op) => op.type)).toEqual([
      'block_create',
      'block_create',
      'block_create',
    ]);
    expect(ops.map((op) => op.payload.afterInkwellBlockId)).toEqual([
      'first',
      'second',
      'third',
    ]);
  });
});
