import { defineConfig } from 'wxt';

const isProduction = process.env.NODE_ENV === 'production';
const frameSrc = isProduction
  ? 'https:'
  : 'http://localhost:* http://127.0.0.1:* https:';

export default defineConfig({
  modules: ['@wxt-dev/module-vue'],
  manifestVersion: 3,
  manifest: {
    name: 'Inkwell',
    description:
      'Capture web highlights into structured Notion projects without breaking flow.',
    version: '0.1.0',
    permissions: ['storage', 'activeTab', 'sidePanel', 'tabs', 'audioCapture'],
    host_permissions: ['<all_urls>'],
    content_security_policy: {
      extension_pages:
        `script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; frame-src ${frameSrc};`,
    },
    action: {
      default_title: 'Open Inkwell',
    },
  },
});
