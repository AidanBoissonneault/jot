import type {
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
  selectedParentPageId?: string;
  defaultParentTitle?: string;
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
};

export type SyncValidationResponse = {
  clearSelectedParentPage?: boolean;
  uncachedPageIds?: string[];
  uncachedProjectIds?: string[];
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

export type SyncErrorResponse = {
  error?: string;
  message?: string;
};
