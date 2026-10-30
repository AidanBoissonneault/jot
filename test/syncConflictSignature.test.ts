import { describe, expect, it } from 'vitest';
import { syncConflictContentSignature } from '@/src/lib/syncConflictSignature';

describe('sync conflict content signatures', () => {
  it('preserves empty attributes by default and can omit them for auto-merge', () => {
    const identified = { type: 'paragraph', attrs: { jottathingBlockId: 'local' } };
    const plain = { type: 'paragraph' };

    expect(syncConflictContentSignature(identified))
      .not.toBe(syncConflictContentSignature(plain));
    expect(syncConflictContentSignature(identified, true))
      .toBe(syncConflictContentSignature(plain, true));
  });
});
