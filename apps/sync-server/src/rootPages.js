export function createRootPageHelpers({
  appendLog,
  createChildPage,
  createWorkspacePage,
  isNotionObjectNotFound,
  jotRootPageTitle = 'Jot',
  listAllBlockChildren,
  notionRequest,
  titleFromPage,
  updatePageTitle,
}) {
  async function ensureJotRootPage(store, { selectedParentPageId } = {}) {
    const stored = store.jotRootPage;

    if (selectedParentPageId) {
      if (stored?.id === selectedParentPageId) {
        const existing = await refreshStoredRootPage(store, stored, undefined);

        if (existing) {
          return existing;
        }
      }

      try {
        const page = await notionRequest(store, `/pages/${selectedParentPageId}`);
        store.jotRootPage = {
          id: page.id,
          parentPageId: undefined,
          title: titleFromPage(page) || jotRootPageTitle,
          url: page.url,
        };
        store.jotDatabase = undefined;
        appendLog(store, 'root_page_adopted', store.jotRootPage.title);
        return pageSummary(store.jotRootPage);
      } catch (error) {
        if (!isNotionObjectNotFound(error)) {
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

    const page = await createWorkspacePage(store, jotRootPageTitle);
    store.jotRootPage = {
      id: page.id,
      parentPageId: undefined,
      title: titleFromPage(page) || jotRootPageTitle,
      url: page.url,
    };
    store.jotDatabase = undefined;
    appendLog(store, 'root_page_created', store.jotRootPage.title);

    return pageSummary(store.jotRootPage);
  }

  async function refreshStoredRootPage(store, stored, parentPageId) {
    try {
      const page = await notionRequest(store, `/pages/${stored.id}`);
      store.jotRootPage = {
        id: page.id,
        parentPageId,
        title: titleFromPage(page) || stored.title || jotRootPageTitle,
        url: page.url,
      };
      return pageSummary(store.jotRootPage);
    } catch (error) {
      appendLog(store, 'root_page_lookup_error', error.message);
      return undefined;
    }
  }

  async function ensureProjectRootPage(
    store,
    jotRootPageId,
    project,
    { candidateNotionPageId } = {},
  ) {
    const stored = store.projectPages[project.id];

    if (stored?.notionPageId && stored.parentPageId === jotRootPageId) {
      const existing = await refreshProjectRootPage(store, jotRootPageId, project, stored);

      if (existing) {
        return existing;
      }
    }

    const candidate = await adoptCandidateProjectPage(
      store,
      jotRootPageId,
      project,
      candidateNotionPageId,
    );

    if (candidate) {
      return candidate;
    }

    const matchingChild = await findChildPageByTitle(
      store,
      jotRootPageId,
      project.name || 'Untitled Project',
    );

    if (matchingChild) {
      return storeProjectRootPage(store, jotRootPageId, project, matchingChild, 'project_page_adopted');
    }

    const page = await createChildPage(store, jotRootPageId, project.name || 'Untitled Project');
    return storeProjectRootPage(store, jotRootPageId, project, page, 'project_page_created');
  }

  async function refreshProjectRootPage(store, jotRootPageId, project, stored) {
    try {
      const page = await notionRequest(store, `/pages/${stored.notionPageId}`);
      const title = project.name || stored.title || 'Untitled Project';

      if (titleFromPage(page) !== title) {
        await updatePageTitle(store, page.id, title);
      }

      return storeProjectRootPage(store, jotRootPageId, project, {
        ...page,
        title,
      });
    } catch (error) {
      appendLog(store, 'project_page_lookup_error', error.message);
      return undefined;
    }
  }

  async function adoptCandidateProjectPage(store, jotRootPageId, project, candidateNotionPageId) {
    if (!candidateNotionPageId) {
      return undefined;
    }

    try {
      const page = await notionRequest(store, `/pages/${candidateNotionPageId}`);

      if (parentPageIdFromNotionPage(page) !== jotRootPageId) {
        return undefined;
      }

      const title = project.name || titleFromPage(page) || 'Untitled Project';

      if (titleFromPage(page) !== title) {
        await updatePageTitle(store, page.id, title);
      }

      return storeProjectRootPage(store, jotRootPageId, project, {
        ...page,
        title,
      }, 'project_page_adopted');
    } catch (error) {
      appendLog(store, 'project_page_candidate_error', error.message);
      return undefined;
    }
  }

  async function findChildPageByTitle(store, jotRootPageId, title) {
    const children = await listAllBlockChildren(store, jotRootPageId).catch((error) => {
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
          parent: { type: 'page_id', page_id: jotRootPageId },
          title,
        }
      : undefined;
  }

  function storeProjectRootPage(store, jotRootPageId, project, page, logEvent) {
    const title = page.title || titleFromPage(page) || project.name || 'Untitled Project';

    store.projectPages[project.id] = {
      notionPageId: page.id,
      parentPageId: jotRootPageId,
      title,
      lastEditedTime: page.last_edited_time,
    };

    if (logEvent) {
      appendLog(store, logEvent, store.projectPages[project.id].title);
    }

    return pageSummary({
      id: page.id,
      parentPageId: jotRootPageId,
      title,
      url: page.url,
    });
  }

  return {
    ensureJotRootPage,
    ensureProjectRootPage,
    pageSummary,
  };
}

export function pageSummary(page) {
  return {
    id: page.id,
    parentPageId: page.parentPageId,
    title: page.title || 'Jot',
    url: page.url,
  };
}

function parentPageIdFromNotionPage(page) {
  return page?.parent?.type === 'page_id' ? page.parent.page_id : undefined;
}
