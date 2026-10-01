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

/** Keeps embedded local media backups while replacing content with a Notion snapshot. */
export function preserveLocalMediaSources(
  localContent: DocumentContent,
  syncedContent: DocumentContent,
): DocumentContent {
  const localMediaByIdentity = new Map<string, DocumentContent>();
  collectLocalMedia(localContent, localMediaByIdentity);
  return retainLocalMediaSources(syncedContent, localMediaByIdentity);
}

export function markUnrecoverableTransientMedia(content: DocumentContent): DocumentContent {
  return markNode(content);
}

function sanitizeNode(node: DocumentContent): DocumentContent | undefined {
  if (isUploadableMediaNode(node)) {
    const attrs = node.attrs ?? {};
    const syncAttrs = { ...attrs };
    delete syncAttrs.localSrc;
    const src = String(attrs.src ?? '');
    const hasUpload = Boolean(attrs.notionFileUploadId);
    const isTransient = isTransientUrl(src);

    if (isTransient && !hasUpload) {
      return undefined;
    }

    return {
      ...node,
      attrs: {
        ...syncAttrs,
        ...(isTransient && hasUpload && /^data:/i.test(src) ? { src: '' } : {}),
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
      if (!mediaNodesShareIdentity(localNode, syncedNode)) return syncedNode;
      const localSource = localImageSource(localNode);
      const localAttrs = localNode.attrs ?? {};
      const identityAttrs = mediaIdentityAttributes(localAttrs, syncedAttrs);
      return {
        ...localNode,
        attrs: {
          ...syncedAttrs,
          ...localNode.attrs,
          ...identityAttrs,
          src: syncedSrc,
          ...(localSource ? { localSrc: localSource } : {}),
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

function collectLocalMedia(
  node: DocumentContent,
  mediaByIdentity: Map<string, DocumentContent>,
): void {
  if (node.type === 'image') {
    for (const identity of mediaIdentities(node)) {
      mediaByIdentity.set(identity, node);
    }
  }
  node.content?.forEach((child) => collectLocalMedia(child, mediaByIdentity));
}

function retainLocalMediaSources(
  node: DocumentContent,
  localMediaByIdentity: Map<string, DocumentContent>,
): DocumentContent {
  let nextNode = node;
  if (node.type === 'image') {
    const localNode = localMediaForSyncedNode(node, localMediaByIdentity);
    const localSource = localNode ? embeddedLocalMediaSource(localNode) : undefined;
    if (localSource) {
      nextNode = {
        ...node,
        attrs: { ...node.attrs, localSrc: localSource },
      };
    }
  }
  if (!nextNode.content?.length) return nextNode;
  return {
    ...nextNode,
    content: nextNode.content.map((child) =>
      retainLocalMediaSources(child, localMediaByIdentity),
    ),
  };
}

function mediaIdentities(node: DocumentContent): string[] {
  const attrs = node.attrs ?? {};
  const identities: string[] = [];
  const add = (kind: string, value: unknown) => {
    if (typeof value === 'string' && value.trim()) identities.push(`${kind}:${value}`);
  };
  add('upload', attrs.notionFileUploadId);
  add('block', attrs.notionBlockId);
  add('inkwell', attrs.inkwellBlockId);
  return identities;
}

function mediaNodesShareIdentity(localNode: DocumentContent, syncedNode: DocumentContent): boolean {
  const localAttrs = localNode.attrs ?? {};
  const syncedAttrs = syncedNode.attrs ?? {};
  const localUploadId = nonEmptyString(localAttrs.notionFileUploadId);
  const syncedUploadId = nonEmptyString(syncedAttrs.notionFileUploadId);
  if (localUploadId && syncedUploadId) return localUploadId === syncedUploadId;

  const localBlockId = nonEmptyString(localAttrs.notionBlockId);
  const syncedBlockId = nonEmptyString(syncedAttrs.notionBlockId);
  if (localBlockId && syncedBlockId) return localBlockId === syncedBlockId;

  const localInkwellId = nonEmptyString(localAttrs.inkwellBlockId);
  const syncedInkwellId = nonEmptyString(syncedAttrs.inkwellBlockId);
  if (localInkwellId && syncedInkwellId) return localInkwellId === syncedInkwellId;

  return !mediaIdentities(localNode).length || !mediaIdentities(syncedNode).length;
}

function mediaIdentityAttributes(
  localAttrs: Record<string, unknown>,
  syncedAttrs: Record<string, unknown>,
): Record<string, string> {
  const identityAttrs: Record<string, string> = {};
  for (const key of ['notionFileUploadId', 'notionBlockId', 'inkwellBlockId']) {
    const localValue = localAttrs[key];
    const syncedValue = syncedAttrs[key];
    const value = typeof syncedValue === 'string' && syncedValue.trim()
      ? syncedValue
      : localValue;
    if (typeof value === 'string' && value.trim()) identityAttrs[key] = value;
  }
  return identityAttrs;
}

function localMediaForSyncedNode(
  syncedNode: DocumentContent,
  localMediaByIdentity: Map<string, DocumentContent>,
): DocumentContent | undefined {
  const attrs = syncedNode.attrs ?? {};
  const uploadId = nonEmptyString(attrs.notionFileUploadId);
  if (uploadId) return localMediaByIdentity.get(`upload:${uploadId}`);

  const notionBlockId = nonEmptyString(attrs.notionBlockId);
  if (notionBlockId) return localMediaByIdentity.get(`block:${notionBlockId}`);

  const inkwellBlockId = nonEmptyString(attrs.inkwellBlockId);
  return inkwellBlockId
    ? localMediaByIdentity.get(`inkwell:${inkwellBlockId}`)
    : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function embeddedLocalMediaSource(node: DocumentContent): string | undefined {
  const attrs = node.attrs ?? {};
  const localSrc = String(attrs.localSrc ?? '');
  const src = String(attrs.src ?? '');
  if (/^data:image\//i.test(localSrc)) return localSrc;
  return /^data:image\//i.test(src) ? src : undefined;
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

    // Blob URLs die with their document; data URLs are deliberately persisted
    // so local-only media remains available across extension reloads.
    if (/^blob:/i.test(src) && !attrs.notionFileUploadId) {
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
  const value = node.attrs?.inkwellBlockId;
  return typeof value === 'string' && value ? value : undefined;
}

function mediaSrc(node: DocumentContent) {
  const value = node.attrs?.src;
  return typeof value === 'string' && value ? value : undefined;
}

function localImageSource(node: DocumentContent) {
  if (!node.attrs?.notionFileUploadId) return undefined;
  const localSrc = String(node.attrs.localSrc ?? '');
  if (/^data:image\//i.test(localSrc)) return localSrc;
  const src = String(node.attrs.src ?? '');
  return /^data:image\//i.test(src) ? src : undefined;
}
