/** Names and seed content for the isolated local workspace used by the marketing page. */
import { idbGetMany, idbSet, idbSetMany } from '../../../src/services/idbStore';
import type { DocumentContent, Project, ProjectPage, Workspace } from '../../../src/types/capture';

const preparedKey = '__jottathing_marketing_demo_workspace_v2__';
const workspaceKeys = [
  'projects',
  'pages',
  'currentProjectId',
  'activePageIdsByProject',
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
    workspaceId: 'workspace-local-device',
    syncMode: 'local',
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
    workspaceId: 'workspace-local-device',
    syncMode: 'local',
    localRevision: crypto.randomUUID(),
    syncState: 'saved',
  };
}

function createDemoWorkspaceRecord(now: string): Workspace {
  return {
    id: 'workspace-local-device',
    name: 'Local workspace',
    kind: 'local',
    createdAt: now,
    updatedAt: now,
  };
}

/** Seeds an isolated local workspace using the same records the extension reads. */
export async function prepareDemoWorkspace(): Promise<void> {
  const stored = await idbGetMany(workspaceKeys);
  if (stored[preparedKey] === true) return;

  const now = new Date().toISOString();
  let projects = Array.isArray(stored.projects) ? (stored.projects as Project[]) : [];
  let pages = Array.isArray(stored.pages) ? (stored.pages as ProjectPage[]) : [];
  const workspaces = Array.isArray(stored.workspaces) ? (stored.workspaces as Workspace[]) : [];
  const workspace = workspaces.find((item) => item.id === 'workspace-local-device') ?? createDemoWorkspaceRecord(now);
  const existingProject = projects.find((item) => item.id === 'project-jottathing');
  const project: Project = {
    ...(existingProject ?? createDemoProject(now)),
    name: 'Demo',
    workspaceId: workspace.id,
    syncMode: 'local',
    updatedAt: existingProject?.updatedAt ?? now,
  };
  projects = projects.some((item) => item.id === project.id)
    ? projects.map((item) => item.id === project.id ? project : item)
    : [project, ...projects];

  const activePageIds = stored.activePageIdsByProject && typeof stored.activePageIdsByProject === 'object'
    ? { ...stored.activePageIdsByProject as Record<string, string> }
    : {};
  const existingPage = pages.find((item) =>
    item.id === activePageIds[project.id] && item.projectId === project.id && item.status !== 'archived',
  ) ?? pages.find((item) => item.projectId === project.id && item.status !== 'archived');
  const page: ProjectPage = {
    ...(existingPage ?? createNotesPage(project.id, now)),
    title: existingPage?.title && existingPage.title !== 'Untitled Page'
      ? existingPage.title
      : 'Your Notes',
    workspaceId: workspace.id,
    syncMode: 'local',
    syncAccountId: undefined,
    syncWorkspaceId: undefined,
  };
  pages = pages.some((item) => item.id === page.id)
    ? pages.map((item) => item.id === page.id ? page : item)
    : [...pages, page];
  activePageIds[project.id] = page.id;

  await idbSetMany({
    projects,
    pages,
    workspaces: workspaces.some((item) => item.id === workspace.id)
      ? workspaces
      : [...workspaces, workspace],
    currentProjectId: project.id,
    currentWorkspaceId: workspace.id,
    currentProjectIdByWorkspace: {
      ...((stored.currentProjectIdByWorkspace as Record<string, string> | undefined) ?? {}),
      [workspace.id]: project.id,
    },
    activePageIdsByProject: activePageIds,
  });
  await idbSet(preparedKey, true);
}
