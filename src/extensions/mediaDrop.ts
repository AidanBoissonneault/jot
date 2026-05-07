export const IMAGE_UPLOAD_MAX_BYTES = 20 * 1024 * 1024;

export type UploadableImageDrop = { kind: 'file'; file: File };

type DropData = {
  files?: FileList | File[] | null;
  getData(type: string): string;
};

const IMAGE_URL_PATTERN = /\.(png|jpe?g|gif|webp|svg|avif)(\?[^#]*)?(#.*)?$/i;

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

export function peekUploadableImageDrop(
  dataTransfer: DropData | null | undefined,
): UploadableImageDrop | null {
  const file = Array.from(dataTransfer?.files ?? []).find((item) =>
    item.type.startsWith('image/'),
  );

  return file ? { kind: 'file', file } : null;
}

export function isUploadableImageFile(file: File): boolean {
  return file.type.startsWith('image/') && file.size <= IMAGE_UPLOAD_MAX_BYTES;
}

function imageSrcFromHtml(html: string): string | null {
  const match = html.match(/<img\b[^>]*\bsrc\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/i);
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
