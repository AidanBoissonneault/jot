/**
 * @file Finds, adopts, creates, and refreshes legacy Notion root and project pages.
 * @author Aidan Boissonneault
 * @lastModified September 2026
 */

import type { NotionParentPage, Project } from '../../../src/types/capture.js';
import { isArchivedObject } from './projectDatabaseValues.js';
import type {
  AppendLog,
  ListAllBlockChildren,
  NotionObject,
  NotionRequester,
  StoredPage,
  WorkerStore,
} from './types.js';

/** Describes the root page dependencies contract used by this API feature. */
interface RootPageDependencies {
  appendLog: AppendLog;
  createChildPage: (store: WorkerStore, parentPageId: string, title: string) => Promise<NotionObject>;
  createWorkspacePage: (store: WorkerStore, title: string) => Promise<NotionObject>;
  jottathingRootPageTitle: string;
  isNotionObjectNotFound: (error: unknown) => boolean;
  listAllBlockChildren: ListAllBlockChildren;
  notionRequest: NotionRequester;
  titleFromPage: (page: NotionObject | NotionParentPage) => string;
  updatePageTitle: (store: WorkerStore, pageId: string, title: string) => Promise<unknown>;
}

/** Describes the project page candidate contract used by this API feature. */
interface ProjectPageCandidate extends NotionParentPage {
  last_edited_time: string | undefined;
}

/** Describes the root page helpers contract used by this API feature. */
export interface RootPageHelpers {
  ensureJottathingRootPage: (
    store: WorkerStore,
    options?: { selectedParentPageId: string | undefined },
  ) => Promise<NotionParentPage>;
  ensureProjectRootPage: (
    store: WorkerStore,
    jottathingRootPageId: string,
    project: Project,
    options?: { candidateNotionPageId: string | undefined },
  ) => Promise<NotionParentPage>;
  pageSummary: (page: NotionParentPage) => NotionParentPage;
}

/**
 * Creates legacy root-page operations bound to their Notion dependencies.
 * @param dependencies - Logging, page mutation, lookup, and configuration dependencies.
 * @returns Root-page operations used by the sync coordinator.
 */
export function createRootPageHelpers({
  appendLog,
  createChildPage,
  createWorkspacePage,
  isNotionObjectNotFound,
  jottathingRootPageTitle = 'Jottathing',
  listAllBlockChildren,
  notionRequest,
  titleFromPage,
  updatePageTitle,
}: Omit<RootPageDependencies, 'jottathingRootPageTitle'> & Partial<Pick<RootPageDependencies, 'jottathingRootPageTitle'>>): RootPageHelpers {
  /**
   * Resolves the configured Jottathing root page, adopting or creating it as needed.
   * @param store - Normalized worker state.
   * @param options - Optional explicitly selected parent page.
   * @returns The accessible root-page summary.
   */
  async function ensureJottathingRootPage(
    store: WorkerStore,
    { selectedParentPageId }: { selectedParentPageId: string | undefined } = { selectedParentPageId: undefined },
  ): Promise<NotionParentPage> {
    const stored = store.jottathingRootPage;

    if (selectedParentPageId) {
      if (stored?.id === selectedParentPageId) {
        const existing = await refreshStoredRootPage(store, stored, undefined);

        if (existing) {
          return existing;
        }
      }

      try {
        const page = await notionRequest(store, `/pages/${selectedParentPageId}`);
        store.jottathingRootPage = {
          id: page.id,
          parentPageId: undefined,
          title: titleFromPage(page) || jottathingRootPageTitle,
          url: page.url,
        };
        store.jottathingDatabase = undefined;
        appendLog(store, 'root_page_adopted', store.jottathingRootPage.title);
        return pageSummary(store.jottathingRootPage);
      } catch (error) {
        if (!isNotionObjectNotFound(error) && !isBlockNotPageError(error)) {
          throw error;
        }

        appendLog(
          store,
          'root_parent_inaccessible',
          `${selectedParentPageId}: ${errorMessage(error)}`,
        );
      }
    }

    if (stored?.id && !selectedParentPageId) {
      const existing = await refreshStoredRootPage(store, stored, stored.parentPageId);

      if (existing) {
        return existing;
      }
    }

    const page = await createWorkspacePage(store, jottathingRootPageTitle);
    store.jottathingRootPage = {
      id: page.id,
      parentPageId: undefined,
      title: titleFromPage(page) || jottathingRootPageTitle,
      url: page.url,
    };
    store.jottathingDatabase = undefined;
    appendLog(store, 'root_page_created', store.jottathingRootPage.title);

    return pageSummary(store.jottathingRootPage);
  }

  /**
   * Refreshes a previously stored root-page reference.
   * @param store - Normalized worker state.
   * @param stored - Previously persisted root-page summary.
   * @param parentPageId - Parent page to retain in the refreshed summary.
   * @returns A refreshed summary, or undefined when inaccessible.
   */
  async function refreshStoredRootPage(
    store: WorkerStore,
    stored: NotionParentPage,
    parentPageId: string | undefined,
  ): Promise<NotionParentPage | undefined> {
    try {
      const page = await notionRequest(store, `/pages/${stored.id}`);
      store.jottathingRootPage = {
        id: page.id,
        parentPageId,
        title: titleFromPage(page) || stored.title || jottathingRootPageTitle,
        url: page.url,
      };
      return pageSummary(store.jottathingRootPage);
    } catch (error) {
      appendLog(store, 'root_page_lookup_error', errorMessage(error));
      return undefined;
    }
  }

  /**
   * Resolves a legacy project child page under the Jottathing root.
   * @param store - Normalized worker state.
   * @param jottathingRootPageId - Owning root-page identifier.
   * @param project - Local project to represent.
   * @param options - Optional existing Notion page candidate.
   * @returns The project-page summary.
   */
  async function ensureProjectRootPage(
    store: WorkerStore,
    jottathingRootPageId: string,
    project: Project,
    { candidateNotionPageId }: { candidateNotionPageId: string | undefined } = { candidateNotionPageId: undefined },
  ): Promise<NotionParentPage> {
    const stored = store.projectPages[project.id];

    if (stored?.notionPageId && stored.parentPageId === jottathingRootPageId) {
      const existing = await refreshProjectRootPage(store, jottathingRootPageId, project, stored);

      if (existing) {
        return existing;
      }
    }

    const candidate = await adoptCandidateProjectPage(
      store,
      jottathingRootPageId,
      project,
      candidateNotionPageId,
    );

    if (candidate) {
      return candidate;
    }

    const matchingChild = await findChildPageByTitle(
      store,
      jottathingRootPageId,
      project.name || 'Untitled Project',
    );

    if (matchingChild) {
      return storeProjectRootPage(store, jottathingRootPageId, project, matchingChild, 'project_page_adopted');
    }

    const page = await createChildPage(store, jottathingRootPageId, project.name || 'Untitled Project');
    return storeProjectRootPage(store, jottathingRootPageId, project, page, 'project_page_created');
  }

  /**
   * Refreshes and, when needed, renames a stored project root page.
   * @param store - Normalized worker state.
   * @param jottathingRootPageId - Owning root-page identifier.
   * @param project - Local project metadata.
   * @param stored - Stored project-page mapping.
   * @returns The refreshed page summary or undefined.
   */
  async function refreshProjectRootPage(
    store: WorkerStore,
    jottathingRootPageId: string,
    project: Project,
    stored: StoredPage,
  ): Promise<NotionParentPage | undefined> {
    try {
      const page = await notionRequest(store, `/pages/${stored.notionPageId}`);
      const title = project.name || stored.title || 'Untitled Project';

      if (titleFromPage(page) !== title) {
        await updatePageTitle(store, page.id, title);
      }

      return storeProjectRootPage(store, jottathingRootPageId, project, {
        ...page,
        title,
      });
    } catch (error) {
      appendLog(store, 'project_page_lookup_error', errorMessage(error));
      return undefined;
    }
  }

  /**
   * Adopts a caller-provided project page when it belongs to the expected root.
   * @param store - Normalized worker state.
   * @param jottathingRootPageId - Expected root-page identifier.
   * @param project - Local project metadata.
   * @param candidateNotionPageId - Candidate Notion page identifier.
   * @returns The adopted page summary or undefined.
   */
  async function adoptCandidateProjectPage(
    store: WorkerStore,
    jottathingRootPageId: string,
    project: Project,
    candidateNotionPageId: string | undefined,
  ): Promise<NotionParentPage | undefined> {
    if (!candidateNotionPageId) {
      return undefined;
    }

    try {
      const page = await notionRequest(store, `/pages/${candidateNotionPageId}`);

      if (parentPageIdFromNotionPage(page) !== jottathingRootPageId) {
        return undefined;
      }

      const title = project.name || titleFromPage(page) || 'Untitled Project';

      if (titleFromPage(page) !== title) {
        await updatePageTitle(store, page.id, title);
      }

      return storeProjectRootPage(store, jottathingRootPageId, project, {
        ...page,
        title,
      }, 'project_page_adopted');
    } catch (error) {
      appendLog(store, 'project_page_candidate_error', errorMessage(error));
      return undefined;
    }
  }

  /**
   * Finds an accessible child page with an exact title match.
   * @param store - Normalized worker state.
   * @param jottathingRootPageId - Parent block identifier.
   * @param title - Desired child-page title.
   * @returns A page candidate or undefined.
   */
  async function findChildPageByTitle(
    store: WorkerStore,
    jottathingRootPageId: string,
    title: string,
  ): Promise<ProjectPageCandidate | undefined> {
    const children = await listAllBlockChildren(store, jottathingRootPageId).catch((error) => {
      appendLog(store, 'project_page_lookup_error', errorMessage(error));
      return [];
    });

    const child = children.find((block) =>
      block.type === 'child_page' &&
      nestedString(block, 'child_page', 'title') === title &&
      !isArchivedObject(block),
    );

    return child
      ? {
          id: child.id,
          parentPageId: jottathingRootPageId,
          title,
          url: undefined,
          last_edited_time: child.last_edited_time,
        }
      : undefined;
  }

  /**
   * Persists and summarizes a resolved legacy project page.
   * @param store - Normalized worker state.
   * @param jottathingRootPageId - Owning root-page identifier.
   * @param project - Local project metadata.
   * @param page - Resolved Notion page.
   * @param logEvent - Optional event name to append.
   * @returns The persisted page summary.
   */
  function storeProjectRootPage(
    store: WorkerStore,
    jottathingRootPageId: string,
    project: Project,
    page: NotionObject | ProjectPageCandidate,
    logEvent: string | undefined = undefined,
  ): NotionParentPage {
    const explicitTitle = typeof page.title === 'string' ? page.title : '';
    const title = explicitTitle || titleFromPage(page) || project.name || 'Untitled Project';
    const pageUrl = typeof page.url === 'string' ? page.url : undefined;

    store.projectPages[project.id] = {
      archived: false,
      dataSourceId: undefined,
      kind: undefined,
      notionPageId: page.id,
      parentPageId: jottathingRootPageId,
      title,
      lastEditedTime: page.last_edited_time,
    };

    if (logEvent) {
      appendLog(store, logEvent, store.projectPages[project.id].title);
    }

    return pageSummary({
      id: page.id,
      parentPageId: jottathingRootPageId,
      title,
      url: pageUrl,
    });
  }

  return {
    ensureJottathingRootPage,
    ensureProjectRootPage,
    pageSummary,
  };
}

/**
 * Normalizes a page-like object to the public parent-page summary.
 * @param page - Page identity and display metadata.
 * @returns A stable parent-page summary.
 */
function pageSummary(page: NotionParentPage): NotionParentPage {
  return {
    id: page.id,
    parentPageId: page.parentPageId,
    title: page.title || 'Jottathing',
    url: page.url,
  };
}

/**
 * Reads a page parent identifier from a Notion page response.
 * @param page - Notion page response.
 * @returns Parent page identifier or undefined.
 */
function parentPageIdFromNotionPage(page: NotionObject): string | undefined {
  return page?.parent?.type === 'page_id' ? page.parent.page_id : undefined;
}

/**
 * Detects Notion's validation error for block identifiers passed to page APIs.
 * @param error - Unknown thrown value.
 * @returns Whether the error reports a block/page mismatch.
 */
function isBlockNotPageError(error: unknown): boolean {
  return (
    errorProperty(error, 'code') === 'validation_error' &&
    /is a block, not a page|retrieve block API/i.test(errorMessage(error))
  );
}

/**
 * Extracts a readable message from an unknown error.
 * @param error - Unknown thrown value.
 * @returns Human-readable error text.
 */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Reads a string property from an unknown error-like object.
 * @param error - Unknown error-like value.
 * @param key - Property name.
 * @returns The string property or undefined.
 */
function errorProperty(error: unknown, key: string): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const value: unknown = (error as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

/**
 * Reads a nested string from a Notion object.
 * @param value - Root object.
 * @param path - Property path.
 * @returns The nested string or undefined.
 */
function nestedString(value: Record<string, unknown>, ...path: string[]): string | undefined {
  let current: unknown = value;
  for (const key of path) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === 'string' ? current : undefined;
}
