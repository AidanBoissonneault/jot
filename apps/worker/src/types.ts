/**
 * @file Defines normalized domain contracts shared by the Jottathing API worker.
 * @author Aidan Boissonneault
 * @lastModified September 2026
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { DocumentContent, NotionParentPage, Project, ProjectPage } from '../../../src/types/capture.js';
import type { SyncBlockOperation } from '../../../src/types/sync.js';

/** Describes an identifier accepted by persistence and external service boundaries. */
export type Identifier = string | number;
/** Describes a JSON-compatible object whose property values require runtime narrowing. */
export type JsonObject = Record<string, unknown>;
/** Describes the privileged Supabase client used by worker services. */
export type WorkerSupabaseClient = SupabaseClient;

/** Describes normalized rich-text data returned by Notion. */
export interface NotionRichText extends JsonObject {
  annotations: JsonObject;
  href: string | null;
  plain_text: string;
  text: JsonObject | undefined;
  type: string | undefined;
}

/** Describes outbound text content accepted by Notion block mutations. */
export interface NotionRichTextPayload extends JsonObject {
  text: JsonObject;
  type: 'text';
}

/** Describes normalized content shared by supported Notion block variants. */
export interface NotionBlockContent extends JsonObject {
  external: JsonObject | undefined;
  file: JsonObject | undefined;
  file_upload: JsonObject | undefined;
  language: string | undefined;
  rich_text: NotionRichText[];
  type: string | undefined;
  url: string | undefined;
}

/** Describes the parent descriptor attached to a Notion object. */
export interface NotionParent extends JsonObject {
  block_id: string | undefined;
  database_id: string | undefined;
  page_id: string | undefined;
  type: string;
  workspace: boolean | undefined;
}

/** Describes the normalized fields shared by Notion API responses. */
export interface NotionObject extends JsonObject {
  archived?: boolean;
  created_time: string;
  has_more: boolean;
  id: string;
  in_trash?: boolean;
  is_archived?: boolean;
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

/** Describes a normalized Notion block with supported content containers. */
export interface NotionBlock extends NotionObject {
  audio: NotionBlockContent;
  code: NotionBlockContent;
  embed: NotionBlockContent;
  heading_1: NotionBlockContent;
  heading_2: NotionBlockContent;
  heading_3: NotionBlockContent;
  heading_4: NotionBlockContent;
  image: NotionBlockContent;
  paragraph: NotionBlockContent;
  quote: NotionBlockContent;
  toggle: NotionBlockContent;
  video: NotionBlockContent;
}

/** Describes an outbound Notion block mutation payload. */
export interface NotionBlockPayload extends JsonObject {
  object: 'block';
  type: string;
}

/** Describes the complete transport options for a Notion request. */
export interface NotionRequestInit {
  body: unknown;
  headers: HeadersInit;
  method: string;
}

/** Describes caller-provided overrides for a Notion request. */
export type PartialNotionRequestInit = Partial<NotionRequestInit>;

/** Describes the overloaded authenticated Notion request function. */
export interface NotionRequester {
  (store: WorkerStore, endpoint: string): Promise<NotionObject>;
  (store: WorkerStore, endpoint: string, init: PartialNotionRequestInit): Promise<NotionObject>;
}

/** Describes the durable identity and synchronization state for one managed block. */
export interface BlockMapping {
  jottathingBlockId: string;
  kind: string;
  lastSyncedHash: string;
  localNodeId: string;
  localPageId: string;
  localBaselineAcknowledged?: boolean;
  newState: NotionBlockPayload | null;
  notionBlockId: string | undefined;
  oldState: NotionBlockPayload | null;
  order: number;
}

/** Describes cached metadata for a page managed by the worker. */
export interface StoredPage {
  archived: boolean;
  dataSourceId: string | undefined;
  kind: string | undefined;
  lastEditedTime: string | undefined;
  notionPageId: string | undefined;
  parentPageId: string;
  title: string;
}

/** Describes cached metadata for a managed Notion block. */
export interface StoredBlock {
  blockId: string;
  lastEditedTime: string | undefined;
  parentPageId: string;
  title: string;
}

/** Describes the discovered or created Jottathing project database. */
export interface JottathingDatabase {
  dataSourceId: string;
  databaseId: string;
  parentPageId: string | undefined;
  propertyIds: Record<string, string>;
  title: string;
  url: string | undefined;
  views: Record<string, string>;
}

/** Describes one bounded diagnostic event recorded in worker state. */
export interface WorkerLog {
  at: string;
  event: string;
  message: string;
}

/** Describes the fully normalized persisted state for an installation. */
export interface WorkerStore {
  blockMappings: Record<string, BlockMapping[]>;
  ignoredJottathingDatabaseIds: Set<string>;
  jottathingDatabase: JottathingDatabase | undefined;
  jottathingRootPage: NotionParentPage | undefined;
  installationId: Identifier | undefined;
  logs: WorkerLog[];
  notePages: Record<string, StoredPage>;
  parentPages: Record<string, StoredPage>;
  projectBlocks: Record<string, StoredBlock>;
  projectPages: Record<string, StoredPage>;
  threadBlocks: Record<string, StoredBlock>;
  tokens: { access_token: string } | undefined;
}

/** Describes worker state proven to contain installation credentials. */
export interface ConnectedWorkerStore extends WorkerStore {
  installationId: Identifier;
  tokens: { access_token: string };
}

/** Describes the normalized subset of a local block operation consumed by the worker. */
export interface ManagedBlockOperation {
  /** Local edit time used to decide whether an archived project should be restored. */
  createdAt?: string;
  jottathingBlockId: string | undefined;
  /** Preserved in the durable payload so a retry can reconcile local operation IDs. */
  opId?: string;
  payload: Partial<SyncBlockOperation['payload']>;
  type: SyncBlockOperation['type'];
}

/** Describes the complete context carried by an incremental block queue message. */
export interface BlockQueuePayload {
  ops: ManagedBlockOperation[];
  page: SyncBlockOperation['payload']['page'];
  project: SyncBlockOperation['payload']['project'];
  selectedParentPageId: string | undefined;
}

/** Describes the complete context carried by a full-page queue message. */
export interface PageQueuePayload {
  page: ProjectPage;
  project: Project;
  selectedParentPageId: string | undefined;
}

/** Describes the complete context carried by a project queue message. */
export interface ProjectQueuePayload {
  project: Project;
  selectedParentPageId: string | undefined;
}

/** Describes fields shared by every synchronization queue message. */
interface SyncQueueMessageBase {
  installationId: Identifier;
  localId: string;
  queuedVersion: number;
  /** Set after repeated Queue or permanent Notion failures so Sync can redrive this durable payload. */
  deadLetteredAt?: string;
  /** Set when the durable payload was stored but its Queue reference could not be published. */
  deliveryPendingAt?: string;
}

/** Describes a versioned incremental block queue message. */
export interface BlockQueueMessage extends SyncQueueMessageBase {
  batchId: string;
  batchIndex: number;
  batchSize: number;
  pageId: string;
  payload: BlockQueuePayload;
  projectId: string;
  type: 'block_op';
}

/** Describes a versioned full-page queue message. */
export interface PageQueueMessage extends SyncQueueMessageBase {
  pageId: string;
  payload: PageQueuePayload;
  projectId: string;
  type: 'page';
}

/** Describes a versioned project queue message. */
export interface ProjectQueueMessage extends SyncQueueMessageBase {
  payload: ProjectQueuePayload;
  projectId: string;
  type: 'project';
}

/** Describes the discriminated union of synchronization queue messages. */
export type SyncQueueMessage = BlockQueueMessage | PageQueueMessage | ProjectQueueMessage;

/** The Cloudflare Queue carries only a random reference; document content stays in Supabase. */
export interface SyncQueueReference {
  jobId: string;
}

/** Describes Cloudflare bindings and configuration required by the API worker. */
export interface WorkerEnv {
  JOTTATHING_EXTENSION_ORIGIN: string | undefined;
  JOTTATHING_ROOT_PAGE_TITLE: string | undefined;
  INKWELL_EXTENSION_ORIGIN?: string | undefined;
  NOTION_OAUTH_CLIENT_ID: string | undefined;
  NOTION_OAUTH_CLIENT_SECRET: string | undefined;
  NOTION_VERSION: string | undefined;
  NOTION_WEBHOOK_SECRET: string | undefined;
  NOTION_WEBHOOK_SETUP_TOKEN: string | undefined;
  SUPABASE_SERVICE_KEY: string;
  SUPABASE_URL: string;
  SYNC_EVENTS: DurableObjectNamespace;
  SYNC_QUEUE: Queue<SyncQueueReference>;
  TRUSTED_ORIGINS: string | undefined;
  WORKER_URL: string | undefined;
}

/** Describes created remote blocks returned by a managed mutation. */
export interface ManagedBlockResult {
  createdBlocks: Array<NotionObject | undefined>;
  content?: DocumentContent;
  baselineContent?: DocumentContent;
}

/** Describes the dependency signature for recording a worker diagnostic. */
export type AppendLog = (store: WorkerStore, event: string, message: string) => void;
/** Describes the dependency signature for stable content hashing. */
export type HashValue = (value: string) => string;
/** Describes the dependency signature for loading paginated Notion children. */
export type ListAllBlockChildren = (store: WorkerStore, blockId: string) => Promise<NotionBlock[]>;
/** Describes the dependency signature for replacing managed page content. */
export type ReplaceManagedBlocks = (
  store: WorkerStore,
  localPageId: string,
  notionPageId: string,
  content: DocumentContent,
  baselineContent?: DocumentContent,
) => Promise<ManagedBlockResult>;
