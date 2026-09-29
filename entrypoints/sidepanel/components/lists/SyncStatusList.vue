<script setup lang="ts">
/** Displays the current account and synchronization summary as a definition list. */
defineProps<{ items: ReadonlyArray<{ label: string; value: string }> }>();
</script>

<template>
  <dl class="status-list">
    <div v-for="item in items" :key="item.label">
      <dt>{{ item.label }}</dt>
      <dd>{{ item.value }}</dd>
    </div>
  </dl>
</template>
