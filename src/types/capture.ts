export type CaptureType = 'quote' | 'task' | 'idea' | 'link';
export type SaveStatus = 'idle' | 'saving' | 'saved' | 'stale' | 'error';

export type HighlightMeta = {
  text: string;
  sourceLink?: string;
  xpath?: string;
  offset?: number;
  prefix?: string;
  suffix?: string;
  isHeading?: boolean;
  headingLevel?: 1 | 2 | 3 | 4 | 5 | 6;
};

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

export type Project = {
  id: string;
  name: string;
  status: 'active' | 'archived';
  tags: string[];
};

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
  remoteRevision?: string;
  syncMessage?: string;
  syncState?: SaveStatus;
};

export type CreateCaptureInput = Omit<Capture, 'id' | 'createdAt'> & {
  createdAt?: string;
};

export type NotionBlockMapping = {
  localPageId: string;
  localNodeId?: string;
  captureId?: string;
  notionBlockId: string;
  kind: 'page-title' | 'paragraph' | 'heading' | 'quote' | 'task' | 'source';
  lastSyncedHash: string;
};

export type SyncConfig = {
  serverUrl: string;
  authenticated?: boolean;
  userName?: string;
  userEmail?: string;
  workspaceId?: string;
  workspaceName?: string;
  selectedDatabaseId?: string;
  selectedDatabaseTitle?: string;
  selectedDataSourceId?: string;
  selectedParentPageId?: string;
  selectedParentPageTitle?: string;
  connected: boolean;
};

export type NotionParentPage = {
  id: string;
  parentPageId?: string;
  title: string;
  url?: string;
};
