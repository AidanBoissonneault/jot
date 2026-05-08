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
  if (isUploadableMediaNode(content)) {
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
  if (isUploadableMediaNode(node)) {
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
  if (
    isUploadableMediaNode(localNode) &&
    localNode.type === syncedNode.type
  ) {
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
    content: mergeContent(localNode.content, syncedNode.content),
  };
}

function mergeContent(
  localContent: DocumentContent[],
  syncedContent: DocumentContent[],
): DocumentContent[] {
  const localMediaIds = new Set(
    localContent
      .filter(isRenderableMediaNode)
      .map(nodeId)
      .filter((id): id is string => Boolean(id)),
  );
  const localMediaSources = new Set(
    localContent
      .filter(isRenderableMediaNode)
      .map(mediaSrc)
      .filter((src): src is string => Boolean(src)),
  );
  const merged = localContent.map((child, index) =>
    syncedContent[index] ? mergeNode(child, syncedContent[index]) : child,
  );

  syncedContent.forEach((syncedNode, index) => {
    if (
      !isRenderableMediaNode(syncedNode) ||
      hasMatchingMediaNode(syncedNode, localContent[index], localMediaIds, localMediaSources)
    ) {
      return;
    }

    const insertAt = Math.min(index, merged.length);
    merged.splice(insertAt, 0, syncedNode);
    const id = nodeId(syncedNode);
    const src = mediaSrc(syncedNode);

    if (id) localMediaIds.add(id);
    if (src) localMediaSources.add(src);
  });

  return merged;
}

function markNode(node: DocumentContent): DocumentContent {
  if (isUploadableMediaNode(node)) {
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

function isUploadableMediaNode(node: DocumentContent) {
  return node.type === 'image' || node.type === 'audio';
}

function isRenderableMediaNode(node: DocumentContent) {
  if (!['image', 'audio', 'youtube'].includes(String(node.type))) {
    return false;
  }

  return isHttpUrl(mediaSrc(node) ?? '');
}

function hasMatchingMediaNode(
  node: DocumentContent,
  localNodeAtSameIndex: DocumentContent | undefined,
  localIds: Set<string>,
  localSources: Set<string>,
) {
  const id = nodeId(node);
  const src = mediaSrc(node);

  return Boolean(
    (isUploadableMediaNode(localNodeAtSameIndex ?? {}) &&
      localNodeAtSameIndex?.type === node.type) ||
    (id && localIds.has(id)) ||
    (src && localSources.has(src)),
  );
}

function nodeId(node: DocumentContent) {
  const value = node.attrs?.jotBlockId;
  return typeof value === 'string' && value ? value : undefined;
}

function mediaSrc(node: DocumentContent) {
  const value = node.attrs?.src;
  return typeof value === 'string' && value ? value : undefined;
}
