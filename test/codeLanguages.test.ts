import { describe, expect, it } from 'vitest';
import {
  browserExecutableLanguage,
  detectCodeLanguage,
  normalizeCodeLanguage,
} from '@/src/lib/codeLanguages';
import { createCapturedContent } from '@/src/services/notionClient';

describe('code languages', () => {
  it('normalizes common website aliases', () => {
    expect(normalizeCodeLanguage('language-js')).toBe('javascript');
    expect(normalizeCodeLanguage('tsx')).toBe('typescript');
    expect(normalizeCodeLanguage('highlight-source-cpp')).toBe('c++');
  });

  it('finds a language in syntax highlighter class lists', () => {
    expect(detectCodeLanguage(['rounded hljs language-python copyable'])).toBe('python');
    expect(detectCodeLanguage(['highlight highlight-source-js position-relative'])).toBe('javascript');
  });

  it('only marks languages the sandbox can actually run as executable', () => {
    expect(browserExecutableLanguage('js')).toBe('javascript');
    expect(browserExecutableLanguage('html')).toBe('html');
    expect(browserExecutableLanguage('typescript')).toBeUndefined();
    expect(browserExecutableLanguage('python')).toBeUndefined();
  });

  it('creates a typed code cell when captured code is dropped', () => {
    const content = createCapturedContent({
      text: 'const answer = 42;',
      sourceUrl: 'https://example.com/docs',
      pageTitle: 'Example docs',
      highlightMeta: {
        text: 'const answer = 42;',
        isCodeBlock: true,
        codeLanguage: 'js',
      },
    });

    expect(content[0]).toEqual({
      type: 'codeBlock',
      attrs: { language: 'javascript' },
      content: [{ type: 'text', text: 'const answer = 42;' }],
    });
    expect(content[1]).toMatchObject({ type: 'paragraph' });
  });
});
