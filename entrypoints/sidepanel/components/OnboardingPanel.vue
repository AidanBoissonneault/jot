<!--
  Created: September 13, 2026
  Author: Aidan
  Description: Gives first-time users a concise overview of Inkwell's core workflow.
-->
<script setup lang="ts">
const emit = defineEmits<{
  finishLocal: [];
  setupSync: [];
}>();

const features = [
  {
    icon: ['fas', 'highlighter'],
    title: 'Capture from any page',
    copy: 'Select useful text while browsing and save it with a link to its source.',
  },
  {
    icon: ['fas', 'folder-tree'],
    title: 'Organize your notes',
    copy: 'Use projects and pages to keep related research and ideas together.',
  },
  {
    icon: ['fas', 'cloud-arrow-up'],
    title: 'Sync when you want',
    copy: 'Work locally without an account, or connect Notion for syncing across devices.',
  },
] as const;
</script>

<template>
  <section class="onboarding-simple" aria-labelledby="onboarding-title">
    <header class="onboarding-simple-header">
      <strong>Quick start</strong>
      <button type="button" class="secondary-button" @click="emit('finishLocal')">
        Skip
      </button>
    </header>

    <div class="onboarding-simple-body">
      <div class="onboarding-simple-intro">
        <h1 id="onboarding-title">Capture what matters.</h1>
        <p>Keep useful parts of the web close while you turn them into organized notes.</p>
      </div>

      <div class="onboarding-feature-list">
        <article v-for="feature in features" :key="feature.title" class="onboarding-feature">
          <span class="onboarding-feature-icon" aria-hidden="true">
            <font-awesome-icon :icon="feature.icon" fixed-width />
          </span>
          <div>
            <h2>{{ feature.title }}</h2>
            <p>{{ feature.copy }}</p>
          </div>
        </article>
      </div>

      <p class="onboarding-local-note">
        Your work is saved on this device until you choose to connect Notion.
      </p>
    </div>

    <footer class="onboarding-simple-actions">
      <button type="button" class="secondary-button" @click="emit('finishLocal')">
        Keep it local
      </button>
      <button type="button" @click="emit('setupSync')">
        Set up Notion
      </button>
    </footer>
  </section>
</template>
