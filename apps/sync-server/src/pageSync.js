export async function pushPageToNotionCore({
  request,
  page,
  project,
  selectedParentPageId,
  dependencies,
}) {
  const {
    appendLog,
    createChildPage,
    ensureJotRootPage,
    ensureProjectRootPage,
    notionRequest,
    replaceManagedBlocks,
    requireConnectedStore,
    updateChildNotePage,
    writeStore,
  } = dependencies;
  const store = await requireConnectedStore(request);
  const jotRootPage = await ensureJotRootPage(store, { selectedParentPageId });
  const projectRootPage = await ensureProjectRootPage(store, jotRootPage.id, project);
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
    parentPage: jotRootPage,
    page: syncedPage,
    status: 'saved',
    message: 'Synced to Notion.',
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
  if (node?.type === 'image' && node.attrs?.notionFileUploadId) {
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
  if (block?.type !== 'image') {
    return null;
  }

  return block.image?.file?.url ?? block.image?.external?.url ?? null;
}
