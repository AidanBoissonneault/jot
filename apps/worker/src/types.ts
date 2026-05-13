import type { Queue } from '@cloudflare/workers-types';
import type { Project, ProjectPage, NotionBlockMapping, NotionParentPage } from '../../../src/types/capture.js';
import type { SyncBlockOperation } from '../../../src/types/sync.js';

export type SyncJob = {
  type: 'page' | 'project' | 'block_op';
  localId: string;
  pageId?: string;
  projectId: string;
  installationId: number;
  queuedVersion: number;
  payload: {
    page?: ProjectPage;
    project: Project;
    op?: SyncBlockOperation;
    ops?: SyncBlockOperation[];
    selectedParentPageId?: string;
  };
};

export type WorkerEnv = {
  NOTION_VERSION?: string;
  INKWELL_ROOT_PAGE_TITLE?: string;
  WORKER_URL?: string;
  NOTION_OAUTH_CLIENT_ID?: string;
  NOTION_OAUTH_CLIENT_SECRET?: string;
  SESSION_SECRET?: string;
  INKWELL_EXTENSION_ORIGIN?: string;
  TRUSTED_ORIGINS?: string;
  SUPABASE_URL: string;
  SUPABASE_SERVICE_KEY: string;
  SYNC_QUEUE: Queue<SyncJob>;
};

export type JsonRecord = Record<string, unknown>;

export type SyncStore = {
  installationId?: number | string;
  tokens?: { access_token: string };
  inkwellRootPage?: {
    id: string;
    parentPageId?: string;
    title?: string;
  };
  inkwellDatabase?: {
    databaseId: string;
    dataSourceId?: string;
    parentPageId?: string;
    title?: string;
  };
  notePages: Record<string, NotionParentPage & { kind?: 'page' | 'thread'; notionPageId?: string }>;
  blockMappings: Record<string, NotionBlockMapping[]>;
  parentPages: Record<string, NotionParentPage>;
  projectPages: Record<string, NotionParentPage & { notionPageId?: string }>;
  projectBlocks: Record<string, JsonRecord>;
  threadBlocks: Record<string, { blockId?: string }>;
  logs: Array<{ at: string; event: string; message?: string }>;
};

export type PageSyncPayload = {
  page: ProjectPage;
  project: Project;
  selectedParentPageId?: string;
};
