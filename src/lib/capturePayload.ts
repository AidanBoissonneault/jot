import type { CaptureSelectionPayload } from '@/src/types/messages';
import { safeExternalUrl } from '@/src/extensions/jottathingLink';

const MAX_CAPTURE_TEXT_LENGTH = 256 * 1024;
const MAX_CAPTURE_URL_LENGTH = 8192;
const MAX_PAGE_TITLE_LENGTH = 4096;
const MAX_XPATH_LENGTH = 4096;
const MAX_CONTEXT_LENGTH = 256;
const MAX_CODE_LANGUAGE_LENGTH = 128;

/** Validates data crossing from a webpage drag into the privileged sidepanel. */
export function parseCaptureSelectionPayload(value: unknown): CaptureSelectionPayload | null {
  if (!isRecord(value)) return null;

  const { text, sourceUrl, pageTitle, highlightMeta } = value;
  if (
    !boundedString(text, MAX_CAPTURE_TEXT_LENGTH) ||
    !text.trim() ||
    !boundedString(pageTitle, MAX_PAGE_TITLE_LENGTH) ||
    !boundedString(sourceUrl, MAX_CAPTURE_URL_LENGTH)
  ) {
    return null;
  }

  const safeSourceUrl = safeExternalUrl(sourceUrl);
  if (!safeSourceUrl) return null;

  const safeMeta = parseHighlightMeta(highlightMeta, text, safeSourceUrl);
  return safeMeta ? { text, sourceUrl: safeSourceUrl, pageTitle, highlightMeta: safeMeta } : null;
}

/** Validates and copies only the highlight fields the extension consumes. */
function parseHighlightMeta(
  value: unknown,
  text: string,
  sourceUrl: string,
): CaptureSelectionPayload['highlightMeta'] | null {
  if (!isRecord(value) || !hasValidHighlightMeta(value, text)) return null;

  const safeMeta: CaptureSelectionPayload['highlightMeta'] = {
    text,
    ...(typeof value.xpath === 'string' ? { xpath: value.xpath } : {}),
    ...(typeof value.offset === 'number' ? { offset: value.offset } : {}),
    ...(typeof value.prefix === 'string' ? { prefix: value.prefix } : {}),
    ...(typeof value.suffix === 'string' ? { suffix: value.suffix } : {}),
    ...(typeof value.isHeading === 'boolean' ? { isHeading: value.isHeading } : {}),
    ...(typeof value.headingLevel === 'number' ? { headingLevel: value.headingLevel as 1 | 2 | 3 | 4 | 5 | 6 } : {}),
    ...(typeof value.isCodeBlock === 'boolean' ? { isCodeBlock: value.isCodeBlock } : {}),
    ...(typeof value.codeLanguage === 'string' ? { codeLanguage: value.codeLanguage } : {}),
    ...(isCaptureSourceBlockType(value.sourceBlockType)
      ? { sourceBlockType: value.sourceBlockType }
      : {}),
  };

  const safeSourceLink = safeCaptureSourceLink(value.sourceLink, sourceUrl);
  if (safeSourceLink) safeMeta.sourceLink = safeSourceLink;

  return safeMeta;
}

/** Checks every bounded optional field before the metadata is copied. */
function hasValidHighlightMeta(value: Record<string, unknown>, text: string): boolean {
  return boundedString(value.text, MAX_CAPTURE_TEXT_LENGTH) &&
    value.text === text &&
    optionalBoundedString(value.xpath, MAX_XPATH_LENGTH) &&
    optionalBoundedString(value.prefix, MAX_CONTEXT_LENGTH) &&
    optionalBoundedString(value.suffix, MAX_CONTEXT_LENGTH) &&
    optionalBoolean(value.isHeading) &&
    optionalBoolean(value.isCodeBlock) &&
    optionalBoundedString(value.codeLanguage, MAX_CODE_LANGUAGE_LENGTH) &&
    optionalCaptureSourceBlockType(value.sourceBlockType) &&
    optionalHeadingLevel(value.headingLevel) &&
    optionalOffset(value.offset);
}

function safeCaptureSourceLink(value: unknown, sourceUrl: string): string | undefined {
  if (!boundedString(value, MAX_CAPTURE_URL_LENGTH)) return undefined;
  const candidate = safeExternalUrl(value);
  if (!candidate) return undefined;

  try {
    const source = new URL(sourceUrl);
    const link = new URL(candidate);
    return source.origin === link.origin &&
      source.pathname === link.pathname &&
      source.search === link.search
      ? candidate
      : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function boundedString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length <= maxLength;
}

function optionalBoundedString(value: unknown, maxLength: number): boolean {
  return value === undefined || boundedString(value, maxLength);
}

function optionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === 'boolean';
}

function optionalHeadingLevel(value: unknown): boolean {
  return value === undefined || (
    typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 6
  );
}

function optionalCaptureSourceBlockType(value: unknown): boolean {
  return value === undefined || isCaptureSourceBlockType(value);
}

function isCaptureSourceBlockType(
  value: unknown,
): value is NonNullable<CaptureSelectionPayload['highlightMeta']['sourceBlockType']> {
  return value === 'heading' || value === 'paragraph' || value === 'blockquote' || value === 'codeBlock';
}

function optionalOffset(value: unknown): boolean {
  return value === undefined || (
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
  );
}
