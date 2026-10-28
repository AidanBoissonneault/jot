import { shallowRef } from 'vue';
import { describe, expect, it, vi } from 'vitest';
import { useEditorDropHandling } from '@/entrypoints/sidepanel/composables/useEditorDropHandling';

describe('editor image paste handling', () => {
  it('intercepts clipboard image files and routes them through the shared file uploader', () => {
    const image = new File(['pixels'], 'clipboard.png', { type: 'image/png' });
    const handleUploadableImageDrop = vi.fn(async () => undefined);
    const preventDefault = vi.fn();
    const event = clipboardEvent({
      files: [],
      items: [{ kind: 'file', type: 'image/png', getAsFile: () => image }],
      getData: () => '',
    }, preventDefault);
    const handling = createHandling(handleUploadableImageDrop);

    expect(handling.handlePaste({} as never, event)).toBe(true);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(handleUploadableImageDrop).toHaveBeenCalledWith({ kind: 'file', file: image });
  });

  it('leaves ordinary HTML image paste to ProseMirror so image markup is retained', () => {
    const handleUploadableImageDrop = vi.fn(async () => undefined);
    const preventDefault = vi.fn();
    const event = clipboardEvent({
      files: [],
      items: [],
      getData: (type: string) => type === 'text/html'
        ? '<img src="https://example.com/pasted.png">'
        : '',
    }, preventDefault);
    const handling = createHandling(handleUploadableImageDrop);

    expect(handling.handlePaste({} as never, event)).toBe(false);
    expect(preventDefault).not.toHaveBeenCalled();
    expect(handleUploadableImageDrop).not.toHaveBeenCalled();
  });

  it('preserves images copied from the Jottathing editor with their existing block identity', () => {
    const handleUploadableImageDrop = vi.fn(async () => undefined);
    const preventDefault = vi.fn();
    const event = clipboardEvent({
      files: [new File(['pixels'], 'copied.png', { type: 'image/png' })],
      items: [],
      getData: (type: string) => type === 'text/html'
        ? '<div data-pm-slice="1 1 []"><img src="https://example.com/copied.png" data-jottathing-block-id="img-1"></div>'
        : '',
    }, preventDefault);
    const handling = createHandling(handleUploadableImageDrop);

    expect(handling.handlePaste({} as never, event)).toBe(false);
    expect(preventDefault).not.toHaveBeenCalled();
    expect(handleUploadableImageDrop).not.toHaveBeenCalled();
  });
});

function createHandling(handleUploadableImageDrop: (info: { kind: 'file'; file: File }) => Promise<void>) {
  return useEditorDropHandling({
    captureInsertion: {} as never,
    editor: shallowRef(undefined),
    handleUploadableAudioDrop: async () => undefined,
    handleUploadableImageDrop,
    saveEditorContent: async () => undefined,
  });
}

function clipboardEvent(
  clipboardData: ClipboardEvent['clipboardData'],
  preventDefault: () => void,
): ClipboardEvent {
  return { clipboardData, preventDefault } as unknown as ClipboardEvent;
}
