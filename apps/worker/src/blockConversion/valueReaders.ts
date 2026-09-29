/** @file Safely reads nested Notion API values used by block conversion. */
import type { JsonObject, NotionRichText } from '../types.js';
/**
 * Reads an object-valued property from an unknown record.
 * @param value - Candidate record.
 * @param key - Property name.
 * @returns The nested object or an empty object.
 */
export function objectProperty(value: unknown, key: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const property: unknown = (value as JsonObject)[key];
  return property && typeof property === 'object' && !Array.isArray(property)
    ? (property as JsonObject)
    : {};
}

/**
 * Reads a string property from an unknown record.
 * @param value - Candidate record.
 * @param key - Property name.
 * @returns The string property or undefined.
 */
export function stringProperty(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const property: unknown = (value as JsonObject)[key];
  return typeof property === 'string' ? property : undefined;
}

/**
 * Reads a rich-text array from an unknown record.
 * @param value - Candidate record.
 * @param key - Property name.
 * @returns The rich-text array, or an empty array.
 */
export function richTextProperty(value: unknown, key: string): NotionRichText[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const property: unknown = (value as JsonObject)[key];
  return Array.isArray(property) ? (property as NotionRichText[]) : [];
}
