import { describe, expect, it } from 'vitest';
import {
  IMAGE_UPLOAD_MAX_BYTES,
  isUploadableImageFile,
  peekUploadableImageDrop,
  readImageDropSrc,
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
});

function dropData(values: Record<string, string>, files: File[] = []) {
  return {
    files,
    getData(type: string) {
      return values[type] ?? '';
    },
  };
}
