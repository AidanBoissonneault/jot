<script setup lang="ts">
/** Shows the active workspace and project controls. */
import type { TopBarContext } from './topBarContext';
import ProjectHeaderControls from './ProjectHeaderControls.vue';

defineProps<{ context: TopBarContext }>();
</script>

<template>
  <div class="topbar-status">
    <div class="topbar-meta">
      <ProjectHeaderControls :context="context" />
    </div>
  </div>
</template>
