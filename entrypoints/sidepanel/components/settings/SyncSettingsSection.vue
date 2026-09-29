<script setup lang="ts">
/** Presents the SyncSettingsSection settings section; the parent owns the shared settings state. */
import { computed } from 'vue';
import type { SettingsPageContext } from './settingsPageContext';
import SyncStatusList from '../lists/SyncStatusList.vue';
import LegalConsent from './LegalConsent.vue';

const props = defineProps<{ context: SettingsPageContext }>();
const {
  store,
  saveLabel,
  accountLabel,
  parentPageLabel,
  isResyncing,
  resync,
  hasAcceptedLegalTerms,
  isLegalAcceptanceLoaded,
  LEGAL_TERMS_URL,
  LEGAL_PRIVACY_URL,
  openLegalUrl,
  canLoginWithNotion,
  isSigningIn,
  loginWithNotion,
  logout,
} = props.context;

const statusItems = computed(() => [
  { label: 'Account', value: accountLabel.value },
  { label: 'Workspace', value: store.syncConfig.workspaceName || 'Not connected' },
  { label: 'Parent page', value: parentPageLabel.value },
  { label: 'Status', value: saveLabel.value },
  { label: 'Connection', value: store.isOnline ? 'Online' : 'Offline' },
  {
    label: 'Local queue',
    value: `${store.pendingSyncCount} ${store.pendingSyncCount === 1 ? 'change' : 'changes'}`,
  },
]);
</script>

<template>
  <div class="panel-section">
    <div class="section-heading">
      <h2>Sync</h2>
      <button
        v-if="store.syncConfig.connected"
        type="button"
        class="icon-label-button secondary-button"
        :disabled="isResyncing"
        :title="isResyncing ? 'Syncing with Notion' : 'Resync'"
        :aria-label="isResyncing ? 'Syncing with Notion' : 'Resync'"
        :aria-busy="isResyncing"
        @click="resync"
      >
        <font-awesome-icon :icon="['fas', 'rotate']" :class="{ 'sync-rotating-icon': isResyncing }" fixed-width />
        <span>Resync</span>
      </button>
    </div>

    <SyncStatusList :items="statusItems" />

    <LegalConsent
      v-if="!store.syncConfig.connected"
      v-model:accepted="hasAcceptedLegalTerms"
      :loaded="isLegalAcceptanceLoaded"
      :terms-url="LEGAL_TERMS_URL"
      :privacy-url="LEGAL_PRIVACY_URL"
      :open-legal-url="openLegalUrl"
    />

    <button
      v-if="!store.syncConfig.connected"
      type="button"
      class="icon-label-button"
      :disabled="!canLoginWithNotion"
      :title="isSigningIn ? 'Connecting' : 'Continue with Notion'"
      :aria-label="isSigningIn ? 'Connecting' : 'Continue with Notion'"
      @click="loginWithNotion"
    >
      <font-awesome-icon :icon="['fas', 'cloud-arrow-up']" fixed-width />
      <span>{{ isSigningIn ? 'Connecting...' : 'Continue with Notion' }}</span>
    </button>
    <button
      v-else
      type="button"
      class="icon-label-button secondary-button"
      title="Logout"
      aria-label="Logout"
      @click="logout"
    >
      <font-awesome-icon :icon="['fas', 'right-from-bracket']" fixed-width />
      <span>Logout</span>
    </button>
  </div>
</template>
