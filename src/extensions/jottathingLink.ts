import Link from '@tiptap/extension-link';
import type { SourceOpenPayload } from '@/src/types/messages';

export const JOTTATHING_SOURCE_ATTR = 'jottathingSource';
const LEGACY_SOURCE_DATA_ATTR = 'data-inkwell-source';

/**
 * Source data is persisted once on a captured block. Short keys and a relative
 * source-link hash keep the project JSON small without tying it to the text's
 * current formatting or inline-node boundaries.
 */
export type StoredJottathingSource = {
  u: string;
  t: string;
  l?: string;
  x?: string;
  o?: number;
  p?: string;
  s?: string;
};

export function storeJottathingSource(
  payload: SourceOpenPayload,
): StoredJottathingSource {
  const sourceLink = compactSourceLink(
    payload.sourceUrl,
    payload.highlightMeta.sourceLink,
    payload.highlightMeta.text,
  );

  return withoutUndefined({
    u: payload.sourceUrl,
    t: payload.highlightMeta.text,
    l: sourceLink,
    x: payload.highlightMeta.xpath,
    o: payload.highlightMeta.offset,
    p: payload.highlightMeta.prefix,
    s: payload.highlightMeta.suffix,
  });
}

export function encodeJottathingSource(payload: SourceOpenPayload) {
  return JSON.stringify(storeJottathingSource(payload));
}

export function decodeJottathingSource(value: unknown): SourceOpenPayload | null {
  if (!value) {
    return null;
  }

  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;

    if (isStoredJottathingSource(parsed)) {
      return {
        sourceUrl: parsed.u,
        highlightMeta: withoutUndefined({
          text: parsed.t,
          sourceLink: expandSourceLink(parsed.u, parsed.l, parsed.t),
          xpath: parsed.x,
          offset: parsed.o,
          prefix: parsed.p,
          suffix: parsed.s,
        }),
      };
    }

    const payload = parsed as SourceOpenPayload;

    if (!payload.sourceUrl || !payload.highlightMeta?.text) {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
}

export function isAccessibleJottathingSource(payload: SourceOpenPayload | null) {
  if (!payload) {
    return false;
  }

  return Boolean(safeJottathingSourceUrl(payload));
}

export function safeJottathingSourceUrl(payload: SourceOpenPayload) {
  return (
    safeHttpUrl(payload.highlightMeta.sourceLink ?? '') ??
    safeHttpUrl(payload.sourceUrl)
  );
}

/** Allows ordinary editor links to open only web URLs. */
export function safeExternalUrl(value: string) {
  return safeHttpUrl(value);
}

function isStoredJottathingSource(value: unknown): value is StoredJottathingSource {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Partial<StoredJottathingSource>;
  return typeof candidate.u === 'string' && typeof candidate.t === 'string';
}

function compactSourceLink(sourceUrl: string, sourceLink: string | undefined, text: string) {
  if (!sourceLink || sourceLink === sourceUrl) {
    return undefined;
  }

  try {
    const source = new URL(sourceUrl);
    const link = new URL(sourceLink, source);

    if (link.toString() === defaultTextFragmentLink(sourceUrl, text)) {
      return undefined;
    }

    if (
      source.origin === link.origin &&
      source.pathname === link.pathname &&
      source.search === link.search
    ) {
      return link.hash || undefined;
    }
  } catch {
    // Keep the original link below. Validation happens before it is opened.
  }

  return sourceLink;
}

function expandSourceLink(sourceUrl: string, sourceLink: string | undefined, text: string) {
  if (!sourceLink) {
    return defaultTextFragmentLink(sourceUrl, text);
  }

  try {
    return new URL(sourceLink, sourceUrl).toString();
  } catch {
    return sourceLink;
  }
}

function defaultTextFragmentLink(sourceUrl: string, text: string) {
  try {
    const url = new URL(sourceUrl);
    const fragment = encodeURIComponent(text.replace(/\s+/g, ' ').trim());

    if (!fragment) {
      return url.toString();
    }

    const baseUrl = `${url.origin}${url.pathname}${url.search}`;
    return url.hash
      ? `${baseUrl}${url.hash}:~:text=${fragment}`
      : `${baseUrl}#:~:text=${fragment}`;
  } catch {
    return sourceUrl;
  }
}

function safeHttpUrl(value: string) {
  try {
    const url = new URL(value);
    if (url.username || url.password) return null;
    return url.protocol === 'http:' || url.protocol === 'https:'
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

function withoutUndefined<T extends object>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined && item !== ''),
  ) as T;
}

export const JottathingLink = Link.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      [JOTTATHING_SOURCE_ATTR]: {
        default: null,
        parseHTML: (element) =>
          element.getAttribute('data-jottathing-source') ??
          element.getAttribute(LEGACY_SOURCE_DATA_ATTR),
        renderHTML: (attributes) => {
          const value = attributes[JOTTATHING_SOURCE_ATTR];

          return typeof value === 'string' && value
            ? { 'data-jottathing-source': value }
            : {};
        },
      },
    };
  },
}).configure({
  openOnClick: false,
});
