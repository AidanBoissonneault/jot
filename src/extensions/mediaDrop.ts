export const IMAGE_UPLOAD_MAX_BYTES = 20 * 1024 * 1024;
export const AUDIO_UPLOAD_MAX_BYTES = 20 * 1024 * 1024;
export const SUPPORTED_IMAGE_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/heic',
  'image/svg+xml',
  'image/tiff',
  'image/vnd.microsoft.icon',
  'image/bmp',
  'image/apng',
] as const;
export const IMAGE_FILE_ACCEPT = [
  ...SUPPORTED_IMAGE_MIME_TYPES,
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif', '.heic', '.svg',
  '.tif', '.tiff', '.ico', '.bmp', '.apng',
].join(',');

export type UploadableImageDrop = { kind: 'file'; file: File };
export type UploadableAudioDrop = { kind: 'file'; file: File };

type DropData = {
  files?: FileList | File[] | null;
  items?: ArrayLike<{ kind?: string; type?: string; getAsFile?: () => File | null }> | null;
  types?: readonly string[] | null;
  getData(type: string): string;
};

type ClipboardImageData = Pick<DropData, 'files' | 'items'>;

const IMAGE_URL_PATTERN = /\.(png|jpe?g|gif|webp|svg|avif|heic|tif{1,2}|bmp|ico|apng)(\?[^#]*)?(#.*)?$/i;
const AUDIO_URL_PATTERN = /\.(mp3|mpeg|m4a|aac|wav|ogg|oga|opus|webm)(\?[^#]*)?(#.*)?$/i;
const YOUTUBE_HOST_PATTERN = /(^|\.)youtube(?:-nocookie)?\.com$|(^|\.)youtu\.be$/i;
const IMAGE_EXTENSION_MIME_TYPES: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  heic: 'image/heic',
  svg: 'image/svg+xml',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  ico: 'image/vnd.microsoft.icon',
  bmp: 'image/bmp',
  apng: 'image/apng',
};

export function readImageDropSrc(dataTransfer: DropData | null | undefined): string | null {
  const html = dataTransfer?.getData('text/html') ?? '';
  const htmlSrc = imageSrcFromHtml(html);

  if (htmlSrc && isPublicHttpUrl(htmlSrc)) {
    return htmlSrc;
  }

  const uriList = dataTransfer?.getData('text/uri-list') ?? '';
  const uri = firstUriListUrl(uriList);

  if (uri && isLikelyPublicImageUrl(uri)) {
    return uri;
  }

  const plainText = dataTransfer?.getData('text/plain') ?? '';
  const plainUrl = firstPlainTextUrl(plainText);

  return plainUrl && isLikelyPublicImageUrl(plainUrl) ? plainUrl : null;
}

export function readYoutubeDropSrc(dataTransfer: DropData | null | undefined): string | null {
  const html = dataTransfer?.getData('text/html') ?? '';
  const htmlHref = hrefFromHtml(html);

  if (htmlHref && isYoutubeVideoUrl(htmlHref)) {
    return htmlHref;
  }

  const uriList = dataTransfer?.getData('text/uri-list') ?? '';
  const uri = firstUriListUrl(uriList);

  if (uri && isYoutubeVideoUrl(uri)) {
    return uri;
  }

  const plainText = dataTransfer?.getData('text/plain') ?? '';
  const plainUrl = firstPlainTextUrl(plainText);

  return plainUrl && isYoutubeVideoUrl(plainUrl) ? plainUrl : null;
}

export function readAudioDropSrc(dataTransfer: DropData | null | undefined): string | null {
  const html = dataTransfer?.getData('text/html') ?? '';
  const htmlSrc = audioSrcFromHtml(html);

  if (htmlSrc && isLikelyPublicAudioUrl(htmlSrc)) {
    return htmlSrc;
  }

  const htmlHref = hrefFromHtml(html);

  if (htmlHref && isLikelyPublicAudioUrl(htmlHref)) {
    return htmlHref;
  }

  const uriList = dataTransfer?.getData('text/uri-list') ?? '';
  const uri = firstUriListUrl(uriList);

  if (uri && isLikelyPublicAudioUrl(uri)) {
    return uri;
  }

  const plainText = dataTransfer?.getData('text/plain') ?? '';
  const plainUrl = firstPlainTextUrl(plainText);

  return plainUrl && isLikelyPublicAudioUrl(plainUrl) ? plainUrl : null;
}

export function peekUploadableImageDrop(
  dataTransfer: DropData | null | undefined,
): UploadableImageDrop | null {
  const file = imageFileFromTransfer(dataTransfer);

  return file ? { kind: 'file', file } : null;
}

/** Reads image files from clipboard files or file-kind clipboard items. */
export function peekUploadableImageClipboard(
  clipboardData: ClipboardImageData | null | undefined,
): UploadableImageDrop | null {
  const file = imageFileFromTransfer(clipboardData);
  return file ? { kind: 'file', file } : null;
}

export function peekUploadableAudioDrop(
  dataTransfer: DropData | null | undefined,
): UploadableAudioDrop | null {
  const file = Array.from(dataTransfer?.files ?? []).find((item) =>
    item.type.startsWith('audio/'),
  );

  return file ? { kind: 'file', file } : null;
}

export function isUploadableImageFile(file: File): boolean {
  return isSupportedImageMimeType(imageMimeTypeForFile(file)) &&
    file.size > 0 && file.size <= IMAGE_UPLOAD_MAX_BYTES;
}

export function isSupportedImageMimeType(mimeType: string): boolean {
  const normalizedMime = normalizeImageMimeType(mimeType);
  return SUPPORTED_IMAGE_MIME_TYPES.includes(
    normalizedMime as (typeof SUPPORTED_IMAGE_MIME_TYPES)[number],
  );
}

/** Resolves browser MIME aliases and missing MIME types from common image extensions. */
export function imageMimeTypeForFile(file: File): string {
  const declaredMime = normalizeImageMimeType(file.type);
  if (isSupportedImageMimeType(declaredMime)) return declaredMime;
  if (declaredMime && declaredMime !== 'application/octet-stream' && declaredMime !== 'binary/octet-stream') {
    return declaredMime;
  }
  const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
  return IMAGE_EXTENSION_MIME_TYPES[extension] ?? '';
}

function normalizeImageMimeType(mimeType: string): string {
  const normalizedMime = mimeType.trim().toLowerCase();
  return normalizedMime === 'image/x-icon' ? 'image/vnd.microsoft.icon' : normalizedMime;
}

function imageFileFromTransfer(data: ClipboardImageData | null | undefined): File | null {
  const file = Array.from(data?.files ?? []).find((candidate) => candidate.type.startsWith('image/'));
  if (file) return file;

  for (const item of Array.from(data?.items ?? [])) {
    if (item.kind !== 'file' || !item.type?.toLowerCase().startsWith('image/')) continue;
    const itemFile = item.getAsFile?.();
    if (!itemFile) continue;
    if (itemFile.type) return itemFile;
    return new File([itemFile], itemFile.name || 'pasted-image', {
      type: item.type.toLowerCase(),
      lastModified: itemFile.lastModified,
    });
  }

  return null;
}

export function isUploadableAudioFile(file: File): boolean {
  return file.type.startsWith('audio/') && file.size <= AUDIO_UPLOAD_MAX_BYTES;
}

function imageSrcFromHtml(html: string): string | null {
  const match = html.match(/<img\b[^>]*\bsrc\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/i);
  return (match?.[1] ?? match?.[2] ?? match?.[3] ?? '').trim() || null;
}

function audioSrcFromHtml(html: string): string | null {
  const sourceMatch = html.match(/<source\b[^>]*\bsrc\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/i);
  const audioMatch = html.match(/<audio\b[^>]*\bsrc\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/i);
  return (
    sourceMatch?.[1] ??
    sourceMatch?.[2] ??
    sourceMatch?.[3] ??
    audioMatch?.[1] ??
    audioMatch?.[2] ??
    audioMatch?.[3] ??
    ''
  ).trim() || null;
}

function hrefFromHtml(html: string): string | null {
  const match = html.match(/<a\b[^>]*\bhref\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/i);
  return (match?.[1] ?? match?.[2] ?? match?.[3] ?? '').trim() || null;
}

function firstUriListUrl(uriList: string): string | null {
  return uriList
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith('#')) ?? null;
}

function firstPlainTextUrl(text: string): string | null {
  return text.trim().split(/\s+/)[0] || null;
}

function isPublicHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function isLikelyPublicImageUrl(value: string): boolean {
  return isPublicHttpUrl(value) && IMAGE_URL_PATTERN.test(value);
}

function isLikelyPublicAudioUrl(value: string): boolean {
  return isPublicHttpUrl(value) && AUDIO_URL_PATTERN.test(value);
}

function isYoutubeVideoUrl(value: string): boolean {
  if (!isPublicHttpUrl(value)) {
    return false;
  }

  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();

    if (!YOUTUBE_HOST_PATTERN.test(host)) {
      return false;
    }

    if (host.endsWith('youtu.be')) {
      return url.pathname.length > 1;
    }

    return (
      Boolean(url.searchParams.get('v')) ||
      /^\/(embed|shorts|v)\/[\w-]+/i.test(url.pathname)
    );
  } catch {
    return false;
  }
}
