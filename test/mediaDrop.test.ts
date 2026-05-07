import { describe, expect, it } from 'vitest';
import {
  AUDIO_UPLOAD_MAX_BYTES,
  IMAGE_UPLOAD_MAX_BYTES,
  isUploadableAudioFile,
  isUploadableImageFile,
  peekUploadableAudioDrop,
  peekUploadableImageDrop,
  readAudioDropSrc,
  readImageDropSrc,
  readYoutubeDropSrc,
} from '@/src/extensions/mediaDrop';

describe('media drop helpers', () => {
  it('extracts public image URLs from dropped HTML, URI lists, and plain text', () => {
    expect(
      readImageDropSrc(dropData({
        'text/html': '<img alt="capture" src="https://example.com/capture">',
      })),
    ).toBe('https://example.com/capture');

    expect(
      readImageDropSrc(dropData({
        'text/uri-list': '# comment\nhttps://example.com/capture.webp?size=2',
      })),
    ).toBe('https://example.com/capture.webp?size=2');

    expect(
      readImageDropSrc(dropData({
        'text/plain': 'https://example.com/capture.avif',
      })),
    ).toBe('https://example.com/capture.avif');
  });

  it('rejects data and blob URLs as durable image sources', () => {
    expect(
      readImageDropSrc(dropData({
        'text/html': '<img src="blob:https://example.com/local">',
      })),
    ).toBeNull();

    expect(
      readImageDropSrc(dropData({
        'text/plain': 'data:image/png;base64,abc',
      })),
    ).toBeNull();
  });

  it('extracts YouTube URLs from dropped HTML, URI lists, and plain text', () => {
    expect(
      readYoutubeDropSrc(dropData({
        'text/html': '<a href="https://www.youtube.com/watch?v=dQw4w9WgXcQ">Video</a>',
      })),
    ).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ');

    expect(
      readYoutubeDropSrc(dropData({
        'text/uri-list': '# comment\nhttps://youtu.be/dQw4w9WgXcQ?t=12',
      })),
    ).toBe('https://youtu.be/dQw4w9WgXcQ?t=12');

    expect(
      readYoutubeDropSrc(dropData({
        'text/plain': 'https://www.youtube.com/shorts/dQw4w9WgXcQ',
      })),
    ).toBe('https://www.youtube.com/shorts/dQw4w9WgXcQ');
  });

  it('rejects non-video and non-YouTube URLs as YouTube drops', () => {
    expect(
      readYoutubeDropSrc(dropData({
        'text/plain': 'https://www.youtube.com/feed/subscriptions',
      })),
    ).toBeNull();

    expect(
      readYoutubeDropSrc(dropData({
        'text/plain': 'https://example.com/watch?v=dQw4w9WgXcQ',
      })),
    ).toBeNull();
  });

  it('extracts public audio URLs from dropped HTML, URI lists, and plain text', () => {
    expect(
      readAudioDropSrc(dropData({
        'text/html': '<audio src="https://example.com/clip.mp3"></audio>',
      })),
    ).toBe('https://example.com/clip.mp3');

    expect(
      readAudioDropSrc(dropData({
        'text/uri-list': '# comment\nhttps://example.com/clip.m4a?download=1',
      })),
    ).toBe('https://example.com/clip.m4a?download=1');

    expect(
      readAudioDropSrc(dropData({
        'text/plain': 'https://example.com/clip.webm',
      })),
    ).toBe('https://example.com/clip.webm');
  });

  it('rejects non-audio URLs as audio drops', () => {
    expect(
      readAudioDropSrc(dropData({
        'text/plain': 'https://example.com/page',
      })),
    ).toBeNull();
  });

  it('selects only image files for upload and applies the 20 MB limit', () => {
    const image = new File(['pixels'], 'capture.png', { type: 'image/png' });
    const text = new File(['notes'], 'notes.txt', { type: 'text/plain' });
    const oversized = new File([new Uint8Array(IMAGE_UPLOAD_MAX_BYTES + 1)], 'huge.png', {
      type: 'image/png',
    });

    expect(peekUploadableImageDrop(dropData({}, [text, image]))).toEqual({
      kind: 'file',
      file: image,
    });
    expect(isUploadableImageFile(image)).toBe(true);
    expect(isUploadableImageFile(oversized)).toBe(false);
  });

  it('selects only audio files for upload and applies the 20 MB limit', () => {
    const audio = new File(['sound'], 'clip.mp3', { type: 'audio/mpeg' });
    const text = new File(['notes'], 'notes.txt', { type: 'text/plain' });
    const oversized = new File([new Uint8Array(AUDIO_UPLOAD_MAX_BYTES + 1)], 'huge.mp3', {
      type: 'audio/mpeg',
    });

    expect(peekUploadableAudioDrop(dropData({}, [text, audio]))).toEqual({
      kind: 'file',
      file: audio,
    });
    expect(isUploadableAudioFile(audio)).toBe(true);
    expect(isUploadableAudioFile(oversized)).toBe(false);
  });
});

function dropData(values: Record<string, string>, files: File[] = []) {
  return {
    files,
    getData(type: string) {
      return values[type] ?? '';
    },
  };
}
