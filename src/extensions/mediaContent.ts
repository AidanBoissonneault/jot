import type { DocumentContent } from '@/src/types/capture';

const TRANSIENT_URL_PATTERN = /^(blob:|data:)/i;

export function sanitizeMediaForSync(content: DocumentContent): DocumentContent {
  const sanitized = sanitizeNode(content);

  return sanitized ?? {
    ...content,
    type: content.type ?? 'doc',
    content: [],
  };
}

export function hasPendingTransientMedia(content: DocumentContent): boolean {
  if (content.type === 'image') {
    const attrs = content.attrs ?? {};
    const src = String(attrs.src ?? '');
    return isTransientUrl(src) && !attrs.notionFileUploadId;
  }

  return content.content?.some(hasPendingTransientMedia) ?? false;
}

export function mergeSyncedMediaContent(
  localContent: DocumentContent,
  syncedContent: DocumentContent | undefined,
): DocumentContent {
  if (!syncedContent) {
    return localContent;
  }

  return mergeNode(localContent, syncedContent);
}

export function markUnrecoverableTransientMedia(content: DocumentContent): DocumentContent {
  return markNode(content);
}

function sanitizeNode(node: DocumentContent): DocumentContent | undefined {
  if (node.type === 'image') {
    const attrs = node.attrs ?? {};
    const src = String(attrs.src ?? '');
    const hasUpload = Boolean(attrs.notionFileUploadId);
    const isTransient = isTransientUrl(src);

    if (isTransient && !hasUpload) {
      return undefined;
    }

    return {
      ...node,
      attrs: {
        ...attrs,
        ...(isTransient && hasUpload ? { uploadState: 'done' } : {}),
      },
    };
  }

  if (!node.content) {
    return node;
  }

  const content = node.content
    .map((child) => sanitizeNode(child))
    .filter((child): child is DocumentContent => Boolean(child));

  return {
    ...node,
    content,
  };
}

function mergeNode(localNode: DocumentContent, syncedNode: DocumentContent): DocumentContent {
  if (localNode.type === 'image' && syncedNode.type === 'image') {
    const syncedAttrs = syncedNode.attrs ?? {};
    const syncedSrc = String(syncedAttrs.src ?? '');

    if (isHttpUrl(syncedSrc)) {
      return {
        ...localNode,
        attrs: {
          ...localNode.attrs,
          src: syncedSrc,
          uploadState: 'done',
        },
      };
    }
  }

  if (!localNode.content?.length || !syncedNode.content?.length) {
    return localNode;
  }

  return {
    ...localNode,
    content: localNode.content.map((child, index) =>
      syncedNode.content?.[index] ? mergeNode(child, syncedNode.content[index]) : child,
    ),
  };
}

function markNode(node: DocumentContent): DocumentContent {
  if (node.type === 'image') {
    const attrs = node.attrs ?? {};
    const src = String(attrs.src ?? '');

    if (isTransientUrl(src) && !attrs.notionFileUploadId) {
      return {
        ...node,
        attrs: {
          ...attrs,
          uploadState: 'error',
        },
      };
    }
  }

  if (!node.content?.length) {
    return node;
  }

  return {
    ...node,
    content: node.content.map(markNode),
  };
}

function isTransientUrl(value: string) {
  return TRANSIENT_URL_PATTERN.test(value);
}

function isHttpUrl(value: string) {
  return /^https?:\/\//i.test(value);
}
