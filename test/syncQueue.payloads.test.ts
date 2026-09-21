import { describe, expect, test } from 'vitest';
import { buildPageSyncOps } from '@/src/services/syncQueue';
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
