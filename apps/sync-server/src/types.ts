import type { Project, ProjectPage, NotionBlockMapping, NotionParentPage } from '../../../src/types/capture.js';

export type JsonRecord = Record<string, unknown>;

export type NotionTokens = {
  access_token: string;
  refresh_token?: string | null;
};

export type SyncStore = {
  installationId?: number | string;
  tokens?: NotionTokens;
  jotRootPage?: {
    id: string;
    parentPageId?: string;
    title?: string;
  };
  jotDatabase?: {
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

export type NotionObject = JsonRecord & {
  id?: string;
  type?: string;
  object?: string;
  url?: string;
  properties?: Record<string, JsonRecord>;
  last_edited_time?: string;
  archived?: boolean;
};

export type PageSyncPayload = {
  page: ProjectPage;
  project: Project;
  selectedParentPageId?: string;
};
