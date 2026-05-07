import { describe, expect, it } from 'vitest';
import {
  hasPendingTransientMedia,
  markUnrecoverableTransientMedia,
  mergeSyncedMediaContent,
  sanitizeMediaForSync,
} from '@/src/extensions/mediaContent';
import type { DocumentContent } from '@/src/types/capture';

describe('media content helpers', () => {
  it('detects pending blob images and removes them from sync content', () => {
    const content = doc([
      image({ src: 'blob:chrome-extension://preview' }),
      paragraph('Saved text'),
    ]);

    expect(hasPendingTransientMedia(content)).toBe(true);
    expect(sanitizeMediaForSync(content).content).toEqual([paragraph('Saved text')]);
  });

  it('allows uploaded blob previews to sync by file upload id', () => {
    const content = doc([
      image({
        src: 'blob:chrome-extension://preview',
        notionFileUploadId: 'upload-id',
        uploadState: 'uploading',
      }),
    ]);

    expect(hasPendingTransientMedia(content)).toBe(false);
    expect(sanitizeMediaForSync(content).content?.[0].attrs).toMatchObject({
      src: 'blob:chrome-extension://preview',
      notionFileUploadId: 'upload-id',
      uploadState: 'done',
    });
  });

  it('merges Notion file URLs into local uploaded image previews', () => {
    const local = doc([
      image({
        src: 'blob:chrome-extension://preview',
        notionFileUploadId: 'upload-id',
      }),
    ]);
    const synced = doc([image({ src: 'https://secure.notion-static.com/image.png' })]);

    expect(mergeSyncedMediaContent(local, synced).content?.[0].attrs).toMatchObject({
      src: 'https://secure.notion-static.com/image.png',
      uploadState: 'done',
    });
  });

  it('marks existing unsynced blob images as unrecoverable', () => {
    const content = markUnrecoverableTransientMedia(
      doc([image({ src: 'blob:chrome-extension://stale' })]),
    );

    expect(content.content?.[0].attrs).toMatchObject({
      src: 'blob:chrome-extension://stale',
      uploadState: 'error',
    });
  });
});

function doc(content: DocumentContent[]): DocumentContent {
  return {
    type: 'doc',
    content,
  };
}

function paragraph(text: string): DocumentContent {
  return {
    type: 'paragraph',
    content: [{ type: 'text', text }],
  };
}

function image(attrs: Record<string, unknown>): DocumentContent {
  return {
    type: 'image',
    attrs,
  };
}
