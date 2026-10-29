<script setup lang="ts">
/** Composes the focused settings sections into the settings page. */
import type { SettingsPageContext } from './settingsPageContext';
import LegalLinksSection from './LegalLinksSection.vue';
import InterfaceSettingsSection from './InterfaceSettingsSection.vue';

defineProps<{ context: SettingsPageContext }>();
</script>
<template>
  <section class="tab-panel settings-panel" aria-labelledby="settings-heading">
    <header class="settings-page-heading">
      <h1 id="settings-heading">Settings</h1>
      <p>Appearance and legal information.</p>
    </header>
    <InterfaceSettingsSection :context="context" />
    <LegalLinksSection :context="context" />
  </section>
</template>
