import type {
  Capture,
  DocumentContent,
  Project,
  ProjectPage,
} from '@/src/types/capture';
import type { CaptureSelectionPayload } from '@/src/types/messages';

type JotStorage = {
  activePageIdsByProject?: Record<string, string>;
  captures?: Capture[];
  currentProjectId?: string;
  hasMigratedCapturesToPages?: boolean;
  pages?: ProjectPage[];
  projects?: Project[];
};

const STORAGE_KEYS: Array<keyof JotStorage> = [
  'activePageIdsByProject',
  'captures',
  'currentProjectId',
  'hasMigratedCapturesToPages',
  'pages',
  'projects',
];

const mockProjects: Project[] = [
  {
    id: 'project-product-research',
    name: 'Product Research',
    status: 'active',
    tags: ['research', 'jot'],
  },
  {
    id: 'project-writing',
    name: 'Writing Queue',
    status: 'active',
    tags: ['notes'],
  },
];

const mockCaptures: Capture[] = [
  {
    id: 'capture-quote-1',
    projectId: 'project-product-research',
    type: 'quote',
    content: 'Capture without breaking flow.',
    sourceUrl: 'https://example.com/product-thinking',
    pageTitle: 'Product Thinking',
    highlightMeta: {
      text: 'Capture without breaking flow.',
    },
    createdAt: '2026-05-05T20:12:00.000Z',
  },
  {
    id: 'capture-task-1',
    projectId: 'project-product-research',
    type: 'task',
    content: 'Sketch the drag-to-sidebar interaction states.',
    sourceUrl: 'https://example.com/ux-notes',
    pageTitle: 'UX Notes',
    createdAt: '2026-05-05T20:42:00.000Z',
  },
  {
    id: 'capture-link-1',
    projectId: 'project-writing',
    type: 'link',
    content: 'https://example.com/notion-api-patterns',
    sourceUrl: 'https://example.com/notion-api-patterns',
    pageTitle: 'Notion API Patterns',
    createdAt: '2026-05-05T21:03:00.000Z',
  },
];

const waitForStub = () => new Promise((resolve) => setTimeout(resolve, 120));

function emptyDocument(): DocumentContent {
  return {
    type: 'doc',
    content: [
      {
        type: 'paragraph',
      },
    ],
  };
}

function textParagraph(text: string, marks?: DocumentContent['marks']): DocumentContent {
  return {
    type: 'paragraph',
    content: [
      {
        type: 'text',
        text,
        ...(marks ? { marks } : {}),
      },
    ],
  };
}

export function createCapturedContent(payload: CaptureSelectionPayload): DocumentContent[] {
  if (payload.highlightMeta.isHeading) {
    return createLinkedHeadingContent(payload);
  }

  return [
    {
      type: 'blockquote',
      content: [textParagraph(payload.text)],
    },
    textParagraph(`Source: ${payload.pageTitle || 'Untitled page'} - ${payload.sourceUrl}`, [
      {
        type: 'link',
        attrs: {
          href: payload.sourceUrl,
          target: '_blank',
          rel: 'noopener noreferrer nofollow',
          class: null,
        },
      },
    ]),
    {
      type: 'paragraph',
    },
  ];
}

export function createLinkedHeadingContent(
  payload: CaptureSelectionPayload,
): DocumentContent[] {
  const href = payload.highlightMeta.sourceLink || payload.sourceUrl;

  return [
    {
      type: 'heading',
      attrs: {
        level: 2,
      },
      content: [
        {
          type: 'text',
          text: payload.text,
          marks: [
            {
              type: 'link',
              attrs: {
                href,
                target: '_blank',
                rel: 'noopener noreferrer nofollow',
                class: null,
              },
            },
          ],
        },
      ],
    },
    {
      type: 'paragraph',
    },
  ];
}

function pageContentFromCaptures(captures: Capture[]): DocumentContent {
  const content = captures.flatMap((capture) =>
    createCapturedContent({
      text: capture.content,
      sourceUrl: capture.sourceUrl,
      pageTitle: capture.pageTitle,
      highlightMeta: capture.highlightMeta ?? {
        text: capture.content,
      },
    }),
  );

  return {
    type: 'doc',
    content: content.length ? content : emptyDocument().content,
  };
}

function createDefaultPages(projects: Project[], captures: Capture[]): ProjectPage[] {
  const now = new Date().toISOString();

  return projects.map((project) => {
    const projectCaptures = captures
      .filter((capture) => capture.projectId === project.id)
      .sort(
        (first, second) =>
          new Date(first.createdAt).getTime() - new Date(second.createdAt).getTime(),
      );

    return {
      id: `page-${project.id}`,
      projectId: project.id,
      title: `${project.name} Page`,
      status: 'active',
      content: pageContentFromCaptures(projectCaptures),
      createdAt: now,
      updatedAt: now,
    };
  });
}

async function readStorage(): Promise<Required<JotStorage>> {
  const stored = (await browser.storage.local.get(STORAGE_KEYS)) as JotStorage;

  const projects = stored.projects?.length ? stored.projects : mockProjects;
  const captures = stored.captures ?? mockCaptures;
  const shouldCreatePages =
    !stored.pages?.length || !stored.hasMigratedCapturesToPages;
  const pages = (shouldCreatePages
    ? createDefaultPages(projects, captures)
    : stored.pages ?? createDefaultPages(projects, captures)
  ).map((page) => ({
    ...page,
    status: page.status ?? 'active',
  }));
  const currentProjectId = stored.currentProjectId || projects[0]?.id || '';
  const activePageIdsByProject = createCompatibleActivePageIds(
    projects,
    pages,
    stored.activePageIdsByProject,
  );
  const hasCompatibleActivePages =
    JSON.stringify(activePageIdsByProject) ===
    JSON.stringify(stored.activePageIdsByProject ?? {});
  const hasCompatiblePageStatuses =
    !stored.pages || stored.pages.every((page) => page.status);

  if (
    !stored.activePageIdsByProject ||
    !hasCompatibleActivePages ||
    !hasCompatiblePageStatuses ||
    !stored.projects ||
    !stored.currentProjectId ||
    shouldCreatePages ||
    stored.hasMigratedCapturesToPages !== true
  ) {
    await browser.storage.local.set({
      activePageIdsByProject,
      projects,
      currentProjectId,
      pages,
      hasMigratedCapturesToPages: true,
    });
  }

  return {
    captures,
    currentProjectId,
    activePageIdsByProject,
    hasMigratedCapturesToPages: true,
    pages,
    projects,
  };
}

async function writeStorage(storage: Partial<JotStorage>) {
  await browser.storage.local.set(storage);
}

function appendContent(page: ProjectPage, content: DocumentContent[]): ProjectPage {
  const existingContent = page.content.content ?? [];

  return {
    ...page,
    content: {
      ...page.content,
      type: 'doc',
      content: [...existingContent, ...content],
    },
    updatedAt: new Date().toISOString(),
  };
}

function createCompatibleActivePageIds(
  projects: Project[],
  pages: ProjectPage[],
  storedActivePageIds: Record<string, string> | undefined,
) {
  return projects.reduce<Record<string, string>>((result, project) => {
    const projectPages = pages.filter(
      (page) => page.projectId === project.id && page.status !== 'archived',
    );
    const storedPageId = storedActivePageIds?.[project.id];
    const storedPage = projectPages.find((page) => page.id === storedPageId);

    result[project.id] = storedPage?.id ?? projectPages[0]?.id ?? '';
    return result;
  }, {});
}

function createEmptyPage(projectId: string, title: string): ProjectPage {
  const now = new Date().toISOString();

  return {
    id: `page-${projectId}-${crypto.randomUUID()}`,
    projectId,
    title,
    status: 'active',
    content: emptyDocument(),
    createdAt: now,
    updatedAt: now,
  };
}

export const notionClient = {
  async listProjects(): Promise<Project[]> {
    await waitForStub();
    const { projects } = await readStorage();
    return [...projects];
  },

  async getCurrentProjectId(): Promise<string> {
    const { currentProjectId } = await readStorage();
    return currentProjectId;
  },

  async setCurrentProjectId(projectId: string): Promise<void> {
    const { projects } = await readStorage();

    if (!projects.some((project) => project.id === projectId)) {
      return;
    }

    await writeStorage({ currentProjectId: projectId });
  },

  async getProjectPage(projectId: string): Promise<ProjectPage | undefined> {
    await waitForStub();
    const { activePageIdsByProject, pages } = await readStorage();
    const activePageId = activePageIdsByProject[projectId];
    return (
      pages.find((page) => page.id === activePageId && page.status !== 'archived') ??
      pages.find(
        (page) => page.projectId === projectId && page.status !== 'archived',
      )
    );
  },

  async listProjectPages(projectId: string): Promise<ProjectPage[]> {
    await waitForStub();
    const { pages } = await readStorage();
    return pages
      .filter((page) => page.projectId === projectId && page.status !== 'archived')
      .sort(
        (first, second) =>
          new Date(first.createdAt).getTime() - new Date(second.createdAt).getTime(),
      );
  },

  async setActiveProjectPage(pageId: string): Promise<ProjectPage | undefined> {
    const { activePageIdsByProject, pages } = await readStorage();
    const page = pages.find((storedPage) => storedPage.id === pageId);

    if (!page || page.status === 'archived') {
      return undefined;
    }

    await writeStorage({
      activePageIdsByProject: {
        ...activePageIdsByProject,
        [page.projectId]: page.id,
      },
    });

    return page;
  },

  async createProjectPage(projectId: string, title = 'Untitled Page') {
    const { activePageIdsByProject, pages, projects } = await readStorage();

    if (!projects.some((project) => project.id === projectId)) {
      throw new Error('This project is no longer available.');
    }

    const page = createEmptyPage(projectId, title.trim() || 'Untitled Page');

    await writeStorage({
      activePageIdsByProject: {
        ...activePageIdsByProject,
        [projectId]: page.id,
      },
      pages: [...pages, page],
    });

    return page;
  },

  async renameProjectPage(pageId: string, title: string) {
    const { pages } = await readStorage();
    const page = pages.find((storedPage) => storedPage.id === pageId);

    if (!page) {
      throw new Error('This page is no longer available.');
    }

    const updatedPage = {
      ...page,
      title: title.trim() || 'Untitled Page',
      updatedAt: new Date().toISOString(),
    };

    await writeStorage({
      pages: pages.map((storedPage) =>
        storedPage.id === updatedPage.id ? updatedPage : storedPage,
      ),
    });

    return updatedPage;
  },

  async archiveProjectPage(pageId: string): Promise<ProjectPage> {
    const { activePageIdsByProject, pages } = await readStorage();
    const page = pages.find((storedPage) => storedPage.id === pageId);

    if (!page) {
      throw new Error('This page is no longer available.');
    }

    const archivedPage = {
      ...page,
      status: 'archived' as const,
      updatedAt: new Date().toISOString(),
    };
    const pagesAfterArchive = pages.map((storedPage) =>
      storedPage.id === archivedPage.id ? archivedPage : storedPage,
    );
    const replacementPage =
      pagesAfterArchive.find(
        (storedPage) =>
          storedPage.projectId === page.projectId && storedPage.status !== 'archived',
      ) ?? createEmptyPage(page.projectId, 'Untitled Page');
    const nextPages = pagesAfterArchive.some(
      (storedPage) => storedPage.id === replacementPage.id,
    )
      ? pagesAfterArchive
      : [...pagesAfterArchive, replacementPage];

    await writeStorage({
      activePageIdsByProject: {
        ...activePageIdsByProject,
        [page.projectId]: replacementPage.id,
      },
      pages: nextPages,
    });

    return replacementPage;
  },

  async updateProjectPage(page: ProjectPage): Promise<ProjectPage> {
    const { pages } = await readStorage();
    const updatedPage = {
      ...page,
      updatedAt: new Date().toISOString(),
    };

    await writeStorage({
      pages: pages.map((storedPage) =>
        storedPage.id === updatedPage.id ? updatedPage : storedPage,
      ),
    });

    return updatedPage;
  },

  async appendCaptureToCurrentPage(
    payload: CaptureSelectionPayload,
  ): Promise<ProjectPage> {
    const { activePageIdsByProject, currentProjectId, pages, projects } =
      await readStorage();
    const projectId = currentProjectId || projects[0]?.id;
    const page =
      pages.find(
        (storedPage) =>
          storedPage.id === activePageIdsByProject[projectId] &&
          storedPage.status !== 'archived',
      ) ??
      pages.find(
        (storedPage) =>
          storedPage.projectId === projectId && storedPage.status !== 'archived',
      );

    if (!page) {
      throw new Error('No Jot page is available for this capture.');
    }

    const updatedPage = appendContent(page, createCapturedContent(payload));

    await writeStorage({
      pages: pages.map((storedPage) =>
        storedPage.id === updatedPage.id ? updatedPage : storedPage,
      ),
    });

    return updatedPage;
  },
};
