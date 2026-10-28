<script setup lang="ts">
/** Confirms signing out of the active Notion connection. */
const props = defineProps<{ busy: boolean; error: string; online: boolean; progress: string }>();
const emit = defineEmits<{ cancel: []; confirm: [] }>();
</script>

<template>
  <div
    class="modal-backdrop notion-modal-backdrop"
    role="dialog"
    aria-modal="true"
    aria-labelledby="notion-logout-title"
    @click.self="emit('cancel')"
    @keydown.esc.prevent="emit('cancel')"
  >
    <section class="modal notion-logout-modal">
      <h2 id="notion-logout-title">Leave this Notion workspace?</h2>
      <p>
        Jottathing will send saved changes to Notion and wait for sync to finish before signing out.
        Your notes remain on this device, and you can reconnect later.
      </p>
      <p v-if="!props.online" class="notion-logout-warning" role="status">
        You’re offline. Jottathing can’t push or verify the sync queue right now. If you sign out,
        your notes and pending changes will stay on this device for the next time you connect the
        same Notion account.
      </p>
      <p v-if="props.busy && props.progress" class="notion-logout-progress" role="status" aria-live="polite">
        <span class="notion-logout-progress-track" aria-hidden="true"><span /></span>
        <span>{{ props.progress }}</span>
      </p>
      <p v-if="props.error" class="notion-logout-error" role="alert">{{ props.error }}</p>
      <div class="modal-actions">
        <button
          type="button"
          class="icon-label-button secondary-button"
          :disabled="props.busy"
          @click="emit('cancel')"
        >
          <span>Stay connected</span>
        </button>
        <button
          type="button"
          class="icon-label-button danger-primary"
          :disabled="props.busy"
          :aria-busy="props.busy"
          @click="emit('confirm')"
        >
          <font-awesome-icon :icon="['fas', 'right-from-bracket']" fixed-width />
          <span>{{ props.busy ? 'Syncing…' : props.online ? 'Sign out' : 'Sign out anyway' }}</span>
        </button>
      </div>
    </section>
  </div>
</template>
