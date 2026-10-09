import type { Project, ProjectPage } from '../../../src/types/capture.js';

/** Compares the shared Notion identities that are visible across installations. */
export function hasWorkspaceStructureChanged(
  remote: { pageIds: string[]; projectIds: string[] },
  projects: Project[],
  pages: ProjectPage[],
): boolean {
  const activeProjectIds = new Set(
    projects
      .filter((project) => project.status !== 'archived')
      .map((project) => project.id),
  );
  const linkedRemotePageIds = pages
    .filter((page) => page.status !== 'archived' && activeProjectIds.has(page.projectId))
    .map((page) => page.notionPageId)
    .filter((id): id is string => typeof id === 'string');

  return !sameIdSet(remote.projectIds, [...activeProjectIds]) ||
    !sameIdSet(remote.pageIds, linkedRemotePageIds);
}

function sameIdSet(first: string[], second: string[]): boolean {
  if (first.length !== second.length) return false;
  const ids = new Set(first);
  return ids.size === first.length && second.every((id) => ids.has(id));
}

/** Ignores legacy installation rows already represented by a shared Notion block. */
export function isUnrepresentedSyncedPage(
  row: { entity_type: string; local_id: string; notion_block_id: string | null; status: string },
  localPageIds: Set<string>,
  remoteNotionPageIds: Set<string>,
): boolean {
  return row.status === 'synced' &&
    (row.entity_type === 'page' || row.entity_type === 'block_op') &&
    !localPageIds.has(row.local_id) &&
    (!row.notion_block_id || !remoteNotionPageIds.has(row.notion_block_id));
}
