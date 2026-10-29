/**
 * @file Defines capture, page, project, and Notion parent contracts shared by the application and API.
 * @author Aidan Boissonneault
 * @lastModified September 2026
*/

import type { SyncContentConflict } from './sync.js';

/** Describes the lifecycle states used while a local save is pending. */
export type OptimisticStatus = 'creating' | 'saving' | 'saved' | 'stale' | 'error';
/** Describes all idle, optimistic, and terminal save states. */
export type SaveStatus = 'idle' | OptimisticStatus;

/** Describes a project and its workspace-derived synchronization state. */
export type Project = {
  id: string;
  name: string;
  /** Workspace that contains this project. */
  workspaceId?: string;
  /** Kept aligned with the containing workspace for existing sync operations. */
  syncMode?: 'local' | 'notion';
  status: 'active' | 'archived';
  category?: string;
  createdAt: string;
  updatedAt: string;
  stateContent: DocumentContent;
  /** Last synced project-state snapshot, retained in local IndexedDB for three-way merges. */
  stateSyncBaselineContent?: DocumentContent;
  /** Page merge reviews retained locally until the user resolves them. */
  syncConflicts?: SyncContentConflict[];
  stateRemoteRevision?: string;
  tags: string[];
  syncMessage?: string;
  syncState?: SaveStatus;
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

/** Describes a page plus its workspace-derived Notion synchronization metadata. */
export type ProjectPage = {
  id: string;
  projectId: string;
  /** Workspace that contains this page; kept aligned with its project. */
  workspaceId?: string;
  kind?: 'page' | 'project';
  title: string;
  status?: 'active' | 'archived';
  content: DocumentContent;
  /** Last synced page snapshot, retained locally while edits are made offline. */
  syncBaselineContent?: DocumentContent;
  /** Local ordering within the page list for this project. */
  pageOrder?: number;
  createdAt: string;
  updatedAt: string;
  notionPageId?: string;
  /** Inherited from its workspace; all pages in a project share the same mode. */
  syncMode?: 'local' | 'notion';
  /** Account that owns this page's local copy. Notion pages are bound to this account. */
  syncAccountId?: string;
  /** Notion workspace that owns this page after it has been synced. */
  syncWorkspaceId?: string;
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

/** A selectable local collection or the signed-in user's Notion workspace. */
export type Workspace = {
  id: string;
  name: string;
  kind: 'local' | 'notion';
  /** Account that owns a local workspace or the Notion workspace. */
  accountId?: string;
  /** Actual Notion workspace id for a Notion-backed workspace. */
  notionWorkspaceId?: string;
  createdAt: string;
  updatedAt: string;
  syncState?: SaveStatus;
  syncMessage?: string;
};


/** Describes persisted client configuration for Notion synchronization. */
export type SyncConfig = {
  serverUrl: string;
  authenticated?: boolean;
  /** Current server-authenticated Jottathing account identifier. */
  userId?: string;
  /** Account that owns local documents and sync work; null means legacy data needs explicit assignment. */
  syncQueueOwnerUserId?: string | null;
  /** Workspace that owns the active durable sync queue. */
  syncQueueOwnerWorkspaceId?: string;
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
