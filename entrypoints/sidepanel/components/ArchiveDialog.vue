<!--
  Created: September 12, 2026
  Author: Aidan
  Description: Confirms destructive project and page archive requests before they are committed.
-->
<script setup lang="ts">
export interface ArchiveTarget {
  kind: 'project' | 'page';
  id: string;
  title: string;
}

defineProps<{ target: ArchiveTarget }>();

defineEmits<{
  cancel: [];
  confirm: [];
}>();
</script>

<template>
  <div class="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="archive-title">
    <section class="modal">
      <h2 id="archive-title">Delete {{ target.kind }}?</h2>
      <p>
        <strong>{{ target.title }}</strong>
        {{ target.kind === 'project'
          ? ' and all of its pages will be removed from Inkwell.'
          : ' will be removed from Inkwell.' }}
        This cannot be undone here.
      </p>
      <div class="modal-actions">
        <button type="button" class="icon-label-button secondary-button" title="Cancel" aria-label="Cancel" @click="$emit('cancel')">
          <font-awesome-icon :icon="['fas', 'xmark']" fixed-width />
          <span>Cancel</span>
        </button>
        <button type="button" class="icon-label-button danger-primary" title="Delete" aria-label="Confirm delete" @click="$emit('confirm')">
          <font-awesome-icon :icon="['fas', 'trash-can']" fixed-width />
          <span>Delete</span>
        </button>
      </div>
    </section>
  </div>
</template>
