<script setup lang="ts">
/** @file Preset buttons for choosing the sidepanel interface scale. */

defineProps<{ selectedScale: number }>();
const emit = defineEmits<{ select: [scale: number] }>();

const presets = [90, 100, 120, 140] as const;
</script>

<template>
  <div class="scale-presets" aria-label="Interface size presets">
    <button
      v-for="preset in presets"
      :key="preset"
      type="button"
      class="secondary-button"
      :class="{ active: selectedScale === preset }"
      :aria-pressed="selectedScale === preset"
      @click="emit('select', preset)"
    >
      {{ preset === 100 ? 'Default' : `${preset}%` }}
    </button>
  </div>
</template>
