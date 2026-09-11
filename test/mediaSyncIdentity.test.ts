import { describe, expect, it, vi } from 'vitest';
import { importManagedBlocks } from '@/apps/worker/src/importManagedBlocks';
import { normalizeSyncedMediaContent } from '@/apps/worker/src/pageSync';

describe('media sync identity', () => {
  it('keeps the upload id when a Notion pull replaces an expired signed URL', async () => {
    const store = {
      blockMappings: {
        'page-1': [{
          localPageId: 'page-1',
          inkwellBlockId: 'image-1',
          localNodeId: 'image-1',
          notionBlockId: 'notion-image-1',
          kind: 'media',
          order: 0,
          oldState: null,
          newState: {
            object: 'block',
            type: 'image',
            image: { type: 'file_upload', file_upload: { id: 'upload-1' } },
          },
        }],
      },
    };
    const listAllBlockChildren = vi.fn(async () => [{
      id: 'notion-image-1',
      type: 'image',
      image: {
        type: 'file',
        file: { url: 'https://secure.notion-static.com/fresh-image.png?expires=2' },
      },
    }]);

    const content = await importManagedBlocks({
      store,
      page: { id: 'page-1', notionPageId: 'notion-page-1' },
      listAllBlockChildren,
      hash: (value: string) => value,
    });

    expect(content?.content?.[0].attrs).toMatchObject({
      src: 'https://secure.notion-static.com/fresh-image.png?expires=2',
      inkwellBlockId: 'image-1',
      notionBlockId: 'notion-image-1',
      notionFileUploadId: 'upload-1',
      uploadState: 'done',
    });
    expect(store.blockMappings['page-1'][0].newState).toMatchObject({
      type: 'image',
      image: { type: 'file_upload', file_upload: { id: 'upload-1' } },
    });
  });

  it('records the Notion block id when an uploaded image is attached', () => {
    const content = normalizeSyncedMediaContent(
      {
        type: 'doc',
        content: [{
          type: 'image',
          attrs: {
            src: 'blob:chrome-extension://preview',
            notionFileUploadId: 'upload-1',
            uploadState: 'uploading',
          },
        }],
      },
      [{
        id: 'notion-image-1',
        type: 'image',
        image: { file: { url: 'https://secure.notion-static.com/image.png?expires=2' } },
      }],
    );

    expect(content.content[0].attrs).toMatchObject({
      src: 'https://secure.notion-static.com/image.png?expires=2',
      notionBlockId: 'notion-image-1',
      notionFileUploadId: 'upload-1',
      uploadState: 'done',
    });
  });
});
