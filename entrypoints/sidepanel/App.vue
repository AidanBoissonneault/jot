<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { captureLabels, useJotStore } from '@/src/stores/jot';
import type { Capture, CaptureType } from '@/src/types/capture';

const store = useJotStore();
const quickNote = ref('');

const captureTypes: CaptureType[] = ['quote', 'task', 'idea', 'link'];

const currentProjectModel = computed({
  get: () => store.currentProjectId,
  set: (projectId: string) => {
    void store.selectProject(projectId);
  },
});

onMounted(() => {
  void store.initialize();
});

async function submitQuickNote() {
  await store.createQuickNote(quickNote.value);
  quickNote.value = '';
}

function formatTime(capture: Capture) {
  return new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(capture.createdAt));
}
</script>

<template>
  <main class="shell">
    <header class="topbar">
      <div>
        <h1>Jot</h1>
        <p>{{ store.currentProject?.name ?? 'Loading project' }}</p>
      </div>

      <select
        v-model="currentProjectModel"
        aria-label="Project"
        :disabled="store.isLoading || store.projects.length === 0"
      >
        <option
          v-for="project in store.projects"
          :key="project.id"
          :value="project.id"
        >
          {{ project.name }}
        </option>
      </select>
    </header>

    <form class="quick-note" @submit.prevent="submitQuickNote">
      <textarea
        v-model="quickNote"
        rows="3"
        placeholder="+ Quick note..."
        aria-label="Quick note"
      />
      <button type="submit" :disabled="!quickNote.trim() || store.isLoading">
        Save
      </button>
    </form>

    <p v-if="store.errorMessage" class="error">{{ store.errorMessage }}</p>

    <section class="zones" aria-label="Capture sections">
      <article
        v-for="type in captureTypes"
        :key="type"
        class="drop-zone"
        :data-type="type"
      >
        <header>
          <h2>{{ captureLabels[type] }}</h2>
          <span>{{ store.capturesByType[type].length }}</span>
        </header>

        <ul v-if="store.capturesByType[type].length" class="capture-list">
          <li v-for="capture in store.capturesByType[type]" :key="capture.id">
            <p>{{ capture.content }}</p>
            <small>{{ capture.pageTitle }}</small>
          </li>
        </ul>

        <p v-else class="empty">Drop captures here</p>
      </article>
    </section>

    <section class="activity" aria-label="Recent activity">
      <header>
        <h2>Recent Activity</h2>
        <span>{{ store.recentCaptures.length }}</span>
      </header>

      <ol v-if="store.recentCaptures.length">
        <li v-for="capture in store.recentCaptures" :key="capture.id">
          <span class="type">{{ captureLabels[capture.type] }}</span>
          <p>{{ capture.content }}</p>
          <time :datetime="capture.createdAt">{{ formatTime(capture) }}</time>
        </li>
      </ol>

      <p v-else class="empty">No captures yet</p>
    </section>
  </main>
</template>

<style scoped>
.shell {
  min-height: 100vh;
  padding: 16px;
}

.topbar {
  display: grid;
  grid-template-columns: 1fr;
  gap: 12px;
  padding-bottom: 16px;
  border-bottom: 1px solid var(--jot-border);
}

.topbar h1,
.topbar p,
.drop-zone h2,
.activity h2,
.capture-list p,
.activity p {
  margin: 0;
}

.topbar h1 {
  font-size: 1.35rem;
  font-weight: 750;
}

.topbar p,
small,
time,
.empty {
  color: var(--jot-muted);
}

.quick-note {
  display: grid;
  gap: 8px;
  margin: 16px 0;
}

.quick-note textarea {
  min-height: 80px;
  padding: 10px 12px;
  resize: vertical;
}

.quick-note button {
  justify-self: end;
  min-width: 76px;
  min-height: 36px;
  padding: 0 14px;
  font-weight: 650;
}

.error {
  margin: 0 0 12px;
  color: var(--jot-warning);
}

.zones {
  display: grid;
  gap: 10px;
  padding: 14px 0;
  border-top: 1px solid var(--jot-border);
  border-bottom: 1px solid var(--jot-border);
}

.drop-zone,
.activity {
  border: 1px solid var(--jot-border);
  border-radius: var(--jot-radius);
  background: var(--jot-surface);
  box-shadow: var(--jot-shadow);
}

.drop-zone {
  min-height: 118px;
  padding: 12px;
}

.drop-zone:hover {
  border-color: var(--jot-border-strong);
}

.drop-zone header,
.activity header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 10px;
}

.drop-zone h2,
.activity h2 {
  font-size: 0.95rem;
  font-weight: 700;
}

.drop-zone header span,
.activity header span,
.type {
  border-radius: 999px;
  background: var(--jot-surface-muted);
  color: var(--jot-accent-strong);
  font-size: 0.75rem;
  font-weight: 700;
}

.drop-zone header span,
.activity header span {
  min-width: 24px;
  padding: 2px 7px;
  text-align: center;
}

.capture-list,
.activity ol {
  display: grid;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.capture-list li,
.activity li {
  display: grid;
  gap: 4px;
  padding: 9px;
  border-radius: 6px;
  background: var(--jot-surface-muted);
}

.capture-list p,
.activity p {
  overflow-wrap: anywhere;
}

.empty {
  margin: 0;
  padding: 18px 8px;
  border: 1px dashed var(--jot-border);
  border-radius: 6px;
  text-align: center;
}

.activity {
  margin-top: 16px;
  padding: 12px;
}

.activity li {
  grid-template-columns: auto 1fr auto;
  align-items: center;
}

.type {
  padding: 3px 7px;
}
</style>
