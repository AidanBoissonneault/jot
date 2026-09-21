/**
 * @file Defines normalized domain contracts shared by the Inkwell API worker.
 * @author Aidan Boissonneault
 * @lastModified September 2026
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { DocumentContent, NotionParentPage, Project, ProjectPage } from '../../../src/types/capture.js';
import type { SyncBlockOperation } from '../../../src/types/sync.js';

export type Identifier = string | number;
export type JsonObject = Record<string, unknown>;
export type WorkerSupabaseClient = SupabaseClient;

export interface NotionRichText extends JsonObject {
  annotations: JsonObject;
  href: string | null;
  plain_text: string;
  text: JsonObject | undefined;
  type: string | undefined;
}

export interface NotionRichTextPayload extends JsonObject {
  text: JsonObject;
  type: 'text';
}

export interface NotionBlockContent extends JsonObject {
  external: JsonObject | undefined;
  file: JsonObject | undefined;
  file_upload: JsonObject | undefined;
  language: string | undefined;
  rich_text: NotionRichText[];
  type: string | undefined;
  url: string | undefined;
}

export interface NotionParent extends JsonObject {
  block_id: string | undefined;
  database_id: string | undefined;
  page_id: string | undefined;
  type: string;
  workspace: boolean | undefined;
}

export interface NotionObject extends JsonObject {
  archived: boolean;
  created_time: string;
  has_more: boolean;
  id: string;
  in_trash: boolean;
  last_edited_time: string;
  next_cursor: string | null;
  object: string;
  parent: NotionParent;
  properties: Record<string, JsonObject>;
  results: NotionObject[];
  title: NotionRichText[];
  type: string;
  url: string;
}

export interface NotionBlock extends NotionObject {
  audio: NotionBlockContent;
  code: NotionBlockContent;
  embed: NotionBlockContent;
  heading_1: NotionBlockContent;
  heading_2: NotionBlockContent;
  heading_3: NotionBlockContent;
  image: NotionBlockContent;
  paragraph: NotionBlockContent;
  quote: NotionBlockContent;
  toggle: NotionBlockContent;
  video: NotionBlockContent;
}

export interface NotionBlockPayload extends JsonObject {
  object: 'block';
  type: string;
}

export interface NotionRequestInit {
  body: unknown;
  headers: HeadersInit;
  method: string;
}

export type PartialNotionRequestInit = Partial<NotionRequestInit>;

export interface NotionRequester {
  (store: WorkerStore, endpoint: string): Promise<NotionObject>;
  (store: WorkerStore, endpoint: string, init: PartialNotionRequestInit): Promise<NotionObject>;
}

export interface BlockMapping {
  inkwellBlockId: string;
  kind: string;
  lastSyncedHash: string;
  localNodeId: string;
  localPageId: string;
  newState: NotionBlockPayload | null;
  notionBlockId: string | undefined;
  oldState: NotionBlockPayload | null;
  order: number;
}

export interface StoredPage {
  archived: boolean;
  dataSourceId: string | undefined;
  kind: string | undefined;
  lastEditedTime: string | undefined;
  notionPageId: string | undefined;
  parentPageId: string;
  title: string;
}

export interface StoredBlock {
  blockId: string;
  lastEditedTime: string | undefined;
  parentPageId: string;
  title: string;
}

export interface InkwellDatabase {
  dataSourceId: string;
  databaseId: string;
  parentPageId: string | undefined;
  propertyIds: Record<string, string>;
  title: string;
  url: string | undefined;
  views: Record<string, string>;
}

export interface WorkerLog {
  at: string;
  event: string;
  message: string;
}

export interface WorkerStore {
  blockMappings: Record<string, BlockMapping[]>;
  ignoredInkwellDatabaseIds: Set<string>;
  inkwellDatabase: InkwellDatabase | undefined;
  inkwellRootPage: NotionParentPage | undefined;
  installationId: Identifier | undefined;
  logs: WorkerLog[];
  notePages: Record<string, StoredPage>;
  parentPages: Record<string, StoredPage>;
  projectBlocks: Record<string, StoredBlock>;
  projectPages: Record<string, StoredPage>;
  threadBlocks: Record<string, StoredBlock>;
  tokens: { access_token: string } | undefined;
}

export interface ConnectedWorkerStore extends WorkerStore {
  installationId: Identifier;
  tokens: { access_token: string };
}

export interface ManagedBlockOperation {
  inkwellBlockId: string | undefined;
  payload: Partial<SyncBlockOperation['payload']>;
  type: SyncBlockOperation['type'];
}

export interface BlockQueuePayload {
  ops: ManagedBlockOperation[];
  page: SyncBlockOperation['payload']['page'];
  project: SyncBlockOperation['payload']['project'];
  selectedParentPageId: string | undefined;
}

export interface PageQueuePayload {
  page: SyncBlockOperation['payload']['page'];
  project: SyncBlockOperation['payload']['project'];
  selectedParentPageId: string | undefined;
}

export interface ProjectQueuePayload {
  project: SyncBlockOperation['payload']['project'];
  selectedParentPageId: string | undefined;
}

interface SyncQueueMessageBase {
  installationId: Identifier;
  localId: string;
  queuedVersion: number;
}

export interface BlockQueueMessage extends SyncQueueMessageBase {
  batchId: string;
  batchIndex: number;
  batchSize: number;
  pageId: string;
  payload: BlockQueuePayload;
  projectId: string;
  type: 'block_op';
}

export interface PageQueueMessage extends SyncQueueMessageBase {
  pageId: string;
  payload: PageQueuePayload;
  projectId: string;
  type: 'page';
}

export interface ProjectQueueMessage extends SyncQueueMessageBase {
  payload: ProjectQueuePayload;
  projectId: string;
  type: 'project';
}

export type SyncQueueMessage = BlockQueueMessage | PageQueueMessage | ProjectQueueMessage;

export interface WorkerEnv {
  INKWELL_EXTENSION_ORIGIN: string | undefined;
  INKWELL_ROOT_PAGE_TITLE: string | undefined;
  NOTION_OAUTH_CLIENT_ID: string | undefined;
  NOTION_OAUTH_CLIENT_SECRET: string | undefined;
  NOTION_VERSION: string | undefined;
  NOTION_WEBHOOK_SECRET: string | undefined;
  SUPABASE_SERVICE_KEY: string;
  SUPABASE_URL: string;
  SYNC_EVENTS: DurableObjectNamespace;
  SYNC_QUEUE: Queue<SyncQueueMessage>;
  TRUSTED_ORIGINS: string | undefined;
  WORKER_URL: string | undefined;
}

export interface ManagedBlockResult {
  createdBlocks: Array<NotionObject | undefined>;
}

export type AppendLog = (store: WorkerStore, event: string, message: string) => void;
export type HashValue = (value: string) => string;
export type ListAllBlockChildren = (store: WorkerStore, blockId: string) => Promise<NotionBlock[]>;
export type ReplaceManagedBlocks = (
  store: WorkerStore,
  localPageId: string,
  notionPageId: string,
  content: DocumentContent,
) => Promise<ManagedBlockResult>;
