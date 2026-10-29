import type {
  Capture,
  DocumentContent,
  NotionParentPage,
  Project,
  ProjectPage,
  SaveStatus,
  SyncConfig,
  Workspace,
} from '@/src/types/capture';
import {
  idbClear,
  idbGet,
  idbGetMany,
  idbSet,
  idbSetMany,
  pauseIdbWrites,
  resumeIdbWrites,
} from '@/src/services/idbStore';
import { createJottathingBlockId, normalizeJottathingBlockIds } from '@/src/extensions/jottathingBlockIds';
import { JOTTATHING_SOURCE_ATTR, storeJottathingSource } from '@/src/extensions/jottathingLink';
import {
  addSourceToProjectState,
  capturedBlockId,
  migratePageSourcesToProjectState,
  sourceEntryForProjectState,
} from '@/src/extensions/sourceRegistry';
import type {
  CaptureSelectionPayload,
  SourceOpenPayload,
} from '@/src/types/messages';
import { normalizeCodeLanguage } from '@/src/lib/codeLanguages';
import { cleanSyncServerUrl } from '@/src/lib/syncServerUrl';
import { getBrandedStorageValue } from '@/src/services/brandedStorage';
import { pruneOrphanedProjectStateSources } from '@/src/lib/projectStateSources';
import { stripSyncConflictBlocks } from '@/src/lib/syncConflictReview';
import type {
  CreateNotionPageResponse,
  ListNotionPagesResponse,
  MediaUploadResponse,
  MediaRefreshResponse,
  SyncEnqueueResponse,
  SyncEventMessage,
  SyncPageResponse,
  SyncProjectResponse,
  SyncConflictDiff,
  SyncContentConflict,
  SyncReloadResponse,
  SyncProgressUpdate,
  SyncQueueRetryResponse,
  SyncQueueStatusResponse,
  SyncSessionResponse,
  SyncValidationResponse,
} from '@/src/types/sync';
import {
  isDirectMediaUploadActive,
  mergeUploadedMediaAttributes,
  markUnrecoverableTransientMedia,
  preserveLocalMediaSources,
  sanitizeMediaForSync,
} from '@/src/extensions/mediaContent';
import {
  addPendingProjectSyncEvent,
  addPendingProjectSourceSyncEvent,
  addPendingSyncOps,
  blockPendingProjectSyncEvents,
  blockPendingSyncOps,
  buildPageSyncOps,
  compactStoredPendingSyncOps,
  listPendingProjectSyncEvents,
  listBlockedProjectSyncIds,
  listPendingSyncOps,
  pendingSyncEventCount as queuedSyncEventCount,
  removePendingProjectSyncEvents,
  removePendingSyncOps,
  switchPendingSyncQueueAccount,
  resolveBlockedProjectSyncEvent,
  unblockPendingProjectSyncEvents,
  unblockPendingSyncOps,
  type BlockSyncOp,
  type ProjectSyncEvent,
} from '@/src/services/syncQueue';

type JottathingStorage = {
  activePageIdsByProject?: Record<string, string>;
  captures?: Capture[];
  currentProjectId?: string;
  currentWorkspaceId?: string;
  currentProjectIdByWorkspace?: Record<string, string>;
  hasExplicitlyLoggedOut?: boolean;
  hasMigratedCapturesToPages?: boolean;
  notionHydrationSource?: string;
  pages?: ProjectPage[];
  projects?: Project[];
  syncConfig?: SyncConfig;
  workspaces?: Workspace[];
};

type OptimisticProjectCreation = {
  page: ProjectPage;
  project: Project;
  settled: Promise<{ page: ProjectPage; project: Project }>;
};

type ProjectCreationOptions = {
  workspaceId?: string;
  pageTitle?: string;
  pageContent?: DocumentContent;
};

type OptimisticPageCreation = {
  page: ProjectPage;
  settled: Promise<ProjectPage>;
};


const STORAGE_KEYS: Array<keyof JottathingStorage> = [
  'activePageIdsByProject',
  'captures',
  'currentProjectId',
  'currentWorkspaceId',
  'currentProjectIdByWorkspace',
  'hasExplicitlyLoggedOut',
  'hasMigratedCapturesToPages',
  'notionHydrationSource',
  'pages',
  'projects',
  'syncConfig',
  'workspaces',
];

const DEFAULT_SYNC_CONFIG: SyncConfig = {
  serverUrl: import.meta.env.DEV
    ? 'http://localhost:8787'
    : import.meta.env.VITE_API_URL ?? '',
  authenticated: false,
  connected: false,
};
const PENDING_CONNECTION_DELETION_KEY = 'jottathingPendingConnectionDeletion';
const LEGACY_PENDING_CONNECTION_DELETION_KEY = 'inkwellPendingConnectionDeletion';
const LEGACY_SYNC_CREDENTIALS_SCRUBBED_KEY = '__legacy_sync_credentials_scrubbed__';

type PendingConnectionDeletion = {
  requestId: string;
  serverUrl: string;
  userId?: string;
  userEmail?: string;
  workspaceId?: string;
};

const defaultProjects: Project[] = [
  {
    id: 'project-jottathing',
    name: 'Jottathing',
    status: 'active',
    category: 'General',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    stateContent: emptyDocument(),
    tags: ['jottathing'],
  },
];

const waitForStub = () => new Promise((resolve) => setTimeout(resolve, 80));
const LOCAL_QUEUE_DELIVERY_DELAY_MS = 500;
const REMOTE_QUEUE_SETTLE_TIMEOUT_MS = 10 * 60_000;
const REMOTE_QUEUE_STATUS_POLL_MS = 2_000;
const MAX_QUEUE_RETRY_DELAY_MS = 5 * 60_000;
const pendingTempPageSaves = new Map<string, ProjectPage>();
const projectReconciliations = new Map<string, Promise<string>>();
const projectIdAliases = new Map<string, string>();
const pageIdAliases = new Map<string, string>();
const inFlightProjectSyncRequests = new Map<string, Promise<SyncProjectResponse>>();
let queueDeliveryPromise: Promise<void> | undefined;
let queueDeliveryTimer: ReturnType<typeof setTimeout> | undefined;
let forcedQueueDeliveryPromise: Promise<void> | undefined;
let queueDeliveryRetryAttempt = 0;
let queueDeliveryRetryDelayMs = 0;
let syncQueueRetryEndpointAvailable: boolean | undefined;
let isSessionLogoutPending = false;
let isConnectionDeletionPending = false;
let idbWriteRecoveryPromise: Promise<void> | undefined;
let currentProjectSelectionRevision = 0;
let requestedCurrentProjectId: string | undefined;
let workspaceWriteVersion = 0;
let workspaceWriteQueue: Promise<void> = Promise.resolve();

function emptyDocument(): DocumentContent {
  return normalizeJottathingBlockIds({
    type: 'doc',
    content: [
      {
        type: 'paragraph',
      },
    ],
  });
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

export function sourcePayloadFromCapture(payload: CaptureSelectionPayload): SourceOpenPayload {
  return {
    sourceUrl: payload.sourceUrl,
    highlightMeta: {
      text: payload.highlightMeta.text || payload.text,
      sourceLink: payload.highlightMeta.sourceLink,
      xpath: payload.highlightMeta.xpath,
      offset: payload.highlightMeta.offset,
      prefix: payload.highlightMeta.prefix,
      suffix: payload.highlightMeta.suffix,
    },
  };
}

export function createCapturedContent(payload: CaptureSelectionPayload): DocumentContent[] {
  const source = storeJottathingSource(sourcePayloadFromCapture(payload));

  if (payload.highlightMeta.isHeading || payload.highlightMeta.sourceBlockType === 'heading') {
    return createLinkedHeadingContent(payload);
  }

  if (
    payload.highlightMeta.isCodeBlock ||
    payload.highlightMeta.sourceBlockType === 'codeBlock'
  ) {
    return [
      {
        type: 'codeBlock',
        attrs: {
          language: normalizeCodeLanguage(payload.highlightMeta.codeLanguage),
          jottathingBlockId: createJottathingBlockId(),
          [JOTTATHING_SOURCE_ATTR]: source,
        },
        content: payload.text ? [{ type: 'text', text: payload.text }] : undefined,
      },
      {
        type: 'paragraph',
      },
    ];
  }

  if (payload.highlightMeta.sourceBlockType === 'paragraph') {
    return [
      {
        type: 'paragraph',
        attrs: {
          jottathingBlockId: createJottathingBlockId(),
          [JOTTATHING_SOURCE_ATTR]: source,
        },
        content: payload.text ? [{ type: 'text', text: payload.text }] : undefined,
      },
      {
        type: 'paragraph',
      },
    ];
  }

  return [
    {
      type: 'blockquote',
      attrs: {
        jottathingBlockId: createJottathingBlockId(),
        [JOTTATHING_SOURCE_ATTR]: source,
      },
      content: [textParagraph(payload.text)],
    },
    {
      type: 'paragraph',
    },
  ];
}

export function createLinkedHeadingContent(
  payload: CaptureSelectionPayload,
): DocumentContent[] {
  const level = payload.highlightMeta.headingLevel ?? 2;
  const source = storeJottathingSource(sourcePayloadFromCapture(payload));

  return [
    {
      type: 'heading',
      attrs: {
        jottathingBlockId: createJottathingBlockId(),
        [JOTTATHING_SOURCE_ATTR]: source,
        level,
      },
      content: [
        {
          type: 'text',
          text: payload.text,
        },
      ],
    },
    {
      type: 'paragraph',
    },
  ];
}

function createDefaultPages(projects: Project[]): ProjectPage[] {
  const now = new Date().toISOString();

  return projects.map((project) => {
    return {
      id: `page-${project.id}`,
      projectId: project.id,
      kind: 'page',
      title: 'Untitled Page',
      status: 'active',
      content: emptyDocument(),
      createdAt: now,
      updatedAt: now,
      localRevision: crypto.randomUUID(),
      syncState: 'saved',
    };
  });
}

function createProjectRecord(name: string, id = `project-${crypto.randomUUID()}`): Project {
  const now = new Date().toISOString();

  return {
    id,
    name: name.trim() || 'Untitled Project',
    syncMode: 'local',
    status: 'active',
    category: '',
    createdAt: now,
    updatedAt: now,
    stateContent: emptyDocument(),
    tags: [],
    syncState: 'saved',
  };
}

function normalizeProject(project: Project): Project {
  const now = new Date().toISOString();
  const createdAt = project.createdAt ?? now;

  return {
    ...project,
    category: project.category ?? project.tags?.[0] ?? '',
    createdAt,
    updatedAt: project.updatedAt ?? createdAt,
    stateContent: project.stateContent ?? emptyDocument(),
    tags: project.tags ?? [],
    syncState: project.syncState ?? 'saved',
  };
}

function touchProject(project: Project, updates: Partial<Project> = {}): Project {
  return {
    ...project,
    ...updates,
    updatedAt: new Date().toISOString(),
  };
}

function sortProjectsByUpdatedDesc(first: Project, second: Project) {
  return new Date(second.updatedAt).getTime() - new Date(first.updatedAt).getTime();
}

async function migrateStorageToIdb(): Promise<void> {
  const done = await idbGet<boolean>('__idb_migrated__');
  if (!done) {
    const existing = (await browser.storage.local.get(STORAGE_KEYS)) as JottathingStorage;
    if (Object.keys(existing).length > 0) {
      await idbSetMany(existing as Record<string, unknown>);
    }
    await idbSet('__idb_migrated__', true);
  }

  // Older releases mirrored syncConfig in extension storage. Scrub this copy
  // once during migration; logout rechecks it in case an older build restored it.
  const credentialsAlreadyScrubbed = await idbGet<boolean>(LEGACY_SYNC_CREDENTIALS_SCRUBBED_KEY);
  if (credentialsAlreadyScrubbed) return;
  await scrubLegacyExtensionSyncCredentials();
  await idbSet(LEGACY_SYNC_CREDENTIALS_SCRUBBED_KEY, true);
}

async function scrubLegacyExtensionSyncCredentials(): Promise<void> {
  const legacyStorage = await browser.storage.local.get('syncConfig') as { syncConfig?: unknown };
  const legacyConfig = legacyStorage.syncConfig;
  if (legacyConfig && typeof legacyConfig === 'object' && !Array.isArray(legacyConfig)) {
    if (hasStoredSyncCredentials(legacyConfig)) {
      await browser.storage.local.set({
        syncConfig: stripStoredSyncCredentials(legacyConfig as SyncConfig),
      });
    }
  }
}

/** Recovers the write fence after a crash between clearing local data and resuming IndexedDB. */
async function recoverIdbWriteFence(): Promise<void> {
  if (!idbWriteRecoveryPromise) {
    idbWriteRecoveryPromise = (async () => {
      const deletionState = await getBrandedStorageValue<PendingConnectionDeletion>(
        PENDING_CONNECTION_DELETION_KEY,
        LEGACY_PENDING_CONNECTION_DELETION_KEY,
      );
      if (deletionState) {
        isConnectionDeletionPending = true;
        await pauseIdbWrites();
        return;
      }

      await resumeIdbWrites({ adoptCurrentEpoch: true });
    })().catch((error) => {
      idbWriteRecoveryPromise = undefined;
      throw error;
    });
  }
  await idbWriteRecoveryPromise;
}

async function readStorage(): Promise<Required<JottathingStorage>> {
  await recoverIdbWriteFence();
  await migrateStorageToIdb();
  const stored = (await idbGetMany(STORAGE_KEYS)) as JottathingStorage;

  const storedProjects = stored.projects !== undefined ? stored.projects : defaultProjects;
  const storedSyncConfig = {
    ...DEFAULT_SYNC_CONFIG,
    ...stored.syncConfig,
  };
  const hasStoredSyncCredentials = containsSyncCredentials(stored.syncConfig);
  const legacyAccountId = storedSyncConfig.syncQueueOwnerUserId ?? storedSyncConfig.userId;
  const legacyWorkspaceId = storedSyncConfig.syncQueueOwnerWorkspaceId ??
    storedSyncConfig.workspaceId ?? workspaceFromHydrationSource(stored.notionHydrationSource);
  const syncConfig = stripStoredSyncCredentials({
    ...storedSyncConfig,
    syncQueueOwnerWorkspaceId: storedSyncConfig.syncQueueOwnerWorkspaceId ??
      (legacyAccountId ? legacyWorkspaceId : undefined),
  });
  let allProjects = (isLegacyStubProjectSet(storedProjects)
    ? defaultProjects
    : storedProjects
  ).map(normalizeProject)
    .sort(sortProjectsByUpdatedDesc);
  const captures = stored.captures ?? [];
  const shouldCreatePages =
    !stored.pages?.length ||
    !stored.hasMigratedCapturesToPages ||
    isLegacyStubProjectSet(storedProjects);
  let allPages = (shouldCreatePages
    ? createDefaultPages(allProjects)
    : stored.pages ?? createDefaultPages(allProjects)
  ).map((page) => normalizeStoredPage(
    page,
    shouldCreatePages ? 'local' : 'notion',
    legacyAccountId,
    legacyWorkspaceId,
  ));
  let allWorkspaces = [...(stored.workspaces ?? [])];
  let workspaceMigrationChanged = !stored.workspaces;
  const workspaceAccountId = syncConfig.userId ?? syncConfig.syncQueueOwnerUserId ?? undefined;
  const now = new Date().toISOString();
  const ensureWorkspace = (
    kind: Workspace['kind'],
    accountId?: string,
    notionWorkspaceId?: string,
    name?: string,
  ): Workspace => {
    const existingIndex = allWorkspaces.findIndex((workspace) =>
      workspace.kind === kind && workspace.accountId === accountId &&
      (kind === 'local' || workspace.notionWorkspaceId === notionWorkspaceId),
    );
    if (existingIndex >= 0) {
      const existing = allWorkspaces[existingIndex];
      if (name && existing.name !== name) {
        const updated = { ...existing, name, updatedAt: now };
        allWorkspaces[existingIndex] = updated;
        workspaceMigrationChanged = true;
        return updated;
      }
      return existing;
    }
    const created: Workspace = {
      id: kind === 'local'
        ? `workspace-local-${encodeURIComponent(accountId ?? 'device')}`
        : `workspace-notion-${encodeURIComponent(accountId ?? 'unknown')}-${encodeURIComponent(notionWorkspaceId ?? 'unknown')}`,
      name: name || (kind === 'local' ? 'Local workspace' : 'Notion workspace'),
      kind,
      ...(accountId ? { accountId } : {}),
      ...(kind === 'notion' && notionWorkspaceId ? { notionWorkspaceId } : {}),
      createdAt: now,
      updatedAt: now,
    };
    allWorkspaces.push(created);
    workspaceMigrationChanged = true;
    return created;
  };
  if (syncConfig.authenticated && syncConfig.userId) {
    if (allWorkspaces.some((workspace) => workspace.kind === 'local' && !workspace.accountId)) {
      workspaceMigrationChanged = true;
    }
    allWorkspaces = allWorkspaces.map((workspace) => workspace.kind === 'local' && !workspace.accountId
      ? { ...workspace, accountId: syncConfig.userId, updatedAt: now }
      : workspace);
  }
  if (syncConfig.authenticated && syncConfig.userId && syncConfig.workspaceId) {
    ensureWorkspace('notion', syncConfig.userId, syncConfig.workspaceId, syncConfig.workspaceName);
  }
  const localWorkspace = ensureWorkspace('local', workspaceAccountId);
  const projectWorkspaceIds = new Map<string, string>();
  for (const project of allProjects) {
    const projectPages = allPages.filter((page) => page.projectId === project.id);
    const assignedWorkspace = allWorkspaces.find((workspace) => workspace.id === project.workspaceId);
    const notionPage = projectPages.find((page) => page.syncMode === 'notion');
    const workspace = assignedWorkspace ?? (notionPage
      ? ensureWorkspace(
          'notion',
          notionPage.syncAccountId ?? legacyAccountId,
          notionPage.syncWorkspaceId ?? legacyWorkspaceId,
          syncConfig.workspaceName,
        )
      : projectPages.find((page) => page.syncAccountId)
        ? ensureWorkspace('local', projectPages.find((page) => page.syncAccountId)?.syncAccountId)
        : localWorkspace);
    projectWorkspaceIds.set(project.id, workspace.id);
    if (project.workspaceId !== workspace.id || project.syncMode !== workspace.kind) {
      workspaceMigrationChanged = true;
    }
  }
  allProjects = allProjects.map((project) => {
    const workspaceId = projectWorkspaceIds.get(project.id) ?? project.workspaceId ?? localWorkspace.id;
    const workspace = allWorkspaces.find((entry) => entry.id === workspaceId) ?? localWorkspace;
    return { ...project, workspaceId, syncMode: workspace.kind };
  });
  const workspaceIdByProject = new Map(allProjects.map((project) => [project.id, project.workspaceId]));
  allPages = allPages.map((page) => {
    const workspaceId = workspaceIdByProject.get(page.projectId) ?? page.workspaceId ?? localWorkspace.id;
    const workspace = allWorkspaces.find((entry) => entry.id === workspaceId) ?? localWorkspace;
    const syncAccountId = workspace.kind === 'notion' ? workspace.accountId : workspace.accountId;
    const syncWorkspaceId = workspace.kind === 'notion' ? workspace.notionWorkspaceId : undefined;
    if (
      page.workspaceId !== workspaceId || page.syncMode !== workspace.kind ||
      page.syncAccountId !== syncAccountId || page.syncWorkspaceId !== syncWorkspaceId
    ) workspaceMigrationChanged = true;
    return { ...page, workspaceId, syncMode: workspace.kind, syncAccountId, syncWorkspaceId };
  });
  if (!allProjects.some((project) => project.workspaceId === localWorkspace.id)) {
    const project = {
      ...createProjectRecord('Untitled Project'),
      workspaceId: localWorkspace.id,
      syncMode: 'local' as const,
    };
    const page = {
      ...createEmptyPage(project.id, 'Untitled Page'),
      workspaceId: localWorkspace.id,
      syncMode: 'local' as const,
      syncAccountId: localWorkspace.accountId,
    };
    allProjects = [project, ...allProjects];
    allPages = [...allPages, page];
    workspaceMigrationChanged = true;
  }
  const stateByProjectId = new Map(
    allProjects.map((project) => [project.id, project.stateContent]),
  );
  let sourceMigrationChanged = false;
  allPages = allPages.map((page) => {
    const migration = migratePageSourcesToProjectState(
      page.content,
      stateByProjectId.get(page.projectId),
    );
    if (!migration.changed) {
      return page;
    }

    sourceMigrationChanged = true;
    stateByProjectId.set(page.projectId, migration.stateContent);
    return { ...page, content: migration.content };
  });

  if (sourceMigrationChanged) {
    allProjects = allProjects.map((project) => ({
      ...project,
      stateContent: stateByProjectId.get(project.id) ?? project.stateContent,
    }));
  }
  const allActivePageIdsByProject = createCompatibleActivePageIds(
    allProjects,
    allPages,
    stored.activePageIdsByProject,
  );
  const hasCompatibleActivePages =
    JSON.stringify(allActivePageIdsByProject) ===
    JSON.stringify(stored.activePageIdsByProject ?? {});
  const hasCompatiblePageStatuses =
    !stored.pages || stored.pages.every((page) => page.status);
  const hasExplicitlyLoggedOut = stored.hasExplicitlyLoggedOut ?? Boolean(
    stored.syncConfig && !stored.syncConfig.authenticated && !stored.syncConfig.connected,
  );
  const notionHydrationSource = stored.notionHydrationSource ?? (
    hasRemoteBackedData(allProjects, allPages) ? hydrationSource(syncConfig) : ''
  );
  const activeAccountId = syncConfig.userId ?? syncConfig.syncQueueOwnerUserId ?? undefined;
  const visibleWorkspaces = allWorkspaces.filter((workspace) => workspace.kind === 'local'
    ? workspace.accountId
      ? !activeAccountId || workspace.accountId === activeAccountId
      : !syncConfig.authenticated || syncConfig.syncQueueOwnerUserId === undefined
    : Boolean(
        syncConfig.authenticated && workspace.accountId === syncConfig.userId &&
        (!workspace.notionWorkspaceId || workspace.notionWorkspaceId === syncConfig.workspaceId),
      ));
  const currentWorkspaceId = visibleWorkspaces.some((workspace) => workspace.id === stored.currentWorkspaceId)
    ? stored.currentWorkspaceId!
    : localWorkspace.id;
  const selectedWorkspace = visibleWorkspaces.find((workspace) => workspace.id === currentWorkspaceId);
  if (selectedWorkspace?.kind === 'local' && !allProjects.some((project) => project.workspaceId === currentWorkspaceId)) {
    const project = {
      ...createProjectRecord('Untitled Project'),
      workspaceId: currentWorkspaceId,
      syncMode: 'local' as const,
    };
    const page = {
      ...createEmptyPage(project.id, 'Untitled Page'),
      workspaceId: currentWorkspaceId,
      syncMode: 'local' as const,
      syncAccountId: selectedWorkspace.accountId,
    };
    allProjects = [project, ...allProjects];
    allPages = [...allPages, page];
    workspaceMigrationChanged = true;
  }
  const currentProjectIdByWorkspace = { ...(stored.currentProjectIdByWorkspace ?? {}) };
  const activeWorkspaceProjects = allProjects.filter((project) => project.workspaceId === currentWorkspaceId);
  const requestedProjectId = currentProjectIdByWorkspace[currentWorkspaceId] ?? stored.currentProjectId;
  const activeProjectId = activeWorkspaceProjects.some((project) => project.id === requestedProjectId)
    ? requestedProjectId!
    : activeWorkspaceProjects[0]?.id ?? '';
  currentProjectIdByWorkspace[currentWorkspaceId] = activeProjectId;
  const hasPageScopeMigration = (stored.pages ?? []).some((page) =>
    !page.syncMode ||
    (page.syncMode === 'notion' && !page.syncAccountId && Boolean(legacyAccountId)) ||
    (page.syncMode === 'notion' && !page.syncWorkspaceId && Boolean(legacyWorkspaceId)),
  );
  const hasQueueScopeMigration = Boolean(
    !storedSyncConfig.syncQueueOwnerWorkspaceId && legacyAccountId && legacyWorkspaceId,
  );

  if (hasStoredSyncCredentials) {
    await idbSet('syncConfig', syncConfig);
  }

  if (
    !stored.activePageIdsByProject ||
    !hasCompatibleActivePages ||
    !hasCompatiblePageStatuses ||
    !stored.projects ||
    !stored.currentProjectId ||
    stored.notionHydrationSource === undefined ||
    !stored.syncConfig ||
    !stored.workspaces ||
    workspaceMigrationChanged ||
    stored.currentWorkspaceId !== currentWorkspaceId ||
    JSON.stringify(stored.currentProjectIdByWorkspace ?? {}) !== JSON.stringify(currentProjectIdByWorkspace) ||
    (stored.hasExplicitlyLoggedOut === undefined && hasExplicitlyLoggedOut) ||
    shouldCreatePages ||
    stored.hasMigratedCapturesToPages !== true ||
    sourceMigrationChanged ||
    hasPageScopeMigration ||
    hasQueueScopeMigration
  ) {
    await idbSetMany({
      activePageIdsByProject: allActivePageIdsByProject,
      projects: allProjects,
      currentProjectId: activeProjectId,
      currentWorkspaceId,
      currentProjectIdByWorkspace,
      pages: allPages,
      syncConfig,
      workspaces: allWorkspaces,
      hasExplicitlyLoggedOut,
      notionHydrationSource,
      hasMigratedCapturesToPages: true,
    });
  }

  const pages = allPages.filter((page) => isPageVisibleForAccount(page, syncConfig));
  const visibleProjectIds = new Set(pages.map((page) => page.projectId));
  const visibleProjects = allProjects
    .filter((project) => visibleProjectIds.has(project.id))
    .map((project) => ({
      ...project,
      syncMode: allWorkspaces.find((workspace) => workspace.id === project.workspaceId)?.kind ?? 'local',
    }));
  const currentProjectId = activeProjectId;
  const activePageIdsByProject = createCompatibleActivePageIds(
    visibleProjects,
    pages,
    stored.activePageIdsByProject,
  );
  const syncStateRank: Record<string, number> = {
    error: 5,
    stale: 4,
    saving: 3,
    creating: 2,
    saved: 1,
    idle: 0,
  };
  const projects = visibleProjects.map((project) => {
    const projectPages = pages.filter((page) => page.projectId === project.id);
    const pageWorstState = projectPages
      .map((page) => page.syncState)
      .filter((state): state is NonNullable<Project['syncState']> => Boolean(state))
      .sort((first, second) => (syncStateRank[second] ?? 0) - (syncStateRank[first] ?? 0))[0];
    const worstPage = projectPages.find((page) => page.syncState === pageWorstState);
    return {
      ...project,
      // A project's menu badge represents its pages. Project-state edits and
      // conflicts stay in the conflict flow and must not make unchanged pages
      // appear to have block differences.
      syncState: pageWorstState ?? 'saved',
      syncMessage: worstPage?.syncMessage,
    };
  });
  const workspacesWithSyncState = visibleWorkspaces.map((workspace) => {
    const workspaceProjects = projects.filter((project) =>
      project.workspaceId === workspace.id && project.status !== 'archived',
    );
    const itemWorst = workspaceProjects.map((project) => project.syncState).filter(Boolean)
      .sort((first, second) => (syncStateRank[second!] ?? 0) - (syncStateRank[first!] ?? 0))[0];
    const worstItem = workspaceProjects.find((project) => project.syncState === itemWorst);
    return {
      ...workspace,
      syncState: itemWorst ?? 'saved',
      syncMessage: worstItem?.syncMessage,
    };
  });

  return {
    captures,
    currentProjectId,
    currentWorkspaceId,
    currentProjectIdByWorkspace,
    hasExplicitlyLoggedOut,
    activePageIdsByProject,
    hasMigratedCapturesToPages: true,
    pages,
    projects,
    syncConfig,
    notionHydrationSource,
    workspaces: workspacesWithSyncState,
  };
}

function hasRemoteBackedData(projects: Project[], pages: ProjectPage[]) {
  return projects.some((project) => Boolean(project.stateRemoteRevision)) ||
    pages.some((page) => Boolean(
      page.notionPageId ||
      page.notionDatabaseId ||
      page.notionDataSourceId ||
      page.notionParentPageId ||
      page.remoteRevision,
    ));
}

function hydrationSource(syncConfig: SyncConfig) {
  const serverUrl = cleanSyncServerUrl(syncConfig.serverUrl);
  const workspace = syncConfig.workspaceId?.trim() || 'connected-workspace';
  const account = syncConfig.userId?.trim() || 'unassigned-account';
  return `${serverUrl}::${account}::${workspace}`;
}

function workspaceFromHydrationSource(source: string | undefined): string | undefined {
  if (!source) return undefined;
  const parts = source.split('::');
  return parts.length >= 2 ? parts[parts.length - 1] : undefined;
}

function isPageVisibleForAccount(page: ProjectPage, syncConfig: SyncConfig): boolean {
  const activeAccountId = syncConfig.userId ?? syncConfig.syncQueueOwnerUserId;
  if (page.syncMode === 'notion') {
    return Boolean(
      syncConfig.authenticated && syncConfig.userId &&
      page.syncAccountId === syncConfig.userId &&
      (!page.syncWorkspaceId || !syncConfig.workspaceId || page.syncWorkspaceId === syncConfig.workspaceId),
    );
  }
  if (page.syncAccountId) return !activeAccountId || page.syncAccountId === activeAccountId;
  return !syncConfig.authenticated || syncConfig.syncQueueOwnerUserId === undefined;
}

function hasSameReloadTarget(first: SyncConfig, second: SyncConfig): boolean {
  return cleanSyncServerUrl(first.serverUrl) === cleanSyncServerUrl(second.serverUrl) &&
    first.userId === second.userId &&
    first.workspaceId === second.workspaceId &&
    first.selectedParentPageId === second.selectedParentPageId;
}

function syncQueueBelongsToActiveAccount(syncConfig: SyncConfig): boolean {
  return syncConfig.syncQueueOwnerUserId !== null && (
    syncConfig.syncQueueOwnerUserId === undefined ||
    syncConfig.syncQueueOwnerUserId === syncConfig.userId
  ) && (
    !syncConfig.syncQueueOwnerWorkspaceId || !syncConfig.workspaceId ||
    syncConfig.syncQueueOwnerWorkspaceId === syncConfig.workspaceId
  );
}

function isLegacyStubProjectSet(projects: Project[]) {
  return projects.some((project) =>
    ['project-product-research', 'project-writing'].includes(project.id),
  );
}

async function writeStorage(
  storage: Partial<JottathingStorage>,
  options: { expectedVersion?: number; removeWorkspaceIds?: string[] } = {},
): Promise<boolean> {
  const write = workspaceWriteQueue.then(async () => {
    if (
      options.expectedVersion !== undefined &&
      options.expectedVersion !== workspaceWriteVersion
    ) {
      return false;
    }

    const updates = { ...storage } as Record<string, unknown>;
    if (storage.workspaces) {
      const persistedWorkspaces = (await idbGet<Workspace[]>('workspaces')) ?? [];
      const byId = new Map(persistedWorkspaces.map((workspace) => [workspace.id, workspace]));
      for (const workspaceId of options.removeWorkspaceIds ?? []) byId.delete(workspaceId);
      for (const workspace of storage.workspaces) byId.set(workspace.id, workspace);
      updates.workspaces = [...byId.values()];
    }
    if (storage.pages) {
      const persisted = await idbGetMany(['pages', 'syncConfig']);
      const storedConfig = {
        ...DEFAULT_SYNC_CONFIG,
        ...(persisted.syncConfig as SyncConfig | undefined),
        ...(storage.syncConfig ?? {}),
      };
      const hiddenPages = ((persisted.pages as ProjectPage[] | undefined) ?? [])
        .filter((page) => !isPageVisibleForAccount(page, storedConfig));
      const incomingIds = new Set(storage.pages.map((page) => page.id));
      updates.pages = [
        ...storage.pages,
        ...hiddenPages.filter((page) => !incomingIds.has(page.id)),
      ];
      if (storage.projects) {
        const hiddenProjectIds = new Set(hiddenPages.map((page) => page.projectId));
        const existingHiddenProjects = ((await idbGet<Project[]>('projects')) ?? [])
          .filter((project) => hiddenProjectIds.has(project.id));
        const projectIds = new Set((storage.projects as Project[]).map((project) => project.id));
        updates.projects = [
          ...storage.projects,
          ...existingHiddenProjects.filter((project) => !projectIds.has(project.id)),
        ];
      }
    }
    await idbSetMany(updates);
    workspaceWriteVersion += 1;
    return true;
  });
  workspaceWriteQueue = write.then(() => undefined, () => undefined);
  return write;
}

/** Applies page updates by ID against the latest IndexedDB snapshot. */
async function persistPagesById(pageUpdates: ProjectPage[]): Promise<void> {
  if (!pageUpdates.length) return;
  const write = workspaceWriteQueue.then(async () => {
    const storedPages = (await idbGet<ProjectPage[]>('pages')) ?? [];
    const pagesById = new Map(storedPages.map((page) => [page.id, page]));
    for (const page of pageUpdates) pagesById.set(page.id, page);
    await idbSet('pages', [...pagesById.values()]);
    workspaceWriteVersion += 1;
  });
  workspaceWriteQueue = write.then(() => undefined, () => undefined);
  await write;
}

/** Appends a page atomically so concurrent creates cannot overwrite each other. */
async function appendPageAtomically(page: ProjectPage): Promise<ProjectPage> {
  const write = workspaceWriteQueue.then(async () => {
    const stored = await idbGetMany(['pages', 'activePageIdsByProject']);
    const storedPages = (stored.pages as ProjectPage[] | undefined) ?? [];
    const samePage = storedPages.find((candidate) => candidate.id === page.id);
    const existingProjectPages = sortProjectPages(storedPages.filter((candidate) =>
      candidate.projectId === page.projectId &&
      candidate.status !== 'archived' &&
      candidate.id !== page.id,
    ));
    const pageToStore = {
      ...page,
      pageOrder: samePage?.pageOrder ?? existingProjectPages.length,
    };
    const orderedProjectPages = sortProjectPages([...existingProjectPages, pageToStore]);
    const pageOrderById = new Map(orderedProjectPages.map((candidate, index) => [candidate.id, index]));
    const pagesById = new Map(storedPages.map((candidate) => [candidate.id, candidate]));
    for (const candidate of orderedProjectPages) {
      pagesById.set(candidate.id, {
        ...candidate,
        pageOrder: pageOrderById.get(candidate.id) ?? candidate.pageOrder,
      });
    }
    const activePageIdsByProject = {
      ...((stored.activePageIdsByProject as Record<string, string> | undefined) ?? {}),
      [page.projectId]: page.id,
    };
    await idbSetMany({
      pages: [...pagesById.values()],
      activePageIdsByProject,
    });
    workspaceWriteVersion += 1;
    return pageToStore;
  });
  workspaceWriteQueue = write.then(() => undefined, () => undefined);
  return write;
}

/** Replaces an optimistic page against the latest snapshot without dropping concurrent creates. */
async function replacePageAtomically(tempPage: ProjectPage, realPage: ProjectPage): Promise<void> {
  const write = workspaceWriteQueue.then(async () => {
    const stored = await idbGetMany(['pages', 'activePageIdsByProject']);
    const storedPages = (stored.pages as ProjectPage[] | undefined) ?? [];
    const currentTempPage = storedPages.find((page) => page.id === tempPage.id);
    const currentRealPage = storedPages.find((page) => page.id === realPage.id);
    const currentPage = currentTempPage ?? currentRealPage;
    const replacement: ProjectPage = {
      ...(currentPage ?? tempPage),
      ...realPage,
      ...(currentPage ? {
        content: currentPage.content,
        title: currentPage.title,
        pageOrder: currentPage.pageOrder,
      } : {}),
      syncState: pendingTempPageSaves.has(tempPage.id)
        ? 'saving'
        : currentRealPage?.syncState ?? realPage.syncState,
    };
    const pages = storedPages.filter((page) => page.id !== tempPage.id && page.id !== realPage.id);
    pages.push(replacement);
    const activePageIdsByProject = {
      ...((stored.activePageIdsByProject as Record<string, string> | undefined) ?? {}),
    };
    if (activePageIdsByProject[realPage.projectId] === tempPage.id) {
      activePageIdsByProject[realPage.projectId] = realPage.id;
    }

    await idbSetMany({ pages, activePageIdsByProject });
    workspaceWriteVersion += 1;
  });
  workspaceWriteQueue = write.then(() => undefined, () => undefined);
  await write;
  rememberPageIdAlias(tempPage.id, realPage.id);
}

async function persistRebasedProjectSnapshots(
  snapshots: Project[],
  pagesToPreserve: ProjectPage[] = [],
): Promise<void> {
  const storage = await readStorage();
  const snapshotById = new Map(snapshots.map((project) => [project.id, project]));
  const projects = storage.projects.map((project) => snapshotById.get(project.id) ?? project);
  const projectIds = new Set(projects.map((project) => project.id));
  for (const snapshot of snapshots) {
    if (!projectIds.has(snapshot.id)) projects.push(snapshot);
  }

  const pagesById = new Map(storage.pages.map((page) => [page.id, page]));
  for (const page of pagesToPreserve) pagesById.set(page.id, page);
  const pages = [...pagesById.values()];
  const activePageIdsByProject = createCompatibleActivePageIds(
    projects,
    pages,
    storage.activePageIdsByProject,
  );
  const activeProjects = projects.filter((project) => project.status !== 'archived');
  const currentProjectId = activeProjects.some((project) => project.id === storage.currentProjectId)
    ? storage.currentProjectId
    : activeProjects[0]?.id ?? '';

  await writeStorage({
    activePageIdsByProject,
    currentProjectId,
    pages,
    projects: projects.sort(sortProjectsByUpdatedDesc),
  });
}

function appendContent(page: ProjectPage, content: DocumentContent[]): ProjectPage {
  const existingContent = page.content.content ?? [];

  return markPageDirty({
    ...page,
    content: normalizeJottathingBlockIds({
      ...page.content,
      type: 'doc',
      content: [...existingContent, ...content],
    }),
  });
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

async function syncProject(project: Project): Promise<Project | undefined> {
  const { syncConfig, pages } = await readStorage();
  if (!pages.some((page) => page.projectId === project.id && page.syncMode === 'notion')) {
    return withProjectSyncStatus(project, 'saved');
  }
  const notionProject = { ...project, syncMode: 'notion' as const };
  const queuedEvent = await addPendingProjectSyncEvent(
    notionProject,
    syncConfig.selectedParentPageId,
  );

  if (queuedEvent.deliveryBlocked) {
    return withProjectSyncStatus(notionProject, 'error', queuedEvent.deliveryBlocked.message);
  }

  triggerQueueDelivery();

  if (!syncConfig.connected || isBrowserOffline()) {
    return withProjectSyncStatus(
      notionProject,
      'stale',
      syncConfig.connected
        ? 'Saved locally. Will sync when a connection is available.'
        : 'Saved locally. Connect Notion to sync this project.',
    );
  }

  try {
    const response = await requestQueuedProjectSync(queuedEvent, syncConfig);

    if (response.parentPage) {
      await updateStoredSyncConfig({
        selectedParentPageId: response.parentPage.id,
        selectedParentPageTitle: response.parentPage.title,
      });
    }

    if (response.status === 'error') {
      throw new Error(response.message ?? 'Unable to sync this project.');
    }

    await removePendingProjectSyncEvents([queuedEvent.eventId]);
    await clearProjectConflictResolutionMarkers(project.id);
    resetQueueDeliveryBackoff();
    return response.project
      ? { ...response.project, syncMode: 'notion', syncConflicts: project.syncConflicts }
      : withProjectSyncStatus(notionProject, 'saved');
  } catch (error) {
    if (isUnmappedContentConflict(error)) {
      await blockPendingProjectSyncEvents(project.id, {
        code: 'unmapped_notion_content',
        message: error.message,
        ...(error.diff ? { diff: { ...error.diff, localContent: project.stateContent } } : {}),
      });
      return withProjectSyncStatus(notionProject, 'error', error.message);
    }

    recordQueueDeliveryFailure(error);
    scheduleNextQueueDelivery(queueDeliveryRetryDelayMs);

    return withProjectSyncStatus(
      notionProject,
      'stale',
      'Saved locally. Will sync when a connection is available.',
    );
  }
}

async function syncProjectSource(
  project: Project,
  blockId: string,
  source: SourceOpenPayload,
): Promise<Project> {
  const { syncConfig, pages } = await readStorage();
  if (!pages.some((page) => page.projectId === project.id && page.syncMode === 'notion')) {
    return withProjectSyncStatus(project, 'saved');
  }
  const notionProject = { ...project, syncMode: 'notion' as const };
  const block = sourceEntryForProjectState(blockId, source);
  const queuedEvent = await addPendingProjectSourceSyncEvent(
    notionProject,
    blockId,
    block,
    syncConfig.selectedParentPageId,
  );

  if (queuedEvent.deliveryBlocked) {
    return withProjectSyncStatus(notionProject, 'error', queuedEvent.deliveryBlocked.message);
  }

  triggerQueueDelivery();

  if (!syncConfig.connected || isBrowserOffline()) {
    return withProjectSyncStatus(
      notionProject,
      'stale',
      syncConfig.connected
        ? 'Saved locally. Will sync when a connection is available.'
        : 'Saved locally. Connect Notion to sync this source.',
    );
  }

  try {
    const response = await requestQueuedProjectSync(queuedEvent, syncConfig);
    if (response.status === 'error') {
      throw new Error(response.message ?? 'Unable to sync this source.');
    }
    await removePendingProjectSyncEvents([queuedEvent.eventId]);
    await clearProjectConflictResolutionMarkers(project.id);
    resetQueueDeliveryBackoff();
    return withProjectSyncStatus({
      ...notionProject,
      ...(response.project?.stateSyncBaselineContent
        ? { stateSyncBaselineContent: response.project.stateSyncBaselineContent }
        : {}),
    }, 'saved');
  } catch (error) {
    if (isUnmappedContentConflict(error)) {
      await blockPendingProjectSyncEvents(project.id, {
        code: 'unmapped_notion_content',
        message: error.message,
        ...(error.diff ? { diff: { ...error.diff, localContent: project.stateContent } } : {}),
      });
      return withProjectSyncStatus(notionProject, 'error', error.message);
    }

    recordQueueDeliveryFailure(error);
    scheduleNextQueueDelivery(queueDeliveryRetryDelayMs);

    return withProjectSyncStatus(
      notionProject,
      'stale',
      'Saved locally. Will sync when a connection is available.',
    );
  }
}

function createEmptyPage(projectId: string, title: string): ProjectPage {
  const now = new Date().toISOString();

  return {
    id: `page-${projectId}-${crypto.randomUUID()}`,
    projectId,
    kind: 'page',
    title,
    status: 'active',
    pageOrder: 0,
    content: emptyDocument(),
    syncMode: 'local',
    createdAt: now,
    updatedAt: now,
    localRevision: crypto.randomUUID(),
    syncState: 'saved',
  };
}

function createOptimisticProjectRecord(name: string): Project {
  return {
    ...createProjectRecord(name, `temp-project-${crypto.randomUUID()}`),
    syncState: 'creating',
  };
}

function createOptimisticPage(projectId: string, title: string): ProjectPage {
  return {
    ...createEmptyPage(projectId, title),
    id: `temp-page-${crypto.randomUUID()}`,
    syncState: 'creating',
  };
}

function isTempProject(project: Project | undefined) {
  return Boolean(project?.id.startsWith('temp-project-'));
}

function isTempPage(page: ProjectPage | undefined) {
  return Boolean(page?.id.startsWith('temp-page-'));
}

function markPageDirty(page: ProjectPage): ProjectPage {
  return {
    ...page,
    updatedAt: new Date().toISOString(),
    localRevision: crypto.randomUUID(),
    syncMessage: undefined,
    syncState: 'saving',
  };
}

function withSyncStatus(
  page: ProjectPage,
  status: Exclude<SaveStatus, 'idle'>,
  message?: string,
): ProjectPage {
  return {
    ...page,
    syncMessage: message,
    syncState: status,
  };
}

function withProjectSyncStatus(
  project: Project,
  status: Exclude<SaveStatus, 'idle' | 'saving' | 'creating'>,
  message?: string,
): Project {
  return {
    ...project,
    syncMessage: message,
    syncState: status,
  };
}

async function projectsWithQueueStatus(projects: Project[]): Promise<Project[]> {
  const pendingEvents = await listPendingProjectSyncEvents();
  const blockedMessageByProject = new Map<string, string>();
  for (const event of pendingEvents) {
    if (event.deliveryBlocked) {
      blockedMessageByProject.set(event.projectId, event.deliveryBlocked.message);
    }
  }
  return projects.map((project) => {
    const blockedMessage = blockedMessageByProject.get(project.id);
    return blockedMessage
      ? withProjectSyncStatus(project, 'error', blockedMessage)
      : project;
  });
}

function uncachePageNotionMetadata(page: ProjectPage): ProjectPage {
  return {
    ...page,
    notionPageId: undefined,
    notionDatabaseId: undefined,
    notionDataSourceId: undefined,
    notionParentPageId: undefined,
    notionLastEditedTime: undefined,
    remoteRevision: undefined,
    knownSyncVersion: undefined,
    serverSyncVersion: undefined,
    syncMessage: undefined,
    syncState: 'saved',
  };
}

function isBrowserOffline() {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

function collectJottathingBlockIds(content: DocumentContent, ids: Set<string>): void {
  const value = content.attrs?.jottathingBlockId;
  if (typeof value === 'string' && value) ids.add(value);
  for (const child of content.content ?? []) collectJottathingBlockIds(child, ids);
}

class SyncServerError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly retryAfterMs?: number,
    readonly diff?: SyncConflictDiff,
  ) {
    super(message);
    this.name = 'SyncServerError';
  }
}

function isUnmappedContentConflict(error: unknown): error is SyncServerError {
  return error instanceof SyncServerError && (
    error.code === 'unmapped_notion_content' ||
    error.message.includes('Notion and local content differ in blocks that could not be matched')
  );
}

async function requestServer<T>(
  path: string,
  init?: RequestInit,
  config?: SyncConfig,
): Promise<T> {
  const syncConfig = config ?? (await readStorage()).syncConfig;
  const requiresAccountBinding = path.startsWith('/sync/') || path.startsWith('/media/');
  if (requiresAccountBinding) {
    if (!syncConfig.userId) {
      throw new Error('Refresh the Notion session before syncing local data.');
    }
    if (
      syncConfig.syncQueueOwnerUserId === null ||
      (syncConfig.syncQueueOwnerUserId && syncConfig.syncQueueOwnerUserId !== syncConfig.userId)
    ) {
      throw new Error('Local data is locked to its original Notion account. Reconnect that account to sync it.');
    }
  }
  const headers = {
    ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
    ...(requiresAccountBinding ? { 'X-Jottathing-Account': syncConfig.userId } : {}),
    ...init?.headers,
  };
  const response = await fetch(`${cleanSyncServerUrl(syncConfig.serverUrl)}${path}`, {
    ...init,
    headers,
    credentials: 'include',
  });

  const payload = (await response.json().catch(() => ({}))) as T & {
    code?: string;
    diff?: SyncConflictDiff;
    error?: string;
    message?: string;
  };

  // Content conflicts are expected sync outcomes handled by the merge UI.
  // Interpret their JSON code without returning an HTTP error to the browser.
  if (!response.ok || payload.code === 'unmapped_notion_content') {
    throw new SyncServerError(
      payload.message ?? payload.error ?? `Sync server returned ${response.status}.`,
      response.status,
      payload.code,
      parseRetryAfter(response.headers.get('retry-after')),
      payload.diff,
    );
  }

  return payload;
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - Date.now()) : undefined;
}

function requestQueuedProjectSync(
  event: ProjectSyncEvent,
  syncConfig: SyncConfig,
): Promise<SyncProjectResponse> {
  const existing = inFlightProjectSyncRequests.get(event.eventId);
  if (existing) return existing;

  const isSourceEvent = event.type === 'project_source_upsert';
  const payload = {
    ...event.payload,
    project: withoutLocalSyncConflicts(event.payload.project),
  };
  let request: Promise<SyncProjectResponse>;
  request = requestServer<SyncProjectResponse>(
    isSourceEvent ? '/sync/project/source' : '/sync/project',
    { method: 'POST', body: JSON.stringify(payload) },
    syncConfig,
  ).finally(() => {
    if (inFlightProjectSyncRequests.get(event.eventId) === request) {
      inFlightProjectSyncRequests.delete(event.eventId);
    }
  });
  inFlightProjectSyncRequests.set(event.eventId, request);
  return request;
}

function recordQueueDeliveryFailure(error: unknown): void {
  queueDeliveryRetryAttempt += 1;
  const exponentialDelay = Math.min(
    LOCAL_QUEUE_DELIVERY_DELAY_MS * (2 ** Math.min(queueDeliveryRetryAttempt - 1, 5)),
    MAX_QUEUE_RETRY_DELAY_MS,
  );
  const serverDelay = error instanceof SyncServerError ? error.retryAfterMs ?? 0 : 0;
  queueDeliveryRetryDelayMs = Math.min(
    Math.max(exponentialDelay, serverDelay),
    MAX_QUEUE_RETRY_DELAY_MS,
  );
}

function resetQueueDeliveryBackoff(): void {
  queueDeliveryRetryAttempt = 0;
  queueDeliveryRetryDelayMs = 0;
}

async function pendingLocalWorkCount(): Promise<number> {
  const [{ pages }, queuedCount] = await Promise.all([
    readStorage(),
    queuedSyncEventCount(),
  ]);
  return queuedCount + pages.filter((page) => page.status !== 'archived').reduce(
    (count, page) => count + countPendingLocalMedia(page.content),
    0,
  );
}

/** Waits for accepted server queue jobs before importing their Notion snapshot. */
async function waitForRemoteSyncQueueToSettle(
  syncConfig: SyncConfig,
  onProgress?: (progress: SyncProgressUpdate) => void,
  timeoutMs = REMOTE_QUEUE_SETTLE_TIMEOUT_MS,
  allowParkedFailures = false,
): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    let eventSource: EventSource | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let poller: ReturnType<typeof setInterval> | undefined;
    let statusCheckInFlight = false;
    let statusRecheckRequested = false;
    let finished = false;
    let totalPending: number | undefined;

    const finish = (error?: unknown, failedCount = 0): void => {
      if (finished) return;
      finished = true;
      if (timeout) clearTimeout(timeout);
      if (poller) clearInterval(poller);
      eventSource?.close();
      if (error) reject(error);
      else resolve(failedCount);
    };

    const checkQueue = async (): Promise<void> => {
      if (finished) return;
      if (statusCheckInFlight) {
        statusRecheckRequested = true;
        return;
      }
      statusCheckInFlight = true;
      try {
        do {
          statusRecheckRequested = false;
          const status = await requestServer<SyncQueueStatusResponse>(
            '/sync/status',
            undefined,
            syncConfig,
          );
          if (typeof status.hasPending !== 'boolean') {
            throw new Error('The sync server returned an invalid queue status. Try Sync again.');
          }
          const pending = Number.isSafeInteger(status.pendingCount)
            ? Math.max(0, status.pendingCount ?? 0)
            : Number(status.hasPending);
          const failed = Number.isSafeInteger(status.failedCount)
            ? Math.max(0, status.failedCount ?? 0)
            : 0;
          totalPending = Math.max(totalPending ?? 0, pending);
          onProgress?.({
            phase: 'waiting_for_server',
            completed: Math.max(0, totalPending - pending),
            total: totalPending,
            pending,
          });
          if (!status.hasPending) {
            finish(failed > 0 && !allowParkedFailures
              ? new Error(`${failed} Notion upload${failed === 1 ? '' : 's'} failed. Your local notes remain saved; retry Sync to send them again.`)
              : undefined, failed);
            return;
          }
        } while (statusRecheckRequested && !finished);
      } catch (error) {
        finish(error);
      } finally {
        statusCheckInFlight = false;
      }
    };

    try {
      eventSource = connectSyncEvents(syncConfig, (event) => {
        // Recheck after a push event so a late or duplicated idle notification
        // cannot make the snapshot race with newly queued work.
        if (event.status === 'queue_idle' || (event.status === 'failed' && event.deadLettered)) {
          // Queue events can arrive before the durable payload has been marked
          // parked. Re-read status and let the queue table decide whether work
          // remains active or needs a user-visible retry.
          void checkQueue();
        }
      });
      eventSource.onopen = () => { void checkQueue(); };
      eventSource.onerror = () => {
        // EventSource reconnects automatically. Its next open triggers one
        // status check, covering idle notifications lost during a disconnect.
      };
    } catch {
      // Status polling still drains the queue if EventSource is unavailable.
      void checkQueue();
    }

    poller = setInterval(() => { void checkQueue(); }, REMOTE_QUEUE_STATUS_POLL_MS);

    timeout = setTimeout(() => {
      finish(new Error('Notion is still processing saved changes. Your local notes remain saved; use Sync to check again.'));
    }, timeoutMs);
  });
}

function countPendingLocalMedia(node: DocumentContent): number {
  const attrs = node.attrs ?? {};
  const isPendingMedia =
    (node.type === 'image' || node.type === 'audio') &&
    /^data:/i.test(String(attrs.src ?? '')) &&
    !attrs.notionFileUploadId &&
    !isDirectMediaUploadActive(attrs);
  return (isPendingMedia ? 1 : 0) + (node.content ?? []).reduce(
    (count, child) => count + countPendingLocalMedia(child),
    0,
  );
}

async function uploadMediaBlob(
  blob: Blob,
  mimeType: string,
  filename: string,
  syncConfig: SyncConfig,
): Promise<string> {
  const buf = await blob.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = '';
  const chunkSize = 8192;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }

  const response = await requestServer<MediaUploadResponse>('/media/upload', {
    method: 'POST',
    body: JSON.stringify({ dataBase64: btoa(binary), mimeType, filename }),
  }, syncConfig);

  if (!response.fileUploadId) {
    throw new Error('The sync server did not return a Notion file upload id.');
  }
  return response.fileUploadId;
}

function blobFromDataUrl(src: string): { blob: Blob; mimeType: string } | undefined {
  const match = /^data:([^;,]+)?;base64,([\s\S]+)$/i.exec(src);
  if (!match) return undefined;
  const mimeType = match[1] || 'application/octet-stream';
  const binary = atob(match[2]);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return { blob: new Blob([bytes], { type: mimeType }), mimeType };
}

async function uploadLocalMediaInNode(
  node: DocumentContent,
  syncConfig: SyncConfig,
): Promise<{ content: DocumentContent; changed: boolean; failed: boolean }> {
  const attrs = node.attrs ?? {};
  const src = String(attrs.src ?? '');

  if (
    (node.type === 'image' || node.type === 'audio') &&
    /^data:/i.test(src) &&
    !attrs.notionFileUploadId
  ) {
    if (isDirectMediaUploadActive(attrs)) {
      return { content: node, changed: false, failed: false };
    }
    const decoded = blobFromDataUrl(src);
    if (!decoded) return { content: node, changed: false, failed: true };
    try {
      const fileUploadId = await uploadMediaBlob(
        decoded.blob,
        String(attrs.mimeType || decoded.mimeType),
        String(attrs.filename || `${node.type}-${crypto.randomUUID()}`),
        syncConfig,
      );
      const { uploadStartedAt: _uploadStartedAt, ...cleanAttrs } = attrs;
      return {
        content: {
          ...node,
          attrs: {
            ...cleanAttrs,
            notionFileUploadId: fileUploadId,
            uploadState: 'done',
          },
        },
        changed: true,
        failed: false,
      };
    } catch {
      return { content: node, changed: false, failed: true };
    }
  }

  if (!node.content?.length) {
    return { content: node, changed: false, failed: false };
  }

  let changed = false;
  let failed = false;
  const content: DocumentContent[] = [];
  for (const child of node.content) {
    const result = await uploadLocalMediaInNode(child, syncConfig);
    content.push(result.content);
    changed ||= result.changed;
    failed ||= result.failed;
  }
  return {
    content: changed ? { ...node, content } : node,
    changed,
    failed,
  };
}

async function uploadPendingLocalMedia(
  syncConfig: SyncConfig,
  excludedProjectIds: ReadonlySet<string> = new Set(),
): Promise<boolean> {
  const { pages, projects } = await readStorage();
  let hadFailures = false;

  for (const page of pages) {
    if (
      page.status === 'archived' ||
      page.syncMode !== 'notion' ||
      excludedProjectIds.has(page.projectId)
    ) continue;
    const result = await uploadLocalMediaInNode(page.content, syncConfig);
    hadFailures ||= result.failed;
    if (!result.changed) continue;
    const latestStorage = await readStorage();
    const latestPage = latestStorage.pages.find((candidate) => candidate.id === page.id);
    const project = latestStorage.projects.find((candidate) => candidate.id === page.projectId) ??
      projects.find((candidate) => candidate.id === page.projectId);
    if (!project) continue;
    const updatedPage = markPageDirty({
      ...(latestPage ?? page),
      content: mergeUploadedMediaAttributes(latestPage?.content ?? page.content, result.content),
    });
    await persistPage(updatedPage);
    const queuedPage = await enqueuePageSync(updatedPage, project, latestPage ?? page);
    await persistPage(queuedPage);
  }

  return hadFailures;
}

async function enqueuePageSync(
  page: ProjectPage,
  project: Project,
  previousPage?: ProjectPage,
): Promise<ProjectPage> {
  const { syncConfig, workspaces } = await readStorage();
  const workspace = workspaces.find((entry) => entry.id === page.workspaceId)
    ?? workspaces.find((entry) => entry.id === project.workspaceId);
  const shouldSyncToNotion = page.syncMode === 'notion' ||
    project.syncMode === 'notion' ||
    workspace?.kind === 'notion';
  const syncMode: 'notion' | 'local' = shouldSyncToNotion ? 'notion' : 'local';
  const normalizedPage = {
    ...page,
    syncMode,
    ...(shouldSyncToNotion
      ? {
          syncAccountId: workspace?.kind === 'notion'
            ? workspace.accountId ?? page.syncAccountId ?? syncConfig.userId ?? syncConfig.syncQueueOwnerUserId ?? undefined
            : page.syncAccountId ?? syncConfig.userId ?? syncConfig.syncQueueOwnerUserId ?? undefined,
          syncWorkspaceId: workspace?.kind === 'notion'
            ? workspace.notionWorkspaceId ?? page.syncWorkspaceId ?? syncConfig.workspaceId
            : page.syncWorkspaceId ?? syncConfig.workspaceId,
        }
      : { syncWorkspaceId: undefined }),
    content: normalizeJottathingBlockIds(page.content),
  };
  if (normalizedPage.syncMode !== 'notion') {
    return withSyncStatus(normalizedPage, 'saved');
  }
  const normalizedProject = project.syncMode === 'notion'
    ? project
    : { ...project, syncMode: 'notion' as const };
  const syncablePage = {
    ...normalizedPage,
    content: sanitizeMediaForSync(normalizedPage.content),
  };
  const syncablePreviousPage = previousPage
    ? { ...previousPage, content: sanitizeMediaForSync(previousPage.content) }
    : undefined;

  const pendingOps = await addPendingSyncOps(buildPageSyncOps({
    previousPage: syncablePreviousPage,
    page: syncablePage,
    project: normalizedProject,
    selectedParentPageId: syncConfig.selectedParentPageId,
  }));
  if (pendingOps.length || countPendingLocalMedia(normalizedPage.content) > 0) {
    triggerQueueDelivery();
  }

  if (!syncQueueBelongsToActiveAccount(syncConfig)) {
    return withSyncStatus(
      normalizedPage,
      'stale',
      syncConfig.syncQueueOwnerUserId === null
        ? 'Saved locally. Reconnect the Notion account that owns this queue to sync it.'
        : 'Saved locally. This queue belongs to a different Notion account or workspace.',
    );
  }

  return syncConfig.connected && !isBrowserOffline()
    ? withSyncStatus(normalizedPage, pendingOps.length ? 'saving' : 'saved')
    : withSyncStatus(
        normalizedPage,
        'stale',
        syncConfig.connected
          ? 'Saved locally. Will sync when a connection is available.'
          : 'Connect Notion to sync this page.',
      );

}

function triggerQueueDelivery(): void {
  if (isSessionLogoutPending || isConnectionDeletionPending || queueDeliveryPromise) return;
  scheduleNextQueueDelivery(Math.max(
    LOCAL_QUEUE_DELIVERY_DELAY_MS,
    queueDeliveryRetryDelayMs,
  ));
}

function runQueueDelivery(): void {
  if (isSessionLogoutPending || isConnectionDeletionPending || queueDeliveryPromise || forcedQueueDeliveryPromise) return;
  const delivery = deliverPendingSyncOps({ force: false }).catch((error) => {
    recordQueueDeliveryFailure(error);
    throw error;
  });
  queueDeliveryPromise = delivery;
  void delivery.finally(() => {
    if (queueDeliveryPromise === delivery) queueDeliveryPromise = undefined;
    void scheduleQueueDeliveryIfNeeded();
  }).catch(() => undefined);
}

async function scheduleQueueDeliveryIfNeeded(): Promise<void> {
  if (isSessionLogoutPending || isConnectionDeletionPending) return;
  if (await hasPendingConnectionDeletion()) return;
  const [{ syncConfig, pages }, pendingOps, projectEvents] = await Promise.all([
    readStorage(),
    listPendingSyncOps(),
    listPendingProjectSyncEvents(),
  ]);
  if (!syncQueueBelongsToActiveAccount(syncConfig)) return;
  const projectsWaitingForSetup = new Set(projectEvents.map((event) => event.projectId));
  const hasDeliverableWork = pendingOps.some((op) =>
    !op.deliveryBlocked && !projectsWaitingForSetup.has(op.projectId),
  ) ||
    projectEvents.some((event) => !event.deliveryBlocked) ||
    pages.some((page) =>
      !projectsWaitingForSetup.has(page.projectId) && countPendingLocalMedia(page.content) > 0,
    );

  if (syncConfig.connected && !isBrowserOffline() && hasDeliverableWork) {
    scheduleNextQueueDelivery(Math.max(
      LOCAL_QUEUE_DELIVERY_DELAY_MS,
      queueDeliveryRetryDelayMs,
    ));
  }
}

function scheduleNextQueueDelivery(delayMs: number): void {
  if (queueDeliveryTimer) {
    clearTimeout(queueDeliveryTimer);
  }
  queueDeliveryTimer = setTimeout(() => {
    queueDeliveryTimer = undefined;
    runQueueDelivery();
  }, Math.max(0, delayMs));
}

export function connectSyncEvents(
  syncConfig: SyncConfig,
  onEvent: (event: SyncEventMessage) => void,
): EventSource {
  const es = new EventSource(`${cleanSyncServerUrl(syncConfig.serverUrl)}/sync/events`, { withCredentials: true });
  es.onmessage = (e) => {
    try {
      onEvent(JSON.parse(e.data as string) as SyncEventMessage);
    } catch { /* ignore malformed */ }
  };
  return es;
}

export async function applySyncResult(event: SyncEventMessage): Promise<ProjectPage | undefined> {
  if (event.status === 'queue_idle' || event.status === 'reload_progress') return undefined;

  const { pages } = await readStorage();
  const page = pages.find((p) => p.id === event.pageId);
  if (!page) return undefined;

  if (event.status === 'stale') {
    const stalePage = typeof event.version === 'number'
      ? { ...page, serverSyncVersion: event.version, syncState: 'stale' as const }
      : { ...page, syncState: 'stale' as const };
    await persistPage(stalePage);
    return stalePage;
  }

  const updated =
    event.status === 'synced'
      ? {
          ...page,
          ...(event.notionBlockId ? { notionPageId: event.notionBlockId } : {}),
          ...(typeof event.version === 'number'
            ? { serverSyncVersion: event.version }
            : {}),
          syncState: 'saved' as const,
          syncMessage: undefined,
          content: stripConflictResolutionMarkers(page.content),
        }
      : withSyncStatus(
          page,
          'error',
          event.message ?? (event.statusCode
            ? `Notion sync failed with HTTP ${event.statusCode}. Check Notion access, then use Resync.`
            : 'Notion sync failed. Will retry.'),
        );

  await persistPage(updated);
  return updated;
}

export async function clearStalePages(pageIds: string[]): Promise<void> {
  if (!pageIds.length) return;
  const { syncConfig } = await readStorage();
  if (!syncConfig.connected) return;
  await requestServer('/sync/clear-stale', {
    method: 'POST',
    body: JSON.stringify({ pageIds }),
  }, syncConfig).catch(() => undefined);
}

async function syncPullPage(page: ProjectPage, options: { force?: boolean } = {}): Promise<ProjectPage> {
  const { syncConfig } = await readStorage();

  if (!syncConfig.connected || isBrowserOffline() || !page.notionPageId) {
    return page;
  }

  if (!options.force && !hasNewerServerVersion(page)) {
    return page;
  }

  try {
    const response = await requestServer<SyncPageResponse>('/sync/pull', {
      method: 'POST',
      body: JSON.stringify({
        page,
      }),
    }, syncConfig);

    return response.page
      ? {
          ...page,
          ...response.page,
          syncMode: 'notion',
          syncAccountId: page.syncAccountId,
          syncWorkspaceId: page.syncWorkspaceId,
          content: response.page.content
            ? preserveLocalMediaSources(page.content, response.page.content)
            : page.content,
          knownSyncVersion: page.serverSyncVersion ?? page.knownSyncVersion,
          syncMessage: response.message,
          syncState: response.status,
        }
      : withSyncStatus(page, response.status, response.message);
  } catch (error) {
    return withSyncStatus(
      page,
      'error',
      error instanceof Error ? error.message : 'Unable to pull Notion changes.',
    );
  }
}

function hasNewerServerVersion(page: ProjectPage): boolean {
  return typeof page.serverSyncVersion === 'number' &&
    page.serverSyncVersion > (page.knownSyncVersion ?? 0);
}

async function persistPage(page: ProjectPage) {
  await persistPagesById([page]);
}

/** Persists sync metadata without overwriting a page edit made during the request. */
async function persistSyncedPagePreservingNewerEdit(page: ProjectPage): Promise<ProjectPage> {
  const write = workspaceWriteQueue.then(async () => {
    const storedPages = (await idbGet<ProjectPage[]>('pages')) ?? [];
    const currentPage = storedPages.find((storedPage) => storedPage.id === page.id);
    const hasNewerLocalEdit = Boolean(
      currentPage?.localRevision && page.localRevision &&
      currentPage.localRevision !== page.localRevision,
    );
    const pageToStore = hasNewerLocalEdit
      ? {
          ...page,
          content: currentPage!.content,
          title: currentPage!.title,
          status: currentPage!.status,
          pageOrder: currentPage!.pageOrder,
          localRevision: currentPage!.localRevision,
          updatedAt: currentPage!.updatedAt,
          syncState: currentPage!.syncState,
          syncMessage: currentPage!.syncMessage,
        }
      : page;
    const pagesById = new Map(storedPages.map((storedPage) => [storedPage.id, storedPage]));
    pagesById.set(pageToStore.id, pageToStore);
    await idbSet('pages', [...pagesById.values()]);
    workspaceWriteVersion += 1;
    return pageToStore;
  });
  workspaceWriteQueue = write.then(() => undefined, () => undefined);
  return write;
}

async function syncAndPersistPage(page: ProjectPage): Promise<ProjectPage> {
  const synced = isTempPage(page) || page.syncMode !== 'notion' ? page : await syncPullPage(page);
  if (synced !== page) await persistPage(synced);
  return synced;
}

function findActiveProjectPages(pages: ProjectPage[], projectId: string, excludePageId?: string): ProjectPage[] {
  return pages.filter(
    (page) =>
      page.projectId === projectId &&
      page.status !== 'archived' &&
      page.id !== excludePageId &&
      !isTempPage(page),
  );
}

function sortProjectPages(pages: ProjectPage[]): ProjectPage[] {
  const hasExplicitOrder = pages.some((page) => typeof page.pageOrder === 'number');
  return [...pages].sort((first, second) => {
    if (hasExplicitOrder) {
      const firstOrder = typeof first.pageOrder === 'number' ? first.pageOrder : Number.POSITIVE_INFINITY;
      const secondOrder = typeof second.pageOrder === 'number' ? second.pageOrder : Number.POSITIVE_INFINITY;
      if (firstOrder !== secondOrder) return firstOrder - secondOrder;
    }
    return new Date(first.createdAt).getTime() - new Date(second.createdAt).getTime();
  });
}

function normalizeStoredPage<T extends {
  content?: DocumentContent;
  localRevision?: string;
  status?: string;
  syncState?: string;
  syncMode?: 'local' | 'notion';
  syncAccountId?: string;
  syncWorkspaceId?: string;
}>(
  page: T,
  defaultMode: 'local' | 'notion' = 'notion',
  defaultAccountId?: string,
  defaultWorkspaceId?: string,
): T {
  const syncMode = page.syncMode ?? defaultMode;
  return {
    ...page,
    content: normalizeJottathingBlockIds(markUnrecoverableTransientMedia(page.content as DocumentContent)),
    syncMode,
    syncAccountId: page.syncAccountId ?? (syncMode === 'notion' ? defaultAccountId : undefined),
    syncWorkspaceId: page.syncWorkspaceId ?? (syncMode === 'notion' ? defaultWorkspaceId : undefined),
    localRevision: page.localRevision ?? crypto.randomUUID(),
    status: page.status ?? 'active',
    syncState: page.syncState ?? 'saved',
  };
}

function requireActiveProject(projects: Project[], projectId: string): Project {
  const project = projects.find((p) => p.id === projectId);
  if (!project || project.status === 'archived') {
    throw new Error('This project is no longer available.');
  }
  return project;
}

async function saveProjectUpdate(
  projects: Project[],
  projectId: string,
  updates: Partial<Project>,
): Promise<Project> {
  const inFlightReconciliation = projectReconciliations.get(projectId);
  let resolvedProjectId = projectIdAliases.get(projectId) ?? projectId;
  if (inFlightReconciliation) {
    resolvedProjectId = await inFlightReconciliation;
  }

  if (resolvedProjectId !== projectId || inFlightReconciliation) {
    // Project edits can arrive while the optimistic project is being assigned
    // its durable ID. Wait for that migration, then apply only the user's
    // changed fields to the latest stored project to avoid creating a second
    // Notion row with the temporary ID or overwriting freshly synced state.
    const latest = await readStorage();
    projects = latest.projects;
    projectId = resolvedProjectId;
  }

  const currentProject = requireActiveProject(projects, projectId);
  const updatedProject = touchProject(currentProject, updates);
  await writeStorage({
    projects: projects
      .map((project) => (project.id === projectId ? updatedProject : project))
      .sort(sortProjectsByUpdatedDesc),
  });

  const syncedProject = await syncProject(updatedProject);
  const savedProject = syncedProject ?? updatedProject;
  const { projects: latestProjects } = await readStorage();
  const latestProject = latestProjects.find((project) => project.id === projectId);

  if (latestProject?.updatedAt !== updatedProject.updatedAt) {
    return latestProject ?? savedProject;
  }

  await writeStorage({
    projects: latestProjects
      .map((project) => (project.id === projectId ? savedProject : project))
      .sort(sortProjectsByUpdatedDesc),
  });
  return savedProject;
}

/** Resolves optimistic project IDs before applying user edits. */
async function projectForUpdate(projectId: string): Promise<{
  projectId: string;
  projects: Project[];
}> {
  const reconciliation = projectReconciliations.get(projectId);
  const aliasedProjectId = projectIdAliases.get(projectId);
  if (!reconciliation && !aliasedProjectId) {
    return { projectId, projects: (await readStorage()).projects };
  }

  const resolvedProjectId = reconciliation
    ? await reconciliation
    : aliasedProjectId!;
  const { projects } = await readStorage();
  return { projectId: resolvedProjectId, projects };
}

async function saveProjectSourceUpdate(
  projects: Project[],
  projectId: string,
  updatedProject: Project,
  blockId: string,
  source: SourceOpenPayload,
): Promise<Project> {
  await writeStorage({
    projects: projects
      .map((storedProject) => storedProject.id === projectId ? updatedProject : storedProject)
      .sort(sortProjectsByUpdatedDesc),
  });
  const savedProject = await syncProjectSource(updatedProject, blockId, source);
  const { projects: latestProjects } = await readStorage();
  if (latestProjects.find((storedProject) => storedProject.id === projectId)?.updatedAt !== updatedProject.updatedAt) {
    return latestProjects.find((storedProject) => storedProject.id === projectId) ?? savedProject;
  }
  await writeStorage({
    projects: latestProjects.map((storedProject) =>
      storedProject.id === projectId ? savedProject : storedProject,
    ),
  });
  return savedProject;
}

async function requirePageWithProject(pageId: string) {
  const storage = await readStorage();
  const resolvedPageId = pageIdAliases.get(pageId) ?? pageId;
  const page = storage.pages.find((p) => p.id === resolvedPageId)
    ?? storage.pages.find((p) => p.id === pageId);
  if (!page) throw new Error('This page is no longer available.');
  const resolvedProjectId = projectIdAliases.get(page.projectId) ?? page.projectId;
  const project = storage.projects.find((p) => p.id === resolvedProjectId)
    ?? storage.projects.find((p) => p.id === page.projectId);
  if (!project) throw new Error('This project is no longer available.');
  return { ...storage, page, project };
}

async function replaceTempProject({
  tempPage,
  tempProject,
  realPage,
  realProject,
}: {
  tempPage: ProjectPage;
  tempProject: Project;
  realPage: ProjectPage;
  realProject: Project;
}) {
  const selectionRevisionAtStart = currentProjectSelectionRevision;
  const {
    activePageIdsByProject,
    currentProjectId,
    currentProjectIdByWorkspace,
    pages,
    projects,
  } = await readStorage();
  const resolvedCurrentProjectId = currentProjectIdForTempProject(
    currentProjectId,
    tempProject.id,
    realProject.id,
    selectionRevisionAtStart,
  );
  const nextActivePageIds = { ...activePageIdsByProject };
  const tempActivePageId = nextActivePageIds[tempProject.id];

  delete nextActivePageIds[tempProject.id];
  nextActivePageIds[realProject.id] =
    tempActivePageId === tempPage.id ? realPage.id : tempActivePageId;
  const nextCurrentProjectIdByWorkspace = { ...currentProjectIdByWorkspace };
  if (
    realProject.workspaceId &&
    nextCurrentProjectIdByWorkspace[realProject.workspaceId] === tempProject.id
  ) {
    nextCurrentProjectIdByWorkspace[realProject.workspaceId] = realProject.id;
  }

  await writeStorage({
    activePageIdsByProject: nextActivePageIds,
    currentProjectId: resolvedCurrentProjectId,
    currentProjectIdByWorkspace: nextCurrentProjectIdByWorkspace,
    pages: pages.map((page) =>
      page.id === tempPage.id
        ? {
            ...page,
            ...realPage,
            content: page.content,
            title: page.title,
            syncState: pendingTempPageSaves.has(tempPage.id) ? 'saving' : 'saved',
          }
        : page.projectId === tempProject.id
          ? { ...page, projectId: realProject.id }
          : page,
    ),
    projects: projects
      .map((project) =>
        project.id === tempProject.id ? realProject : project,
      )
      .sort(sortProjectsByUpdatedDesc),
  });
  rememberPageIdAlias(tempPage.id, realPage.id);
}

async function rollbackTempProject(
  tempProject: Project,
  tempPage: ProjectPage,
  previousProjectId: string,
  message: string,
) {
  const selectionRevisionAtStart = currentProjectSelectionRevision;
  const {
    activePageIdsByProject,
    currentProjectId,
    currentProjectIdByWorkspace,
    pages,
    projects,
  } = await readStorage();
  const resolvedCurrentProjectId = currentProjectIdForTempProject(
    currentProjectId,
    tempProject.id,
    previousProjectId,
    selectionRevisionAtStart,
  );
  const nextActivePageIds = { ...activePageIdsByProject };
  delete nextActivePageIds[tempProject.id];
  pendingTempPageSaves.delete(tempPage.id);
  const remainingProjects = projects.filter((project) => project.id !== tempProject.id);
  const nextCurrentProjectIdByWorkspace = { ...currentProjectIdByWorkspace };
  if (
    tempProject.workspaceId &&
    nextCurrentProjectIdByWorkspace[tempProject.workspaceId] === tempProject.id
  ) {
    nextCurrentProjectIdByWorkspace[tempProject.workspaceId] =
      remainingProjects.find((project) =>
        project.workspaceId === tempProject.workspaceId &&
        project.status !== 'archived' &&
        project.id === previousProjectId,
      )?.id ?? remainingProjects.find((project) =>
        project.workspaceId === tempProject.workspaceId && project.status !== 'archived',
      )?.id ?? '';
  }

  await writeStorage({
    activePageIdsByProject: nextActivePageIds,
    currentProjectId: resolvedCurrentProjectId,
    currentProjectIdByWorkspace: nextCurrentProjectIdByWorkspace,
    pages: pages.filter((page) => page.projectId !== tempProject.id),
    projects: remainingProjects
      .map((project) =>
        project.id === previousProjectId
          ? { ...project, syncState: 'error' as const, syncMessage: message }
          : project,
      )
      .sort(sortProjectsByUpdatedDesc),
  });
}

function currentProjectIdForTempProject(
  storedProjectId: string,
  tempProjectId: string,
  resolvedProjectId: string,
  selectionRevisionAtStart: number,
): string {
  const selectedProjectId = selectionRevisionAtStart === currentProjectSelectionRevision
    ? storedProjectId
    : requestedCurrentProjectId ?? storedProjectId;
  return selectedProjectId === tempProjectId ? resolvedProjectId : selectedProjectId;
}

function rememberPageIdAlias(tempPageId: string, realPageId: string) {
  if (tempPageId === realPageId) return;
  pageIdAliases.set(tempPageId, realPageId);
  while (pageIdAliases.size > 100) {
    const oldestPageId = pageIdAliases.keys().next().value;
    if (!oldestPageId) break;
    pageIdAliases.delete(oldestPageId);
  }
}

async function replaceTempPage(tempPage: ProjectPage, realPage: ProjectPage) {
  await replacePageAtomically(tempPage, realPage);
}

async function replayTempPageSave(tempPageId: string, realPage: ProjectPage) {
  const pendingPage = pendingTempPageSaves.get(tempPageId);
  pendingTempPageSaves.delete(tempPageId);

  const storedPage = (await readStorage()).pages.find((page) => page.id === realPage.id);
  const storedUpdatedAt = Date.parse(storedPage?.updatedAt ?? '');
  const pendingUpdatedAt = Date.parse(pendingPage?.updatedAt ?? '');
  const latestPage = storedPage && (
    !pendingPage ||
    (Number.isFinite(storedUpdatedAt) && storedUpdatedAt >= pendingUpdatedAt)
  )
    ? storedPage
    : pendingPage;
  if (!latestPage) return storedPage ?? realPage;

  if (
    latestPage.title === realPage.title &&
    JSON.stringify(latestPage.content) === JSON.stringify(realPage.content)
  ) {
    return storedPage ?? realPage;
  }

  return notionClient.updateProjectPage({
    ...realPage,
    title: latestPage.title,
    content: latestPage.content,
  });
}

/** Reads the freshest optimistic page edit before assigning its durable ID. */
async function latestTempPageSnapshot(
  tempPageId: string,
  fallback: ProjectPage,
  resolvedPageId = tempPageId,
): Promise<ProjectPage> {
  const storage = await readStorage();
  const storedPage = storage.pages.find((page) => page.id === resolvedPageId)
    ?? storage.pages.find((page) => page.id === tempPageId);
  const pendingPage = pendingTempPageSaves.get(tempPageId);
  if (!pendingPage) return storedPage ?? fallback;
  if (resolvedPageId === tempPageId || !storedPage) return pendingPage;

  const storedUpdatedAt = Date.parse(storedPage.updatedAt);
  const pendingUpdatedAt = Date.parse(pendingPage.updatedAt);
  if (Number.isFinite(storedUpdatedAt) && storedUpdatedAt >= pendingUpdatedAt) {
    return storedPage;
  }

  return {
    ...storedPage,
    title: pendingPage.title,
    content: pendingPage.content,
    localRevision: pendingPage.localRevision,
    updatedAt: pendingPage.updatedAt,
  };
}

/** Repairs a project left with an optimistic ID after the extension stopped mid-create. */
async function recoverOrphanedTemporaryProject(tempProjectId: string): Promise<ProjectPage> {
  const existingReconciliation = projectReconciliations.get(tempProjectId);
  if (existingReconciliation) {
    await existingReconciliation;
    const latest = await readStorage();
    const activePageId = latest.activePageIdsByProject[
      latest.currentProjectIdByWorkspace[latest.currentWorkspaceId] ?? latest.currentProjectId
    ];
    const recoveredPage = latest.pages.find((page) => page.id === activePageId);
    if (recoveredPage) return recoveredPage;
  }

  const recovery = (async () => {
    const storage = await readStorage();
    const tempProject = storage.projects.find((project) => project.id === tempProjectId);
    if (!tempProject || !isTempProject(tempProject)) {
      throw new Error('This project is no longer available.');
    }
    const tempPages = sortProjectPages(storage.pages.filter((page) =>
      page.projectId === tempProjectId && page.status !== 'archived',
    ));
    if (!tempPages.length) {
      throw new Error('The project is still being created. Keep it open and try again shortly.');
    }

    // The active page was just created by the caller. Use an older page as the
    // project anchor where possible so the active page identity can be migrated
    // independently without dropping its edits.
    const activeTempPageId = storage.activePageIdsByProject[tempProjectId];
    const rootTempPage = tempPages.find((page) => page.id !== activeTempPageId) ?? tempPages[0];
    const realProject: Project = {
      ...tempProject,
      id: `project-${crypto.randomUUID()}`,
      syncState: tempProject.syncMode === 'notion' ? 'saving' : 'saved',
      syncMessage: undefined,
    };
    const realRootPage: ProjectPage = {
      ...rootTempPage,
      id: `page-${realProject.id}-${crypto.randomUUID()}`,
      projectId: realProject.id,
      syncState: 'saved',
      syncMessage: undefined,
    };

    await replaceTempProject({
      tempPage: rootTempPage,
      tempProject,
      realPage: realRootPage,
      realProject,
    });
    projectIdAliases.set(tempProjectId, realProject.id);
    while (projectIdAliases.size > 100) {
      const oldestProjectId = projectIdAliases.keys().next().value;
      if (!oldestProjectId) break;
      projectIdAliases.delete(oldestProjectId);
    }

    let latest = await readStorage();
    const pagesToQueue: Array<{ page: ProjectPage; tempPageId?: string }> = [
      { page: realRootPage, tempPageId: rootTempPage.id },
    ];
    for (const storedPage of latest.pages.filter((page) => page.projectId === realProject.id)) {
      if (storedPage.id === realRootPage.id) continue;
      let page = storedPage;
      const tempPageId = page.id.startsWith('temp-page-') ? page.id : undefined;
      if (tempPageId) {
        page = {
          ...page,
          id: `page-${realProject.id}-${crypto.randomUUID()}`,
          syncState: 'saved',
          syncMessage: undefined,
        };
        await replaceTempPage(storedPage, page);
      }
      pagesToQueue.push({ page, ...(tempPageId ? { tempPageId } : {}) });
    }

    const syncedProject = await syncProject(realProject);
    const savedProject = syncedProject ?? realProject;
    latest = await readStorage();
    await writeStorage({
      projects: latest.projects.map((project) => project.id === realProject.id
        ? savedProject
        : project),
    });

    for (const { page, tempPageId } of pagesToQueue) {
      const queuedPage = await enqueuePageSync(page, savedProject);
      await persistPage(queuedPage);
      if (tempPageId) await replayTempPageSave(tempPageId, queuedPage);
    }

    latest = await readStorage();
    const currentProjectId = latest.currentProjectIdByWorkspace[latest.currentWorkspaceId]
      ?? latest.currentProjectId;
    const activePageId = latest.activePageIdsByProject[currentProjectId];
    const currentPage = latest.pages.find((page) => page.id === activePageId);
    if (currentPage) return currentPage;
    const recoveredPage = latest.pages.find((page) => page.projectId === realProject.id);
    if (recoveredPage) return recoveredPage;
    throw new Error('The project was recovered, but its page could not be opened.');
  })();
  const projectReconciliation = recovery.then((page) => page.projectId);
  projectReconciliation.catch(() => undefined);
  projectReconciliations.set(tempProjectId, projectReconciliation);
  try {
    return await recovery;
  } finally {
    if (projectReconciliations.get(tempProjectId) === projectReconciliation) {
      projectReconciliations.delete(tempProjectId);
    }
  }
}

async function flushPendingSyncOps(
  options: { force?: boolean; allowSessionLogout?: boolean } = {},
): Promise<void> {
  if ((isSessionLogoutPending && !options.allowSessionLogout) || isConnectionDeletionPending) return;
  if (await hasPendingConnectionDeletion()) return;

  if (options.force) {
    if (queueDeliveryTimer) {
      clearTimeout(queueDeliveryTimer);
      queueDeliveryTimer = undefined;
    }

    if (forcedQueueDeliveryPromise) {
      // A later block exit may have queued edits after the active delivery
      // already took its snapshot. Drain again after that delivery settles so
      // the newer edits are included in this caller's forced flush.
      const inFlightDelivery = forcedQueueDeliveryPromise;
      return inFlightDelivery
        .catch(() => undefined)
        .then(() => flushPendingSyncOps(options));
    }

    const delivery = (async () => {
      if (queueDeliveryPromise) {
        await queueDeliveryPromise;
      }
      try {
        await deliverPendingSyncOps({
          force: true,
          allowSessionLogout: options.allowSessionLogout,
        });
      } catch (error) {
        recordQueueDeliveryFailure(error);
        throw error;
      }
    })();
    forcedQueueDeliveryPromise = delivery;
    void delivery.finally(() => {
      if (forcedQueueDeliveryPromise === delivery) forcedQueueDeliveryPromise = undefined;
      void scheduleQueueDeliveryIfNeeded();
    }).catch(() => undefined);

    return forcedQueueDeliveryPromise;
  }

  triggerQueueDelivery();
}

async function hasPendingConnectionDeletion(): Promise<boolean> {
  const pending = Boolean(await getBrandedStorageValue<PendingConnectionDeletion>(
    PENDING_CONNECTION_DELETION_KEY,
    LEGACY_PENDING_CONNECTION_DELETION_KEY,
  ));
  if (pending) {
    isConnectionDeletionPending = true;
    if (queueDeliveryTimer) {
      clearTimeout(queueDeliveryTimer);
      queueDeliveryTimer = undefined;
    }
  }
  return pending;
}

async function deliverPendingSyncOps({
  force,
  allowSessionLogout = false,
}: {
  force: boolean;
  allowSessionLogout?: boolean;
}): Promise<void> {
  if (
    (isSessionLogoutPending && !allowSessionLogout) ||
    isConnectionDeletionPending ||
    await hasPendingConnectionDeletion()
  ) return;
  const { syncConfig } = await readStorage();
  if (!syncConfig.connected || isBrowserOffline()) return;
  if (!syncQueueBelongsToActiveAccount(syncConfig)) return;

  const projectDelivery = await deliverPendingProjectSyncEvents(syncConfig);
  const hadMediaFailures = await uploadPendingLocalMedia(
    syncConfig,
    projectDelivery.blockedProjectIds,
  );

  const pendingBeforeRetry = (await compactStoredPendingSyncOps()).filter((op) =>
    !projectDelivery.blockedProjectIds.has(op.projectId),
  );
  if (pendingBeforeRetry.length) {
    const retry = await retryUndeliveredQueuePayloads(
      syncConfig,
      pendingBeforeRetry.map((op) => op.opId),
      true,
    );
    const requeuedIds = new Set(retry?.requeuedOperationIds ?? []);
    const requeuedOps = pendingBeforeRetry.filter((op) => requeuedIds.has(op.opId));
    if (requeuedOps.length) {
      await removePendingSyncOps(requeuedOps.map((op) => op.opId));
      await applyQueuedVersions(requeuedOps, retry!);
    }
  }

  const pending = await compactStoredPendingSyncOps();
  if (pending.length) {
    const now = Date.now();
    const eligible = pending.filter((op) =>
      !op.deliveryBlocked &&
      !projectDelivery.blockedProjectIds.has(op.projectId) &&
      (force || now - Date.parse(op.createdAt) >= LOCAL_QUEUE_DELIVERY_DELAY_MS),
    );

    if (!eligible.length) {
      const deliverable = pending.filter((op) =>
        !op.deliveryBlocked && !projectDelivery.blockedProjectIds.has(op.projectId),
      );
      if (deliverable.length) scheduleNextQueueDelivery(msUntilOldestOpIsEligible(deliverable, now));
      if (projectDelivery.retryError) throw projectDelivery.retryError;
      return;
    }

    const response = await requestServer<SyncEnqueueResponse>('/sync/push', {
      method: 'POST',
      body: JSON.stringify({ ops: eligible }),
    }, syncConfig);

    await removePendingSyncOps(eligible.map((op) => op.opId));
    await applyQueuedVersions(eligible, response);
  }

  if (hadMediaFailures) {
    throw new Error('Some local media is still waiting for a connection.');
  }

  const remaining = (await listPendingSyncOps()).filter((op) =>
    !op.deliveryBlocked && !projectDelivery.blockedProjectIds.has(op.projectId),
  );
  if (remaining.length) {
    scheduleNextQueueDelivery(msUntilOldestOpIsEligible(remaining));
  }

  resetQueueDeliveryBackoff();
  if (projectDelivery.retryError) throw projectDelivery.retryError;
}

function stripConflictResolutionMarkers(content: DocumentContent): DocumentContent {
  const attrs = { ...(content.attrs ?? {}) };
  delete attrs.jottathingConflictResolution;
  delete attrs.jottathingPreserveRemoteBlocks;
  delete attrs.jottathingDeleteNotionBlockIds;
  return {
    ...content,
    ...(content.attrs ? { attrs } : {}),
    ...(content.content ? { content: content.content.map(stripConflictResolutionMarkers) } : {}),
  };
}

async function clearProjectConflictResolutionMarkers(projectId: string): Promise<void> {
  const { projects } = await readStorage();
  await writeStorage({
    projects: projects.map((project) => project.id === projectId
      ? { ...project, stateContent: stripConflictResolutionMarkers(project.stateContent) }
      : project),
  });
}

async function clearStoredPageSyncConflict(pageId: string): Promise<void> {
  const { projects } = await readStorage();
  const nextProjects = projects.map((project) => {
    const syncConflicts = project.syncConflicts?.filter((conflict) =>
      conflict.targetType !== 'page' || conflict.targetId !== pageId,
    );
    return {
      ...project,
      ...(syncConflicts?.length ? { syncConflicts } : { syncConflicts: undefined }),
    };
  });
  await writeStorage({ projects: nextProjects });
}

async function persistPageSyncConflicts(conflicts: SyncContentConflict[]): Promise<void> {
  if (!conflicts.length) return;
  const { pages, projects } = await readStorage();
  const projectIdByPageId = new Map(pages.map((page) => [page.id, page.projectId]));
  const conflictsByProject = new Map<string, SyncContentConflict[]>();
  for (const conflict of conflicts) {
    if (conflict.targetType !== 'page') continue;
    const projectId = projectIdByPageId.get(conflict.targetId);
    if (!projectId) continue;
    const group = conflictsByProject.get(projectId) ?? [];
    group.push(conflict);
    conflictsByProject.set(projectId, group);
  }
  if (!conflictsByProject.size) return;

  await writeStorage({
    projects: projects.map((project) => {
      const nextConflicts = conflictsByProject.get(project.id);
      if (!nextConflicts) return project;
      const affectedPageIds = new Set(nextConflicts.map((conflict) => conflict.targetId));
      const retained = (project.syncConflicts ?? []).filter((conflict) =>
        !affectedPageIds.has(conflict.targetId),
      );
      return { ...project, syncConflicts: [...retained, ...nextConflicts] };
    }),
  });
}

function withoutLocalSyncConflicts<T extends { syncConflicts?: SyncContentConflict[] }>(project: T): Omit<T, 'syncConflicts'> {
  const { syncConflicts: _syncConflicts, ...syncable } = project;
  return syncable;
}

async function deliverPendingProjectSyncEvents(syncConfig: SyncConfig): Promise<{
  blockedProjectIds: Set<string>;
  retryError?: unknown;
}> {
  const events = await listPendingProjectSyncEvents();
  const failedProjectIds = new Set<string>();
  let retryError: unknown;

  for (const event of events) {
    if (failedProjectIds.has(event.projectId)) continue;
    if (event.deliveryBlocked) {
      failedProjectIds.add(event.projectId);
      continue;
    }

    const isSourceEvent = event.type === 'project_source_upsert';
    let response: SyncProjectResponse;
    try {
      response = await requestQueuedProjectSync(event, syncConfig);
    } catch (error) {
      if (isUnmappedContentConflict(error)) {
        const { projects } = await readStorage();
        const localProject = projects.find((project) => project.id === event.projectId);
        await blockPendingProjectSyncEvents(event.projectId, {
          code: 'unmapped_notion_content',
          message: error.message,
          ...(error.diff ? {
            diff: {
              ...error.diff,
              localContent: localProject?.stateContent ?? error.diff.localContent,
            },
          } : {}),
        });
        failedProjectIds.add(event.projectId);
        continue;
      }
      failedProjectIds.add(event.projectId);
      retryError ??= error;
      continue;
    }

    if (response.status === 'error') {
      failedProjectIds.add(event.projectId);
      retryError ??= new Error(response.message ?? 'Unable to sync this project.');
      continue;
    }

    if (response.parentPage) {
      await updateStoredSyncConfig({
        selectedParentPageId: response.parentPage.id,
        selectedParentPageTitle: response.parentPage.title,
      });
    }

    await applySyncedProject(event.payload.project, response.project, isSourceEvent);
    await removePendingProjectSyncEvents([event.eventId]);
    await clearProjectConflictResolutionMarkers(event.projectId);
  }

  const remainingEvents = await listPendingProjectSyncEvents();
  return {
    blockedProjectIds: new Set(remainingEvents.map((event) => event.projectId)),
    ...(retryError ? { retryError } : {}),
  };
}

async function applySyncedProject(
  queuedProject: Omit<Project, 'stateContent'> | Project,
  responseProject?: Project,
  preserveLocalState = false,
): Promise<void> {
  const { projects } = await readStorage();
  await writeStorage({
    projects: projects.map((project) =>
      project.id === queuedProject.id && project.updatedAt === queuedProject.updatedAt
        ? {
            ...(responseProject ?? project),
            ...(project.syncConflicts?.length
              ? { syncConflicts: project.syncConflicts }
              : { syncConflicts: undefined }),
            ...(preserveLocalState
              ? { stateContent: stripConflictResolutionMarkers(project.stateContent) }
              : {}),
            syncState: 'saved' as const,
            syncMessage: undefined,
          }
        : project,
    ),
  });
}

async function applyQueuedVersions(
  ops: BlockSyncOp[],
  response: Pick<SyncEnqueueResponse, 'version' | 'versions' | 'opVersions'>,
): Promise<void> {
  const versions = response.versions ?? {};
  const opVersions = response.opVersions ?? {};
  const versionByPage = new Map<string, number>();

  for (const op of ops) {
    const version = versions[op.pageId] ?? opVersions[op.opId] ?? response.version ?? op.localVersion;
    if (typeof version === 'number') {
      versionByPage.set(op.pageId, Math.max(versionByPage.get(op.pageId) ?? 0, version));
    }
  }

  if (!versionByPage.size) return;

  const { pages } = await readStorage();
  await writeStorage({
    pages: pages.map((page) => {
      const version = versionByPage.get(page.id);
      return typeof version === 'number'
        ? {
            ...page,
            knownSyncVersion: Math.max(page.knownSyncVersion ?? 0, version),
            serverSyncVersion: Math.max(page.serverSyncVersion ?? 0, version),
          }
        : page;
    }),
  });
}

/** Redrives durable Queue payloads whose references could not be published. */
async function retryUndeliveredQueuePayloads(
  syncConfig: SyncConfig,
  opIds: string[],
  deliveryPendingOnly = false,
): Promise<SyncQueueRetryResponse | undefined> {
  if (syncQueueRetryEndpointAvailable === false) return undefined;
  try {
    const response = await requestServer<SyncQueueRetryResponse>(
      `/sync/retry${deliveryPendingOnly ? '?deliveryPendingOnly=true' : ''}`,
      {
        method: 'POST',
        body: JSON.stringify({ opIds: opIds.slice(0, 5000) }),
      },
      syncConfig,
    );
    syncQueueRetryEndpointAvailable = true;
    return response;
  } catch (error) {
    // Older deployed workers can keep syncing through the extension's durable queue.
    if (error instanceof SyncServerError && error.status === 404) {
      syncQueueRetryEndpointAvailable = false;
      return undefined;
    }
    throw error;
  }
}

function msUntilOldestOpIsEligible(ops: BlockSyncOp[], now = Date.now()): number {
  const oldestCreatedAt = Math.min(
    ...ops.map((op) => Date.parse(op.createdAt)).filter((time) => Number.isFinite(time)),
  );

  if (!Number.isFinite(oldestCreatedAt)) {
    return LOCAL_QUEUE_DELIVERY_DELAY_MS;
  }

  return Math.max(0, LOCAL_QUEUE_DELIVERY_DELAY_MS - (now - oldestCreatedAt));
}

async function updateStoredSyncConfig(
  config: Partial<SyncConfig>,
  additionalStorage: Partial<JottathingStorage> = {},
): Promise<SyncConfig> {
  const { syncConfig } = await readStorage();
  const nextConfig = stripStoredSyncCredentials({
    ...syncConfig,
    ...config,
    serverUrl: config.serverUrl
      ? cleanSyncServerUrl(config.serverUrl)
      : syncConfig.serverUrl,
  });

  await writeStorage({ syncConfig: nextConfig, ...additionalStorage });
  return nextConfig;
}

/** Removes legacy or injected credential fields when local auth state is rewritten. */
export function stripStoredSyncCredentials(syncConfig: SyncConfig): SyncConfig {
  return stripCredentialFields(syncConfig, new WeakMap<object, unknown>()) as SyncConfig;
}

function containsSyncCredentials(value: unknown, seen = new WeakSet<object>()): boolean {
  if (!value || typeof value !== 'object' || seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some((item) => containsSyncCredentials(item, seen));

  return Object.keys(value).some((key) =>
    /(?:token|secret|credential|authorization)/i.test(key) ||
    containsSyncCredentials((value as Record<string, unknown>)[key], seen),
  );
}

function hasStoredSyncCredentials(value: unknown): boolean {
  return containsSyncCredentials(value);
}

function stripCredentialFields(value: unknown, seen: WeakMap<object, unknown>): unknown {
  if (!value || typeof value !== 'object') return value;
  const prior = seen.get(value);
  if (prior) return prior;

  if (Array.isArray(value)) {
    const sanitized: unknown[] = [];
    seen.set(value, sanitized);
    for (const item of value) sanitized.push(stripCredentialFields(item, seen));
    return sanitized;
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;

  const sanitized = Object.create(prototype) as Record<string, unknown>;
  seen.set(value, sanitized);
  for (const key of Object.keys(value)) {
    if (/(?:token|secret|credential|authorization)/i.test(key)) continue;
    Object.defineProperty(sanitized, key, {
      configurable: true,
      enumerable: true,
      value: stripCredentialFields((value as Record<string, unknown>)[key], seen),
      writable: true,
    });
  }
  return sanitized;
}

function markConnectionDeletionPending(): void {
  isConnectionDeletionPending = true;
  if (queueDeliveryTimer) {
    clearTimeout(queueDeliveryTimer);
    queueDeliveryTimer = undefined;
  }
}

export const notionClient = {
  flushPendingSyncOps,
  pendingSyncEventCount: pendingLocalWorkCount,

  /** Stop queued network delivery and drain any request already in flight before a deletion. */
  async prepareConnectionDeletion(): Promise<boolean> {
    markConnectionDeletionPending();
    await Promise.allSettled(
      [queueDeliveryPromise, forcedQueueDeliveryPromise].filter(
        (promise): promise is Promise<void> => Boolean(promise),
      ),
    );
    await pauseIdbWrites();
    return true;
  },

  /** Keep a retry-pending deletion from resuming queued server sync on worker startup. */
  markConnectionDeletionPending,

  /** Unfence this context after an unsuccessful request; pending deletion still blocks sync. */
  async abortConnectionDeletion(): Promise<void> {
    await resumeIdbWrites();
    isConnectionDeletionPending = true;
  },

  /** Adopt the post-wipe IDB generation in the background worker. */
  async completeConnectionDeletion(): Promise<void> {
    await resumeIdbWrites({ adoptCurrentEpoch: true });
    isConnectionDeletionPending = false;
    queueDeliveryRetryAttempt = 0;
    queueDeliveryRetryDelayMs = 0;
  },

  async resyncPendingChanges(
    onProgress?: (progress: SyncProgressUpdate) => void,
  ): Promise<{
    blockedMessage?: string;
    blockedProjectCount: number;
    conflicts: SyncContentConflict[];
    reloadedFromNotion: boolean;
    remoteReloadPending: boolean;
    failedUploadCount: number;
    remainingCount: number;
  }> {
    const { syncConfig } = await readStorage();
    if (!syncConfig.connected || isBrowserOffline()) {
      throw new Error('Reconnect to Notion before resyncing. Your local changes remain saved.');
    }
    if (!syncQueueBelongsToActiveAccount(syncConfig)) {
      throw new Error('Local data is locked to its original Notion account. Reconnect that account to send local documents.');
    }

    let reloadedFromNotion = false;
    let remoteReloadPending = false;
    let failedUploadCount = 0;
    const pageConflicts: SyncContentConflict[] = [];

    // Retry blocked snapshots only from this explicit user action.
    await unblockPendingSyncOps();
    await unblockPendingProjectSyncEvents();

    // Queue bodies are durably stored in Supabase. Redrive them before
    // reconciling, and remove only local operations covered by those payloads.
    const pendingBeforeRetry = await listPendingSyncOps();
    const retry = await retryUndeliveredQueuePayloads(
      syncConfig,
      pendingBeforeRetry.map((op) => op.opId),
    );
    const requeuedCount = Number.isSafeInteger(retry?.requeuedCount)
      ? Math.max(0, retry?.requeuedCount ?? 0)
      : 0;
    const requeuedIds = new Set(retry?.requeuedOperationIds ?? []);
    const requeuedOps = pendingBeforeRetry.filter((op) => requeuedIds.has(op.opId));
    if (requeuedOps.length) {
      await removePendingSyncOps(requeuedOps.map((op) => op.opId));
      await applyQueuedVersions(requeuedOps, retry!);
    }

    const remoteQueue = await requestServer<SyncQueueStatusResponse>(
      '/sync/status',
      undefined,
      syncConfig,
    );
    failedUploadCount = Number.isSafeInteger(remoteQueue.failedCount)
      ? Math.max(0, remoteQueue.failedCount ?? 0)
      : 0;

    // Project state uses a separate durable client outbox. It can be the only
    // pending work after page uploads have drained, so always check it during
    // an explicit Sync instead of tying delivery to the server page queue.
    await deliverPendingProjectSyncEvents(syncConfig);
    if (remoteQueue.hasPending) {
      onProgress?.({ phase: 'waiting_for_server', pending: remoteQueue.pendingCount ?? requeuedCount });
      failedUploadCount = Math.max(
        failedUploadCount,
        await waitForRemoteSyncQueueToSettle(syncConfig, onProgress, undefined, true),
      );
    }

    const workspace = await readStorage();
    const pendingOps = await listPendingSyncOps();
    onProgress?.({ phase: 'checking_notion' });
    const validation = await notionClient.validateNotionCache();
    const pageIdsToReconcile = new Set([
      ...pendingOps.map((op) => op.pageId),
      ...workspace.pages.filter((page) => page.syncState === 'error').map((page) => page.id),
      ...validation.failedPageIds,
    ]);

    let reconciledPageCount = 0;
    onProgress?.({
      phase: 'syncing_pages',
      completed: 0,
      total: pageIdsToReconcile.size,
    });
    for (const pageId of pageIdsToReconcile) {
      const page = workspace.pages.find((entry) => entry.id === pageId);
      const project = page && workspace.projects.find((entry) => entry.id === page.projectId);
      if (!page || !project || page.status === 'archived' || project.status === 'archived') {
        reconciledPageCount += 1;
        onProgress?.({ phase: 'syncing_pages', completed: reconciledPageCount, total: pageIdsToReconcile.size });
        continue;
      }

      try {
        const response = await requestServer<SyncPageResponse>('/sync/page/resync', {
          method: 'POST',
          body: JSON.stringify({
            page: { ...page, content: sanitizeMediaForSync(page.content) },
            project: withoutLocalSyncConflicts(project),
            selectedParentPageId: syncConfig.selectedParentPageId,
          }),
        }, syncConfig);
        if (response.status === 'error') throw new Error(response.message ?? 'Unable to sync this page.');
        if (response.status === 'stale') {
          await persistPage({
            ...(response.page ?? page),
            syncState: 'stale',
            syncMessage: response.message ?? 'Notion changed before this page could be synced. Review it, then resync.',
          });
          continue;
        }
        if (response.page) await persistPage({
          ...response.page,
          syncMode: 'notion',
          syncAccountId: page.syncAccountId,
          syncWorkspaceId: page.syncWorkspaceId,
          content: stripConflictResolutionMarkers(response.page.content),
        });
        await clearStoredPageSyncConflict(pageId);
        await removePendingSyncOps((await listPendingSyncOps())
          .filter((op) => op.pageId === pageId)
          .map((op) => op.opId));
      } catch (error) {
        if (!isUnmappedContentConflict(error) || !error.diff) throw error;
        const currentOps = (await listPendingSyncOps()).filter((op) => op.pageId === pageId);
        if (!currentOps.length) {
          await addPendingSyncOps(buildPageSyncOps({
            page: { ...page, content: sanitizeMediaForSync(page.content) },
            project,
            selectedParentPageId: syncConfig.selectedParentPageId,
          }));
        }
        await blockPendingSyncOps(pageId, {
          code: 'unmapped_notion_content',
          message: error.message,
          diff: error.diff,
        });
        pageConflicts.push({
          targetType: 'page',
          targetId: page.id,
          targetTitle: page.title,
          baseContent: error.diff.baseContent,
          reason: error.diff.reason,
          localChangedBlockIds: error.diff.localChangedBlockIds,
          remoteChangedBlockIds: error.diff.remoteChangedBlockIds,
          localContent: error.diff.localContent,
          remoteContent: error.diff.remoteContent,
        });
        await persistPage({ ...page, syncState: 'error', syncMessage: error.message });
      } finally {
        reconciledPageCount += 1;
        onProgress?.({
          phase: 'syncing_pages',
          completed: reconciledPageCount,
          total: pageIdsToReconcile.size,
        });
      }
    }

    onProgress?.({ phase: 'uploading', pending: await pendingLocalWorkCount() });
    await flushPendingSyncOps({ force: true });
    const queueAfterLocalFlush = await requestServer<SyncQueueStatusResponse>(
      '/sync/status',
      undefined,
      syncConfig,
    );
    failedUploadCount = Math.max(
      failedUploadCount,
      Number.isSafeInteger(queueAfterLocalFlush.failedCount)
        ? Math.max(0, queueAfterLocalFlush.failedCount ?? 0)
        : 0,
    );
    if (queueAfterLocalFlush.hasPending) {
      onProgress?.({
        phase: 'waiting_for_server',
        pending: queueAfterLocalFlush.pendingCount ?? 0,
      });
      failedUploadCount = Math.max(
        failedUploadCount,
        await waitForRemoteSyncQueueToSettle(syncConfig, onProgress, undefined, true),
      );
    }
    const projectEvents = await listPendingProjectSyncEvents();
    const blockedEvents = projectEvents.filter((event) => event.deliveryBlocked);
    const { pages, projects } = await readStorage();
    const projectsById = new Map(projects.map((project) => [project.id, project]));
    const blockIdsByProject = new Map<string, Set<string>>();
    for (const page of pages) {
      if (page.status === 'archived') continue;
      const blockIds = blockIdsByProject.get(page.projectId) ?? new Set<string>();
      collectJottathingBlockIds(page.content, blockIds);
      blockIdsByProject.set(page.projectId, blockIds);
    }
    const conflicts = [...pageConflicts];
    const uniqueBlockedEvents = [...new Map(
      blockedEvents.map((event) => [event.projectId, event]),
    ).values()];
    for (const event of uniqueBlockedEvents) {
      let project = projectsById.get(event.projectId) ??
        (event.type === 'project_source_upsert'
          ? { ...event.payload.project, stateContent: { type: 'doc', content: [event.payload.block] } }
          : event.payload.project);
      const diff = event.deliveryBlocked?.diff;
      if (!diff) continue;

      const liveBlockIds = blockIdsByProject.get(event.projectId) ?? new Set<string>();
      const localState = project.stateContent ?? diff.localContent;
      const localContent = pruneOrphanedProjectStateSources(localState, liveBlockIds);
      const remoteContent = diff.remoteContent
        ? pruneOrphanedProjectStateSources(diff.remoteContent, liveBlockIds)
        : null;
      const baseContent = diff.baseContent
        ? pruneOrphanedProjectStateSources(diff.baseContent, liveBlockIds)
        : null;

      if (localContent !== localState && projectsById.has(event.projectId)) {
        project = { ...project, stateContent: localContent };
        projectsById.set(project.id, project);
        await persistRebasedProjectSnapshots([project]);
      }

      conflicts.push({
        targetType: 'project',
        targetId: event.projectId,
        targetTitle: project.name,
        baseContent,
        reason: diff.reason,
        localChangedBlockIds: diff.localChangedBlockIds,
        remoteChangedBlockIds: diff.remoteChangedBlockIds,
        localContent,
        remoteContent,
      });
    }

    const canReloadRemoteWorkspace =
      !blockedEvents.length &&
      pageConflicts.length === 0 &&
      failedUploadCount === 0 &&
      await pendingLocalWorkCount() === 0;
    if (canReloadRemoteWorkspace) {
      // A manual Sync is also the user's explicit request to reconcile the
      // workspace inventory. Validation signals can miss pages from older or
      // differently-shaped Notion records, so always fetch the full snapshot
      // once local writes and conflict handling are clear.
      await notionClient.reloadFromNotion({ force: true, onProgress });
      reloadedFromNotion = true;
    } else {
      // Keep remote discovery alive until local writes or conflict review no
      // longer make replacing the workspace snapshot unsafe.
      remoteReloadPending = true;
    }

    await persistPageSyncConflicts(pageConflicts);

    return {
      blockedMessage: blockedEvents[0]?.deliveryBlocked?.message,
      blockedProjectCount: new Set(blockedEvents.map((event) => event.projectId)).size,
      conflicts: [...pageConflicts, ...conflicts],
      reloadedFromNotion,
      remoteReloadPending,
      failedUploadCount,
      remainingCount: await pendingLocalWorkCount(),
    };
  },

  async resolveSyncConflict(
    targetType: 'page' | 'project',
    targetId: string,
    content: DocumentContent,
  ): Promise<void> {
    const storage = await readStorage();
    const { projects, syncConfig } = storage;
    if (targetType === 'page') {
      const page = storage.pages.find((entry) => entry.id === targetId);
      const project = page && projects.find((entry) => entry.id === page.projectId);
      if (!page || !project) throw new Error('This page is no longer available.');
      const mergedPage = {
        ...page,
        content: normalizeJottathingBlockIds(content),
        updatedAt: new Date().toISOString(),
        syncState: 'saving' as const,
        syncMessage: undefined,
      };
      const response = await requestServer<SyncPageResponse>('/sync/page/resync', {
        method: 'POST',
        body: JSON.stringify({
          page: {
            ...mergedPage,
            content: sanitizeMediaForSync(stripSyncConflictBlocks(mergedPage.content)),
          },
          project: withoutLocalSyncConflicts(project),
          selectedParentPageId: syncConfig.selectedParentPageId,
        }),
      }, syncConfig);
      if (response.status !== 'saved') {
        throw new Error(response.message ?? 'Unable to sync the merged page. Review the page and try again.');
      }
      await removePendingSyncOps((await listPendingSyncOps())
        .filter((op) => op.pageId === targetId)
        .map((op) => op.opId));
      const syncedPage = response.page ?? mergedPage;
      await persistPage({
        ...syncedPage,
        syncMode: 'notion',
        syncAccountId: page.syncAccountId,
        syncWorkspaceId: page.syncWorkspaceId,
        content: stripConflictResolutionMarkers(stripSyncConflictBlocks(syncedPage.content)),
      });
      await clearStoredPageSyncConflict(targetId);
      return;
    }

    const project = projects.find((entry) => entry.id === targetId);
    if (!project) throw new Error('This project is no longer available.');
    const mergedProject: Project = {
      ...project,
      stateContent: normalizeJottathingBlockIds(content),
      updatedAt: new Date().toISOString(),
      syncState: 'saving',
      syncMessage: undefined,
    };
    const replaced = await resolveBlockedProjectSyncEvent(
      mergedProject,
      async (snapshot) => persistRebasedProjectSnapshots([snapshot]),
      syncConfig.selectedParentPageId,
    );
    if (!replaced) throw new Error('This sync conflict has already been resolved.');
    triggerQueueDelivery();
    try {
      await flushPendingSyncOps({ force: true });
    } catch (error) {
      // Project delivery runs before unrelated page and media queue work. If
      // the reviewed project event was removed, its Notion write succeeded;
      // keep that merge resolved even when a separate queued item failed.
      const remainingEvents = await listPendingProjectSyncEvents();
      if (remainingEvents.some((event) => event.projectId === targetId)) throw error;
    }
    const remainingConflict = (await listPendingProjectSyncEvents())
      .find((event) => event.projectId === targetId && event.deliveryBlocked);
    if (remainingConflict?.deliveryBlocked) {
      throw new Error(remainingConflict.deliveryBlocked.message);
    }
  },

  async prepareLocalWorkspaceForFirstSync(): Promise<boolean> {
    const storage = await readStorage();
    const { syncConfig } = storage;

    if (
      !syncConfig.connected ||
      !syncQueueBelongsToActiveAccount(syncConfig) ||
      storage.notionHydrationSource === hydrationSource(syncConfig) ||
      await pendingLocalWorkCount() === 0
    ) {
      return false;
    }

    const pages = storage.pages.filter((page) => page.syncMode === 'notion').map((page) => ({
      ...page,
      content: normalizeJottathingBlockIds(page.content),
    }));
    if (!pages.length) return false;
    await writeStorage({ pages });

    const notionProjectIds = new Set(pages.map((page) => page.projectId));
    for (const project of storage.projects.filter((candidate) => notionProjectIds.has(candidate.id))) {
      await addPendingProjectSyncEvent(project, syncConfig.selectedParentPageId);
    }

    for (const page of pages) {
      const project = storage.projects.find((candidate) => candidate.id === page.projectId);
      if (!project) continue;
      await addPendingSyncOps(buildPageSyncOps({
        page: { ...page, content: sanitizeMediaForSync(page.content) },
        project,
        selectedParentPageId: syncConfig.selectedParentPageId,
      }));
    }

    // Mark the destination before delivery. If the extension closes midway,
    // startup keeps the local snapshot and resumes the still-durable queue.
    await writeStorage({ notionHydrationSource: hydrationSource(syncConfig) });
    triggerQueueDelivery();
    return true;
  },

  async needsInitialNotionHydration(): Promise<boolean> {
    const { notionHydrationSource, syncConfig } = await readStorage();

    if (
      !syncConfig.connected ||
      !syncQueueBelongsToActiveAccount(syncConfig) ||
      notionHydrationSource === hydrationSource(syncConfig)
    ) {
      return false;
    }

    // Never replace local edits that have not reached the sync server yet. Once
    // the queue drains, a later startup can safely hydrate this workspace.
    return await pendingLocalWorkCount() === 0;
  },

  async listProjects(): Promise<Project[]> {
    await waitForStub();
    const { projects, currentWorkspaceId } = await readStorage();
    return (await projectsWithQueueStatus(projects))
      .filter((project) => project.workspaceId === currentWorkspaceId && project.status !== 'archived')
      .sort(sortProjectsByUpdatedDesc);
  },

  async listWorkspaceProjects(): Promise<Project[]> {
    await waitForStub();
    const { projects } = await readStorage();
    return (await projectsWithQueueStatus(projects))
      .filter((project) => project.status !== 'archived')
      .sort(sortProjectsByUpdatedDesc);
  },

  async listWorkspaces(): Promise<Workspace[]> {
    const { workspaces } = await readStorage();
    return workspaces.sort((first, second) => {
      if (first.kind !== second.kind) return first.kind === 'local' ? -1 : 1;
      return first.createdAt.localeCompare(second.createdAt);
    });
  },

  async getCurrentWorkspaceId(): Promise<string> {
    const { currentWorkspaceId } = await readStorage();
    return currentWorkspaceId;
  },

  async setCurrentWorkspaceId(workspaceId: string): Promise<void> {
    const storage = await readStorage();
    const workspace = storage.workspaces.find((entry) => entry.id === workspaceId);
    if (!workspace) return;
    let projects = storage.projects;
    let pages = storage.pages;
    let activePageIdsByProject = storage.activePageIdsByProject;
    let currentProjectIdByWorkspace = storage.currentProjectIdByWorkspace;
    let selectedProjectId = currentProjectIdByWorkspace[workspaceId];
    if (workspace.kind === 'local' && !projects.some((project) => project.workspaceId === workspaceId)) {
      const project = {
        ...createProjectRecord('Untitled Project'),
        workspaceId,
        syncMode: 'local' as const,
      };
      const page = {
        ...createEmptyPage(project.id, 'Untitled Page'),
        workspaceId,
        syncMode: 'local' as const,
        syncAccountId: workspace.accountId,
      };
      projects = [project, ...projects];
      pages = [...pages, page];
      activePageIdsByProject = { ...activePageIdsByProject, [project.id]: page.id };
      selectedProjectId = project.id;
    }
    const workspaceProjectIds = new Set(projects
      .filter((project) => project.workspaceId === workspaceId && project.status !== 'archived')
      .map((project) => project.id));
    const currentProjectId = selectedProjectId ??
      [...workspaceProjectIds][0] ?? '';
    await writeStorage({
      activePageIdsByProject,
      currentWorkspaceId: workspaceId,
      currentProjectId,
      currentProjectIdByWorkspace: {
        ...currentProjectIdByWorkspace,
        [workspaceId]: currentProjectId,
      },
      pages,
      projects,
    });
  },

  async createLocalWorkspace(name = 'New workspace'): Promise<Workspace> {
    const storage = await readStorage();
    const now = new Date().toISOString();
    const workspace: Workspace = {
      id: `workspace-local-${crypto.randomUUID()}`,
      name: name.trim() || 'New workspace',
      kind: 'local',
      ...(storage.syncConfig.userId ?? storage.syncConfig.syncQueueOwnerUserId
        ? { accountId: storage.syncConfig.userId ?? storage.syncConfig.syncQueueOwnerUserId! }
        : {}),
      createdAt: now,
      updatedAt: now,
    };
    const project = {
      ...createProjectRecord('Untitled Project'),
      workspaceId: workspace.id,
      syncMode: 'local' as const,
    };
    const page = {
      ...createEmptyPage(project.id, 'Untitled Page'),
      workspaceId: workspace.id,
      syncAccountId: workspace.accountId,
      syncMode: 'local' as const,
    };
    await writeStorage({
      activePageIdsByProject: { ...storage.activePageIdsByProject, [project.id]: page.id },
      currentWorkspaceId: workspace.id,
      currentProjectId: project.id,
      currentProjectIdByWorkspace: {
        ...storage.currentProjectIdByWorkspace,
        [workspace.id]: project.id,
      },
      pages: [...storage.pages, page],
      projects: [project, ...storage.projects],
      workspaces: [...storage.workspaces, workspace],
    });
    return workspace;
  },

  async renameLocalWorkspace(workspaceId: string, name: string): Promise<Workspace> {
    const trimmedName = name.trim();
    if (!trimmedName) throw new Error('Enter a workspace name.');

    const storage = await readStorage();
    const workspace = storage.workspaces.find((entry) => entry.id === workspaceId);
    if (!workspace || workspace.kind !== 'local') {
      throw new Error('Only local workspaces can be renamed here.');
    }

    const activeAccountId = storage.syncConfig.userId ?? storage.syncConfig.syncQueueOwnerUserId;
    if (workspace.accountId && activeAccountId && workspace.accountId !== activeAccountId) {
      throw new Error('This workspace belongs to another account.');
    }

    const updatedWorkspace = {
      ...workspace,
      name: trimmedName,
      updatedAt: new Date().toISOString(),
    };
    await writeStorage({
      workspaces: storage.workspaces.map((entry) =>
        entry.id === workspace.id ? updatedWorkspace : entry,
      ),
    });
    return updatedWorkspace;
  },

  async deleteLocalWorkspace(workspaceId: string): Promise<{ workspaceId: string }> {
    const storage = await readStorage();
    const workspace = storage.workspaces.find((entry) => entry.id === workspaceId);
    if (!workspace || workspace.kind !== 'local') {
      throw new Error('Only local workspaces can be deleted here.');
    }
    if (storage.workspaces.filter((entry) => entry.kind === 'local').length <= 1) {
      throw new Error('Keep at least one local workspace.');
    }
    const activeAccountId = storage.syncConfig.userId ?? storage.syncConfig.syncQueueOwnerUserId;
    if (workspace.accountId && activeAccountId && workspace.accountId !== activeAccountId) {
      throw new Error('This workspace belongs to another account.');
    }

    const projectIds = new Set(storage.projects
      .filter((project) => project.workspaceId === workspace.id)
      .map((project) => project.id));
    const removedPageIds = new Set(storage.pages
      .filter((page) => projectIds.has(page.projectId))
      .map((page) => page.id));
    const projects = storage.projects.filter((project) => !projectIds.has(project.id));
    const pages = storage.pages.filter((page) => !removedPageIds.has(page.id));
    const activePageIdsByProject = Object.fromEntries(
      Object.entries(storage.activePageIdsByProject).filter(([projectId]) => !projectIds.has(projectId)),
    );
    const currentProjectIdByWorkspace = { ...storage.currentProjectIdByWorkspace };
    delete currentProjectIdByWorkspace[workspace.id];

    const workspaces = storage.workspaces.filter((entry) => entry.id !== workspace.id);
    const nextWorkspaceId = storage.currentWorkspaceId === workspace.id
      ? workspaces.find((entry) => entry.kind === 'local')?.id ?? workspaces[0]?.id ?? ''
      : storage.currentWorkspaceId;
    const nextWorkspaceProjects = projects.filter((project) =>
      project.workspaceId === nextWorkspaceId && project.status !== 'archived',
    );
    const rememberedProjectId = currentProjectIdByWorkspace[nextWorkspaceId];
    const nextProjectId = nextWorkspaceProjects.some((project) => project.id === rememberedProjectId)
      ? rememberedProjectId!
      : nextWorkspaceProjects[0]?.id ?? '';
    currentProjectIdByWorkspace[nextWorkspaceId] = nextProjectId;

    await writeStorage({
      activePageIdsByProject,
      currentWorkspaceId: nextWorkspaceId,
      currentProjectId: nextWorkspaceId === storage.currentWorkspaceId && workspace.id !== storage.currentWorkspaceId
        ? storage.currentProjectId
        : nextProjectId,
      currentProjectIdByWorkspace,
      pages,
      projects,
      workspaces,
    }, { removeWorkspaceIds: [workspace.id] });
    return { workspaceId: nextWorkspaceId };
  },

  async moveProjectToWorkspace(
    projectId: string,
    destinationWorkspaceId: string,
  ): Promise<{ workspaceId: string }> {
    const storage = await readStorage();
    const project = storage.projects.find((entry) => entry.id === projectId && entry.status !== 'archived');
    const sourceWorkspace = storage.workspaces.find((workspace) => workspace.id === project?.workspaceId);
    const destination = storage.workspaces.find((workspace) => workspace.id === destinationWorkspaceId);
    if (!project || !sourceWorkspace || !destination) {
      throw new Error('The project or destination workspace is no longer available.');
    }
    if (sourceWorkspace.id === destination.id) return { workspaceId: destination.id };

    const { syncConfig } = storage;
    const activeAccountId = syncConfig.userId ?? syncConfig.syncQueueOwnerUserId;
    if (sourceWorkspace.accountId && activeAccountId && sourceWorkspace.accountId !== activeAccountId) {
      throw new Error('This project is locked to another account.');
    }
    if (destination.kind === 'notion') {
      if (!syncConfig.connected || !syncConfig.authenticated || !syncConfig.userId || !syncConfig.workspaceId) {
        throw new Error('Sign in to the Notion account that should own this project.');
      }
      if (
        destination.accountId !== syncConfig.userId ||
        (destination.notionWorkspaceId && destination.notionWorkspaceId !== syncConfig.workspaceId)
      ) {
        throw new Error('This Notion workspace belongs to another account.');
      }
      if (!syncQueueBelongsToActiveAccount(syncConfig)) {
        throw new Error('Local sync work is locked to another Notion account.');
      }
    } else if (destination.accountId && activeAccountId && destination.accountId !== activeAccountId) {
      throw new Error('The destination workspace belongs to another account.');
    }

    const projectPages = storage.pages.filter((page) => page.projectId === project.id);
    if (sourceWorkspace.kind === 'notion') {
      // Archive the remote project before changing its local workspace metadata.
      // The durable project archive event also completes deletion when offline.
      await flushPendingSyncOps({ force: true });
      const archived = touchProject(project, { status: 'archived' as const });
      const archivedResult = await syncProject(archived);
      if (archivedResult?.syncState === 'error') {
        throw new Error(archivedResult.syncMessage ?? 'Unable to remove the project from Notion.');
      }
      const pageIds = new Set(projectPages.map((page) => page.id));
      const pendingPageOps = await listPendingSyncOps();
      await removePendingSyncOps(pendingPageOps
        .filter((operation) => pageIds.has(operation.pageId))
        .map((operation) => operation.opId));
    }

    const movedAt = new Date(Math.max(Date.now(), Date.parse(project.updatedAt) + 1)).toISOString();
    const movedProject: Project = {
      ...project,
      workspaceId: destination.id,
      syncMode: destination.kind,
      status: 'active',
      updatedAt: movedAt,
      syncState: destination.kind === 'notion' ? 'saving' : 'saved',
      syncMessage: undefined,
      stateRemoteRevision: destination.kind === 'local' ? undefined : project.stateRemoteRevision,
    };
    const movedPages = projectPages.map((page) => destination.kind === 'notion'
      ? markPageDirty({
          ...page,
          workspaceId: destination.id,
          syncMode: 'notion',
          syncAccountId: syncConfig.userId,
          syncWorkspaceId: destination.notionWorkspaceId,
        })
      : {
          ...uncachePageNotionMetadata(page),
          workspaceId: destination.id,
          syncMode: 'local' as const,
          syncAccountId: destination.accountId ?? activeAccountId ?? undefined,
          syncWorkspaceId: undefined,
        });
    const movedPageIds = new Set(movedPages.map((page) => page.id));
    const remainingSourceProjects = storage.projects.filter((entry) =>
      entry.workspaceId === sourceWorkspace.id && entry.id !== project.id && entry.status !== 'archived',
    );
    const selectedSourceProjectId = storage.currentProjectIdByWorkspace[sourceWorkspace.id] ??
      (storage.currentWorkspaceId === sourceWorkspace.id ? storage.currentProjectId : '');
    const nextSourceProjectId = remainingSourceProjects.some((entry) =>
      entry.id === selectedSourceProjectId,
    )
      ? selectedSourceProjectId
      : remainingSourceProjects[0]?.id ?? '';
    const selectedDestinationProjectId = storage.currentProjectIdByWorkspace[destination.id];
    const remainingDestinationProjects = storage.projects.filter((entry) =>
      entry.workspaceId === destination.id && entry.id !== project.id && entry.status !== 'archived',
    );
    const destinationProjectId = remainingDestinationProjects.some((entry) =>
      entry.id === selectedDestinationProjectId,
    )
      ? selectedDestinationProjectId
      : project.id;
    const selectedCurrentProjectId = storage.currentProjectIdByWorkspace[storage.currentWorkspaceId] ??
      storage.currentProjectId;
    const movingCurrentProject = selectedCurrentProjectId === project.id;
    const currentProjectIdByWorkspace = {
      ...storage.currentProjectIdByWorkspace,
      [sourceWorkspace.id]: nextSourceProjectId,
      [destination.id]: movingCurrentProject ? project.id : destinationProjectId,
    };
    await writeStorage({
      currentWorkspaceId: movingCurrentProject ? destination.id : storage.currentWorkspaceId,
      currentProjectId: movingCurrentProject ? project.id : storage.currentProjectId,
      currentProjectIdByWorkspace,
      notionHydrationSource: destination.kind === 'notion'
        ? hydrationSource(syncConfig)
        : storage.notionHydrationSource,
      pages: storage.pages.map((page) => movedPageIds.has(page.id)
        ? movedPages.find((movedPage) => movedPage.id === page.id)!
        : page),
      projects: storage.projects.map((entry) => entry.id === project.id ? movedProject : entry),
    });

    if (destination.kind === 'notion') {
      const syncResult = await syncProject(movedProject);
      const syncedProject = {
        ...(syncResult ?? movedProject),
        workspaceId: destination.id,
        syncMode: 'notion' as const,
      };
      const latestStorage = await readStorage();
      if (latestStorage.projects.some((entry) => entry.id === movedProject.id && entry.updatedAt === movedProject.updatedAt)) {
        await writeStorage({
          projects: latestStorage.projects.map((entry) => entry.id === movedProject.id
            ? syncedProject
            : entry),
        });
      }
      for (const page of movedPages) {
        const queuedPage = await enqueuePageSync(page, syncedProject);
        await persistPage(queuedPage);
      }
      await flushPendingSyncOps({ force: true });
    }
    return { workspaceId: destination.id };
  },

  async movePageToProject(
    pageId: string,
    destinationProjectId: string,
    targetPageId?: string,
    position: 'before' | 'after' = 'after',
  ): Promise<ProjectPage> {
    let storage = await readStorage();
    let page = storage.pages.find((entry) => entry.id === pageId && entry.status !== 'archived');
    let sourceProject = storage.projects.find((entry) =>
      entry.id === page?.projectId && entry.status !== 'archived',
    );
    let destinationProject = storage.projects.find((entry) =>
      entry.id === destinationProjectId && entry.status !== 'archived',
    );
    let sourceWorkspace = storage.workspaces.find((entry) => entry.id === sourceProject?.workspaceId);
    let destinationWorkspace = storage.workspaces.find((entry) => entry.id === destinationProject?.workspaceId);
    if (!page || !sourceProject || !destinationProject || !sourceWorkspace || !destinationWorkspace) {
      throw new Error('The page or destination project is no longer available.');
    }
    const initialPage = page;
    const initialSourceProject = sourceProject;
    if (initialSourceProject.id === destinationProject.id) {
      const pagesInOrder = sortProjectPages(storage.pages.filter((entry) =>
        entry.projectId === initialSourceProject.id && entry.status !== 'archived',
      ));
      if (targetPageId === initialPage.id) return initialPage;
      const reorderedPages = pagesInOrder.filter((entry) => entry.id !== initialPage.id);
      const targetIndex = targetPageId
        ? reorderedPages.findIndex((entry) => entry.id === targetPageId)
        : -1;
      const insertionIndex = targetIndex < 0
        ? reorderedPages.length
        : targetIndex + (position === 'after' ? 1 : 0);
      reorderedPages.splice(insertionIndex, 0, initialPage);
      const orderByPageId = new Map<string, number>(
        reorderedPages.map((entry, index) => [entry.id, index] as const),
      );
      const hasChanged = reorderedPages.some((entry, index) =>
        entry.id !== pagesInOrder[index]?.id || entry.pageOrder !== index,
      );
      if (!hasChanged) return initialPage;
      const nextPages = storage.pages.map((entry) => orderByPageId.has(entry.id)
        ? { ...entry, pageOrder: orderByPageId.get(entry.id) }
        : entry);
      await writeStorage({ pages: nextPages });
      return nextPages.find((entry) => entry.id === initialPage.id)!;
    }

    let syncConfig = storage.syncConfig;
    let activeAccountId = syncConfig.userId ?? syncConfig.syncQueueOwnerUserId;
    for (const workspace of [sourceWorkspace, destinationWorkspace]) {
      if (workspace.accountId && activeAccountId && workspace.accountId !== activeAccountId) {
        throw new Error('This workspace is locked to another account.');
      }
    }
    if (
      sourceWorkspace.accountId && destinationWorkspace.accountId &&
      sourceWorkspace.accountId !== destinationWorkspace.accountId
    ) {
      throw new Error('Projects and pages cannot move between different accounts.');
    }
    if (sourceWorkspace.kind === 'notion' || destinationWorkspace.kind === 'notion') {
      if (!syncConfig.connected || !syncConfig.authenticated || !syncConfig.userId || !syncConfig.workspaceId) {
        throw new Error('Sign in to the Notion account that should own this page.');
      }
      if (!syncQueueBelongsToActiveAccount(syncConfig)) {
        throw new Error('Local sync work is locked to another Notion account.');
      }
    }
    for (const workspace of [sourceWorkspace, destinationWorkspace]) {
      if (workspace.kind === 'notion' && (
        workspace.accountId !== syncConfig.userId ||
        (workspace.notionWorkspaceId && workspace.notionWorkspaceId !== syncConfig.workspaceId)
      )) {
        throw new Error('This Notion workspace belongs to another account.');
      }
    }

    if (sourceWorkspace.kind === 'notion') {
      await flushPendingSyncOps({ force: true });
      const latestStorage = await readStorage();
      const latestPage = latestStorage.pages.find((entry) => entry.id === pageId && entry.status !== 'archived');
      const latestSourceProject = latestStorage.projects.find((entry) =>
        entry.id === latestPage?.projectId && entry.status !== 'archived',
      );
      const latestDestinationProject = latestStorage.projects.find((entry) =>
        entry.id === destinationProjectId && entry.status !== 'archived',
      );
      const latestSourceWorkspace = latestStorage.workspaces.find((entry) =>
        entry.id === latestSourceProject?.workspaceId,
      );
      const latestDestinationWorkspace = latestStorage.workspaces.find((entry) =>
        entry.id === latestDestinationProject?.workspaceId,
      );
      if (
        !latestPage || !latestSourceProject || !latestDestinationProject ||
        !latestSourceWorkspace || !latestDestinationWorkspace
      ) {
        throw new Error('The page or destination project is no longer available.');
      }
      storage = latestStorage;
      page = latestPage;
      sourceProject = latestSourceProject;
      destinationProject = latestDestinationProject;
      sourceWorkspace = latestSourceWorkspace;
      destinationWorkspace = latestDestinationWorkspace;
      syncConfig = latestStorage.syncConfig;
      activeAccountId = syncConfig.userId ?? syncConfig.syncQueueOwnerUserId;
      if (!syncConfig.authenticated || !syncQueueBelongsToActiveAccount(syncConfig)) {
        throw new Error('Sign in to the Notion account that should own this page.');
      }
    }

    const movedAt = new Date(Math.max(Date.now(), Date.parse(page.updatedAt) + 1)).toISOString();
    const archivedPage: ProjectPage = {
      ...page,
      status: 'archived',
      updatedAt: movedAt,
      localRevision: crypto.randomUUID(),
      syncMessage: undefined,
      syncState: sourceWorkspace.kind === 'notion' ? 'saving' : 'saved',
    };
    const remainingSourcePages = sortProjectPages(storage.pages.filter((entry) =>
      entry.projectId === sourceProject.id && entry.status !== 'archived' && entry.id !== page.id,
    ));
    const destinationActivePages = sortProjectPages(storage.pages.filter((entry) =>
      entry.projectId === destinationProject.id && entry.status !== 'archived',
    ));
    const targetIndex = targetPageId
      ? destinationActivePages.findIndex((entry) => entry.id === targetPageId)
      : -1;
    const destinationInsertionIndex = targetIndex < 0
      ? destinationActivePages.length
      : targetIndex + (position === 'after' ? 1 : 0);
    const movedPageId = `page-${destinationProject.id}-${crypto.randomUUID()}`;
    const movedPageBase: ProjectPage = {
      ...uncachePageNotionMetadata(page),
      id: movedPageId,
      projectId: destinationProject.id,
      pageOrder: destinationInsertionIndex,
      workspaceId: destinationWorkspace.id,
      status: 'active',
      syncMode: destinationWorkspace.kind,
      syncAccountId: destinationWorkspace.kind === 'notion'
        ? syncConfig.userId
        : destinationWorkspace.accountId ?? activeAccountId ?? undefined,
      syncWorkspaceId: destinationWorkspace.kind === 'notion'
        ? destinationWorkspace.notionWorkspaceId
        : undefined,
      syncBaselineContent: undefined,
      updatedAt: movedAt,
      localRevision: crypto.randomUUID(),
      syncState: destinationWorkspace.kind === 'notion' ? 'saving' : 'saved',
    };
    const movedPage = destinationWorkspace.kind === 'notion'
      ? markPageDirty(movedPageBase)
      : movedPageBase;

    const replacementPage = remainingSourcePages[0] ?? {
      ...createEmptyPage(sourceProject.id, 'Untitled Page'),
      workspaceId: sourceWorkspace.id,
      syncMode: sourceWorkspace.kind,
      syncAccountId: sourceWorkspace.kind === 'notion'
        ? syncConfig.userId
        : sourceWorkspace.accountId ?? activeAccountId ?? undefined,
      syncWorkspaceId: sourceWorkspace.kind === 'notion'
        ? sourceWorkspace.notionWorkspaceId
        : undefined,
    };
    const sourceNeedsReplacement = remainingSourcePages.length === 0;
    const sourcePageIdsInOrder = sourceNeedsReplacement
      ? [replacementPage.id]
      : remainingSourcePages.map((entry) => entry.id);
    const destinationPageIdsInOrder = destinationActivePages.map((entry) => entry.id);
    destinationPageIdsInOrder.splice(destinationInsertionIndex, 0, movedPage.id);
    const pageOrderById = new Map<string, number>();
    sourcePageIdsInOrder.forEach((id, index) => pageOrderById.set(id, index));
    destinationPageIdsInOrder.forEach((id, index) => pageOrderById.set(id, index));
    const orderedMovedPage = { ...movedPage, pageOrder: pageOrderById.get(movedPage.id) };
    const orderedReplacementPage = sourceNeedsReplacement
      ? { ...replacementPage, pageOrder: pageOrderById.get(replacementPage.id) }
      : replacementPage;
    const pagesAfterArchive = storage.pages.map((entry) => {
      if (entry.id === page.id) return archivedPage;
      const pageOrder = pageOrderById.get(entry.id);
      return pageOrder === undefined ? entry : { ...entry, pageOrder };
    });
    const nextPages = [
      ...pagesAfterArchive,
      orderedMovedPage,
      ...(sourceNeedsReplacement ? [orderedReplacementPage] : []),
    ];
    const activePageIdsByProject = { ...storage.activePageIdsByProject };
    const activePageIdForSource = remainingSourcePages.some((entry) =>
      entry.id === activePageIdsByProject[sourceProject.id],
    )
      ? activePageIdsByProject[sourceProject.id]
      : replacementPage.id;
    const destinationRememberedPageId = activePageIdsByProject[destinationProject.id];
    const movingCurrentPage =
      (storage.currentProjectIdByWorkspace[storage.currentWorkspaceId] ?? storage.currentProjectId) === sourceProject.id &&
      activePageIdsByProject[sourceProject.id] === page.id;
    activePageIdsByProject[sourceProject.id] = activePageIdForSource;
    activePageIdsByProject[destinationProject.id] = movingCurrentPage
      ? orderedMovedPage.id
      : destinationActivePages.some((entry) => entry.id === destinationRememberedPageId)
        ? destinationRememberedPageId
        : destinationActivePages[0]?.id ?? orderedMovedPage.id;

    const currentProjectIdByWorkspace = { ...storage.currentProjectIdByWorkspace };
    const sourceWorkspaceProjectId = currentProjectIdByWorkspace[sourceWorkspace.id] ??
      (storage.currentWorkspaceId === sourceWorkspace.id ? storage.currentProjectId : '');
    const sourceWorkspaceProjects = storage.projects.filter((entry) =>
      entry.workspaceId === sourceWorkspace.id && entry.status !== 'archived',
    );
    if (!sourceWorkspaceProjects.some((entry) => entry.id === sourceWorkspaceProjectId)) {
      currentProjectIdByWorkspace[sourceWorkspace.id] = sourceProject.id;
    }
    if (movingCurrentPage) currentProjectIdByWorkspace[destinationWorkspace.id] = destinationProject.id;
    else if (!storage.projects.some((entry) =>
      entry.id === currentProjectIdByWorkspace[destinationWorkspace.id] && entry.status !== 'archived',
    )) currentProjectIdByWorkspace[destinationWorkspace.id] = destinationProject.id;

    await writeStorage({
      activePageIdsByProject,
      currentWorkspaceId: movingCurrentPage ? destinationWorkspace.id : storage.currentWorkspaceId,
      currentProjectId: movingCurrentPage ? destinationProject.id : storage.currentProjectId,
      currentProjectIdByWorkspace,
      pages: nextPages,
    });

    const stalePageOps = (await listPendingSyncOps()).filter((operation) => operation.pageId === page.id);
    await removePendingSyncOps(stalePageOps.map((operation) => operation.opId));
    await clearStoredPageSyncConflict(page.id);

    if (sourceWorkspace.kind === 'notion') {
      await persistPage(await enqueuePageSync(archivedPage, sourceProject, page));
      if (sourceNeedsReplacement) {
        await persistPage(await enqueuePageSync(replacementPage, sourceProject));
      }
    }
    if (destinationWorkspace.kind === 'notion') {
      await persistPage(await enqueuePageSync(orderedMovedPage, destinationProject));
    }

    return orderedMovedPage;
  },

  async getCurrentProjectId(): Promise<string> {
    const { currentProjectId, currentProjectIdByWorkspace, currentWorkspaceId } = await readStorage();
    const selectedProjectId = currentProjectIdByWorkspace[currentWorkspaceId] ?? currentProjectId;
    if (selectedProjectId) return selectedProjectId;
    return currentProjectId;
  },

  async setCurrentProjectId(projectId: string): Promise<void> {
    const selectionRevision = ++currentProjectSelectionRevision;
    requestedCurrentProjectId = projectId;
    const { projects, currentWorkspaceId, currentProjectIdByWorkspace } = await readStorage();

    if (!projects.some((project) => project.id === projectId && project.workspaceId === currentWorkspaceId && project.status !== 'archived')) {
      if (selectionRevision === currentProjectSelectionRevision) {
        requestedCurrentProjectId = undefined;
      }
      return;
    }

    if (selectionRevision !== currentProjectSelectionRevision) return;
    await writeStorage({
      currentProjectId: projectId,
      currentProjectIdByWorkspace: { ...currentProjectIdByWorkspace, [currentWorkspaceId]: projectId },
    });
  },

  async createProject(
    name = 'Untitled Project',
    options: ProjectCreationOptions = {},
  ): Promise<OptimisticProjectCreation> {
    const {
      activePageIdsByProject,
      currentWorkspaceId: storedCurrentWorkspaceId,
      currentProjectId,
      currentProjectIdByWorkspace,
      pages,
      projects,
      syncConfig,
      workspaces,
    } = await readStorage();
    const currentWorkspaceId = options.workspaceId ?? storedCurrentWorkspaceId;
    const workspace = workspaces.find((entry) => entry.id === currentWorkspaceId);
    if (!workspace) throw new Error('Choose a workspace before creating a project.');
    const project = {
      ...createOptimisticProjectRecord(name),
      workspaceId: currentWorkspaceId,
      syncMode: workspace.kind,
    };
    const page = {
      ...createOptimisticPage(project.id, options.pageTitle ?? 'Untitled Page'),
      workspaceId: currentWorkspaceId,
      syncMode: workspace.kind,
      syncAccountId: workspace.accountId ?? syncConfig.userId ?? syncConfig.syncQueueOwnerUserId ?? undefined,
      syncWorkspaceId: workspace.kind === 'notion' ? workspace.notionWorkspaceId : undefined,
      ...(options.pageContent
        ? { content: normalizeJottathingBlockIds(options.pageContent) }
        : {}),
    };

    await writeStorage({
      activePageIdsByProject: {
        ...activePageIdsByProject,
        [project.id]: page.id,
      },
      currentWorkspaceId,
      currentProjectId: project.id,
      currentProjectIdByWorkspace: {
        ...currentProjectIdByWorkspace,
        [currentWorkspaceId]: project.id,
      },
      pages: [...pages, page],
      projects: [...projects, project].sort(sortProjectsByUpdatedDesc),
    });

    const settled = (async () => {
      const realProject = {
        ...createProjectRecord(project.name),
        workspaceId: currentWorkspaceId,
        syncMode: workspace.kind,
      };
      const realPageId = `page-${realProject.id}-${crypto.randomUUID()}`;

      try {
        const pageSnapshot = await latestTempPageSnapshot(page.id, page);
        const realPage = {
          ...pageSnapshot,
          id: realPageId,
          projectId: realProject.id,
          syncState: 'saved' as const,
        };
        // Reconcile temporary IDs before touching the network so the project
        // and its first page remain usable if the request hangs or the panel closes.
        projectIdAliases.set(project.id, realProject.id);
        while (projectIdAliases.size > 100) {
          const oldestProjectId = projectIdAliases.keys().next().value;
          if (!oldestProjectId) break;
          projectIdAliases.delete(oldestProjectId);
        }
        await replaceTempProject({
          tempPage: page,
          tempProject: project,
          realPage,
          realProject,
        });
        const syncedProject = await syncProject(realProject);
        const savedProject = syncedProject ?? realProject;
        const { projects: latestProjects } = await readStorage();
        const latestProject = latestProjects.find(
          (storedProject) => storedProject.id === realProject.id,
        );
        if (latestProject?.updatedAt === realProject.updatedAt) {
          await writeStorage({
            projects: latestProjects.map((storedProject) =>
              storedProject.id === realProject.id ? savedProject : storedProject,
            ),
          });
        }
        const latestRealPage = await latestTempPageSnapshot(page.id, realPage, realPage.id);
        const queuedPage = await enqueuePageSync(latestRealPage, savedProject);
        const persistedPage = await persistSyncedPagePreservingNewerEdit(queuedPage);
        const savedPage = await replayTempPageSave(page.id, persistedPage);
        // A new project and its first page are user-visible immediately. Start
        // an outbox delivery from this live UI context instead of depending on
        // a timer that a suspended extension worker may not run promptly.
        void flushPendingSyncOps({ force: true }).catch(() => undefined);
        return { page: savedPage, project: savedProject };
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'Unable to create this project.';
        projectIdAliases.delete(project.id);
        await rollbackTempProject(project, page, currentProjectId, message);
        throw error;
      } finally {
        projectReconciliations.delete(project.id);
      }
    })();

    const projectReconciliation = settled.then(({ project }) => project.id);
    projectReconciliation.catch(() => undefined);
    projectReconciliations.set(project.id, projectReconciliation);

    return { page, project, settled };
  },

  async renameProject(projectId: string, name: string): Promise<Project> {
    const resolved = await projectForUpdate(projectId);
    requireActiveProject(resolved.projects, resolved.projectId);
    return saveProjectUpdate(resolved.projects, resolved.projectId, {
      name: name.trim() || 'Untitled Project',
    });
  },

  async archiveProject(projectId: string): Promise<{ currentProjectId: string; project: Project }> {
    const {
      activePageIdsByProject,
      currentProjectId,
      currentProjectIdByWorkspace,
      pages,
      projects,
    } = await readStorage();
    const project = requireActiveProject(projects, projectId);
    const activeProjects = projects.filter((storedProject) =>
      storedProject.workspaceId === project.workspaceId && storedProject.status !== 'archived',
    );

    if (activeProjects.length <= 1) {
      throw new Error('Create another project before archiving this one.');
    }

    const archivedProject = touchProject(project, {
      status: 'archived' as const,
    });
    const replacementProject = activeProjects.find(
      (storedProject) => storedProject.id !== projectId,
    );
    const replacementPage = replacementProject
      ? pages.find(
          (page) =>
            page.projectId === replacementProject.id &&
            page.status !== 'archived' &&
            page.id === activePageIdsByProject[replacementProject.id],
        ) ??
        pages.find(
          (page) =>
            page.projectId === replacementProject.id &&
            page.status !== 'archived',
        )
      : undefined;

    await writeStorage({
      currentProjectId: currentProjectId === projectId
        ? replacementProject?.id ?? ''
        : currentProjectId,
      currentProjectIdByWorkspace: {
        ...currentProjectIdByWorkspace,
        [project.workspaceId ?? '']: replacementProject?.id ?? '',
      },
      projects: projects.map((storedProject) =>
        storedProject.id === projectId ? archivedProject : storedProject,
      ),
      activePageIdsByProject: {
        ...activePageIdsByProject,
        ...(replacementProject && replacementPage
          ? { [replacementProject.id]: replacementPage.id }
        : {}),
      },
    });

    const syncedProject = await syncProject(archivedProject);
    const savedProject = syncedProject ?? archivedProject;
    const { projects: latestProjects } = await readStorage();
    const latestProject = latestProjects.find((storedProject) => storedProject.id === projectId);

    if (latestProject?.updatedAt === archivedProject.updatedAt) {
      await writeStorage({
        projects: latestProjects.map((storedProject) =>
          storedProject.id === projectId ? savedProject : storedProject,
        ),
      });
    }

    return {
      currentProjectId: replacementProject?.id ?? '',
      project: savedProject,
    };
  },

  async updateProjectMetadata(
    projectId: string,
    metadata: { category?: string; stateContent?: DocumentContent },
  ): Promise<Project> {
    const resolved = await projectForUpdate(projectId);
    requireActiveProject(resolved.projects, resolved.projectId);
    return saveProjectUpdate(resolved.projects, resolved.projectId, {
      ...(metadata.category !== undefined ? { category: metadata.category.trim() } : {}),
      ...(metadata.stateContent !== undefined ? { stateContent: metadata.stateContent } : {}),
    });
  },

  async addProjectSource(
    projectId: string,
    blockId: string,
    payload: CaptureSelectionPayload,
  ): Promise<Project> {
    const { projects } = await readStorage();
    const project = requireActiveProject(projects, projectId);
    const source = sourcePayloadFromCapture(payload);
    const updatedProject = touchProject(project, {
      stateContent: addSourceToProjectState(
        project.stateContent,
        blockId,
        source,
      ),
    });
    return saveProjectSourceUpdate(projects, projectId, updatedProject, blockId, source);
  },

  async getSyncConfig(): Promise<SyncConfig> {
    const { syncConfig } = await readStorage();
    return { ...syncConfig };
  },

  async assignUnmatchedPendingQueueToCurrentAccount(): Promise<SyncConfig> {
    const { syncConfig } = await readStorage();
    if (!syncConfig.connected || !syncConfig.userId || syncConfig.syncQueueOwnerUserId !== null) {
      throw new Error('These queued changes cannot be assigned to the current Notion account.');
    }
    const nextConfig = await updateStoredSyncConfig({
      syncQueueOwnerUserId: syncConfig.userId,
      syncQueueOwnerWorkspaceId: syncConfig.workspaceId,
    });
    triggerQueueDelivery();
    return nextConfig;
  },

  async updateSyncConfig(config: Partial<SyncConfig>): Promise<SyncConfig> {
    return updateStoredSyncConfig(config);
  },

  async refreshSyncSession(allowSignedOut = false): Promise<SyncConfig> {
    const { hasExplicitlyLoggedOut, syncConfig } = await readStorage();
    const pendingDeletionState = await getBrandedStorageValue<PendingConnectionDeletion>(
      PENDING_CONNECTION_DELETION_KEY,
      LEGACY_PENDING_CONNECTION_DELETION_KEY,
    );
    if (pendingDeletionState) {
      try {
        await notionClient.deleteConnection();
        return (await readStorage()).syncConfig;
      } catch {
        // The explicit deletion request stays available in settings for a safe retry.
        return syncConfig;
      }
    }
    if (!allowSignedOut && hasExplicitlyLoggedOut) {
      return syncConfig;
    }

    const session = await requestServer<SyncSessionResponse>(
      '/session',
      undefined,
      syncConfig,
    );

    const pendingLocalWork = await pendingLocalWorkCount();
    const workspace = await readStorage();
    const hasRetainedLocalData = pendingLocalWork > 0 ||
      Boolean(workspace.notionHydrationSource) ||
      hasRemoteBackedData(workspace.projects, workspace.pages);
    let syncQueueOwnerUserId = syncConfig.syncQueueOwnerUserId;
    let syncQueueOwnerWorkspaceId = syncConfig.syncQueueOwnerWorkspaceId;
    if (session.authenticated && session.userId) {
      const previousQueueOwner = syncConfig.syncQueueOwnerUserId ?? syncConfig.userId;
      const previousWorkspaceOwner = syncConfig.syncQueueOwnerWorkspaceId ??
        syncConfig.workspaceId ?? workspaceFromHydrationSource(workspace.notionHydrationSource);
      const previousQueueScope = previousQueueOwner
        ? `${previousQueueOwner}::${previousWorkspaceOwner ?? 'connected-workspace'}`
        : '';
      const nextQueueScope = `${session.userId}::${session.workspaceId ?? 'connected-workspace'}`;
      if (previousQueueOwner && previousQueueScope !== nextQueueScope) {
        await Promise.allSettled(
          [queueDeliveryPromise, forcedQueueDeliveryPromise].filter(
            (promise): promise is Promise<void> => Boolean(promise),
          ),
        );
        await switchPendingSyncQueueAccount(previousQueueScope, nextQueueScope);
        syncQueueOwnerUserId = session.userId;
        syncQueueOwnerWorkspaceId = session.workspaceId;
      } else if (!hasRetainedLocalData) {
        syncQueueOwnerUserId = session.userId;
        syncQueueOwnerWorkspaceId = session.workspaceId;
      } else if (syncQueueOwnerUserId === undefined) {
        const matchesLegacyAccount = syncConfig.authenticated &&
          syncConfig.userEmail === session.userEmail &&
          (!syncConfig.workspaceId || syncConfig.workspaceId === session.workspaceId);
        if (syncConfig.userId) {
          syncQueueOwnerUserId = syncConfig.userId;
        } else if (matchesLegacyAccount) {
          syncQueueOwnerUserId = session.userId;
        } else if (hasExplicitlyLoggedOut || syncConfig.userEmail || syncConfig.workspaceId) {
          // Older releases cleared account identity on logout. Keep their queued
          // content local until the user explicitly assigns it to this account.
          syncQueueOwnerUserId = null;
        } else {
          // Local-only work created before the first Notion connection belongs
          // to the account the user is connecting now.
          syncQueueOwnerUserId = session.userId;
        }
      }
      if (syncQueueOwnerUserId === null && syncConfig.userId === session.userId) {
        syncQueueOwnerUserId = session.userId;
        syncQueueOwnerWorkspaceId = session.workspaceId;
      }
      if (syncQueueOwnerUserId === session.userId && !syncQueueOwnerWorkspaceId) {
        syncQueueOwnerWorkspaceId = session.workspaceId;
      }
    }

    const nextConfig = await updateStoredSyncConfig({
      authenticated: session.authenticated,
      ...(session.authenticated && session.userId ? { userId: session.userId } : {}),
      ...(session.authenticated && session.userId ? { syncQueueOwnerUserId } : {}),
      ...(session.authenticated && session.userId
        ? { syncQueueOwnerWorkspaceId }
        : {}),
      userName: session.userName,
      userEmail: session.userEmail,
      connected: session.connected,
      workspaceId: session.workspaceId,
      workspaceName: session.workspaceName,
    }, session.authenticated ? { hasExplicitlyLoggedOut: false } : {});

    if (
      session.authenticated && session.userId &&
      !syncConfig.syncQueueOwnerUserId && !syncConfig.userId
    ) {
      const localWorkspace = await readStorage();
      const boundPages = localWorkspace.pages.map((page) => page.syncMode === 'local' && !page.syncAccountId
        ? { ...page, syncAccountId: session.userId }
        : page);
      if (boundPages.some((page, index) => page !== localWorkspace.pages[index])) {
        await writeStorage({ pages: boundPages });
      }
    }

    if (session.connected && syncQueueBelongsToActiveAccount(nextConfig)) {
      triggerQueueDelivery();
    }

    return nextConfig;
  },

  async validateNotionCache(): Promise<{
    stalePageIds: string[];
    aheadPageIds: string[];
    failedPageIds: string[];
    newPageIds: string[];
    workspaceChanged: boolean;
  }> {
    const { pages, projects, syncConfig } = await readStorage();

    if (!syncConfig.connected) {
      return {
        stalePageIds: [],
        aheadPageIds: [],
        failedPageIds: [],
        newPageIds: [],
        workspaceChanged: false,
      };
    }

    if (!syncQueueBelongsToActiveAccount(syncConfig)) {
      throw new Error('Local data is locked to its original Notion account. Reconnect that account to send local documents.');
    }

    const notionPages = pages.filter((page) => page.syncMode === 'notion');
    const notionProjectIds = new Set(notionPages.map((page) => page.projectId));
    const knownVersions: Record<string, number> = {};
    for (const page of notionPages) {
      if (typeof page.knownSyncVersion === 'number') {
        knownVersions[page.id] = page.knownSyncVersion;
      }
    }

    const response = await requestServer<SyncValidationResponse>('/sync/validate', {
      method: 'POST',
      body: JSON.stringify({
        pages: notionPages,
        projects: projects.filter((project) => notionProjectIds.has(project.id)).map(withoutLocalSyncConflicts),
        knownVersions,
        selectedParentPageId: syncConfig.selectedParentPageId,
      }),
    }, syncConfig);
    const uncachedProjectIds = new Set(response.uncachedProjectIds ?? []);
    const uncachedPageIds = new Set(response.uncachedPageIds ?? []);
    const serverVersions = response.serverVersions ?? {};

    const needsWrite = uncachedProjectIds.size || uncachedPageIds.size || response.clearSelectedParentPage || Object.keys(serverVersions).length;

    if (needsWrite) {
      await writeStorage({
        ...(response.clearSelectedParentPage
          ? {
              syncConfig: {
                ...syncConfig,
                selectedParentPageId: undefined,
                selectedParentPageTitle: undefined,
              },
            }
          : {}),
        projects: projects.map((project) =>
          uncachedProjectIds.has(project.id)
            ? {
                ...project,
                stateRemoteRevision: undefined,
                syncMessage: undefined,
                syncState: 'saved' as const,
              }
            : project,
        ),
        pages: pages.map((page) => {
          const withVersion =
            typeof serverVersions[page.id] === 'number'
              ? {
                  ...page,
                  serverSyncVersion: serverVersions[page.id],
                  ...(serverVersions[page.id] <= (page.knownSyncVersion ?? 0)
                    ? { knownSyncVersion: serverVersions[page.id] }
                    : {}),
                }
              : page;
          return uncachedPageIds.has(page.id) ? uncachePageNotionMetadata(withVersion) : withVersion;
        }),
      });
    }

    return {
      stalePageIds: response.stalePageIds ?? [],
      aheadPageIds: response.aheadPageIds ?? [],
      failedPageIds: response.failedPageIds ?? [],
      newPageIds: response.newPageIds ?? [],
      workspaceChanged: response.workspaceChanged ?? false,
    };
  },

  async reloadFromNotion(options: {
    force?: boolean;
    preserveLocalWhenRemoteEmpty?: boolean;
    onProgress?: (progress: SyncProgressUpdate) => void;
  } = {}): Promise<{
    currentProjectId: string;
    pages: ProjectPage[];
    projects: Project[];
    syncConfig: SyncConfig;
  }> {
    const { currentProjectId, pages: localPages, projects: localProjects, syncConfig } = await readStorage();

    if (!syncConfig.connected) {
      throw new Error('Connect Notion before reloading from Notion.');
    }

    const validation = options.force
      ? { stalePageIds: [], aheadPageIds: [], newPageIds: [], workspaceChanged: false }
      : await this.validateNotionCache();
    if (
      !options.force &&
      !validation.stalePageIds.length &&
      !validation.aheadPageIds.length &&
      !validation.newPageIds.length &&
      !validation.workspaceChanged
    ) {
      return {
        currentProjectId,
        pages: localPages,
        projects: localProjects,
        syncConfig,
      };
    }

    await waitForRemoteSyncQueueToSettle(syncConfig, options.onProgress);
    const startingWorkspaceWriteVersion = workspaceWriteVersion;
    const reloadId = options.onProgress ? crypto.randomUUID() : undefined;
    let reloadProgressStream: EventSource | undefined;
    if (reloadId) {
      try {
        reloadProgressStream = connectSyncEvents(syncConfig, (event) => {
          if (event.status !== 'reload_progress' || event.reloadId !== reloadId) return;
          options.onProgress?.({
            phase: 'loading_workspace',
            stage: event.stage,
            completed: event.completed,
            total: event.total,
          });
        });
      } catch {
        // The reload request remains authoritative if progress streaming is unavailable.
      }
    }
    let response: SyncReloadResponse;
    options.onProgress?.({ phase: 'loading_workspace' });
    try {
      response = await requestServer<SyncReloadResponse>('/sync/reload', {
        method: 'POST',
        body: JSON.stringify({
          selectedParentPageId: syncConfig.selectedParentPageId,
          ...(reloadId ? { reloadId } : {}),
        }),
      }, syncConfig);
    } finally {
      reloadProgressStream?.close();
    }
    const nextSyncConfig = response.clearSelectedParentPage
      ? {
          ...syncConfig,
          selectedParentPageId: undefined,
          selectedParentPageTitle: undefined,
        }
      : syncConfig;

    if (options.preserveLocalWhenRemoteEmpty && response.projects.length === 0) {
      await writeStorage({
        notionHydrationSource: hydrationSource(nextSyncConfig),
        syncConfig: nextSyncConfig,
      });
      const latestStorage = await readStorage();
      return {
        currentProjectId: latestStorage.currentProjectId,
        pages: latestStorage.pages,
        projects: latestStorage.projects,
        syncConfig: nextSyncConfig,
      };
    }

    const localStorageToPreserve = await readStorage();
    const notionWorkspaceId = localStorageToPreserve.workspaces.find((workspace) =>
      workspace.kind === 'notion' && workspace.accountId === syncConfig.userId &&
      workspace.notionWorkspaceId === syncConfig.workspaceId,
    )?.id;
    const localConflictsByProjectId = new Map(localStorageToPreserve.projects.map((project) => [
      project.id,
      project.syncConflicts,
    ]));
    const localProjectsById = new Map(localStorageToPreserve.projects.map((project) => [
      project.id,
      project,
    ]));
    const movedBackToLocalProjectIds = new Set(localStorageToPreserve.projects
      .filter((project) => project.syncMode === 'local' && project.status !== 'archived')
      .map((project) => project.id));
    const notionProjects = response.projects.filter((project) =>
      !movedBackToLocalProjectIds.has(project.id),
    ).map((project) => {
      const normalized = normalizeProject(project);
      const localProject = localProjectsById.get(normalized.id);
      const syncConflicts = localConflictsByProjectId.get(normalized.id);
      return {
        ...normalized,
        stateSyncBaselineContent: localProject?.stateSyncBaselineContent ?? normalized.stateContent,
        workspaceId: notionWorkspaceId,
        syncMode: 'notion' as const,
        ...(syncConflicts?.length ? { syncConflicts } : {}),
      };
    }).sort(sortProjectsByUpdatedDesc);
    const localPagesById = new Map(localStorageToPreserve.pages.map((page) => [page.id, page]));
    const notionPages = response.pages.filter((remotePage) =>
      !movedBackToLocalProjectIds.has(remotePage.projectId),
    ).map((remotePage) => {
      const normalized = normalizeStoredPage(
        remotePage,
        'notion',
        syncConfig.userId,
        syncConfig.workspaceId,
      );
      const localPage = localPagesById.get(normalized.id);
      return {
        ...normalized,
        syncBaselineContent: localPage?.syncBaselineContent ?? normalized.content,
        ...(typeof localPage?.pageOrder === 'number' ? { pageOrder: localPage.pageOrder } : {}),
        workspaceId: notionWorkspaceId,
        syncMode: 'notion' as const,
        syncAccountId: syncConfig.userId,
        syncWorkspaceId: syncConfig.workspaceId,
        ...(localPage
          ? {
            content: preserveLocalMediaSources(localPage.content, normalized.content),
            localRevision: localPage.localRevision ?? normalized.localRevision,
          }
          : {}),
      };
    });
    const notionPageIds = new Set(notionPages.map((page) => page.id));
    const localOnlyPages = localStorageToPreserve.pages.filter(
      (page) => page.syncMode === 'local' && !notionPageIds.has(page.id),
    );
    const pages = [...notionPages, ...localOnlyPages];
    const notionProjectIds = new Set(notionProjects.map((project) => project.id));
    const localOnlyProjectIds = new Set(localOnlyPages.map((page) => page.projectId));
    const localOnlyProjects = localStorageToPreserve.projects.filter(
      (project) => localOnlyProjectIds.has(project.id) && !notionProjectIds.has(project.id),
    );
    const activePageIds = new Set(
      pages.filter((page) => page.status !== 'archived').map((page) => page.id),
    );
    const projects = [...notionProjects, ...localOnlyProjects]
      .map((project) => {
        const syncConflicts = project.syncConflicts?.filter((conflict) =>
          conflict.targetType !== 'page' || activePageIds.has(conflict.targetId),
        );
        return {
          ...project,
          ...(syncConflicts?.length ? { syncConflicts } : { syncConflicts: undefined }),
        };
      })
      .sort(sortProjectsByUpdatedDesc);
    const activePageIdsByProject = createCompatibleActivePageIds(
      projects,
      pages,
      {
        ...(response.activePageIdsByProject ?? {}),
        ...localStorageToPreserve.activePageIdsByProject,
      },
    );
    const activeProjects = projects.filter((project) => project.status !== 'archived');
    const nextCurrentProjectId = activeProjects.some(
      (project) => project.id === localStorageToPreserve.currentProjectId,
    )
      ? localStorageToPreserve.currentProjectId
      : activeProjects.some((project) => project.id === response.currentProjectId)
        ? response.currentProjectId ?? ''
        : activeProjects[0]?.id ?? '';
    const localProjectsToPreserve = localStorageToPreserve.projects;
    const reloadedStorage = {
      activePageIdsByProject,
      currentProjectId: nextCurrentProjectId,
      hasMigratedCapturesToPages: true,
      pages,
      projects,
      syncConfig: nextSyncConfig,
      notionHydrationSource: hydrationSource(nextSyncConfig),
    };
    let applied = await writeStorage(reloadedStorage, {
      expectedVersion: startingWorkspaceWriteVersion,
    });
    if (!applied) {
      // A sync progress event can persist only version/status metadata while the
      // snapshot is in flight. Retry that case, but keep a concurrent local edit
      // or account/workspace change authoritative.
      const retryBaseline = workspaceWriteVersion;
      const latestStorage = await readStorage();
      const pendingLocalWork = await pendingLocalWorkCount();
      if (
        workspaceWriteVersion !== retryBaseline ||
        pendingLocalWork > 0 ||
        !hasSameReloadTarget(syncConfig, latestStorage.syncConfig)
      ) {
        return {
          currentProjectId: latestStorage.currentProjectId,
          pages: latestStorage.pages,
          projects: latestStorage.projects,
          syncConfig: latestStorage.syncConfig,
        };
      }

      const retryStorage = {
        ...reloadedStorage,
        activePageIdsByProject: createCompatibleActivePageIds(
          projects,
          pages,
          {
            ...(response.activePageIdsByProject ?? {}),
            ...latestStorage.activePageIdsByProject,
          },
        ),
        currentProjectId: activeProjects.some(
          (project) => project.id === latestStorage.currentProjectId,
        )
          ? latestStorage.currentProjectId
          : nextCurrentProjectId,
        syncConfig: response.clearSelectedParentPage
          ? nextSyncConfig
          : latestStorage.syncConfig,
      };
      applied = await writeStorage(retryStorage, { expectedVersion: retryBaseline });
      if (!applied) {
        const latestAfterRetry = await readStorage();
        return {
          currentProjectId: latestAfterRetry.currentProjectId,
          pages: latestAfterRetry.pages,
          projects: latestAfterRetry.projects,
          syncConfig: latestAfterRetry.syncConfig,
        };
      }
    }
    const blockedProjectIds = new Set(await listBlockedProjectSyncIds());
    const blockedLocalProjects = localProjectsToPreserve.filter((project) => blockedProjectIds.has(project.id));
    if (blockedLocalProjects.length) {
      const blockedIds = new Set(blockedLocalProjects.map((project) => project.id));
      await persistRebasedProjectSnapshots(
        blockedLocalProjects,
        localStorageToPreserve.pages.filter((page) => blockedIds.has(page.projectId)),
      );
    }

    const latestStorage = await readStorage();

    return {
      currentProjectId: latestStorage.currentProjectId,
      pages: latestStorage.pages,
      projects: latestStorage.projects,
      syncConfig: nextSyncConfig,
    };
  },

  async logoutSyncSession(options: {
    cleanupOnly?: boolean;
    onProgress?: (progress: SyncProgressUpdate) => void;
  } = {}): Promise<{
    notionTokenRevoked: boolean;
    queueDrainDeferred: boolean;
    serverDataCleanupComplete: boolean;
    syncConfig: SyncConfig;
  }> {
    isSessionLogoutPending = true;
    if (queueDeliveryTimer) {
      clearTimeout(queueDeliveryTimer);
      queueDeliveryTimer = undefined;
    }

    let serverCleanup = {
      loggedOut: false,
      notionTokenRevoked: false,
      serverDataCleanupComplete: false,
      retryable: true,
    };
    let queueDrainDeferred = Boolean(options.cleanupOnly);
    try {
      const { syncConfig } = await readStorage();

      if (!options.cleanupOnly) {
        if (isBrowserOffline() || !syncConfig.connected) {
          queueDrainDeferred = true;
        } else if (!syncQueueBelongsToActiveAccount(syncConfig)) {
          if (await pendingLocalWorkCount() > 0) {
            throw new Error(
              'Queued changes belong to a different Notion account. Reconnect that account and sync before signing out.',
            );
          }
          queueDrainDeferred = true;
        } else {
          const drainDeadline = Date.now() + REMOTE_QUEUE_SETTLE_TIMEOUT_MS;
          options.onProgress?.({ phase: 'saving_edits' });
          await Promise.allSettled(
            [queueDeliveryPromise, forcedQueueDeliveryPromise].filter(
              (promise): promise is Promise<void> => Boolean(promise),
            ),
          );

          // Repeat the local outbox check after the worker drains. A capture or
          // editor save can arrive while the user is waiting in this dialog.
          while (true) {
            if (isBrowserOffline()) {
              throw new Error(
                'You went offline before sync finished. Your Notion workspace is still connected; reconnect and try signing out again.',
              );
            }
            if (Date.now() >= drainDeadline) {
              throw new Error(
                'Sync is taking longer than expected. Your Notion workspace is still connected; try signing out again after sync finishes.',
              );
            }

            const localPending = await pendingLocalWorkCount();
            options.onProgress?.({ phase: 'uploading', pending: localPending });
            await flushPendingSyncOps({ force: true, allowSessionLogout: true });

            const remainingLocalWork = await pendingLocalWorkCount();
            if (remainingLocalWork > 0) {
              throw new Error(
                'Some queued changes could not be sent. Your Notion workspace is still connected and your local notes are saved; resolve the sync issue, then try again.',
              );
            }

            options.onProgress?.({ phase: 'waiting_for_server', pending: 0 });
            await waitForRemoteSyncQueueToSettle(
              syncConfig,
              options.onProgress,
              Math.max(1, drainDeadline - Date.now()),
            );

            if (isBrowserOffline()) {
              throw new Error(
                'You went offline before Notion finished syncing. Your Notion workspace is still connected; reconnect and try signing out again.',
              );
            }
            if (await pendingLocalWorkCount() === 0) break;
          }
        }
      }

      await scrubLegacyExtensionSyncCredentials();
      await updateStoredSyncConfig({
        authenticated: false,
        userName: undefined,
        userEmail: undefined,
        connected: false,
        logoutCleanupPending: false,
        workspaceId: undefined,
        workspaceName: undefined,
        selectedParentPageId: undefined,
        selectedParentPageTitle: undefined,
        selectedDatabaseId: undefined,
        selectedDatabaseTitle: undefined,
        selectedDataSourceId: undefined,
      }, { hasExplicitlyLoggedOut: true });
      await Promise.allSettled(
        [queueDeliveryPromise, forcedQueueDeliveryPromise].filter(
          (promise): promise is Promise<void> => Boolean(promise),
        ),
      );
      try {
        const response = await requestServer<{
          connected: false;
          loggedOut: boolean;
          notionTokenRevoked: boolean;
          serverDataCleanupComplete: boolean;
          retryable?: boolean;
        }>('/auth/notion/logout', {
          method: 'POST',
          body: JSON.stringify({}),
        }, syncConfig);
        serverCleanup = {
          loggedOut: response.loggedOut,
          notionTokenRevoked: response.notionTokenRevoked,
          serverDataCleanupComplete: response.serverDataCleanupComplete,
          retryable: response.retryable ?? (!response.loggedOut && !response.serverDataCleanupComplete),
        };
      } catch (error) {
        // Keep local sign-out complete while allowing retry if the server kept its session.
        serverCleanup.retryable = !(error instanceof SyncServerError && (
          error.status === 401 || error.status === 403 || error.status === 404
        ));
      }

      const persistedSyncConfig = await updateStoredSyncConfig({
        logoutCleanupPending: serverCleanup.retryable && !serverCleanup.serverDataCleanupComplete,
      }, { hasExplicitlyLoggedOut: true });

      return {
        notionTokenRevoked: serverCleanup.notionTokenRevoked,
        queueDrainDeferred,
        serverDataCleanupComplete: serverCleanup.serverDataCleanupComplete,
        syncConfig: persistedSyncConfig,
      };
    } catch (error) {
      if (error instanceof Error) throw error;
      throw new Error('Unable to clear the local Jottathing account state.');
    } finally {
      isSessionLogoutPending = false;
      void scheduleQueueDeliveryIfNeeded();
    }
  },

  async deleteConnection(): Promise<{ notionTokenRevoked: boolean }> {
    const { syncConfig: storedSyncConfig } = await readStorage();
    let pendingDeletion = await getBrandedStorageValue<PendingConnectionDeletion>(
      PENDING_CONNECTION_DELETION_KEY,
      LEGACY_PENDING_CONNECTION_DELETION_KEY,
    );
    if (pendingDeletion) {
      const isDifferentAuthenticatedConnection = storedSyncConfig.authenticated && (
        cleanSyncServerUrl(storedSyncConfig.serverUrl) !== pendingDeletion.serverUrl ||
        Boolean(pendingDeletion.userId && storedSyncConfig.userId !== pendingDeletion.userId) ||
        Boolean(pendingDeletion.userEmail && storedSyncConfig.userEmail !== pendingDeletion.userEmail) ||
        Boolean(pendingDeletion.workspaceId && storedSyncConfig.workspaceId !== pendingDeletion.workspaceId)
      );
      if (
        !/^[A-Za-z0-9_-]{40,128}$/.test(pendingDeletion.requestId) ||
        isDifferentAuthenticatedConnection
      ) {
        throw new Error('A previous Jottathing deletion is pending for another connection. Reconnect that account to finish it.');
      }
    } else {
      if (!storedSyncConfig.authenticated || !storedSyncConfig.userId) {
        throw new Error('Sign in to the Notion account that owns this Jottathing data before deleting the connection. Your local documents are unchanged.');
      }
      if (
        storedSyncConfig.syncQueueOwnerUserId === null ||
        (storedSyncConfig.syncQueueOwnerUserId &&
          storedSyncConfig.syncQueueOwnerUserId !== storedSyncConfig.userId)
      ) {
        throw new Error('Reconnect the Notion account that owns this local data before deleting the connection. Your local documents are unchanged.');
      }
      pendingDeletion = {
        requestId: `${crypto.randomUUID()}${crypto.randomUUID()}`,
        serverUrl: cleanSyncServerUrl(storedSyncConfig.serverUrl),
        userId: storedSyncConfig.userId,
        ...(storedSyncConfig.userEmail ? { userEmail: storedSyncConfig.userEmail } : {}),
        ...(storedSyncConfig.workspaceId ? { workspaceId: storedSyncConfig.workspaceId } : {}),
      };
      await browser.storage.local.set({
        [PENDING_CONNECTION_DELETION_KEY]: pendingDeletion,
      });
    }
    const syncConfig = {
      ...storedSyncConfig,
      serverUrl: pendingDeletion.serverUrl,
    };
    isConnectionDeletionPending = true;
    if (queueDeliveryTimer) {
      clearTimeout(queueDeliveryTimer);
      queueDeliveryTimer = undefined;
    }

    let serverDeleted = false;
    let localDataCleared = false;
    try {
      const prepared = await browser.runtime.sendMessage({
        type: 'jottathing.prepareConnectionDeletion',
      });
      if (prepared === false) {
        throw new Error('The background service could not pause Jottathing sync before deletion.');
      }
      await pauseIdbWrites();
      await Promise.allSettled(
        [queueDeliveryPromise, forcedQueueDeliveryPromise].filter(
          (promise): promise is Promise<void> => Boolean(promise),
        ),
      );

      const response = await requestServer<{
        deleted: boolean;
        notionTokenRevoked: boolean;
      }>('/auth/notion/delete-connection', {
        method: 'POST',
        body: JSON.stringify({ requestId: pendingDeletion.requestId }),
      }, syncConfig);
      if (!response.deleted) throw new Error('The Jottathing connection could not be deleted.');
      serverDeleted = true;

      await idbClear();
      await browser.storage.local.clear();
      localDataCleared = true;
      queueDeliveryRetryAttempt = 0;
      queueDeliveryRetryDelayMs = 0;
      return { notionTokenRevoked: response.notionTokenRevoked };
    } finally {
      if (!serverDeleted) {
        await resumeIdbWrites();
        void Promise.resolve(browser.runtime.sendMessage({
          type: 'jottathing.abortConnectionDeletion',
        })).catch(() => undefined);
      } else if (localDataCleared) {
        await resumeIdbWrites({ adoptCurrentEpoch: true });
        isConnectionDeletionPending = false;
        void Promise.resolve(browser.runtime.sendMessage({
          type: 'jottathing.completeConnectionDeletion',
        })).catch(() => undefined);
      }
    }
  },

  async listNotionParentPages(query = ''): Promise<NotionParentPage[]> {
    const search = query.trim()
      ? `?query=${encodeURIComponent(query.trim())}`
      : '';
    const response = await requestServer<ListNotionPagesResponse>(
      `/notion/pages${search}`,
    );
    return response.pages;
  },

  async createNotionParentPage(title: string): Promise<NotionParentPage> {
    const response = await requestServer<CreateNotionPageResponse>('/notion/pages', {
      method: 'POST',
      body: JSON.stringify({ title }),
    });
    return response.page;
  },

  async selectNotionParentPage(
    pageId: string,
    title?: string,
  ): Promise<SyncConfig> {
    return updateStoredSyncConfig({
      selectedParentPageId: pageId || undefined,
      selectedParentPageTitle: title,
    });
  },

  async getProjectPage(projectId: string): Promise<ProjectPage | undefined> {
    await waitForStub();
    const { activePageIdsByProject, pages } = await readStorage();
    const activePageId = activePageIdsByProject[projectId];
    const page =
      pages.find((storedPage) => storedPage.id === activePageId && storedPage.status !== 'archived') ??
      pages.find(
        (storedPage) => storedPage.projectId === projectId && storedPage.status !== 'archived',
      );

    if (!page) {
      return undefined;
    }

    return syncAndPersistPage(page);
  },

  async syncProjectPage(pageId: string): Promise<ProjectPage | undefined> {
    const { pages } = await readStorage();
    const page = pages.find((storedPage) => storedPage.id === pageId);

    if (!page || page.status === 'archived') {
      return undefined;
    }

    return syncAndPersistPage(page);
  },

  async prefetchProjectPages(projectId: string, excludePageId?: string): Promise<void> {
    const { pages } = await readStorage();

    for (const page of findActiveProjectPages(pages, projectId, excludePageId)) {
      await syncAndPersistPage(page);
    }
  },

  async listProjectPages(projectId: string): Promise<ProjectPage[]> {
    await waitForStub();
    const { pages } = await readStorage();
    return sortProjectPages(pages.filter((page) =>
      page.projectId === projectId && page.status !== 'archived',
    ));
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

  async createProjectPage(
    projectId: string,
    title = 'Untitled Page',
  ): Promise<OptimisticPageCreation> {
    const requestedProjectId = projectId;
    let storage = await readStorage();
    let project = storage.projects.find((storedProject) => storedProject.id === projectId);
    const inFlightReconciliation = projectReconciliations.get(requestedProjectId);

    // The project record is switched from its temporary ID before the store's
    // async callback updates the UI selection. Follow that exact temporary to
    // real ID mapping instead of flashing a "not ready" error in this window.
    if (
      !project &&
      (inFlightReconciliation || projectIdAliases.has(requestedProjectId))
    ) {
      const mappedProjectId = projectIdAliases.get(requestedProjectId)
        ?? await inFlightReconciliation;
      project = storage.projects.find((storedProject) => storedProject.id === mappedProjectId);
      if (!project && inFlightReconciliation) {
        await inFlightReconciliation;
        storage = await readStorage();
        project = storage.projects.find((storedProject) => storedProject.id === mappedProjectId);
      }
      if (project) projectId = project.id;
    }

    if (!project) {
      throw new Error('This project is no longer available.');
    }

    const {
      projects,
      syncConfig,
      workspaces,
    } = storage;
    const workspace = workspaces.find((entry) => entry.id === project.workspaceId);
    const syncMode: 'notion' | 'local' = workspace?.kind === 'notion' || project.syncMode === 'notion'
      ? 'notion'
      : workspace?.kind ?? 'local';
    const page = await appendPageAtomically({
      ...createOptimisticPage(projectId, title.trim() || 'Untitled Page'),
      pageOrder: 0,
      workspaceId: project.workspaceId,
      syncMode,
      syncAccountId: syncConfig.userId ?? syncConfig.syncQueueOwnerUserId ?? undefined,
      syncWorkspaceId: syncMode === 'notion'
        ? workspace?.kind === 'notion'
          ? workspace.notionWorkspaceId
          : syncConfig.workspaceId
        : undefined,
    });

    const settled = (async () => {
      try {
        const { projects: latestProjects } = await readStorage();
        const currentProject = latestProjects.find((storedProject) =>
          storedProject.id === projectId,
        );
        if (!inFlightReconciliation && isTempProject(currentProject)) {
          const recoveredPage = await recoverOrphanedTemporaryProject(projectId);
          void flushPendingSyncOps({ force: true }).catch(() => undefined);
          return recoveredPage;
        }
        const realProjectId = inFlightReconciliation
          ? await inFlightReconciliation
          : projectId;
        const { projects: reconciledProjects } = await readStorage();
        const realProject = reconciledProjects.find(
          (storedProject) => storedProject.id === realProjectId,
        );

        if (!realProject || isTempProject(realProject)) {
          throw new Error('This project is not ready to sync pages yet.');
        }

        const pageSnapshot = await latestTempPageSnapshot(page.id, page);
        const realPage = markPageDirty({
          ...pageSnapshot,
          id: `page-${realProject.id}-${crypto.randomUUID()}`,
          projectId: realProject.id,
          syncState: 'saving',
        });
        const syncedPage = await enqueuePageSync(realPage, realProject);

        await replaceTempPage(page, syncedPage);
        const savedPage = await replayTempPageSave(page.id, syncedPage);
        void flushPendingSyncOps({ force: true }).catch(() => undefined);
        return savedPage;
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'Unable to create this page.';
        // Keep the optimistic page and its edits when project reconciliation or
        // sync setup fails. Removing it here could discard content typed while
        // the page's worker request was still pending.
        const latestStorage = await readStorage();
        const retainedPage = latestStorage.pages.find((candidate) => candidate.id === page.id)
          ?? latestStorage.pages.find((candidate) =>
            candidate.id === latestStorage.activePageIdsByProject[projectId],
          );
        if (!retainedPage) throw error;
        const retained = withSyncStatus(
          retainedPage,
          'stale',
          `Saved locally. ${message} Sync will retry when the project is ready.`,
        );
        await persistPage(retained);
        return retained;
      }
    })();

    return { page, settled };
  },

  async renameProjectPage(pageId: string, title: string) {
    const { pages, projects, page, project } = await requirePageWithProject(pageId);

    const updatedPage = markPageDirty({
      ...page,
      title: title.trim() || 'Untitled Page',
    });

    if (isTempPage(updatedPage) || isTempProject(project)) {
      await writeStorage({
        pages: pages.map((storedPage) =>
          storedPage.id === updatedPage.id ? updatedPage : storedPage,
        ),
      });
      pendingTempPageSaves.set(updatedPage.id, updatedPage);
      return updatedPage;
    }

    const syncedPage = await enqueuePageSync(updatedPage, project, page);
    await persistPage(syncedPage);
    void flushPendingSyncOps({ force: true }).catch(() => undefined);

    return syncedPage;
  },

  async archiveProjectPage(pageId: string): Promise<ProjectPage> {
    const { activePageIdsByProject, pages, projects, page, project } = await requirePageWithProject(pageId);
    pageId = page.id;

    const archivedPage = markPageDirty({
      ...page,
      status: 'archived' as const,
    });
    const pagesAfterArchive = pages.map((storedPage) =>
      storedPage.id === archivedPage.id ? archivedPage : storedPage,
    );
    const replacementPage =
      pagesAfterArchive.find(
        (storedPage) =>
          storedPage.projectId === page.projectId && storedPage.status !== 'archived',
      ) ?? {
        ...createEmptyPage(page.projectId, 'Untitled Page'),
        workspaceId: page.workspaceId,
        syncMode: page.syncMode ?? project.syncMode ?? 'local',
        syncAccountId: page.syncAccountId,
        syncWorkspaceId: page.syncWorkspaceId,
      };
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

    // Archiving is an explicit discard of this page's pending edit state.
    // Remove its blocked mutations and review entry before queuing the archive,
    // so the obsolete conflict cannot keep the page in the merge list or block
    // the archive operation itself.
    const pendingPageOps = (await listPendingSyncOps())
      .filter((operation) => operation.pageId === pageId);
    await removePendingSyncOps(pendingPageOps.map((operation) => operation.opId));
    await clearStoredPageSyncConflict(pageId);

    if (!isTempPage(archivedPage) && !isTempProject(project)) {
      const syncedArchivedPage = await enqueuePageSync(archivedPage, project, page);

      if (syncedArchivedPage.syncState === 'error') {
        throw new Error(syncedArchivedPage.syncMessage ?? 'Unable to archive this page in Notion.');
      }
      if (replacementPage.syncMode === 'notion') {
        await persistPage(await enqueuePageSync(replacementPage, project));
      }
    }

    return replacementPage;
  },

  async updateProjectPage(page: ProjectPage): Promise<ProjectPage> {
    const { pages, projects, syncConfig, workspaces } = await readStorage();
    const resolvedPageId = pageIdAliases.get(page.id) ?? page.id;
    const resolvedProjectId = projectIdAliases.get(page.projectId) ?? page.projectId;
    const project = projects.find((storedProject) => storedProject.id === resolvedProjectId)
      ?? projects.find((storedProject) => storedProject.id === page.projectId);

    if (!project) {
      throw new Error('This project is no longer available.');
    }

    const previousPage = pages.find((storedPage) => storedPage.id === resolvedPageId)
      ?? pages.find((storedPage) => storedPage.id === page.id);
    const workspace = workspaces.find((entry) => entry.id === project.workspaceId);
    const syncMode = workspace?.kind ?? project.syncMode ?? 'local';
    const isAlreadySynced = syncMode === 'notion';
    const updatedPage = markPageDirty({
      ...previousPage,
      ...page,
      id: resolvedPageId,
      projectId: project.id,
      workspaceId: project.workspaceId,
      syncMode,
      syncAccountId: isAlreadySynced
        ? workspace?.accountId ?? previousPage?.syncAccountId
        : workspace?.accountId ?? page.syncAccountId ?? syncConfig.userId ?? syncConfig.syncQueueOwnerUserId ?? undefined,
      syncWorkspaceId: isAlreadySynced
        ? workspace?.notionWorkspaceId ?? previousPage?.syncWorkspaceId
        : undefined,
      content: normalizeJottathingBlockIds(
        previousPage
          ? mergeUploadedMediaAttributes(page.content, previousPage.content)
          : page.content,
      ),
    });

    await persistPagesById([updatedPage]);

    if (isTempPage(updatedPage) || isTempProject(project)) {
      pendingTempPageSaves.set(updatedPage.id, updatedPage);
      return updatedPage;
    }

    const syncedPage = await enqueuePageSync(updatedPage, project, previousPage);
    await persistPage(syncedPage);
    void flushPendingSyncOps({ force: true }).catch(() => undefined);
    return syncedPage;
  },

  async appendCaptureToCurrentPage(
    payload: CaptureSelectionPayload,
  ): Promise<ProjectPage> {
    const { activePageIdsByProject, currentProjectId, pages, projects } =
      await readStorage();
    const projectId = currentProjectId || projects[0]?.id;
    const project = projects.find((storedProject) => storedProject.id === projectId);
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

    if (!page || !project) {
      throw new Error('No Jottathing page is available for this capture.');
    }

    const capturedContent = createCapturedContent(payload);
    const sourceBlockId = capturedBlockId(capturedContent);
    const updatedProject = sourceBlockId
      ? touchProject(project, {
          stateContent: addSourceToProjectState(
            project.stateContent,
            sourceBlockId,
            sourcePayloadFromCapture(payload),
          ),
        })
      : project;
    const savedProject = sourceBlockId
      && page.syncMode === 'notion'
      ? (await saveProjectSourceUpdate(
          projects,
          project.id,
          updatedProject,
          sourceBlockId,
          sourcePayloadFromCapture(payload),
        ))
      : project;
    const updatedPage = appendContent(page, capturedContent);

    await persistPagesById([updatedPage]);

    const syncedPage = await enqueuePageSync(updatedPage, savedProject, page);
    await persistPage(syncedPage);
    void flushPendingSyncOps({ force: true }).catch(() => undefined);
    return syncedPage;
  },

  async uploadMedia(blob: Blob, mimeType: string, filename: string): Promise<string> {
    const { syncConfig } = await readStorage();
    if (!syncConfig.connected || isBrowserOffline()) {
      throw new Error(
        syncConfig.connected
          ? 'Reconnect before uploading media.'
          : 'Connect Notion before uploading media.',
      );
    }

    return uploadMediaBlob(blob, mimeType, filename, syncConfig);
  },

  async refreshMediaUrl(fileUploadId?: string, notionBlockId?: string): Promise<string> {
    if (!fileUploadId && !notionBlockId) {
      throw new Error('Missing Notion media identity.');
    }

    const response = await requestServer<MediaRefreshResponse>('/media/refresh', {
      method: 'POST',
      body: JSON.stringify({ fileUploadId, notionBlockId }),
    });

    if (!response.url) {
      throw new Error('The sync server did not return a media URL.');
    }

    return response.url;
  },
};
