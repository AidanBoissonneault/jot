<script setup lang="ts">
/** Collects legal consent immediately before starting Notion OAuth. */
import LegalConsent from '../settings/LegalConsent.vue';

const props = defineProps<{
  accepted: boolean;
  loaded: boolean;
  canContinue: boolean;
  signingIn: boolean;
  termsUrl: string;
  privacyUrl: string;
  openLegalUrl: (url: string) => void;
}>();

const emit = defineEmits<{
  'update:accepted': [accepted: boolean];
  cancel: [];
  confirm: [];
}>();
</script>

<template>
  <div
    class="modal-backdrop notion-modal-backdrop"
    role="dialog"
    aria-modal="true"
    aria-labelledby="notion-connect-title"
    @click.self="emit('cancel')"
    @keydown.esc.prevent="emit('cancel')"
  >
    <section class="modal notion-connect-modal">
      <div class="notion-connect-brand">
        <span class="notion-brand-mark" aria-hidden="true">
          <svg viewBox="0 0 24 24" focusable="false">
            <path d="M4 2.75h16v18.5H4z" />
            <path d="M7 17V7h2l6 7.1V7h2v10h-2l-6-7.1V17z" class="notion-brand-mark-letter" />
          </svg>
        </span>
        <span>Jottathing for Notion</span>
      </div>
      <h2 id="notion-connect-title">Add a Notion workspace</h2>
      <p>
        Connect your Notion account to create a synced Jottathing workspace. Notion will ask you to
        choose which pages Jottathing can access.
      </p>

      <LegalConsent
        :accepted="props.accepted"
        :loaded="props.loaded"
        :terms-url="props.termsUrl"
        :privacy-url="props.privacyUrl"
        :open-legal-url="props.openLegalUrl"
        @update:accepted="emit('update:accepted', $event)"
      />

      <div class="modal-actions notion-connect-actions">
        <button type="button" class="icon-label-button secondary-button" @click="emit('cancel')">
          <span>Cancel</span>
        </button>
        <button
          type="button"
          class="notion-login-button notion-login-button-modal"
          :disabled="!props.canContinue"
          @click="emit('confirm')"
        >
          <span class="notion-brand-mark" aria-hidden="true">
            <svg viewBox="0 0 24 24" focusable="false">
              <path d="M4 2.75h16v18.5H4z" />
              <path d="M7 17V7h2l6 7.1V7h2v10h-2l-6-7.1V17z" class="notion-brand-mark-letter" />
            </svg>
          </span>
          <span>{{ props.signingIn ? 'Waiting for Notion…' : 'Continue with Notion' }}</span>
        </button>
      </div>
    </section>
  </div>
</template>
