import Link from '@tiptap/extension-link';
import type { SourceOpenPayload } from '@/src/types/messages';

export const JOT_SOURCE_ATTR = 'jotSource';

export function encodeJotSource(payload: SourceOpenPayload) {
  return JSON.stringify(payload);
}

export function decodeJotSource(value: unknown): SourceOpenPayload | null {
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

export const JotLink = Link.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      [JOT_SOURCE_ATTR]: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-jot-source'),
        renderHTML: (attributes) => {
          const value = attributes[JOT_SOURCE_ATTR];

          return typeof value === 'string' && value
            ? { 'data-jot-source': value }
            : {};
        },
      },
    };
  },
}).configure({
  openOnClick: false,
});
