import Link from '@tiptap/extension-link';
import type { SourceOpenPayload } from '@/src/types/messages';

export const INKWELL_SOURCE_ATTR = 'inkwellSource';

export function encodeInkwellSource(payload: SourceOpenPayload) {
  return JSON.stringify(payload);
}

export function decodeInkwellSource(value: unknown): SourceOpenPayload | null {
  if (typeof value !== 'string' || !value) {
    return null;
  }

  try {
    const payload = JSON.parse(value) as SourceOpenPayload;

    if (!payload.sourceUrl || !payload.highlightMeta?.text) {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
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
