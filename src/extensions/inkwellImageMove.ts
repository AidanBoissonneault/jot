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
  const match = html.match(/<img\b[^>]*\bsrc\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/i);
  const droppedImageSrc = (match?.[1] ?? match?.[2] ?? match?.[3] ?? '').trim() || null;

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
