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
  isDeletingConnection,
  deleteConnection,
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
const queueAccountMismatch = computed(() =>
  store.syncConfig.connected &&
  store.syncConfig.syncQueueOwnerUserId !== undefined &&
  store.syncConfig.syncQueueOwnerUserId !== store.syncConfig.userId,
);
const queueOwnerUnknown = computed(() => queueAccountMismatch.value && store.syncConfig.syncQueueOwnerUserId === null);

async function assignUnknownQueueToCurrentAccount() {
  const confirmed = window.confirm(
    'These older local changes could not be matched to a Notion account. Sync them to the currently connected account?',
  );
  if (!confirmed) return;
  await store.assignUnmatchedPendingQueueToCurrentAccount().catch(() => undefined);
}
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

    <div v-if="queueAccountMismatch" class="sync-conflict-warning" role="status">
      <template v-if="queueOwnerUnknown">
        <span>Older local data could not be matched to a Notion account. Your documents remain on this device.</span>
        <button type="button" class="secondary-button" @click="assignUnknownQueueToCurrentAccount">
          Use this account for local data
        </button>
      </template>
      <span v-else>Local documents and queued changes are locked to their original Notion account. Reconnect that account to sync them. Your documents remain on this device.</span>
    </div>

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
      :title="isSigningIn ? 'Connecting' : store.syncConfig.logoutCleanupPending ? 'Retry logout cleanup before reconnecting' : 'Continue with Notion'"
      :aria-label="isSigningIn ? 'Connecting' : store.syncConfig.logoutCleanupPending ? 'Retry logout cleanup before reconnecting' : 'Continue with Notion'"
      @click="loginWithNotion"
    >
      <font-awesome-icon :icon="['fas', 'cloud-arrow-up']" fixed-width />
      <span>{{ isSigningIn ? 'Connecting...' : 'Continue with Notion' }}</span>
    </button>
    <button
      v-if="store.syncConfig.logoutCleanupPending"
      type="button"
      class="icon-label-button secondary-button"
      :disabled="store.isRetryingLogoutCleanup"
      :title="store.isRetryingLogoutCleanup ? 'Finishing logout' : 'Retry logout cleanup'"
      :aria-busy="store.isRetryingLogoutCleanup"
      @click="store.retryLogoutCleanup"
    >
      <font-awesome-icon :icon="['fas', 'rotate']" :class="{ 'sync-rotating-icon': store.isRetryingLogoutCleanup }" fixed-width />
      <span>{{ store.isRetryingLogoutCleanup ? 'Finishing logout…' : 'Retry logout cleanup' }}</span>
    </button>
    <button
      v-if="store.syncConfig.authenticated || store.syncConfig.connected"
      type="button"
      class="icon-label-button secondary-button"
      title="Logout"
      aria-label="Logout"
      :disabled="isDeletingConnection"
      @click="logout"
    >
      <font-awesome-icon :icon="['fas', 'right-from-bracket']" fixed-width />
      <span>Logout</span>
    </button>
    <button
      v-if="store.projects.length > 0 || store.pendingSyncCount > 0 || store.syncConfig.authenticated || store.syncConfig.connected"
      type="button"
      class="icon-label-button danger-button"
      :disabled="isDeletingConnection || queueAccountMismatch"
      :aria-busy="isDeletingConnection"
      :title="queueAccountMismatch ? 'Reconnect the account that owns this local data first' : isDeletingConnection ? 'Deleting connection' : 'Delete connection and Inkwell data'"
      @click="deleteConnection"
    >
      <font-awesome-icon :icon="['fas', 'trash-can']" fixed-width />
      <span>{{ isDeletingConnection ? 'Deleting connection…' : 'Delete connection' }}</span>
    </button>
  </div>
</template>
