<script setup lang="ts">
/** Shows synchronization status and account/workspace identity. */
import type { TopBarContext } from './topBarContext';
import ProjectHeaderControls from './ProjectHeaderControls.vue';

const props = defineProps<{ context: TopBarContext }>();
const context = props.context;
const { syncBadgeClass, syncBadgeHoverTitle, saveLabel, accountLabel, workspaceLabel } = context;
</script>

<template>
  <div class="topbar-status">
    <div
      :class="syncBadgeClass"
      :title="syncBadgeHoverTitle"
      role="status"
      tabindex="0"
      :aria-label="syncBadgeHoverTitle"
    >
      <span class="sync-dot" aria-hidden="true" />
      <span class="sync-label">{{ saveLabel }}</span>
    </div>
    <div class="topbar-meta">
      <ProjectHeaderControls :context="context" />
      <small>{{ accountLabel }} / {{ workspaceLabel }}</small>
    </div>
  </div>
</template>
