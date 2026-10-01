const YOUTUBE_FRAME_ORIGINS = [
  'https://www.youtube.com',
  'https://www.youtube-nocookie.com',
];

/** Builds separate production and development CSPs for extension and runner pages. */
export function extensionContentSecurityPolicy(isProduction: boolean) {
  const frameSources = [
    "'self'",
    ...(!isProduction ? ['http://localhost:*', 'http://127.0.0.1:*'] : []),
    ...YOUTUBE_FRAME_ORIGINS,
  ].join(' ');

  return {
    extension_pages:
      `script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; frame-src ${frameSources};`,
    sandbox: [
      'sandbox allow-scripts;',
      "default-src 'none';",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval';",
      "style-src 'self' 'unsafe-inline';",
      'img-src data: blob:;',
      'font-src data: blob:;',
      'media-src data: blob:;',
      "connect-src 'none';",
      'worker-src blob:;',
      "frame-src 'self' data: blob:;",
      "child-src 'self' blob:;",
      "object-src 'none';",
      "form-action 'none';",
      "base-uri 'none';",
    ].join(' '),
  };
}
