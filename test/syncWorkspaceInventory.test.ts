import { describe, expect, test } from 'vitest';
import {
  hasWorkspaceStructureChanged,
  isUnrepresentedSyncedPage,
} from '@/apps/worker/src/syncWorkspaceInventory';
import type { Project, ProjectPage } from '@/src/types/capture';

const project = { id: 'project-1', status: 'active' } as Project;
const linkedPage = {
  id: 'random-local-page-id',
  projectId: project.id,
  status: 'active',
  notionPageId: 'notion-thread-id',
} as ProjectPage;

describe('shared workspace inventory comparison', () => {
  test('matches locally generated IDs through their stable Notion page IDs', () => {
    expect(hasWorkspaceStructureChanged(
      { pageIds: ['notion-thread-id'], projectIds: [project.id] },
      [project],
      [linkedPage],
    )).toBe(false);
  });

  test('detects a page created or deleted by another instance', () => {
    expect(hasWorkspaceStructureChanged(
      { pageIds: ['notion-thread-id', 'new-notion-thread-id'], projectIds: [project.id] },
      [project],
      [linkedPage],
    )).toBe(true);

    expect(hasWorkspaceStructureChanged(
      { pageIds: [], projectIds: [project.id] },
      [project],
      [linkedPage],
    )).toBe(true);
  });

  test('detects a project created or deleted by another instance', () => {
    expect(hasWorkspaceStructureChanged(
      { pageIds: ['notion-thread-id'], projectIds: [project.id, 'project-2'] },
      [project],
      [linkedPage],
    )).toBe(true);

    expect(hasWorkspaceStructureChanged(
      { pageIds: [], projectIds: [] },
      [project],
      [linkedPage],
    )).toBe(true);
  });

  test('ignores local pages that have not been linked to Notion yet', () => {
    const draftPage = { ...linkedPage, id: 'draft-id', notionPageId: undefined };
    expect(hasWorkspaceStructureChanged(
      { pageIds: ['notion-thread-id'], projectIds: [project.id] },
      [project],
      [linkedPage, draftPage],
    )).toBe(false);
  });

  test('does not treat an old local sync row as a second page after identity remapping', () => {
    const localPageIds = new Set([linkedPage.id]);
    const remotePageIds = new Set(['notion-thread-id']);

    expect(isUnrepresentedSyncedPage({
      entity_type: 'page',
      local_id: 'old-local-random-id',
      notion_block_id: 'notion-thread-id',
      status: 'synced',
    }, localPageIds, remotePageIds)).toBe(false);

    expect(isUnrepresentedSyncedPage({
      entity_type: 'page',
      local_id: 'new-local-id',
      notion_block_id: 'new-notion-thread-id',
      status: 'synced',
    }, localPageIds, remotePageIds)).toBe(true);
  });
});
