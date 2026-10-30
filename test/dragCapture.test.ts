import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDragCaptureState } from '@/src/lib/dragCapture';
import type { CaptureSelectionPayload } from '@/src/types/messages';

function capture(text: string, isHeading = false): CaptureSelectionPayload {
  return {
    text,
    sourceUrl: 'https://example.test/article',
    pageTitle: 'Article',
    highlightMeta: { text, isHeading },
  };
}

describe('drag capture state', () => {
  afterEach(() => vi.useRealTimers());

  it('accepts only the matching heading or text capture kind', () => {
    const state = createDragCaptureState();
    const heading = capture('A heading', true);
    const text = capture('Body text');

    expect(state.start(text, 'heading')).toBe(false);
    expect(state.start(heading, 'heading')).toBe(true);
    expect(state.start(heading, 'text')).toBe(false);
    expect(state.start(text, 'text')).toBe(true);
    expect(state.consume(undefined, 'heading')).toEqual(heading);
    expect(state.consume(undefined, 'text')).toEqual(text);
  });

  it('normalizes whitespace, allows partial text matches, and keeps mismatches available', () => {
    const state = createDragCaptureState();
    const text = capture('A   useful\nselection');
    state.start(text, 'text');

    expect(state.consume('unrelated text', 'text')).toBeNull();
    expect(state.consume('useful selection', 'text')).toEqual(text);
    expect(state.consume(undefined, 'text')).toBeNull();
  });

  it('expires after eight seconds but includes the exact expiry boundary', () => {
    vi.useFakeTimers();
    const state = createDragCaptureState();
    const text = capture('Still fresh');
    state.start(text, 'text');

    vi.advanceTimersByTime(8_000);
    expect(state.consume(undefined, 'text')).toEqual(text);

    state.start(text, 'text');
    vi.advanceTimersByTime(8_001);
    expect(state.consume(undefined, 'text')).toBeNull();
  });
});
