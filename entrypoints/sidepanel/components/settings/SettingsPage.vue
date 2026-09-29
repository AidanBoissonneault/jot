<script setup lang="ts">
/** Composes the focused settings sections into the settings page. */
import type { SettingsPageContext } from './settingsPageContext';
import ProjectDetailsSection from './ProjectDetailsSection.vue';
import SyncSettingsSection from './SyncSettingsSection.vue';
import LegalLinksSection from './LegalLinksSection.vue';
import ServerSettingsSection from './ServerSettingsSection.vue';
import NotionParentPageSection from './NotionParentPageSection.vue';
import InterfaceSettingsSection from './InterfaceSettingsSection.vue';

defineProps<{ context: SettingsPageContext }>();
</script>
<template>
  <section class="tab-panel settings-panel" aria-labelledby="settings-heading">
    <ProjectDetailsSection :context="context" />
    <SyncSettingsSection :context="context" />
    <LegalLinksSection :context="context" />
    <ServerSettingsSection :context="context" />
    <NotionParentPageSection :context="context" />
    <InterfaceSettingsSection :context="context" />
  </section>
</template>
