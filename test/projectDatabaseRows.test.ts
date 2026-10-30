import { describe, expect, test, vi } from 'vitest';
import { createProjectDatabaseRows } from '@/apps/worker/src/projectDatabaseRows';
import type {
  NotionObject,
  NotionRequester,
  PartialNotionRequestInit,
  WorkerStore,
} from '@/apps/worker/src/types';

function row(id: string, properties: Record<string, unknown> = {}, inTrash = false) {
  return { id, properties, in_trash: inTrash } as NotionObject;
}

function rowsApi(responses: unknown[]) {
  const notionRequest = vi.fn(async (
    _store: WorkerStore,
    _endpoint: string,
    _init?: PartialNotionRequestInit,
  ) => responses.shift() as NotionObject);
  return {
    notionRequest,
    rows: createProjectDatabaseRows(notionRequest as unknown as NotionRequester),
  };
}

describe('project database row pagination', () => {
  test('queries every page and keeps only active managed rows', async () => {
    const { notionRequest, rows } = rowsApi([
      {
        results: [
          row('managed', { 'Managed by Jottathing': { checkbox: true } }),
          row('unmanaged'),
          row('trashed', { 'Managed by Jottathing': { checkbox: true } }, true),
        ],
        has_more: true,
        next_cursor: 'next',
      },
      { results: [row('next-managed', { 'Managed by Jottathing': { checkbox: true } })], has_more: false },
    ]);

    const result = await rows.queryManagedProjectRows({} as WorkerStore, 'data-source');

    expect(result.map(({ id }) => id)).toEqual(['managed', 'next-managed']);
    expect(notionRequest.mock.calls.map(([, , init]) => init?.body)).toEqual([
      { page_size: 100 },
      { page_size: 100, start_cursor: 'next' },
    ]);
  });

  test('pages past trashed duplicate IDs to find the active row', async () => {
    const { notionRequest, rows } = rowsApi([
      { properties: { 'Jottathing ID': { type: 'rich_text' } } },
      { results: [row('trashed', {}, true)], has_more: true, next_cursor: 'next' },
      { results: [row('active')], has_more: false },
    ]);

    const result = await rows.findProjectPageByJottathingId({} as WorkerStore, 'data-source', 'project');

    expect(result?.id).toBe('active');
    expect(notionRequest.mock.calls[1][2]?.body).toMatchObject({
      filter: { property: 'Jottathing ID', rich_text: { equals: 'project' } },
    });
    expect(notionRequest.mock.calls[2][2]?.body).toMatchObject({ start_cursor: 'next' });
  });

  test('rejects a project database with an unsupported ID property', async () => {
    const { notionRequest, rows } = rowsApi([
      { properties: { 'Jottathing ID': { type: 'title' } } },
    ]);

    await expect(rows.findProjectPageByJottathingId({} as WorkerStore, 'data-source', 'project'))
      .rejects.toThrow('Managed project database is missing its rich-text Jottathing ID property.');

    expect(notionRequest).toHaveBeenCalledTimes(1);
  });

  test.each([
    {
      responses: [{ results: [], has_more: true, next_cursor: null }],
    },
    {
      responses: [
        { results: [], has_more: true, next_cursor: 'same' },
        { results: [], has_more: true, next_cursor: 'same' },
      ],
    },
  ])('rejects a Notion result that cannot continue safely', async ({ responses }) => {
    const { rows } = rowsApi(responses);

    await expect(rows.queryManagedProjectRows({} as WorkerStore, 'data-source'))
      .rejects.toThrow('Notion returned an incomplete managed-project list.');
  });

  test.each([null, { has_more: false }])('rejects malformed result pages', async (response) => {
    const { rows } = rowsApi([response]);

    await expect(rows.queryManagedProjectRows({} as WorkerStore, 'data-source'))
      .rejects.toThrow('Notion returned an invalid managed-project page.');
  });
});
