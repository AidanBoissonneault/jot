import { defineConfig } from 'wxt';

const isProduction = process.env.NODE_ENV === 'production';
const frameSrc = isProduction
  ? "'self' https://www.youtube.com https://www.youtube-nocookie.com"
  : "'self' http://localhost:* http://127.0.0.1:* https://www.youtube.com https://www.youtube-nocookie.com";

export default defineConfig({
  modules: ['@wxt-dev/module-vue'],
  manifestVersion: 3,
  manifest: {
    name: 'Inkwell',
    description:
      'Capture web highlights into structured Notion projects without breaking flow.',
    version: '0.1.0',
    permissions: [
      'storage',
      'sidePanel',
      'audioCapture',
      'clipboardRead',
      'clipboardWrite',
    ],
    host_permissions: ['http://*/*', 'https://*/*'],
    content_security_policy: {
      extension_pages:
        `script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; frame-src ${frameSrc};`,
      sandbox:
        "sandbox allow-scripts; default-src 'none'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src data: blob:; font-src data: blob:; media-src data: blob:; connect-src 'none'; worker-src blob:; frame-src 'self' data: blob:; child-src 'self' blob:; object-src 'none'; form-action 'none'; base-uri 'none';",
    },
    action: {
      default_title: 'Open Inkwell',
    },
  },
});
