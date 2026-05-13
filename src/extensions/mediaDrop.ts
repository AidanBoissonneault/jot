export const IMAGE_UPLOAD_MAX_BYTES = 20 * 1024 * 1024;
export const AUDIO_UPLOAD_MAX_BYTES = 20 * 1024 * 1024;

export type UploadableImageDrop = { kind: 'file'; file: File };
export type UploadableAudioDrop = { kind: 'file'; file: File };
export type InkwellImageMovePayload = {
  kind: 'image';
  pos: number;
  attrs: Record<string, unknown>;
};

type RememberedImageMovePayload = InkwellImageMovePayload & {
  createdAt: number;
};

type DropData = {
  files?: FileList | File[] | null;
  types?: readonly string[] | null;
  getData(type: string): string;
};

const IMAGE_URL_PATTERN = /\.(png|jpe?g|gif|webp|svg|avif)(\?[^#]*)?(#.*)?$/i;
const AUDIO_URL_PATTERN = /\.(mp3|mpeg|m4a|aac|wav|ogg|oga|opus|webm)(\?[^#]*)?(#.*)?$/i;
const YOUTUBE_HOST_PATTERN = /(^|\.)youtube(?:-nocookie)?\.com$|(^|\.)youtu\.be$/i;
export const INKWELL_IMAGE_MOVE_MIME = 'application/x-inkwell-image-move';
const PROSEMIRROR_SLICE_MIME = 'application/x-prosemirror-slice';
const IMAGE_MOVE_MEMORY_TTL_MS = 30_000;

let rememberedImageMovePayload: RememberedImageMovePayload | null = null;

export function isEditorInternalDrop(dataTransfer: DropData | null | undefined): boolean {
  return Array.from(dataTransfer?.types ?? []).includes(PROSEMIRROR_SLICE_MIME);
}

export function rememberInkwellImageMovePayload(payload: InkwellImageMovePayload) {
  rememberedImageMovePayload = {
    ...payload,
    createdAt: Date.now(),
  };
}

export function readInkwellImageMovePayload(
  dataTransfer: DropData | null | undefined,
): InkwellImageMovePayload | null {
  const raw = dataTransfer?.getData(INKWELL_IMAGE_MOVE_MIME) ?? '';
  const parsedPayload = parseInkwellImageMovePayload(raw);

  if (parsedPayload) {
    rememberedImageMovePayload = null;
    return parsedPayload;
  }

  const rememberedPayload = readRememberedImageMovePayload(dataTransfer);

  if (rememberedPayload) {
    rememberedImageMovePayload = null;
    return rememberedPayload;
  }

  return null;
}

function parseInkwellImageMovePayload(raw: string): InkwellImageMovePayload | null {
  if (!raw) {
    return null;
  }

  try {
    const payload = JSON.parse(raw) as Partial<InkwellImageMovePayload>;

    if (
      payload.kind === 'image' &&
      typeof payload.pos === 'number' &&
      Number.isInteger(payload.pos) &&
      payload.pos >= 0 &&
      payload.attrs &&
      typeof payload.attrs === 'object' &&
      !Array.isArray(payload.attrs)
    ) {
      return {
        kind: 'image',
        pos: payload.pos,
        attrs: payload.attrs as Record<string, unknown>,
      };
    }
  } catch {
    return null;
  }

  return null;
}

function readRememberedImageMovePayload(
  dataTransfer: DropData | null | undefined,
): InkwellImageMovePayload | null {
  if (
    !rememberedImageMovePayload ||
    Date.now() - rememberedImageMovePayload.createdAt > IMAGE_MOVE_MEMORY_TTL_MS
  ) {
    rememberedImageMovePayload = null;
    return null;
  }

  if (hasImageLikeDropData(dataTransfer)) {
    return rememberedImageMovePayloadWithoutTimestamp();
  }

  return null;
}

function hasImageLikeDropData(dataTransfer: DropData | null | undefined): boolean {
  const types = Array.from(dataTransfer?.types ?? []);
  const src = String(rememberedImageMovePayload?.attrs.src ?? '');
  const html = dataTransfer?.getData('text/html') ?? '';
  const plainText = dataTransfer?.getData('text/plain') ?? '';
  const droppedImageSrc = imageSrcFromHtml(html);

  return (
    isEditorInternalDrop(dataTransfer) ||
    types.includes('Files') ||
    Boolean(droppedImageSrc) ||
    plainText.trim() === src ||
    /^blob:chrome-extension:\/\//i.test(plainText.trim())
  );
}

function rememberedImageMovePayloadWithoutTimestamp(): InkwellImageMovePayload {
  return {
    kind: rememberedImageMovePayload?.kind ?? 'image',
    pos: rememberedImageMovePayload?.pos ?? 0,
    attrs: rememberedImageMovePayload?.attrs ?? {},
  };
}

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
  const file = Array.from(dataTransfer?.files ?? []).find((item) =>
    item.type.startsWith('image/'),
  );

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
  return file.type.startsWith('image/') && file.size <= IMAGE_UPLOAD_MAX_BYTES;
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
