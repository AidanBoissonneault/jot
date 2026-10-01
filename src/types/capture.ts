/**
 * @file Defines capture, page, project, and Notion parent contracts shared by the application and API.
 * @author Aidan Boissonneault
 * @lastModified September 2026
*/

import type { SyncContentConflict } from './sync.js';

/** Identifies the semantic kind of a captured item. */
export type CaptureType = 'quote' | 'task' | 'idea' | 'link';
/** Describes the lifecycle states used while a local save is pending. */
export type OptimisticStatus = 'creating' | 'saving' | 'saved' | 'stale' | 'error';
/** Describes all idle, optimistic, and terminal save states. */
export type SaveStatus = 'idle' | OptimisticStatus;

/** Describes source location and semantic metadata for captured text. */
export type HighlightMeta = {
  text: string;
  sourceLink?: string;
  xpath?: string;
  offset?: number;
  prefix?: string;
  suffix?: string;
  isHeading?: boolean;
  headingLevel?: 1 | 2 | 3 | 4 | 5 | 6;
  isCodeBlock?: boolean;
  codeLanguage?: string;
};

/** Describes one captured item stored inside a page. */
export type Capture = {
  id: string;
  projectId: string;
  type: CaptureType;
  content: string;
  note?: string;
  sourceUrl: string;
  pageTitle: string;
  highlightMeta?: HighlightMeta;
  createdAt: string;
};

/** Describes a local project and its synchronized project-level state. */
export type Project = {
  id: string;
  name: string;
  status: 'active' | 'archived';
  category?: string;
  createdAt: string;
  updatedAt: string;
  stateContent: DocumentContent;
  /** Page merge reviews retained locally until the user resolves them. */
  syncConflicts?: SyncContentConflict[];
  stateRemoteRevision?: string;
  tags: string[];
  syncMessage?: string;
  syncState?: OptimisticStatus;
};

/** Describes a serializable Tiptap document node. */
export type DocumentContent = {
  type?: string;
  attrs?: Record<string, unknown>;
  content?: DocumentContent[];
  marks?: Array<{
    type: string;
    attrs?: Record<string, unknown>;
  }>;
  text?: string;
};

/** Describes a local page plus its Notion synchronization metadata. */
export type ProjectPage = {
  id: string;
  projectId: string;
  kind?: 'page' | 'project';
  title: string;
  status?: 'active' | 'archived';
  content: DocumentContent;
  createdAt: string;
  updatedAt: string;
  notionPageId?: string;
  notionDatabaseId?: string;
  notionDataSourceId?: string;
  notionParentPageId?: string;
  notionLastEditedTime?: string;
  localRevision?: string;
  localSyncVersion?: number;
  remoteRevision?: string;
  knownSyncVersion?: number;
  serverSyncVersion?: number;
  syncMessage?: string;
  syncState?: SaveStatus;
};


/** Describes persisted client configuration for Notion synchronization. */
export type SyncConfig = {
  serverUrl: string;
  authenticated?: boolean;
  /** Current server-authenticated Inkwell account identifier. */
  userId?: string;
  /** Account that owns local documents and sync work; null means legacy data needs explicit assignment. */
  syncQueueOwnerUserId?: string | null;
  userName?: string;
  userEmail?: string;
  workspaceId?: string;
  workspaceName?: string;
  /** The server is finishing a logout and still accepts a logout retry. */
  logoutCleanupPending?: boolean;
  selectedDatabaseId?: string;
  selectedDatabaseTitle?: string;
  selectedDataSourceId?: string;
  selectedParentPageId?: string;
  selectedParentPageTitle?: string;
  connected: boolean;
};

/** Describes a concise selectable or synchronized Notion parent page. */
export type NotionParentPage = {
  id: string;
  parentPageId?: string;
  title: string;
  url?: string;
};
/**
 * @file Defines shared capture, project, page, editor-document, and synchronization models.
 * @author Aidan Boissonneault
 * @lastModified September 2026
 */
