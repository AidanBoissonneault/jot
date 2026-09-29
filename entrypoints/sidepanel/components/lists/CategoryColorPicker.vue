<script setup lang="ts">
/** @file Displays category colors and emits the selected color. */
import type { CategoryColor } from '../layout/topBarContext';

defineProps<{
  colors: readonly CategoryColor[];
  selectedColor: string;
  enabled: boolean;
}>();

const emit = defineEmits<{ select: [color: CategoryColor] }>();
</script>

<template>
  <div class="category-color-picker" aria-label="Category color">
    <button
      v-for="color in colors"
      :key="color"
      type="button"
      class="category-swatch"
      :class="{ active: selectedColor === color }"
      :style="{ backgroundColor: color }"
      :aria-label="`Use ${color}`"
      :aria-pressed="selectedColor === color"
      :disabled="!enabled"
      @click="emit('select', color)"
    />
  </div>
</template>
