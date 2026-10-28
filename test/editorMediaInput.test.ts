import { ref, shallowRef } from 'vue';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Editor } from '@tiptap/core';
import { useEditorMedia } from '@/entrypoints/sidepanel/composables/useEditorMedia';
import type { EditorMenu } from '@/entrypoints/sidepanel/components/editor/editorToolbarContext';

const notionClientMock = vi.hoisted(() => ({ uploadMedia: vi.fn() }));
vi.mock('@/src/services/notionClient', () => ({ notionClient: notionClientMock }));

describe('editor image file intake', () => {
  beforeEach(() => notionClientMock.uploadMedia.mockReset());

  it('inserts an external image URL entered in the media toolbar', () => {
    const { media, imageNodes, saveEditorContent, activeEditorMenu } = setupMedia({ connected: false, online: false });
    media.imageUrlDraft.value = 'https://example.com/toolbar-image';

    media.insertImage();

    expect(imageNodes).toEqual([{
      type: { name: 'image' },
      attrs: { src: 'https://example.com/toolbar-image' },
    }]);
    expect(media.imageUrlDraft.value).toBe('');
    expect(activeEditorMenu.value).toBeNull();
    expect(saveEditorContent).toHaveBeenCalledOnce();
  });

  it('inserts the selected image locally when Notion is offline', async () => {
    const { media, editor, imageNodes, saveEditorContent } = setupMedia({ connected: false, online: false });
    const input = imageInput(new File(['pixels'], 'offline.png', { type: 'image/png' }));

    await media.handleImageFileInput({ currentTarget: input } as unknown as Event);

    expect(input.value).toBe('');
    expect(imageNodes).toHaveLength(1);
    expect(imageNodes[0].attrs).toMatchObject({
      src: 'data:image/png;base64,cGl4ZWxz',
      uploadState: 'local',
      mimeType: 'image/png',
      filename: 'offline.png',
    });
    expect(imageNodes[0].attrs.jottathingBlockId).toEqual(expect.any(String));
    expect(notionClientMock.uploadMedia).not.toHaveBeenCalled();
    expect(saveEditorContent).toHaveBeenCalledTimes(2);
    expect(editor.value).toBeDefined();
  });

  it('saves an uploading lease and attaches the Notion file id to that exact image', async () => {
    notionClientMock.uploadMedia.mockResolvedValue('upload-id-1');
    const { media, imageNodes, saveEditorContent } = setupMedia({ connected: true, online: true });
    const file = new File(['same pixels'], 'image.png', { type: 'image/png' });

    await media.handleUploadableImageFile(file);

    expect(notionClientMock.uploadMedia).toHaveBeenCalledWith(file, 'image/png', 'image.png');
    expect(imageNodes).toHaveLength(1);
    expect(imageNodes[0].attrs).toMatchObject({
      notionFileUploadId: 'upload-id-1',
      uploadState: 'done',
    });
    expect(imageNodes[0].attrs.uploadStartedAt).toBeUndefined();
    expect(saveEditorContent).toHaveBeenCalledTimes(2);
  });

  it('keeps identical pasted files separate while concurrent uploads finish', async () => {
    notionClientMock.uploadMedia
      .mockResolvedValueOnce('upload-id-a')
      .mockResolvedValueOnce('upload-id-b');
    const { media, imageNodes } = setupMedia({ connected: true, online: true });
    const fileA = new File(['identical bytes'], 'same.png', { type: 'image/png' });
    const fileB = new File(['identical bytes'], 'same.png', { type: 'image/png' });

    await Promise.all([
      media.handleUploadableImageFile(fileA),
      media.handleUploadableImageFile(fileB),
    ]);

    expect(imageNodes).toHaveLength(2);
    expect(imageNodes[0].attrs.jottathingBlockId).not.toBe(imageNodes[1].attrs.jottathingBlockId);
    expect(imageNodes.map((node) => node.attrs.notionFileUploadId)).toEqual([
      'upload-id-a',
      'upload-id-b',
    ]);
  });

  it('surfaces unreadable and unsupported files without inserting broken image nodes', async () => {
    const { media, imageNodes, uiMessage } = setupMedia({ connected: false, online: false });

    await media.handleUploadableImageFile(new File(['raw'], 'image.raw', { type: 'image/x-raw' }));
    expect(uiMessage.value).toBe('Use an image format supported by Notion.');
    expect(imageNodes).toHaveLength(0);

    await media.handleUploadableImageFile(new File([], 'empty.png', { type: 'image/png' }));
    expect(uiMessage.value).toBe('The selected image file is empty.');
    expect(imageNodes).toHaveLength(0);

    await media.handleUploadableImageFile(new File(
      [new Uint8Array(20 * 1024 * 1024 + 1)],
      'oversized.png',
      { type: 'image/png' },
    ));
    expect(uiMessage.value).toBe('Images must be 20 MB or smaller.');
    expect(imageNodes).toHaveLength(0);
  });
});

function setupMedia({ connected, online }: { connected: boolean; online: boolean }) {
  const imageNodes: Array<{ type: { name: string }; attrs: Record<string, unknown> }> = [];
  const saveEditorContent = vi.fn(async () => undefined);
  const editorInstance = {
    chain() {
      const chain = {
        focus: vi.fn(() => chain),
        setImage: vi.fn((attrs: Record<string, unknown>) => {
          imageNodes.push({ type: { name: 'image' }, attrs });
          return chain;
        }),
        setAudio: vi.fn(() => chain),
        command: vi.fn((callback: (context: { tr: { setNodeMarkup: (...args: unknown[]) => void } }) => unknown) => {
          callback({
            tr: {
              setNodeMarkup: (position: number, _type: unknown, attrs: Record<string, unknown>) => {
                if (imageNodes[position]) imageNodes[position].attrs = attrs;
              },
            },
          });
          return chain;
        }),
        run: vi.fn(() => true),
      };
      return chain;
    },
    state: {
      selection: { from: 0 },
      doc: {
        descendants(callback: (node: typeof imageNodes[number], position: number) => void) {
          imageNodes.forEach(callback);
        },
      },
    },
  } as unknown as Editor;
  const editor = shallowRef<Editor | undefined>(editorInstance);
  const uiMessage = ref('');
  const activeEditorMenu = ref<EditorMenu>('media');
  const media = useEditorMedia(
    editor,
    { syncConfig: { connected }, isOnline: online } as never,
    activeEditorMenu,
    uiMessage,
    vi.fn(),
    vi.fn(),
    saveEditorContent,
  );

  return { media, editor, imageNodes, saveEditorContent, uiMessage, activeEditorMenu };
}

function imageInput(file: File) {
  return {
    files: [file],
    value: 'C:\\fakepath\\image.png',
  };
}
