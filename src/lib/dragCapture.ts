import { parseCaptureSelectionPayload } from '@/src/lib/capturePayload';
import type { CaptureSelectionPayload } from '@/src/types/messages';

const DRAG_TTL_MS = 8_000;

type DragKind = 'heading' | 'text';
type PendingDrag = { payload: CaptureSelectionPayload; createdAt: number };

/** Keeps heading and text drags independent; mismatches stay available until expiry. */
export function createDragCaptureState() {
  const pending: Partial<Record<DragKind, PendingDrag>> = {};

  return {
    start(value: unknown, kind: DragKind): boolean {
      const payload = parseCaptureSelectionPayload(value);
      const isHeading = Boolean(payload?.highlightMeta.isHeading);
      if (!payload || isHeading !== (kind === 'heading')) return false;

      pending[kind] = { payload, createdAt: Date.now() };
      return true;
    },

    /** Consumes a fresh matching drag once; absent text accepts any captured text. */
    consume(requestedText: string | undefined, kind: DragKind): CaptureSelectionPayload | null {
      const drag = pending[kind];
      if (!drag || Date.now() - drag.createdAt > DRAG_TTL_MS) return null;

      const requested = requestedText?.replace(/\s+/g, ' ').trim();
      const captured = drag.payload.text.replace(/\s+/g, ' ').trim();
      if (
        requested &&
        requested !== captured &&
        !captured.includes(requested) &&
        !requested.includes(captured)
      ) return null;

      delete pending[kind];
      return drag.payload;
    },
  };
}
