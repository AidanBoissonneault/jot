import { describe, expect, it } from 'vitest';
import {
  safeHtmlPreviewDocument,
  sanitizeHtmlPreview,
} from '@/src/lib/safeHtmlPreview';
import {
  isCodeRunnerRequest,
  MAX_CODE_RUN_LENGTH,
} from '@/src/lib/codeRunnerSecurity';

describe('sanitizeHtmlPreview', () => {
  it('keeps safe markup and inline styling for static previews', () => {
    const result = sanitizeHtmlPreview(
      '<section class="card" style="color: navy"><h1>Layout</h1><p>Text</p></section>',
    );

    expect(result).toContain('<section class="card" style="color: navy">');
    expect(result).toContain('<h1>Layout</h1>');
    expect(result).toContain('<p>Text</p>');
  });

  it('removes scripts, active navigation, resource loads, and refreshes', () => {
    const result = sanitizeHtmlPreview(`
      <base href="https://attacker.example/">
      <meta http-equiv="refresh" content="0;url=https://attacker.example/collect">
      <script>location.href = 'https://attacker.example/collect';</script>
      <img src="https://attacker.example/pixel" onerror="alert(1)" alt="preview">
      <a href="https://attacker.example/collect">leave the preview</a>
      <form action="https://attacker.example/collect"><button>submit</button></form>
      <iframe srcdoc="<script>parent.location='https://attacker.example'</script>"></iframe>
      <object data="https://attacker.example/file"></object>
      <svg><a xlink:href="https://attacker.example/collect">SVG link</a></svg>
    `);

    expect(result).toContain('alt="preview"');
    expect(result).toContain('leave the preview');
    expect(result).not.toMatch(/<script|<meta|<base|<form|<iframe|<object|<svg/i);
    expect(result).not.toMatch(/(?:href|src|action|onerror)=/i);
    expect(result).not.toContain('attacker.example');
  });

  it('sanitizes template contents and discards parser comments', () => {
    const result = sanitizeHtmlPreview(
      '<template><img src="https://attacker.example/pixel"><script>send()</script><b>safe</b></template><!-- hidden -->',
    );

    expect(result).toContain('<template><img><b>safe</b></template>');
    expect(result).not.toContain('attacker.example');
    expect(result).not.toContain('send()');
    expect(result).not.toContain('hidden');
  });

  it('wraps output in a policy that denies scripts and network access', () => {
    const result = safeHtmlPreviewDocument('<h1>preview</h1>');

    expect(result).toContain("default-src 'none'");
    expect(result).toContain("script-src 'none'");
    expect(result).toContain("connect-src 'none'");
    expect(result).toContain('<h1>preview</h1>');
  });

  it('rejects malformed and oversized code runner requests', () => {
    const token = '00000000-0000-4000-8000-000000000000';
    expect(isCodeRunnerRequest({
      type: 'inkwell.codeRunner.run',
      token,
      language: 'html',
      code: '<h1>safe</h1>',
    })).toBe(true);
    expect(isCodeRunnerRequest({
      type: 'inkwell.codeRunner.run',
      token,
      language: 'javascript',
      code: 'x'.repeat(MAX_CODE_RUN_LENGTH + 1),
    })).toBe(false);
    expect(isCodeRunnerRequest({
      type: 'inkwell.codeRunner.run',
      token: 'invalid',
      language: 'javascript',
      code: '1 + 1',
    })).toBe(false);
  });
});
