import { describe, expect, it } from 'vitest';
import { extensionContentSecurityPolicy } from '@/src/lib/extensionCsp';

describe('extension content security policy', () => {
  it('keeps production frames on packaged pages and supported YouTube embeds', () => {
    const policy = extensionContentSecurityPolicy(true);

    expect(policy.extension_pages).toContain(
      "frame-src 'self' https://www.youtube.com https://www.youtube-nocookie.com;",
    );
    expect(policy.extension_pages).not.toContain('https:;');
  });

  it('blocks sandbox network egress and keeps it on an opaque origin', () => {
    const sandbox = extensionContentSecurityPolicy(true).sandbox;

    expect(sandbox).toContain('sandbox allow-scripts;');
    expect(sandbox).toContain("default-src 'none';");
    expect(sandbox).toContain("connect-src 'none';");
    expect(sandbox).toContain("object-src 'none';");
    expect(sandbox).not.toContain('allow-same-origin');
  });

  it('allows development servers only in development builds', () => {
    const production = extensionContentSecurityPolicy(true).extension_pages;
    const development = extensionContentSecurityPolicy(false).extension_pages;

    expect(production).not.toContain('localhost');
    expect(development).toContain('http://localhost:*');
    expect(development).toContain('http://127.0.0.1:*');
  });
});
