/**
 * @file Defines API request, response, queue operation, and event contracts for Notion synchronization.
 * @author Aidan Boissonneault
 * @lastModified September 2026
 */

import type {
  DocumentContent,
  NotionParentPage,
  Project,
  ProjectPage,
  SaveStatus,
} from './capture.js';

/** Represents a synchronization outcome visible to the client. */
export type SyncStatus = Exclude<SaveStatus, 'idle' | 'saving'>;

/** Describes the current authentication and Notion connection state. */
export type SyncSessionResponse = {
  authenticated?: boolean;
  userName?: string;
  userEmail?: string;
  connected: boolean;
  workspaceId?: string;
  workspaceName?: string;
};

/** Describes selectable Notion parent pages returned by the API. */
export type ListNotionPagesResponse = {
  pages: NotionParentPage[];
};

/** Describes the payload used to create a Notion workspace page. */
export type CreateNotionPageRequest = {
  title?: string;
};

/** Describes the created selectable Notion page. */
export type CreateNotionPageResponse = {
  page: NotionParentPage;
};

/** Describes a full-page snapshot or incremental operations submitted for synchronization. */
export type SyncPageRequest = {
  page?: ProjectPage;
  project?: Project;
  ops?: SyncBlockOperation[];
  selectedParentPageId?: string;
  defaultParentTitle?: string;
};

/** Describes the supported incremental page and block mutation kinds. */
export type SyncBlockOperationType =
  | 'page_upsert'
  | 'page_archive'
  | 'blocks_reset'
  | 'block_create'
  | 'block_update'
  | 'block_delete'
  | 'block_reorder';

/** Describes one durable local mutation with ordering and page context. */
export type SyncBlockOperation = {
  opId: string;
  type: SyncBlockOperationType;
  pageId: string;
  projectId: string;
  inkwellBlockId?: string;
  sequence: number;
  createdAt: string;
  localVersion: number;
  baseKnownSyncVersion?: number;
  deliveryBlocked?: SyncBlockDeliveryConflict;
  payload: {
    // content/stateContent remain optional for compatibility with queues made
    // by older extension versions. New operations only carry small metadata.
    page: Omit<ProjectPage, 'content'> & { content?: DocumentContent };
    project: Omit<Project, 'stateContent'> & { stateContent?: DocumentContent };
    block?: DocumentContent;
    previousBlock?: DocumentContent;
    order?: string[];
    index?: number;
    afterInkwellBlockId?: string;
    replaceAll?: boolean;
    selectedParentPageId?: string;
  };
};

/** Describes the result of pushing or pulling one page. */
export type SyncPageResponse = {
  code?: string;
  diff?: SyncConflictDiff;
  message?: string;
  page?: ProjectPage;
  parentPage?: NotionParentPage;
  status: SyncStatus;
};

/** Describes a project snapshot submitted for synchronization. */
export type SyncProjectRequest = {
  project?: Project;
  selectedParentPageId?: string;
};

/** Describes one project-state source block submitted for synchronization. */
export type SyncProjectSourceRequest = {
  project?: Omit<Project, 'stateContent'>;
  blockId?: string;
  block?: DocumentContent;
  selectedParentPageId?: string;
};

/** Describes the result of synchronizing project metadata. */
export type SyncProjectResponse = {
  code?: string;
  diff?: SyncConflictDiff;
  message?: string;
  parentPage?: NotionParentPage;
  project?: Project;
  status: SyncStatus;
};

/** Carries the local and remote documents shown when content matching cannot resolve a sync. */
export type SyncConflictDiff = {
  /** Last shared version of mapped blocks, used to detect edits on both sides. */
  baseContent?: DocumentContent | null;
  localChangedBlockIds?: string[];
  remoteChangedBlockIds?: string[];
  localContent: DocumentContent;
  remoteContent: DocumentContent | null;
};

/** Stops automatic retries for a page until the user resolves its content conflict. */
export type SyncBlockDeliveryConflict = {
  code: 'unmapped_notion_content';
  message: string;
  diff?: SyncConflictDiff;
};

/** Identifies the page or project whose local and remote blocks need a merge. */
export type SyncContentConflict = {
  targetType: 'page' | 'project';
  targetId: string;
  targetTitle: string;
  baseContent?: DocumentContent | null;
  localChangedBlockIds?: string[];
  remoteChangedBlockIds?: string[];
  localContent: DocumentContent;
  remoteContent: DocumentContent | null;
};

/** Describes client entities and known versions submitted for validation. */
export type SyncValidationRequest = {
  pages?: ProjectPage[];
  projects?: Project[];
  knownVersions?: Record<string, number>;
};

/** Describes cache and version differences discovered during validation. */
export type SyncValidationResponse = {
  clearSelectedParentPage?: boolean;
  uncachedPageIds?: string[];
  uncachedProjectIds?: string[];
  failedPageIds?: string[];
  stalePageIds?: string[];
  aheadPageIds?: string[];
  serverVersions?: Record<string, number>;
};

/** Describes the parent selection used while reloading remote state. */
export type SyncReloadRequest = {
  selectedParentPageId?: string;
};

/** Describes projects and pages rebuilt from remote Notion state. */
export type SyncReloadResponse = {
  activePageIdsByProject: Record<string, string>;
  clearSelectedParentPage?: boolean;
  currentProjectId?: string;
  pages: ProjectPage[];
  projects: Project[];
  status: SyncStatus;
};

/** Describes base64 media and metadata submitted for upload. */
export type MediaUploadRequest = {
  dataBase64?: string;
  mimeType?: string;
  filename?: string;
};

/** Describes the Notion file-upload identifier returned after upload. */
export type MediaUploadResponse = {
  fileUploadId: string;
};

/** Describes the upload or block identity used to refresh signed media. */
export type MediaRefreshRequest = {
  fileUploadId?: string;
  notionBlockId?: string;
};

/** Describes a refreshed signed media URL. */
export type MediaRefreshResponse = {
  url?: string;
};


/** Describes server versions assigned to newly queued work. */
export type SyncEnqueueResponse = {
  queued: true;
  version?: number;
  versions?: Record<string, number>;
  opVersions?: Record<string, number>;
};


/** Describes a real-time synchronization status notification. */
export type SyncEventMessage =
  | { status: 'synced'; pageId: string; notionBlockId?: string | null; version?: number }
  | { status: 'failed'; pageId: string; code?: string; message?: string; statusCode?: number }
  | { status: 'stale'; pageId: string; version?: number };
