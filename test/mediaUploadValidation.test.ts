import { describe, expect, it } from 'vitest';
import { hasValidImageSignature } from '@/apps/worker/src/workerUtils';

describe('Notion image upload validation', () => {
  it.each([
    ['image/jpeg', [0xff, 0xd8, 0xff, 0x00]],
    ['image/png', [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
    ['image/gif', [...new TextEncoder().encode('GIF89a')]],
    ['image/webp', [...new TextEncoder().encode('RIFF0000WEBP')]],
    ['image/avif', [...new TextEncoder().encode('0000ftypavif0000')]],
  ])('accepts the %s file signature', (mimeType, bytes) => {
    expect(hasValidImageSignature(new Uint8Array(bytes), mimeType)).toBe(true);
  });

  it('rejects a MIME type that does not match the image bytes', () => {
    expect(hasValidImageSignature(new TextEncoder().encode('not an image'), 'image/png')).toBe(false);
    expect(hasValidImageSignature(new TextEncoder().encode('not an svg'), 'image/svg+xml')).toBe(false);
    expect(hasValidImageSignature(new TextEncoder().encode('0000ftypavif'), 'image/avif')).toBe(false);
  });
});
