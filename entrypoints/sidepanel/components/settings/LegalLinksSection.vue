<script setup lang="ts">
/** Presents the LegalLinksSection settings section; the parent owns the shared settings state. */
import type { SettingsPageContext } from './settingsPageContext';

const props = defineProps<{ context: SettingsPageContext }>();
const { LEGAL_TERMS_URL, LEGAL_PRIVACY_URL, openLegalUrl } = props.context;
</script>

<template>
  <div class="panel-section">
    <h2>Legal</h2>
    <p class="legal-links">
      <a
        :href="LEGAL_TERMS_URL"
        target="_blank"
        rel="noopener noreferrer"
        @click.prevent="openLegalUrl(LEGAL_TERMS_URL)"
        >Terms</a
      >
      <a
        :href="LEGAL_PRIVACY_URL"
        target="_blank"
        rel="noopener noreferrer"
        @click.prevent="openLegalUrl(LEGAL_PRIVACY_URL)"
        >Privacy Policy</a
      >
    </p>
  </div>
</template>
