import { defineConfig } from 'wxt';
import { extensionContentSecurityPolicy } from './src/lib/extensionCsp';

const isProduction = process.env.NODE_ENV === 'production';

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
    content_security_policy: extensionContentSecurityPolicy(isProduction),
    action: {
      default_title: 'Open Inkwell',
    },
  },
});
