import { describe, expect, it } from 'vitest';
import { bytesToBase64 } from '@/src/lib/base64';

describe('bytesToBase64', () => {
  it('encodes binary bytes and empty input', () => {
    expect(bytesToBase64(new Uint8Array([0, 255, 65]))).toBe('AP9B');
    expect(bytesToBase64(new Uint8Array())).toBe('');
  });

  it('encodes data that crosses the conversion chunk boundary', () => {
    const bytes = new Uint8Array(8193).fill(97);
    expect(bytesToBase64(bytes)).toBe(Buffer.from(bytes).toString('base64'));
  });
});
