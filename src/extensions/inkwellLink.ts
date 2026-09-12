import Link from '@tiptap/extension-link';
import type { SourceOpenPayload } from '@/src/types/messages';

export const INKWELL_SOURCE_ATTR = 'inkwellSource';

/**
 * Source data is persisted once on a captured block. Short keys and a relative
 * source-link hash keep the project JSON small without tying it to the text's
 * current formatting or inline-node boundaries.
 */
export type StoredInkwellSource = {
  u: string;
  t: string;
  l?: string;
  x?: string;
  o?: number;
  p?: string;
  s?: string;
};

export function storeInkwellSource(
  payload: SourceOpenPayload,
): StoredInkwellSource {
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

export function encodeInkwellSource(payload: SourceOpenPayload) {
  return JSON.stringify(storeInkwellSource(payload));
}

export function decodeInkwellSource(value: unknown): SourceOpenPayload | null {
  if (!value) {
    return null;
  }

  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;

    if (isStoredInkwellSource(parsed)) {
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

export function isAccessibleInkwellSource(payload: SourceOpenPayload | null) {
  if (!payload) {
    return false;
  }

  return Boolean(safeInkwellSourceUrl(payload));
}

export function safeInkwellSourceUrl(payload: SourceOpenPayload) {
  return (
    safeHttpUrl(payload.highlightMeta.sourceLink ?? '') ??
    safeHttpUrl(payload.sourceUrl)
  );
}

function isStoredInkwellSource(value: unknown): value is StoredInkwellSource {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Partial<StoredInkwellSource>;
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

export const InkwellLink = Link.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      [INKWELL_SOURCE_ATTR]: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-inkwell-source'),
        renderHTML: (attributes) => {
          const value = attributes[INKWELL_SOURCE_ATTR];

          return typeof value === 'string' && value
            ? { 'data-inkwell-source': value }
            : {};
        },
      },
    };
  },
}).configure({
  openOnClick: false,
});
