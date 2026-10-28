import { shallowRef } from 'vue';
import { Schema } from '@tiptap/pm/model';
import { EditorState } from '@tiptap/pm/state';
import { describe, expect, it, vi } from 'vitest';
import { useEditorDropHandling } from '@/entrypoints/sidepanel/composables/useEditorDropHandling';

describe('editor image drop handling', () => {
  it('routes a dropped image file through the same upload flow as clipboard and file chooser', () => {
    const file = new File(['pixels'], 'dropped.png', { type: 'image/png' });
    const uploadImage = vi.fn(async () => undefined);
    const preventDefault = vi.fn();
    const handling = createHandling(uploadImage);
    const { view } = createEditorView();

    expect(handling.handleDrop(view as never, dropEvent({ files: [file] }, preventDefault))).toBe(true);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(uploadImage).toHaveBeenCalledWith({ kind: 'file', file });
  });

  it('inserts an external image URL dragged from a webpage', () => {
    const uploadImage = vi.fn(async () => undefined);
    const saveEditorContent = vi.fn(async () => undefined);
    const { view, insertedImages, editor } = createEditorView();
    const handling = createHandling(uploadImage, saveEditorContent, editor);
    const preventDefault = vi.fn();

    expect(handling.handleDrop(
      view as never,
      dropEvent({
        'text/html': '<img src="https://example.com/image-without-extension">',
      }, preventDefault),
    )).toBe(true);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(insertedImages).toEqual(['https://example.com/image-without-extension']);
    expect(saveEditorContent).toHaveBeenCalledOnce();
    expect(uploadImage).not.toHaveBeenCalled();
  });
});

function createHandling(
  handleUploadableImageDrop: (info: { kind: 'file'; file: File }) => Promise<void>,
  saveEditorContent = vi.fn(async () => undefined),
  editor = shallowRef(undefined),
) {
  return useEditorDropHandling({
    captureInsertion: {
      insertCapturedTextAtDrop: vi.fn(),
      insertLinkedHeadingAtDrop: vi.fn(),
      insertPlainTextAtDrop: vi.fn(),
    } as never,
    editor,
    handleUploadableAudioDrop: async () => undefined,
    handleUploadableImageDrop,
    saveEditorContent,
  });
}

function createEditorView() {
  const schema = new Schema({
    nodes: {
      doc: { content: 'block*' },
      paragraph: { group: 'block', content: 'text*' },
      image: { group: 'block', attrs: { src: { default: '' } }, atom: true },
      text: { group: 'inline' },
    },
  });
  let state = EditorState.create({
    schema,
    doc: schema.node('doc', null, [schema.node('paragraph')]),
  });
  const insertedImages: string[] = [];
  const editorChain = {
    focus: vi.fn(() => editorChain),
    setImage: vi.fn(({ src }: { src: string }) => {
      insertedImages.push(src);
      return editorChain;
    }),
    setAudio: vi.fn(() => editorChain),
    setYoutubeVideo: vi.fn(() => editorChain),
    run: vi.fn(() => true),
  };
  const editor = shallowRef({ chain: () => editorChain });
  const view = {
    get state() { return state; },
    posAtCoords: vi.fn(() => ({ pos: 1 })),
    dispatch: vi.fn((transaction) => { state = state.apply(transaction); }),
    focus: vi.fn(),
  };
  return { view, insertedImages, editorChain, editor };
}

function dropEvent(values: Record<string, string | File[]>, preventDefault: () => void): DragEvent {
  const files = Array.isArray(values.files) ? values.files : [];
  const data = values as Record<string, string>;
  return {
    dataTransfer: {
      files,
      types: Object.keys(data),
      getData: (type: string) => typeof data[type] === 'string' ? data[type] : '',
    },
    clientX: 4,
    clientY: 8,
    preventDefault,
  } as unknown as DragEvent;
}
