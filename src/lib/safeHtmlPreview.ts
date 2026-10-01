import { defaultTreeAdapter, parseFragment, serialize } from 'parse5';
import type { DefaultTreeAdapterTypes } from 'parse5';

const REMOVED_ELEMENTS = new Set([
  'applet',
  'base',
  'embed',
  'form',
  'frame',
  'frameset',
  'iframe',
  'link',
  'meta',
  'object',
  'portal',
  'script',
  'svg',
]);

const REMOVED_ATTRIBUTES = new Set([
  'action',
  'archive',
  'background',
  'cite',
  'classid',
  'codebase',
  'data',
  'formaction',
  'href',
  'itemid',
  'longdesc',
  'manifest',
  'ping',
  'poster',
  'profile',
  'src',
  'srcdoc',
  'srcset',
  'usemap',
  'xlink:href',
]);

const HTML_PREVIEW_CSP = [
  "default-src 'none'",
  "script-src 'none'",
  "style-src 'unsafe-inline'",
  'img-src data:',
  'font-src data:',
  'media-src data:',
  "connect-src 'none'",
  "frame-src 'none'",
  "form-action 'none'",
  "object-src 'none'",
  "base-uri 'none'",
].join('; ');

/** Keeps an HTML preview useful for layout while removing code and network navigation. */
export function sanitizeHtmlPreview(html: string): string {
  const fragment = parseFragment(html);
  sanitizeChildren(fragment);
  return serialize(fragment);
}

/** Wraps the sanitized fragment in an independently restricted preview document. */
export function safeHtmlPreviewDocument(html: string): string {
  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${HTML_PREVIEW_CSP}"></head><body>${sanitizeHtmlPreview(html)}</body></html>`;
}

function sanitizeChildren(parent: DefaultTreeAdapterTypes.ParentNode): void {
  for (const child of [...parent.childNodes]) {
    if (child.nodeName === '#comment' || child.nodeName === '#documentType') {
      defaultTreeAdapter.detachNode(child);
      continue;
    }

    if (!('tagName' in child)) continue;

    if (REMOVED_ELEMENTS.has(child.tagName)) {
      defaultTreeAdapter.detachNode(child);
      continue;
    }

    child.attrs = child.attrs.filter(({ name }) =>
      !REMOVED_ATTRIBUTES.has(name.toLowerCase()) && !name.toLowerCase().startsWith('on'),
    );

    if (child.tagName === 'template' && 'content' in child) {
      sanitizeChildren(child.content);
    }
    sanitizeChildren(child);
  }
}
