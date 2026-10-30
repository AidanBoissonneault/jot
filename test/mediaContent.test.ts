import { describe, expect, it } from 'vitest';
import {
  isDirectMediaUploadActive,
  mergeUploadedMediaAttributes,
  markUnrecoverableTransientMedia,
  mergeSyncedMediaContent,
  sanitizeMediaForSync,
} from '@/src/extensions/mediaContent';
import { doc, paragraph, image, audio } from './helpers/docBuilders';

describe('media content helpers', () => {
  it('keeps active direct uploads out of the retry queue, then retries stale upload leases', () => {
    const now = 1_000_000;
    expect(isDirectMediaUploadActive({ uploadState: 'uploading', uploadStartedAt: now - 1000 }, now)).toBe(true);
    expect(isDirectMediaUploadActive({ uploadState: 'uploading', uploadStartedAt: now - 120_000 }, now)).toBe(false);
    expect(isDirectMediaUploadActive({ uploadState: 'local', uploadStartedAt: now - 1000 }, now)).toBe(false);
  });

  it('detects pending blob images and removes them from sync content', () => {
    const content = doc([
      image({ src: 'blob:chrome-extension://preview' }),
      paragraph('Saved text'),
    ]);

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

  it('keeps an uploaded image source locally after replacing its preview URL', () => {
    const original = 'data:image/png;base64,YQ==';
    const local = doc([
      image({
        src: original,
        notionFileUploadId: 'upload-id',
      }),
    ]);
    const synced = doc([image({ src: 'https://secure.notion-static.com/image.png?expires=1' })]);

    const merged = mergeSyncedMediaContent(local, synced);
    expect(merged.content?.[0].attrs).toMatchObject({
      src: 'https://secure.notion-static.com/image.png?expires=1',
      localSrc: original,
      notionFileUploadId: 'upload-id',
    });
    expect(sanitizeMediaForSync(merged).content?.[0].attrs).not.toHaveProperty('localSrc');
  });

  it('merges background upload identities into newer page content by stable block id', () => {
    const localSrc = 'data:image/png;base64,YQ==';
    const current = doc([
      paragraph('Newer text edit'),
      image({ src: localSrc, jottathingBlockId: 'image-1', alt: 'Kept alt text' }),
    ]);
    const uploaded = doc([
      paragraph('Older text snapshot'),
      image({
        src: localSrc,
        jottathingBlockId: 'image-1',
        notionFileUploadId: 'upload-1',
        notionBlockId: 'notion-image-1',
        uploadState: 'done',
      }),
    ]);

    expect(mergeUploadedMediaAttributes(current, uploaded).content).toEqual([
      paragraph('Newer text edit'),
      image({
        src: localSrc,
        jottathingBlockId: 'image-1',
        notionFileUploadId: 'upload-1',
        notionBlockId: 'notion-image-1',
        uploadState: 'done',
        alt: 'Kept alt text',
      }),
    ]);
  });

  it('does not attach an upload that finished for a removed or replaced image', () => {
    const current = doc([
      image({ src: 'data:image/png;base64,Yg==', jottathingBlockId: 'image-1' }),
    ]);
    const uploaded = doc([
      image({
        src: 'data:image/png;base64,YQ==',
        jottathingBlockId: 'image-1',
        notionFileUploadId: 'upload-1',
      }),
    ]);

    expect(mergeUploadedMediaAttributes(current, uploaded)).toEqual(current);
    expect(mergeUploadedMediaAttributes(doc([]), uploaded)).toEqual(doc([]));
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

  it('does not send transient upload leases to the sync server', () => {
    const content = doc([image({
      src: 'data:image/png;base64,YQ==',
      notionFileUploadId: 'upload-id',
      uploadState: 'done',
      uploadStartedAt: Date.now(),
    })]);

    expect(sanitizeMediaForSync(content).content?.[0].attrs).not.toHaveProperty('uploadStartedAt');
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
        jottathingBlockId: 'remote-image',
      }),
    ]);

    expect(mergeSyncedMediaContent(local, synced).content).toEqual([
      paragraph('Local draft'),
      image({
        src: 'https://secure.notion-static.com/image.png',
        jottathingBlockId: 'remote-image',
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
