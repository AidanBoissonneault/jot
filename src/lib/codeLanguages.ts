export const CODE_LANGUAGES = [
  'plain text',
  'abap',
  'arduino',
  'bash',
  'basic',
  'c',
  'clojure',
  'coffeescript',
  'c++',
  'c#',
  'css',
  'dart',
  'diff',
  'docker',
  'elixir',
  'elm',
  'erlang',
  'flow',
  'fortran',
  'f#',
  'gherkin',
  'glsl',
  'go',
  'graphql',
  'groovy',
  'haskell',
  'html',
  'java',
  'javascript',
  'json',
  'julia',
  'kotlin',
  'latex',
  'less',
  'lisp',
  'livescript',
  'lua',
  'makefile',
  'markdown',
  'markup',
  'matlab',
  'mermaid',
  'nix',
  'objective-c',
  'ocaml',
  'pascal',
  'perl',
  'php',
  'powershell',
  'prolog',
  'protobuf',
  'python',
  'r',
  'reason',
  'ruby',
  'rust',
  'sass',
  'scala',
  'scheme',
  'scss',
  'shell',
  'sql',
  'swift',
  'typescript',
  'vb.net',
  'verilog',
  'vhdl',
  'visual basic',
  'webassembly',
  'xml',
  'yaml',
  'java/c/c++/c#',
] as const;

export type CodeLanguage = (typeof CODE_LANGUAGES)[number];
export type BrowserExecutableLanguage = 'javascript' | 'html';

const LANGUAGE_SET = new Set<string>(CODE_LANGUAGES);
const LANGUAGE_ALIASES: Record<string, CodeLanguage> = {
  text: 'plain text',
  txt: 'plain text',
  plaintext: 'plain text',
  none: 'plain text',
  js: 'javascript',
  jsx: 'javascript',
  node: 'javascript',
  nodejs: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  golang: 'go',
  cpp: 'c++',
  cxx: 'c++',
  cc: 'c++',
  cs: 'c#',
  csharp: 'c#',
  fsharp: 'f#',
  objc: 'objective-c',
  objectivec: 'objective-c',
  sh: 'shell',
  zsh: 'shell',
  fish: 'shell',
  shellsession: 'shell',
  'shell-session': 'shell',
  ps1: 'powershell',
  md: 'markdown',
  yml: 'yaml',
  html5: 'html',
  htm: 'html',
  xhtml: 'html',
  svg: 'xml',
  dockerfile: 'docker',
  make: 'makefile',
  wasm: 'webassembly',
};

const HINT_PREFIXES = [
  'language-',
  'lang-',
  'highlight-source-',
  'source-',
  'brush:',
];

export function normalizeCodeLanguage(value: unknown): CodeLanguage {
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/_/g, '-');

  if (!normalized) {
    return 'plain text';
  }

  const withoutPrefix = HINT_PREFIXES.reduce(
    (current, prefix) => current.startsWith(prefix) ? current.slice(prefix.length) : current,
    normalized,
  ).replace(/[;,]$/, '');
  const alias = LANGUAGE_ALIASES[withoutPrefix];

  if (alias) {
    return alias;
  }

  return LANGUAGE_SET.has(withoutPrefix)
    ? withoutPrefix as CodeLanguage
    : 'plain text';
}

export function detectCodeLanguage(hints: Array<string | null | undefined>): CodeLanguage {
  for (const hint of hints) {
    const rawHint = String(hint ?? '').trim().toLowerCase();

    if (!rawHint) {
      continue;
    }

    const candidates = [rawHint];
    const tokens = rawHint.split(/\s+/);

    for (const token of tokens) {
      candidates.push(token);

      for (const prefix of HINT_PREFIXES) {
        const prefixIndex = token.indexOf(prefix);
        if (prefixIndex >= 0) {
          candidates.push(token.slice(prefixIndex));
        }
      }
    }

    for (const candidate of candidates) {
      const language = normalizeCodeLanguage(candidate);
      if (language !== 'plain text' || /^(plain(?:\s|-)?text|text|txt|none)$/i.test(candidate)) {
        return language;
      }
    }
  }

  return 'plain text';
}

export function browserExecutableLanguage(
  value: unknown,
): BrowserExecutableLanguage | undefined {
  const language = normalizeCodeLanguage(value);
  return language === 'javascript' || language === 'html' ? language : undefined;
}

export function codeLanguageLabel(language: CodeLanguage) {
  const labels: Partial<Record<CodeLanguage, string>> = {
    'plain text': 'Plain text',
    javascript: 'JavaScript',
    typescript: 'TypeScript',
    html: 'HTML',
    css: 'CSS',
    json: 'JSON',
    sql: 'SQL',
    xml: 'XML',
    yaml: 'YAML',
    'c++': 'C++',
    'c#': 'C#',
    'f#': 'F#',
    php: 'PHP',
    r: 'R',
    'vb.net': 'VB.NET',
  };

  return labels[language] ?? language.charAt(0).toUpperCase() + language.slice(1);
}
