<script setup lang="ts">
/**
 * Confirms archiving a project or page. The parent owns the target and the
 * archive operation; this component only presents the confirmation UI.
 */
defineProps<{
  kind: 'project' | 'page';
  title: string;
}>();

const emit = defineEmits<{
  cancel: [];
  confirm: [];
}>();
</script>

<template>
  <div class="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="archive-title">
    <section class="modal">
      <h2 id="archive-title">Archive {{ kind }}</h2>
      <p>{{ title }}</p>
      <div class="modal-actions">
        <button
          type="button"
          class="icon-label-button secondary-button"
          title="Cancel"
          aria-label="Cancel"
          @click="emit('cancel')"
        >
          <font-awesome-icon :icon="['fas', 'xmark']" fixed-width />
          <span>Cancel</span>
        </button>
        <button
          type="button"
          class="icon-label-button danger-primary"
          title="Archive"
          aria-label="Archive"
          @click="emit('confirm')"
        >
          <font-awesome-icon :icon="['fas', 'trash-can']" fixed-width />
          <span>Archive</span>
        </button>
      </div>
    </section>
  </div>
</template>
