export async function syncProjectFolder({
  store,
  project,
  selectedParentPageId,
  ensureJotRootPage,
  ensureProjectPage,
  ensureProjectRootPage,
  archiveProjectRootPage,
  pageSummary,
}) {
  if (project.status === 'archived') {
    if (ensureProjectPage) {
      const projectPage = await ensureProjectPage(store, project, { selectedParentPageId });

      return {
        project: projectPage.project,
        projectPage,
        status: 'saved',
        message: 'Archived project in Notion.',
      };
    }

    const stored = store.projectPages?.[project.id];

    if (!stored?.notionPageId) {
      return {
        status: 'saved',
        message: 'Project has no Notion folder to archive.',
      };
    }

    await archiveProjectRootPage(store, stored.notionPageId);
    delete store.projectPages[project.id];

    return {
      projectPage: pageSummary({
        id: stored.notionPageId,
        parentPageId: stored.parentPageId,
        title: stored.title || project.name || 'Untitled Project',
      }),
      status: 'saved',
      message: 'Archived project in Notion.',
    };
  }

  if (ensureProjectPage) {
    const projectPage = await ensureProjectPage(store, project, { selectedParentPageId });

    return {
      project: projectPage.project,
      projectPage,
      status: 'saved',
      message: 'Synced project to Notion database.',
    };
  }

  const jotRootPage = await ensureJotRootPage(store, { selectedParentPageId });
  const projectPage = await ensureProjectRootPage(store, jotRootPage.id, project);

  return {
    parentPage: jotRootPage,
    projectPage,
    status: 'saved',
    message: 'Synced project to Notion.',
  };
}
