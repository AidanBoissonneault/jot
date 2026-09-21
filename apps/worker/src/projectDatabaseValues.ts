/**
 * @file Builds and reads the pure Notion values used by project-database synchronization.
 * @author Aidan Boissonneault
 * @lastModified September 2026
 */

import type { DocumentContent, NotionParentPage, Project } from '../../../src/types/capture.js';
import type { InkwellDatabase, JsonObject, NotionObject, NotionRichText } from './types.js';

export const INKWELL_DATABASE_TITLE = 'Inkwell';
export const PROJECT_STATE_BLOCK_KEY = 'project-state';
export const PROJECT_PROPERTIES = {
  title: 'Name',
  status: 'Status',
  category: 'Category',
  created: 'Created',
  updated: 'Updated',
  createdBy: 'Created by',
  lastEditedBy: 'Last edited by',
  inkwellId: 'Inkwell ID',
  managed: 'Managed by Inkwell',
} as const;

/**
 * Builds Notion database properties for one local project.
 * @param project - Local project metadata.
 * @returns Notion page-property payload.
 */
export function projectProperties(project: Project): JsonObject {
  const createdAt = project.createdAt ?? new Date().toISOString();
  const updatedAt = project.updatedAt ?? createdAt;
  const category = String(project.category ?? '').trim();
  return {
    [PROJECT_PROPERTIES.title]: { title: [{ text: { content: project.name || 'Untitled Project' } }] },
    [PROJECT_PROPERTIES.status]: { select: { name: project.status === 'archived' ? 'Archived' : 'Active' } },
    [PROJECT_PROPERTIES.category]: { select: category ? { name: category } : null },
    [PROJECT_PROPERTIES.created]: { date: { start: createdAt } },
    [PROJECT_PROPERTIES.updated]: { date: { start: updatedAt } },
    [PROJECT_PROPERTIES.inkwellId]: { rich_text: [{ text: { content: project.id } }] },
    [PROJECT_PROPERTIES.managed]: { checkbox: true },
  };
}

/**
 * Defines the complete managed schema for the Inkwell project database.
 * @returns Notion data-source property schema.
 */
export function projectSchema(): JsonObject {
  return {
    [PROJECT_PROPERTIES.title]: { title: {} },
    [PROJECT_PROPERTIES.status]: { select: { options: [{ name: 'Active', color: 'green' }, { name: 'Archived', color: 'gray' }] } },
    [PROJECT_PROPERTIES.category]: { select: { options: [] } },
    [PROJECT_PROPERTIES.created]: { date: {} },
    [PROJECT_PROPERTIES.updated]: { date: {} },
    [PROJECT_PROPERTIES.createdBy]: { created_by: {} },
    [PROJECT_PROPERTIES.lastEditedBy]: { last_edited_by: {} },
    [PROJECT_PROPERTIES.inkwellId]: { rich_text: {} },
    [PROJECT_PROPERTIES.managed]: { checkbox: {} },
  };
}

/**
 * Defines the filtered active-projects table view.
 * @param propertyIds - Database property identifiers keyed by display name.
 * @returns Notion view payload.
 */
export function activeProjectsView(propertyIds: Record<string, string>): JsonObject {
  return {
    name: 'Active Projects',
    type: 'table',
    filter: { property: PROJECT_PROPERTIES.status, select: { does_not_equal: 'Archived' } },
    sorts: [{ property: PROJECT_PROPERTIES.updated, direction: 'descending' }],
    configuration: tableConfiguration(propertyIds, {
      visible: [PROJECT_PROPERTIES.title, PROJECT_PROPERTIES.status, PROJECT_PROPERTIES.category, PROJECT_PROPERTIES.updated],
    }),
    position: { type: 'start' },
  };
}

/**
 * Defines the active-project board grouped by category.
 * @param propertyIds - Database property identifiers keyed by display name.
 * @returns Notion view payload.
 */
export function byCategoryView(propertyIds: Record<string, string>): JsonObject {
  const categoryId = propertyIds[PROJECT_PROPERTIES.category];
  return {
    name: 'By Category',
    type: 'board',
    filter: { property: PROJECT_PROPERTIES.status, select: { does_not_equal: 'Archived' } },
    sorts: [{ property: PROJECT_PROPERTIES.updated, direction: 'descending' }],
    configuration: {
      type: 'board',
      group_by: categoryId
        ? { type: 'select', property_id: categoryId, group_by: 'value', sort: { type: 'manual' } }
        : undefined,
      card_layout: 'compact',
      properties: propertyVisibility(propertyIds, [PROJECT_PROPERTIES.title, PROJECT_PROPERTIES.status, PROJECT_PROPERTIES.updated]),
    },
  };
}

/**
 * Defines the unfiltered all-projects table view.
 * @param propertyIds - Database property identifiers keyed by display name.
 * @returns Notion view payload.
 */
export function allProjectsView(propertyIds: Record<string, string>): JsonObject {
  return {
    name: 'All Projects',
    type: 'table',
    sorts: [{ property: PROJECT_PROPERTIES.updated, direction: 'descending' }],
    configuration: tableConfiguration(propertyIds, { visible: Object.values(PROJECT_PROPERTIES) }),
  };
}

/**
 * Builds table-view display configuration.
 * @param propertyIds - Database property identifiers keyed by display name.
 * @param options - Property names that should be visible.
 * @returns Notion table configuration.
 */
export function tableConfiguration(
  propertyIds: Record<string, string>,
  { visible }: { visible: string[] },
): JsonObject {
  return { type: 'table', properties: propertyVisibility(propertyIds, visible), wrap_cells: false };
}

/**
 * Maps property identifiers to view visibility flags.
 * @param propertyIds - Database property identifiers keyed by display name.
 * @param visibleNames - Names that should remain visible.
 * @returns Ordered Notion property-visibility entries.
 */
export function propertyVisibility(
  propertyIds: Record<string, string>,
  visibleNames: string[],
): Array<{ property_id: string; visible: boolean }> {
  const visible = new Set(visibleNames);
  return Object.entries(propertyIds).map(([name, propertyId]) => ({
    property_id: propertyId,
    visible: visible.has(name),
  }));
}

/**
 * Extracts stable property identifiers from a Notion schema response.
 * @param properties - Notion properties keyed by display name.
 * @returns Property identifiers keyed by the same names.
 */
export function propertyIdMap(properties: Record<string, JsonObject>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(properties).map(([name, property]) => [name, stringProperty(property, 'id') ?? name]),
  );
}

/**
 * Normalizes a Notion database response for worker persistence.
 * @param database - Notion database response.
 * @param dataSourceId - Primary data-source identifier.
 * @param parentPageId - Explicit parent page, when known.
 * @returns Persistable database summary.
 */
export function databaseSummary(
  database: NotionObject,
  dataSourceId: string,
  parentPageId: string | undefined,
): InkwellDatabase {
  return {
    databaseId: database.id,
    dataSourceId,
    parentPageId: parentPageId ?? parentPageIdFromObject(database),
    propertyIds: {},
    title: titleFromDatabase(database) || INKWELL_DATABASE_TITLE,
    url: database.url,
    views: {},
  };
}

/**
 * Creates a public page summary for a database project row.
 * @param page - Notion project page.
 * @param database - Owning database summary.
 * @returns Public parent-page metadata.
 */
export function pageSummaryFromNotionPage(
  page: NotionObject,
  database: InkwellDatabase,
): NotionParentPage {
  return { id: page.id, parentPageId: database.databaseId, title: titleFromPage(page), url: page.url };
}

/**
 * Builds a Notion database parent selector.
 * @param parentPageId - Parent page identifier or undefined for workspace scope.
 * @returns Notion parent payload.
 */
export function databaseParent(parentPageId: string | undefined): JsonObject {
  return parentPageId
    ? { type: 'page_id', page_id: parentPageId }
    : { type: 'workspace', workspace: true };
}

/**
 * Reads the first data-source identifier from a database response.
 * @param database - Notion database response.
 * @returns Data-source identifier or undefined.
 */
export function firstDataSourceId(database: NotionObject): string | undefined {
  const dataSources: unknown = database.data_sources;
  if (Array.isArray(dataSources)) {
    const first: unknown = dataSources[0];
    const id = stringProperty(first, 'id');
    if (id) return id;
  }
  return nestedString(database, 'initial_data_source', 'id');
}

/**
 * Reads a page parent identifier from a Notion object.
 * @param object - Notion object with parent metadata.
 * @returns Parent page identifier or undefined.
 */
export function parentPageIdFromObject(object: NotionObject): string | undefined {
  return object.parent.type === 'page_id' ? object.parent.page_id : undefined;
}

/**
 * Checks whether Notion reports an object as archived or trashed.
 * @param object - Notion object to inspect.
 * @returns Whether the object is inactive.
 */
export function isArchivedObject(object: NotionObject): boolean {
  return object.archived || object.in_trash;
}

/**
 * Detects a Notion validation error caused by an archived ancestor.
 * @param error - Unknown thrown value.
 * @returns Whether the error identifies an archived ancestor.
 */
export function isArchivedAncestorError(error: unknown): boolean {
  return errorCode(error) === 'validation_error'
    && /archived ancestor|unarchive the ancestor/i.test(errorMessage(error));
}

/**
 * Detects a Notion validation error caused by using a block as a page.
 * @param error - Unknown thrown value.
 * @returns Whether the error identifies a block/page mismatch.
 */
export function isBlockNotPageError(error: unknown): boolean {
  return errorCode(error) === 'validation_error'
    && /is a block, not a page|retrieve block API/i.test(errorMessage(error));
}

/**
 * Extracts plain title text from a Notion database.
 * @param database - Notion database response.
 * @returns Database title.
 */
export function titleFromDatabase(database: NotionObject): string {
  return richTextValue(database.title);
}

/**
 * Extracts the title property from a Notion page.
 * @param page - Notion page response.
 * @returns Page title or the untitled fallback.
 */
export function titleFromPage(page: NotionObject): string {
  const titleProperty = Object.values(page.properties).find(
    (property: JsonObject) => stringProperty(property, 'type') === 'title',
  );
  const title = titleProperty ? richTextArray(titleProperty, 'title') : [];
  return richTextValue(title) || (typeof page.title === 'string' ? page.title : '') || 'Untitled';
}

/**
 * Extracts plain text from a Notion rich-text property.
 * @param property - Notion property response.
 * @returns Plain property text.
 */
export function richTextProperty(property: JsonObject | undefined): string {
  return richTextValue(property ? richTextArray(property, 'rich_text') : []);
}

/**
 * Extracts a Notion select option name.
 * @param property - Notion property response.
 * @returns Selected name or an empty string.
 */
export function selectProperty(property: JsonObject | undefined): string {
  return nestedString(property, 'select', 'name') ?? '';
}

/**
 * Extracts a Notion date property's start value.
 * @param property - Notion property response.
 * @returns ISO date string or undefined.
 */
export function dateProperty(property: JsonObject | undefined): string | undefined {
  return nestedString(property, 'date', 'start');
}

/**
 * Builds one plain Notion rich-text item.
 * @param content - Text content.
 * @returns Notion rich-text payload.
 */
export function richText(content: string): JsonObject[] {
  return [{ type: 'text', text: { content } }];
}

/**
 * Builds a managed Notion toggle block payload.
 * @param title - Toggle title.
 * @returns Notion toggle block payload.
 */
export function toggleBlock(title: string): JsonObject {
  return {
    object: 'block',
    type: 'toggle',
    toggle: { rich_text: richText(title || 'Untitled Page'), color: 'default' },
  };
}

/**
 * Extracts the plain title from a Notion toggle block.
 * @param block - Notion toggle block.
 * @returns Toggle title or an empty string.
 */
export function toggleTitle(block: NotionObject): string {
  const toggle = objectProperty(block, 'toggle');
  return richTextValue(toggle ? richTextArray(toggle, 'rich_text') : []);
}

/**
 * Creates the minimal editable Tiptap document.
 * @returns An empty paragraph document.
 */
export function emptyDocument(): DocumentContent {
  return { type: 'doc', content: [{ type: 'paragraph' }] };
}

/**
 * Builds the mapping key for a project's state toggle.
 * @param projectId - Local project identifier.
 * @returns Stable project-state mapping key.
 */
export function projectStateKey(projectId: string): string {
  return `${PROJECT_STATE_BLOCK_KEY}:${projectId}`;
}

/**
 * Builds the mapping key for a page's thread toggle.
 * @param pageId - Local page identifier.
 * @returns Stable thread mapping key.
 */
export function threadKey(pageId: string): string {
  return `thread:${pageId}`;
}

/** Reads an object property from an unknown value. @param value - Unknown value. @param key - Property name. @returns JSON object when present. */
function objectProperty(value: unknown, key: string): JsonObject | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const property: unknown = (value as JsonObject)[key];
  return property && typeof property === 'object' && !Array.isArray(property) ? property as JsonObject : undefined;
}

/** Reads a string property from an unknown value. @param value - Unknown value. @param key - Property name. @returns String value when present. */
function stringProperty(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const property: unknown = (value as JsonObject)[key];
  return typeof property === 'string' ? property : undefined;
}

/** Reads a nested string from an unknown object. @param value - Unknown root value. @param path - Property path. @returns String value when present. */
function nestedString(value: unknown, ...path: string[]): string | undefined {
  let current: unknown = value;
  for (const key of path) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined;
    current = (current as JsonObject)[key];
  }
  return typeof current === 'string' ? current : undefined;
}

/** Reads a rich-text array from an object property. @param value - Source object. @param key - Property name. @returns Rich-text values. */
function richTextArray(value: JsonObject, key: string): NotionRichText[] {
  const property: unknown = value[key];
  return Array.isArray(property) ? property as NotionRichText[] : [];
}

/** Joins the plain content of a Notion rich-text array. @param items - Rich-text values. @returns Plain text. */
function richTextValue(items: NotionRichText[]): string {
  return items.map((item: NotionRichText) => item.plain_text || nestedString(item, 'text', 'content') || '').join('');
}

/** Extracts a string error code from an unknown thrown value. @param error - Unknown error. @returns Error code when present. */
function errorCode(error: unknown): string | undefined {
  return stringProperty(error, 'code');
}

/** Converts an unknown thrown value to readable text. @param error - Unknown error. @returns Error message. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
