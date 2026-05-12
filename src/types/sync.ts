import type {
  DocumentContent,
  NotionParentPage,
  Project,
  ProjectPage,
  SaveStatus,
} from './capture.js';

export type SyncStatus = Exclude<SaveStatus, 'idle' | 'saving'>;

export type SyncSessionResponse = {
  authenticated?: boolean;
  userName?: string;
  userEmail?: string;
  connected: boolean;
  workspaceId?: string;
  workspaceName?: string;
};

export type ListNotionPagesResponse = {
  pages: NotionParentPage[];
};

export type CreateNotionPageRequest = {
  title?: string;
};

export type CreateNotionPageResponse = {
  page: NotionParentPage;
};

export type SyncPageRequest = {
  page?: ProjectPage;
  project?: Project;
  ops?: SyncBlockOperation[];
  selectedParentPageId?: string;
  defaultParentTitle?: string;
};

export type SyncBlockOperationType =
  | 'page_upsert'
  | 'page_archive'
  | 'block_create'
  | 'block_update'
  | 'block_delete'
  | 'block_reorder';

export type SyncBlockOperation = {
  opId: string;
  type: SyncBlockOperationType;
  pageId: string;
  projectId: string;
  jotBlockId?: string;
  sequence: number;
  createdAt: string;
  baseKnownSyncVersion?: number;
  payload: {
    page: ProjectPage;
    project: Project;
    block?: DocumentContent;
    previousBlock?: DocumentContent;
    order?: string[];
    selectedParentPageId?: string;
  };
};

export type SyncPageResponse = {
  message?: string;
  page?: ProjectPage;
  parentPage?: NotionParentPage;
  status: SyncStatus;
};

export type SyncProjectRequest = {
  project?: Project;
  selectedParentPageId?: string;
};

export type SyncProjectResponse = {
  message?: string;
  parentPage?: NotionParentPage;
  project?: Project;
  status: SyncStatus;
};

export type SyncValidationRequest = {
  pages?: ProjectPage[];
  projects?: Project[];
  knownVersions?: Record<string, number>;
};

export type SyncValidationResponse = {
  clearSelectedParentPage?: boolean;
  uncachedPageIds?: string[];
  uncachedProjectIds?: string[];
  stalePageIds?: string[];
  aheadPageIds?: string[];
  serverVersions?: Record<string, number>;
};

export type SyncReloadRequest = {
  selectedParentPageId?: string;
};

export type SyncReloadResponse = {
  activePageIdsByProject: Record<string, string>;
  clearSelectedParentPage?: boolean;
  currentProjectId?: string;
  pages: ProjectPage[];
  projects: Project[];
  status: SyncStatus;
};

export type MediaUploadRequest = {
  dataBase64?: string;
  mimeType?: string;
  filename?: string;
};

export type MediaUploadResponse = {
  fileUploadId: string;
};

export type MediaRefreshRequest = {
  fileUploadId?: string;
};

export type MediaRefreshResponse = {
  url?: string;
};

export type SyncErrorResponse = {
  error?: string;
  message?: string;
};

export type SyncEnqueueResponse = {
  queued: true;
  version?: number;
  versions?: Record<string, number>;
  opVersions?: Record<string, number>;
};

export type SyncStatusResponse = {
  status: 'pending' | 'syncing' | 'synced' | 'failed' | 'conflict';
  localVersion?: number;
  syncedVersion?: number;
  notionBlockId?: string | null;
};

export type SyncEventMessage =
  | { status: 'synced'; pageId: string; notionBlockId?: string | null; version?: number }
  | { status: 'failed'; pageId: string }
  | { status: 'stale'; pageId: string; version?: number };
