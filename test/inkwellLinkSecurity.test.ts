import { describe, expect, it } from 'vitest';
import { safeExternalUrl } from '@/src/extensions/inkwellLink';

describe('safeExternalUrl', () => {
  it.each([
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'file:///etc/passwd',
    'chrome-extension://attacker/page.html',
    'https://user:password@example.com/',
  ])('rejects non-web URL %s', (url) => {
    expect(safeExternalUrl(url)).toBeNull();
  });

  it('allows HTTP and HTTPS links', () => {
    expect(safeExternalUrl('https://example.com/path')).toBe('https://example.com/path');
    expect(safeExternalUrl('http://localhost:8787/path')).toBe('http://localhost:8787/path');
  });
});
