// @ts-nocheck
export async function pushPageToNotionCore({
  request,
  page,
  project,
  selectedParentPageId,
  dependencies,
}) {
  const {
    archiveThreadToggle,
    appendLog,
    createChildPage,
    ensureInkwellRootPage,
    ensureProjectPage,
    ensureProjectRootPage,
    ensureThreadToggle,
    notionRequest,
    replaceManagedBlocks,
    requireConnectedStore,
    updateThreadToggleTitle,
    updateChildNotePage,
    writeStore,
  } = dependencies;
  const store = await requireConnectedStore(request);

  if (ensureProjectPage && ensureThreadToggle) {
    return pushPageToProjectDatabase({
      appendLog,
      archiveThreadToggle,
      ensureProjectPage,
      ensureThreadToggle,
      notionRequest,
      page,
      project,
      replaceManagedBlocks,
      selectedParentPageId,
      store,
      updateThreadToggleTitle,
      writeStore,
    });
  }

  const inkwellRootPage = await ensureInkwellRootPage(store, { selectedParentPageId });
  const projectRootPage = await ensureProjectRootPage(store, inkwellRootPage.id, project, {
    candidateNotionPageId: page.notionParentPageId,
  });
  const notionPageId = page.notionPageId ?? store.notePages[page.id]?.notionPageId;

  let notePage = notionPageId
    ? await notionRequest(store, `/pages/${notionPageId}`)
    : undefined;

  if (
    notePage?.last_edited_time &&
    page.remoteRevision &&
    notePage.last_edited_time !== page.remoteRevision
  ) {
    appendLog(store, 'sync_stale', `${page.title} changed in Notion.`);
    await writeStore(store);
    return {
      page: {
        ...page,
        notionPageId,
        notionDatabaseId: undefined,
        notionDataSourceId: undefined,
        notionParentPageId: projectRootPage.id,
        notionLastEditedTime: notePage.last_edited_time,
        remoteRevision: notePage.last_edited_time,
      },
      status: 'stale',
      message: 'This page changed in Notion. Pull or review it before saving over it.',
    };
  }

  if (!notePage) {
    notePage = await createChildPage(store, projectRootPage.id, page.title);
  } else {
    await updateChildNotePage(store, notePage.id, page);
  }

  const replacement = await replaceManagedBlocks(store, page.id, notePage.id, page.content);
  const refreshedPage = await notionRequest(store, `/pages/${notePage.id}`);
  const syncedContent = normalizeSyncedMediaContent(
    page.content,
    replacement?.createdBlocks ?? [],
  );
  const syncedPage = {
    ...page,
    content: syncedContent,
    notionPageId: notePage.id,
    notionDatabaseId: undefined,
    notionDataSourceId: undefined,
    notionParentPageId: projectRootPage.id,
    notionLastEditedTime: refreshedPage.last_edited_time,
    remoteRevision: refreshedPage.last_edited_time,
    syncState: 'saved',
  };

  store.notePages[page.id] = {
    notionPageId: notePage.id,
    parentPageId: projectRootPage.id,
    title: page.title,
    lastEditedTime: refreshedPage.last_edited_time,
  };
  appendLog(store, 'sync_push', page.title);
  await writeStore(store);

  return {
    parentPage: inkwellRootPage,
    page: syncedPage,
    status: 'saved',
    message: 'Synced to Notion.',
  };
}

async function pushPageToProjectDatabase({
  appendLog,
  archiveThreadToggle,
  ensureProjectPage,
  ensureThreadToggle,
  notionRequest,
  page,
  project,
  replaceManagedBlocks,
  selectedParentPageId,
  store,
  updateThreadToggleTitle,
  writeStore,
}) {
  const projectPage = await ensureProjectPage(store, project, { selectedParentPageId });

  if (page.status === 'archived') {
    await archiveThreadToggle?.(store, page);
    store.notePages[page.id] = {
      ...(store.notePages[page.id] ?? {}),
      parentPageId: projectPage.id,
      title: page.title,
      archived: true,
    };
    appendLog(store, 'sync_thread_archived', page.title);
    await writeStore(store);
    return {
      projectPage,
      page: {
        ...page,
        notionParentPageId: projectPage.id,
        syncState: 'saved',
      },
      status: 'saved',
      message: 'Archived thread in Notion.',
    };
  }

  const toggle = await ensureThreadToggle(store, projectPage.id, page);

  if (
    toggle?.last_edited_time &&
    page.remoteRevision &&
    toggle.last_edited_time !== page.remoteRevision
  ) {
    appendLog(store, 'sync_stale', `${page.title} changed in Notion.`);
    await writeStore(store);
    return {
      projectPage,
      page: {
        ...page,
        notionPageId: toggle.id,
        notionDatabaseId: undefined,
        notionDataSourceId: undefined,
        notionParentPageId: projectPage.id,
        notionLastEditedTime: toggle.last_edited_time,
        remoteRevision: toggle.last_edited_time,
      },
      status: 'stale',
      message: 'This thread changed in Notion. Pull or review it before saving over it.',
    };
  }

  await updateThreadToggleTitle?.(store, page);
  const replacement = await replaceManagedBlocks(store, page.id, toggle.id, page.content);
  const refreshedBlock = await notionRequest(store, `/blocks/${toggle.id}`).catch(() => toggle);
  const syncedContent = normalizeSyncedMediaContent(
    page.content,
    replacement?.createdBlocks ?? [],
  );
  const syncedPage = {
    ...page,
    content: syncedContent,
    notionPageId: toggle.id,
    notionDatabaseId: undefined,
    notionDataSourceId: undefined,
    notionParentPageId: projectPage.id,
    notionLastEditedTime: refreshedBlock.last_edited_time,
    remoteRevision: refreshedBlock.last_edited_time,
    syncState: 'saved',
  };

  store.notePages[page.id] = {
    notionPageId: toggle.id,
    parentPageId: projectPage.id,
    title: page.title,
    lastEditedTime: refreshedBlock.last_edited_time,
    kind: 'thread',
  };
  appendLog(store, 'sync_thread_push', page.title);
  await writeStore(store);

  return {
    projectPage,
    page: syncedPage,
    status: 'saved',
    message: 'Synced thread to Notion.',
  };
}

function normalizeSyncedMediaContent(content, createdBlocks) {
  if (!content?.content?.length) {
    return content;
  }

  return {
    ...content,
    content: content.content.map((node, index) =>
      normalizeSyncedMediaNode(node, createdBlocks[index]),
    ),
  };
}

function normalizeSyncedMediaNode(node, createdBlock) {
  if ((node?.type === 'image' || node?.type === 'audio') && node.attrs?.notionFileUploadId) {
    const url = mediaUrlFromNotionBlock(createdBlock);

    if (url) {
      return {
        ...node,
        attrs: {
          ...node.attrs,
          src: url,
          uploadState: 'done',
        },
      };
    }
  }

  if (!node?.content?.length) {
    return node;
  }

  return {
    ...node,
    content: node.content.map((child) => normalizeSyncedMediaNode(child)),
  };
}

function mediaUrlFromNotionBlock(block) {
  if (block?.type === 'image') {
    return block.image?.file?.url ?? block.image?.external?.url ?? null;
  }

  if (block?.type === 'audio') {
    return block.audio?.file?.url ?? block.audio?.external?.url ?? null;
  }

  return null;
}
