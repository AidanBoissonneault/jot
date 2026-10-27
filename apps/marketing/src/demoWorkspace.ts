/** Names and seed content for the isolated local workspace used by the marketing page. */
import { idbGetMany, idbSet, idbSetMany } from '../../../src/services/idbStore';
import type { DocumentContent, Project, ProjectPage } from '../../../src/types/capture';

const preparedKey = '__jottathing_marketing_demo_names_v1__';
const workspaceKeys = [
  'projects',
  'pages',
  'currentProjectId',
  'activePageIdsByProject',
  'hasMigratedCapturesToPages',
  preparedKey,
];

function emptyDocument(): DocumentContent {
  return { type: 'doc', content: [{ type: 'paragraph' }] };
}

function createDemoProject(now: string): Project {
  return {
    id: 'project-jottathing',
    name: 'Demo',
    status: 'active',
    category: 'General',
    createdAt: now,
    updatedAt: now,
    stateContent: emptyDocument(),
    tags: ['jottathing'],
    syncState: 'saved',
  };
}

function createNotesPage(projectId: string, now: string): ProjectPage {
  return {
    id: `page-${projectId}`,
    projectId,
    kind: 'page',
    title: 'Your Notes',
    status: 'active',
    content: emptyDocument(),
    createdAt: now,
    updatedAt: now,
    localRevision: crypto.randomUUID(),
    syncState: 'saved',
  };
}

/** Prepares the same local workspace the side panel normally opens, with friendlier demo labels. */
export async function prepareDemoWorkspace(): Promise<void> {
  const stored = await idbGetMany(workspaceKeys);
  if (stored[preparedKey] === true) return;

  const now = new Date().toISOString();
  let projects = Array.isArray(stored.projects) ? (stored.projects as Project[]) : [];
  let pages = Array.isArray(stored.pages) ? (stored.pages as ProjectPage[]) : [];
  const activeProjects = projects
    .filter((project) => project.status !== 'archived')
    .sort((first, second) => Date.parse(second.updatedAt) - Date.parse(first.updatedAt));

  if (activeProjects.length === 0) {
    const project = createDemoProject(now);
    projects = [...projects, project];
    activeProjects.push(project);
  }

  const storedProjectId = typeof stored.currentProjectId === 'string'
    ? stored.currentProjectId
    : '';
  const project = activeProjects.find((item) => item.id === storedProjectId) ?? activeProjects[0]!;

  if (project.name === 'Jottathing') {
    const renamedProject = { ...project, name: 'Demo', updatedAt: now };
    projects = projects.map((item) => item.id === project.id ? renamedProject : item);
  }

  const activePageIds = stored.activePageIdsByProject && typeof stored.activePageIdsByProject === 'object'
    ? { ...stored.activePageIdsByProject as Record<string, string> }
    : {};
  const page = pages.find((item) =>
    item.id === activePageIds[project.id] &&
    item.projectId === project.id &&
    item.status !== 'archived',
  ) ?? pages.find((item) => item.projectId === project.id && item.status !== 'archived');

  if (page) {
    if (page.title === 'Untitled Page') {
      pages = pages.map((item) => item.id === page.id
        ? { ...item, title: 'Your Notes', updatedAt: now }
        : item);
    }
    activePageIds[project.id] = page.id;
  } else {
    const notesPage = createNotesPage(project.id, now);
    pages = [...pages, notesPage];
    activePageIds[project.id] = notesPage.id;
  }

  await idbSetMany({
    projects,
    pages,
    currentProjectId: project.id,
    activePageIdsByProject: activePageIds,
    hasMigratedCapturesToPages: true,
  });
  await idbSet(preparedKey, true);
}
