/**
 * @file Reads capture and heading payloads from drag events and the extension runtime.
 */
import type {
  CaptureSelectionPayload,
  ConsumeHeadingDragMessage,
  ConsumeTextDragMessage,
} from '@/src/types/messages';

const INKWELL_DRAG_MIME = 'application/x-inkwell-capture';
const INKWELL_HEADING_DRAG_MIME = 'application/x-inkwell-heading-capture';
const INKWELL_CAPTURE_DATA_ATTR = 'data-inkwell-capture';

/** Reads a selection payload from custom drag data or its embedded HTML fallback. */
export function readInkwellDropPayload(event: DragEvent): CaptureSelectionPayload | null {
  const rawPayload = event.dataTransfer?.getData(INKWELL_DRAG_MIME);

  if (rawPayload) {
    try {
      return JSON.parse(rawPayload) as CaptureSelectionPayload;
    } catch {
      // Cross-origin drags can expose the standard HTML flavor while hiding
      // or rewriting a custom MIME flavor. Try the embedded HTML payload.
    }
  }

  try {
    const html = event.dataTransfer?.getData('text/html');
    if (!html) return null;
    const document = new DOMParser().parseFromString(html, 'text/html');
    const embedded = document
      .querySelector(`[${INKWELL_CAPTURE_DATA_ATTR}]`)
      ?.getAttribute(INKWELL_CAPTURE_DATA_ATTR);
    return embedded ? (JSON.parse(embedded) as CaptureSelectionPayload) : null;
  } catch {
    return null;
  }
}

/** Identifies a pending heading drag before consuming its one-shot payload. */
export function isLikelyHeadingDrop(event: DragEvent): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes(INKWELL_HEADING_DRAG_MIME);
}

/** Identifies plain-text and selection drags that the editor should capture. */
export function isLikelyTextCaptureDrop(event: DragEvent): boolean {
  const types = Array.from(event.dataTransfer?.types ?? []);
  return (
    !types.includes(INKWELL_HEADING_DRAG_MIME) &&
    (types.includes(INKWELL_DRAG_MIME) ||
      (!types.includes('text/uri-list') &&
        (types.includes('text/plain') || types.includes('text/html'))))
  );
}

/** Consumes the pending text-selection drag payload from the extension worker. */
export async function consumeTextDragPayload(
  text: string,
): Promise<CaptureSelectionPayload | null> {
  return browser.runtime
    .sendMessage({
      type: 'inkwell.consumeTextDrag',
      payload: { text },
    } satisfies ConsumeTextDragMessage)
    .then((payload: unknown) => {
      const dragPayload = payload as CaptureSelectionPayload | null;
      return dragPayload && !dragPayload.highlightMeta?.isHeading ? dragPayload : null;
    })
    .catch(() => null);
}

/** Consumes the pending heading drag payload from the extension worker. */
export async function consumeHeadingDropPayload(
  event: DragEvent,
): Promise<CaptureSelectionPayload | null> {
  const text = event.dataTransfer?.getData('text/plain')?.replace(/\s+/g, ' ').trim();

  return browser.runtime
    .sendMessage({
      type: 'inkwell.consumeHeadingDrag',
      payload: { text },
    } satisfies ConsumeHeadingDragMessage)
    .then((payload: unknown) => {
      const dragPayload = payload as CaptureSelectionPayload | null;
      return dragPayload?.highlightMeta?.isHeading ? dragPayload : null;
    })
    .catch(() => null);
}

/** Builds a source payload for fallback text drops from the active tab. */
export async function capturePayloadFromActiveTab(
  text: string,
): Promise<CaptureSelectionPayload | null> {
  const normalizedText = text.replace(/\r\n/g, '\n').trimEnd();
  if (!normalizedText.trim()) return null;

  try {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    const sourceUrl = safeHttpUrl(tab?.url);
    if (!sourceUrl) return null;

    return {
      text: normalizedText,
      sourceUrl,
      pageTitle: tab?.title ?? '',
      highlightMeta: { text: normalizedText },
    };
  } catch {
    return null;
  }
}

function safeHttpUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;

  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}
