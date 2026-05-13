// @ts-nocheck
export function createRootPageHelpers({
  appendLog,
  createChildPage,
  createWorkspacePage,
  isNotionObjectNotFound,
  inkwellRootPageTitle = 'Inkwell',
  listAllBlockChildren,
  notionRequest,
  titleFromPage,
  updatePageTitle,
}) {
  async function ensureInkwellRootPage(store, { selectedParentPageId } = {}) {
    const stored = store.inkwellRootPage;

    if (selectedParentPageId) {
      if (stored?.id === selectedParentPageId) {
        const existing = await refreshStoredRootPage(store, stored, undefined);

        if (existing) {
          return existing;
        }
      }

      try {
        const page = await notionRequest(store, `/pages/${selectedParentPageId}`);
        store.inkwellRootPage = {
          id: page.id,
          parentPageId: undefined,
          title: titleFromPage(page) || inkwellRootPageTitle,
          url: page.url,
        };
        store.inkwellDatabase = undefined;
        appendLog(store, 'root_page_adopted', store.inkwellRootPage.title);
        return pageSummary(store.inkwellRootPage);
      } catch (error) {
        if (!isNotionObjectNotFound(error) && !isBlockNotPageError(error)) {
          throw error;
        }

        appendLog(
          store,
          'root_parent_inaccessible',
          `${selectedParentPageId}: ${error.message}`,
        );
      }
    }

    if (stored?.id && !selectedParentPageId) {
      const existing = await refreshStoredRootPage(store, stored, stored.parentPageId);

      if (existing) {
        return existing;
      }
    }

    const page = await createWorkspacePage(store, inkwellRootPageTitle);
    store.inkwellRootPage = {
      id: page.id,
      parentPageId: undefined,
      title: titleFromPage(page) || inkwellRootPageTitle,
      url: page.url,
    };
    store.inkwellDatabase = undefined;
    appendLog(store, 'root_page_created', store.inkwellRootPage.title);

    return pageSummary(store.inkwellRootPage);
  }

  async function refreshStoredRootPage(store, stored, parentPageId) {
    try {
      const page = await notionRequest(store, `/pages/${stored.id}`);
      store.inkwellRootPage = {
        id: page.id,
        parentPageId,
        title: titleFromPage(page) || stored.title || inkwellRootPageTitle,
        url: page.url,
      };
      return pageSummary(store.inkwellRootPage);
    } catch (error) {
      appendLog(store, 'root_page_lookup_error', error.message);
      return undefined;
    }
  }

  async function ensureProjectRootPage(
    store,
    inkwellRootPageId,
    project,
    { candidateNotionPageId } = {},
  ) {
    const stored = store.projectPages[project.id];

    if (stored?.notionPageId && stored.parentPageId === inkwellRootPageId) {
      const existing = await refreshProjectRootPage(store, inkwellRootPageId, project, stored);

      if (existing) {
        return existing;
      }
    }

    const candidate = await adoptCandidateProjectPage(
      store,
      inkwellRootPageId,
      project,
      candidateNotionPageId,
    );

    if (candidate) {
      return candidate;
    }

    const matchingChild = await findChildPageByTitle(
      store,
      inkwellRootPageId,
      project.name || 'Untitled Project',
    );

    if (matchingChild) {
      return storeProjectRootPage(store, inkwellRootPageId, project, matchingChild, 'project_page_adopted');
    }

    const page = await createChildPage(store, inkwellRootPageId, project.name || 'Untitled Project');
    return storeProjectRootPage(store, inkwellRootPageId, project, page, 'project_page_created');
  }

  async function refreshProjectRootPage(store, inkwellRootPageId, project, stored) {
    try {
      const page = await notionRequest(store, `/pages/${stored.notionPageId}`);
      const title = project.name || stored.title || 'Untitled Project';

      if (titleFromPage(page) !== title) {
        await updatePageTitle(store, page.id, title);
      }

      return storeProjectRootPage(store, inkwellRootPageId, project, {
        ...page,
        title,
      });
    } catch (error) {
      appendLog(store, 'project_page_lookup_error', error.message);
      return undefined;
    }
  }

  async function adoptCandidateProjectPage(store, inkwellRootPageId, project, candidateNotionPageId) {
    if (!candidateNotionPageId) {
      return undefined;
    }

    try {
      const page = await notionRequest(store, `/pages/${candidateNotionPageId}`);

      if (parentPageIdFromNotionPage(page) !== inkwellRootPageId) {
        return undefined;
      }

      const title = project.name || titleFromPage(page) || 'Untitled Project';

      if (titleFromPage(page) !== title) {
        await updatePageTitle(store, page.id, title);
      }

      return storeProjectRootPage(store, inkwellRootPageId, project, {
        ...page,
        title,
      }, 'project_page_adopted');
    } catch (error) {
      appendLog(store, 'project_page_candidate_error', error.message);
      return undefined;
    }
  }

  async function findChildPageByTitle(store, inkwellRootPageId, title) {
    const children = await listAllBlockChildren(store, inkwellRootPageId).catch((error) => {
      appendLog(store, 'project_page_lookup_error', error.message);
      return [];
    });

    const child = children.find((block) =>
      block.type === 'child_page' &&
      block.child_page?.title === title &&
      !block.archived,
    );

    return child
      ? {
          id: child.id,
          parent: { type: 'page_id', page_id: inkwellRootPageId },
          title,
        }
      : undefined;
  }

  function storeProjectRootPage(store, inkwellRootPageId, project, page, logEvent) {
    const title = page.title || titleFromPage(page) || project.name || 'Untitled Project';

    store.projectPages[project.id] = {
      notionPageId: page.id,
      parentPageId: inkwellRootPageId,
      title,
      lastEditedTime: page.last_edited_time,
    };

    if (logEvent) {
      appendLog(store, logEvent, store.projectPages[project.id].title);
    }

    return pageSummary({
      id: page.id,
      parentPageId: inkwellRootPageId,
      title,
      url: page.url,
    });
  }

  return {
    ensureInkwellRootPage,
    ensureProjectRootPage,
    pageSummary,
  };
}

export function pageSummary(page) {
  return {
    id: page.id,
    parentPageId: page.parentPageId,
    title: page.title || 'Inkwell',
    url: page.url,
  };
}

function parentPageIdFromNotionPage(page) {
  return page?.parent?.type === 'page_id' ? page.parent.page_id : undefined;
}

function isBlockNotPageError(error) {
  return (
    error?.code === 'validation_error' &&
    /is a block, not a page|retrieve block API/i.test(error?.message ?? '')
  );
}
