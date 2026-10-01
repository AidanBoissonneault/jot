import type { CaptureSelectionPayload } from '@/src/types/messages';
import { safeExternalUrl } from '@/src/extensions/inkwellLink';

const MAX_CAPTURE_TEXT_LENGTH = 256 * 1024;
const MAX_CAPTURE_URL_LENGTH = 8192;
const MAX_PAGE_TITLE_LENGTH = 4096;
const MAX_XPATH_LENGTH = 4096;
const MAX_CONTEXT_LENGTH = 256;
const MAX_CODE_LANGUAGE_LENGTH = 128;

/** Validates data crossing from a webpage drag into the privileged sidepanel. */
export function parseCaptureSelectionPayload(value: unknown): CaptureSelectionPayload | null {
  if (!isRecord(value) || !isRecord(value.highlightMeta)) return null;

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
  if (!safeSourceUrl || !boundedString(highlightMeta.text, MAX_CAPTURE_TEXT_LENGTH) || highlightMeta.text !== text) {
    return null;
  }

  if (
    !optionalBoundedString(highlightMeta.xpath, MAX_XPATH_LENGTH) ||
    !optionalBoundedString(highlightMeta.prefix, MAX_CONTEXT_LENGTH) ||
    !optionalBoundedString(highlightMeta.suffix, MAX_CONTEXT_LENGTH) ||
    !optionalBoolean(highlightMeta.isHeading) ||
    !optionalBoolean(highlightMeta.isCodeBlock) ||
    !optionalBoundedString(highlightMeta.codeLanguage, MAX_CODE_LANGUAGE_LENGTH) ||
    !optionalHeadingLevel(highlightMeta.headingLevel) ||
    !optionalOffset(highlightMeta.offset)
  ) {
    return null;
  }

  const safeMeta: CaptureSelectionPayload['highlightMeta'] = {
    text,
    ...(typeof highlightMeta.xpath === 'string' ? { xpath: highlightMeta.xpath } : {}),
    ...(typeof highlightMeta.offset === 'number' ? { offset: highlightMeta.offset } : {}),
    ...(typeof highlightMeta.prefix === 'string' ? { prefix: highlightMeta.prefix } : {}),
    ...(typeof highlightMeta.suffix === 'string' ? { suffix: highlightMeta.suffix } : {}),
    ...(typeof highlightMeta.isHeading === 'boolean' ? { isHeading: highlightMeta.isHeading } : {}),
    ...(typeof highlightMeta.headingLevel === 'number' ? { headingLevel: highlightMeta.headingLevel as 1 | 2 | 3 | 4 | 5 | 6 } : {}),
    ...(typeof highlightMeta.isCodeBlock === 'boolean' ? { isCodeBlock: highlightMeta.isCodeBlock } : {}),
    ...(typeof highlightMeta.codeLanguage === 'string' ? { codeLanguage: highlightMeta.codeLanguage } : {}),
  };

  const safeSourceLink = safeCaptureSourceLink(highlightMeta.sourceLink, safeSourceUrl);
  if (safeSourceLink) safeMeta.sourceLink = safeSourceLink;

  return { text, sourceUrl: safeSourceUrl, pageTitle, highlightMeta: safeMeta };
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

function optionalOffset(value: unknown): boolean {
  return value === undefined || (
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
  );
}
