/** @file Enforces the one-active-page project rule before Notion archive writes. */

import { HTTPException } from 'hono/http-exception';
import type { ProjectPage } from '../../../src/types/capture.js';
import type { WorkerStore } from './types.js';
import { threadKey } from './projectDatabaseValues.js';

const LAST_PAGE_MESSAGE = 'A project must keep at least one page. Create another page before deleting this one.';

/** Rejects an archive unless the worker knows another active page in the same project. */
export function requireActiveSiblingPage(
  store: WorkerStore,
  page: ProjectPage,
  projectPageId: string,
): void {
  const activePageIds = new Set(
    Object.entries(store.notePages ?? {})
      .filter(([pageId, notePage]) =>
        pageId !== page.id && notePage.parentPageId === projectPageId && !notePage.archived,
      )
      .map(([pageId]) => pageId),
  );

  for (const [key, thread] of Object.entries(store.threadBlocks ?? {})) {
    if (key === threadKey(page.id) || thread.parentPageId !== projectPageId) continue;
    const pageId = key.slice('thread:'.length);
    if (!store.notePages?.[pageId]?.archived) activePageIds.add(pageId);
  }

  if (!activePageIds.size) {
    throw Object.assign(new HTTPException(400, { message: LAST_PAGE_MESSAGE }), {
      code: 'last_project_page',
    });
  }
}
