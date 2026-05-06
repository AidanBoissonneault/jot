import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-vue'],
  manifestVersion: 3,
  manifest: {
    name: 'Jot',
    description:
      'Capture web highlights into structured Notion projects without breaking flow.',
    version: '0.0.0',
    permissions: ['storage', 'activeTab', 'sidePanel', 'tabs'],
    host_permissions: ['<all_urls>'],
    action: {
      default_title: 'Open Jot',
    },
  },
});
