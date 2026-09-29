<script setup lang="ts">
/** Composes sync status, project controls, and primary topbar actions. */
import type { TopBarContext } from './topBarContext';
import TopBarStatus from './TopBarStatus.vue';
import TopBarActions from './TopBarActions.vue';

const props = defineProps<{ context: TopBarContext }>();
const context = props.context;
</script>

<template>
  <header class="topbar">
    <TopBarStatus :context="context" />

    <TopBarActions :context="context" />
  </header>
</template>
