import { describe, expect, it } from 'vitest';
import {
  hasPendingTransientMedia,
  markUnrecoverableTransientMedia,
  mergeSyncedMediaContent,
  sanitizeMediaForSync,
} from '@/src/extensions/mediaContent';
import { doc, paragraph, image, audio } from './helpers/docBuilders';

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

  it('keeps local-only data media recoverable while excluding it from sync', () => {
    const localImage = image({
      src: 'data:image/png;base64,YQ==',
      filename: 'offline.png',
      uploadState: 'local',
    });
    const content = doc([localImage, paragraph('Saved locally')]);

    expect(markUnrecoverableTransientMedia(content).content?.[0]).toEqual(localImage);
    expect(hasPendingTransientMedia(content)).toBe(true);
    expect(sanitizeMediaForSync(content).content).toEqual([paragraph('Saved locally')]);
  });

  it('removes large data payloads after assigning a Notion upload id', () => {
    const content = doc([image({
      src: 'data:image/png;base64,YQ==',
      notionFileUploadId: 'upload-id',
      uploadState: 'done',
    })]);

    expect(sanitizeMediaForSync(content).content?.[0].attrs).toMatchObject({
      src: '',
      notionFileUploadId: 'upload-id',
      uploadState: 'done',
    });
  });

  it('handles transient audio uploads like image uploads', () => {
    const content = doc([
      audio({
        src: 'blob:chrome-extension://recording',
        notionFileUploadId: 'audio-upload-id',
        uploadState: 'uploading',
      }),
    ]);
    const synced = doc([audio({ src: 'https://secure.notion-static.com/recording.mp3' })]);

    expect(hasPendingTransientMedia(content)).toBe(false);
    expect(sanitizeMediaForSync(content).content?.[0].attrs).toMatchObject({
      src: 'blob:chrome-extension://recording',
      notionFileUploadId: 'audio-upload-id',
      uploadState: 'done',
    });
    expect(mergeSyncedMediaContent(content, synced).content?.[0].attrs).toMatchObject({
      src: 'https://secure.notion-static.com/recording.mp3',
      uploadState: 'done',
    });
  });

  it('keeps newly synced Notion images when preserving newer local content', () => {
    const local = doc([paragraph('Local draft')]);
    const synced = doc([
      paragraph('Local draft'),
      image({
        src: 'https://secure.notion-static.com/image.png',
        inkwellBlockId: 'remote-image',
      }),
    ]);

    expect(mergeSyncedMediaContent(local, synced).content).toEqual([
      paragraph('Local draft'),
      image({
        src: 'https://secure.notion-static.com/image.png',
        inkwellBlockId: 'remote-image',
      }),
    ]);
  });

  it('does not append non-media remote content while preserving local drafts', () => {
    const local = doc([paragraph('Local draft')]);
    const synced = doc([paragraph('Remote edit'), paragraph('Remote addition')]);

    expect(mergeSyncedMediaContent(local, synced).content).toEqual([
      paragraph('Local draft'),
    ]);
  });
});
