import { describe, expect, it } from 'vitest';
import { privacyBody } from '../apps/worker/src/htmlPages.js';

describe('published privacy policy', () => {
  it('distinguishes logout retention from deletion of this browser and cloud data', () => {
    const policy = privacyBody();

    expect(policy).toContain('Local documents and queued edits remain in this browser');
    expect(policy).toContain('Delete connection in Settings removes the Inkwell account');
    expect(policy).toContain('Pages already stored in Notion remain');
    expect(policy).toContain('Local copies on other browsers or devices are not remotely erased');
    expect(policy).toContain('one-way request hash');
  });
});
