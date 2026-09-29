<script setup lang="ts">
/** @file Selectable project category list. */

defineProps<{ categories: Array<{ name: string; color: string }> }>();

const emit = defineEmits<{ select: [category: string] }>();
</script>

<template>
  <div v-if="categories.length" class="known-categories">
    <button
      v-for="category in categories"
      :key="category.name"
      type="button"
      @click="emit('select', category.name)"
    >
      <span class="category-dot" :style="{ backgroundColor: category.color }" />
      {{ category.name }}
    </button>
  </div>
</template>
