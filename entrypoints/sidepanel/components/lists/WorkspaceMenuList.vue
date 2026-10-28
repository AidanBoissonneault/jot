<script setup lang="ts">
/** Shows workspaces, their projects, and pages in one expandable tree. */
import { onBeforeUnmount, ref, watch } from 'vue';
import type { Project, ProjectPage, Workspace } from '@/src/types/capture';

const props = defineProps<{
  workspaces: Workspace[];
  projects: Project[];
  pagesByProject: Record<string, ProjectPage[]>;
  loadingProjectIds: string[];
  colorForCategory: (category: string) => string;
  selectedWorkspaceId: string;
  selectedProjectId: string | null;
  selectedPageId: string | undefined;
  authenticated: boolean;
}>();

const emit = defineEmits<{
  selectProject: [workspaceId: string, projectId: string];
  selectPage: [workspaceId: string, projectId: string, pageId: string];
  loadPages: [projectId: string];
  createWorkspace: [];
  renameWorkspace: [workspaceId: string, name: string];
  createProject: [workspaceId: string];
  createPage: [workspaceId: string, projectId: string];
  deleteWorkspace: [workspaceId: string];
  deleteProject: [projectId: string];
  deletePage: [pageId: string];
  moveProject: [projectId: string, workspaceId: string];
  movePage: [pageId: string, projectId: string, targetPageId?: string, position?: 'before' | 'after'];
}>();

const expandedWorkspaceIds = ref<string[]>([]);
const expandedProjectIds = ref<string[]>([]);
const detailsWorkspaceId = ref<string | null>(null);
const workspaceNameDraft = ref('');
const draggedItem = ref<{ kind: 'project' | 'page'; id: string } | null>(null);
const activeDropTarget = ref('');
const WORKSPACE_TREE_DRAG_TYPE = 'application/x-jottathing-workspace-item';
let projectExpandTimer: ReturnType<typeof setTimeout> | undefined;
let pendingProjectExpansionId = '';

function isWorkspaceExpanded(workspaceId: string) {
  return expandedWorkspaceIds.value.includes(workspaceId);
}

function isProjectExpanded(projectId: string) {
  return expandedProjectIds.value.includes(projectId);
}

function toggleWorkspace(workspaceId: string) {
  expandedWorkspaceIds.value = isWorkspaceExpanded(workspaceId)
    ? expandedWorkspaceIds.value.filter((id) => id !== workspaceId)
    : [...expandedWorkspaceIds.value, workspaceId];
}

function handleWorkspaceClick(event: MouseEvent, workspace: Workspace) {
  // The first click handles normal expansion. Ignore the second click in a
  // double-click so it doesn't immediately collapse the workspace again.
  if (event.detail > 1) return;
  toggleWorkspace(workspace.id);
}

function handleWorkspaceDoubleClick(workspace: Workspace) {
  if (workspace.kind === 'local') openWorkspaceDetails(workspace);
}

function openWorkspaceDetails(workspace: Workspace) {
  if (detailsWorkspaceId.value === workspace.id) {
    detailsWorkspaceId.value = null;
    return;
  }
  detailsWorkspaceId.value = workspace.id;
  workspaceNameDraft.value = workspace.name;
}

function closeWorkspaceDetails() {
  detailsWorkspaceId.value = null;
  workspaceNameDraft.value = '';
}

function saveWorkspaceName(workspace: Workspace) {
  const name = workspaceNameDraft.value.trim();
  if (workspace.kind !== 'local' || !name || name === workspace.name) return;
  emit('renameWorkspace', workspace.id, name);
  closeWorkspaceDetails();
}

function selectProject(workspaceId: string, projectId: string) {
  detailsWorkspaceId.value = null;
  emit('selectProject', workspaceId, projectId);
}

function selectPage(workspaceId: string, projectId: string, pageId: string) {
  detailsWorkspaceId.value = null;
  emit('selectPage', workspaceId, projectId, pageId);
}

function startDrag(event: DragEvent, item: { kind: 'project' | 'page'; id: string }) {
  draggedItem.value = item;
  if (!event.dataTransfer) return;
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData(WORKSPACE_TREE_DRAG_TYPE, JSON.stringify(item));
}

function cancelProjectExpansion(projectId?: string) {
  if (!projectExpandTimer || (projectId && pendingProjectExpansionId !== projectId)) return;
  clearTimeout(projectExpandTimer);
  projectExpandTimer = undefined;
  pendingProjectExpansionId = '';
}

function finishDrag() {
  cancelProjectExpansion();
  draggedItem.value = null;
  activeDropTarget.value = '';
}

function dragItemFrom(event: DragEvent) {
  if (draggedItem.value) return draggedItem.value;
  const raw = event.dataTransfer?.getData(WORKSPACE_TREE_DRAG_TYPE);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { kind?: unknown; id?: unknown };
    if ((parsed.kind === 'project' || parsed.kind === 'page') && typeof parsed.id === 'string') {
      return { kind: parsed.kind, id: parsed.id };
    }
  } catch {
    // Ignore invalid or unrelated drag payloads.
  }
  return null;
}

function dragOverWorkspace(event: DragEvent, workspaceId: string) {
  const item = dragItemFrom(event);
  const project = item?.kind === 'project'
    ? props.projects.find((entry) => entry.id === item.id)
    : undefined;
  const target = props.workspaces.find((entry) => entry.id === workspaceId);
  if (!project || !target || project.workspaceId === workspaceId) {
    activeDropTarget.value = '';
    return;
  }
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
  activeDropTarget.value = `workspace:${workspaceId}`;
}

function dragOverProject(event: DragEvent, projectId: string) {
  const item = dragItemFrom(event);
  const page = item?.kind === 'page'
    ? Object.values(props.pagesByProject).flat().find((entry) => entry.id === item.id)
    : undefined;
  const targetExists = props.projects.some((project) => project.id === projectId);
  if (!targetExists || !page) {
    cancelProjectExpansion(projectId);
    activeDropTarget.value = '';
    return;
  }
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
  activeDropTarget.value = `project:${projectId}`;
  if (!isProjectExpanded(projectId) && pendingProjectExpansionId !== projectId) {
    cancelProjectExpansion();
    pendingProjectExpansionId = projectId;
    projectExpandTimer = setTimeout(() => {
      projectExpandTimer = undefined;
      pendingProjectExpansionId = '';
      if (draggedItem.value?.kind !== 'page') return;
      expandedProjectIds.value = [...new Set([...expandedProjectIds.value, projectId])];
      emit('loadPages', projectId);
    }, 450);
  }
}

function dragOverPageSlot(event: DragEvent, projectId: string, slotIndex: number) {
  const item = dragItemFrom(event);
  const page = item?.kind === 'page'
    ? Object.values(props.pagesByProject).flat().find((entry) => entry.id === item.id)
    : undefined;
  if (!page) {
    activeDropTarget.value = '';
    return;
  }
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
  activeDropTarget.value = `page-slot:${projectId}:${slotIndex}`;
}

function dragLeave(event: DragEvent, target: string) {
  if (event.relatedTarget instanceof Node && event.currentTarget instanceof Node &&
    event.currentTarget.contains(event.relatedTarget)) return;
  if (activeDropTarget.value === target) activeDropTarget.value = '';
  if (target.startsWith('project:')) cancelProjectExpansion(target.slice('project:'.length));
}

function dropOnWorkspace(event: DragEvent, workspaceId: string) {
  event.preventDefault();
  event.stopPropagation();
  const item = dragItemFrom(event);
  const project = item?.kind === 'project'
    ? props.projects.find((entry) => entry.id === item.id)
    : undefined;
  if (project && project.workspaceId !== workspaceId) emit('moveProject', project.id, workspaceId);
  finishDrag();
}

function dropOnProject(event: DragEvent, projectId: string) {
  event.preventDefault();
  event.stopPropagation();
  const item = dragItemFrom(event);
  const page = item?.kind === 'page'
    ? Object.values(props.pagesByProject).flat().find((entry) => entry.id === item.id)
    : undefined;
  if (page) emit('movePage', page.id, projectId);
  finishDrag();
}

function dropOnPageSlot(event: DragEvent, projectId: string, slotIndex: number) {
  event.preventDefault();
  event.stopPropagation();
  const item = dragItemFrom(event);
  const page = item?.kind === 'page'
    ? Object.values(props.pagesByProject).flat().find((entry) => entry.id === item.id)
    : undefined;
  if (!page) {
    finishDrag();
    return;
  }
  const destinationPages = props.pagesByProject[projectId] ?? [];
  if (!destinationPages.length) {
    emit('movePage', page.id, projectId);
  } else if (slotIndex < destinationPages.length) {
    emit('movePage', page.id, projectId, destinationPages[slotIndex].id, 'before');
  } else {
    emit('movePage', page.id, projectId, destinationPages[destinationPages.length - 1].id, 'after');
  }
  finishDrag();
}

onBeforeUnmount(finishDrag);

function toggleProject(projectId: string) {
  if (isProjectExpanded(projectId)) {
    expandedProjectIds.value = expandedProjectIds.value.filter((id) => id !== projectId);
    return;
  }
  expandedProjectIds.value = [...expandedProjectIds.value, projectId];
  emit('loadPages', projectId);
}

function projectsInWorkspace(workspaceId: string) {
  return props.projects.filter((project) => project.workspaceId === workspaceId);
}

function workspaceKindForProject(project: Project): Workspace['kind'] {
  return props.workspaces.find((workspace) => workspace.id === project.workspaceId)?.kind ??
    project.syncMode ?? 'local';
}

function stateLabel(kind: Workspace['kind'], state?: string, message?: string) {
  if (message) return message;
  if (kind === 'local') {
    if (state === 'error') return 'Local save error';
    if (state === 'stale') return 'Local changes waiting to save';
    if (state === 'saving' || state === 'creating') return 'Saving locally';
    return 'Local only';
  }
  if (state === 'error') return 'Sync error';
  if (state === 'stale') return 'Changes waiting to sync';
  if (state === 'saving' || state === 'creating') return 'Syncing';
  return 'Synced with Notion';
}

watch(() => props.selectedWorkspaceId, (workspaceId) => {
  if (workspaceId && !isWorkspaceExpanded(workspaceId)) {
    expandedWorkspaceIds.value = [...expandedWorkspaceIds.value, workspaceId];
  }
}, { immediate: true });

watch(
  () => props.projects.find((project) => project.id === props.selectedProjectId)?.id,
  (projectId) => {
    const project = props.projects.find((entry) => entry.id === projectId);
    if (!project) return;
    if (project.workspaceId && !isWorkspaceExpanded(project.workspaceId)) {
      expandedWorkspaceIds.value = [...expandedWorkspaceIds.value, project.workspaceId];
    }
    if (!isProjectExpanded(project.id)) {
      expandedProjectIds.value = [...expandedProjectIds.value, project.id];
    }
    emit('loadPages', project.id);
  },
  { immediate: true },
);
</script>

<template>
  <div class="workspace-tree">
    <div class="workspace-tree-heading-row">
      <span class="workspace-dropdown-heading">Workspaces</span>
    </div>
    <section v-for="workspace in workspaces" :key="workspace.id" class="workspace-tree-group">
      <div class="workspace-tree-row">
        <button
          type="button"
          class="workspace-tree-select workspace-tree-workspace"
          :class="{
            active: workspace.id === selectedWorkspaceId,
            'details-open': workspace.id === detailsWorkspaceId,
            'drop-target': activeDropTarget === `workspace:${workspace.id}`,
          }"
          :aria-label="`${workspace.name}, expand or collapse workspace${workspace.kind === 'local' ? ', double-click to rename' : ''}, or drop a project here to move it, ${stateLabel(workspace.kind, workspace.syncState, workspace.syncMessage)}`"
          :title="workspace.kind === 'local'
            ? 'Click to expand; double-click to rename; drop a project here to move it'
            : 'Click to expand; drop a project here to move it'"
          @dragover="dragOverWorkspace($event, workspace.id)"
          @dragleave="dragLeave($event, `workspace:${workspace.id}`)"
          @drop="dropOnWorkspace($event, workspace.id)"
          @click="handleWorkspaceClick($event, workspace)"
          @dblclick="handleWorkspaceDoubleClick(workspace)"
        >
          <font-awesome-icon :icon="['fas', 'folder-tree']" fixed-width class="workspace-tree-icon" />
          <span class="workspace-tree-name">{{ workspace.name }}</span>
          <span class="workspace-tree-kind">{{ workspace.kind === 'notion' ? 'Notion' : 'Local' }}</span>
          <span
            v-if="authenticated"
            class="workspace-sync-dot"
            :class="[workspace.kind, workspace.syncState, { authenticated }]"
            :title="stateLabel(workspace.kind, workspace.syncState, workspace.syncMessage)"
            aria-hidden="true"
          />
        </button>
        <button
          type="button"
          class="workspace-tree-disclosure"
          :aria-label="`${isWorkspaceExpanded(workspace.id) ? 'Collapse' : 'Expand'} ${workspace.name}`"
          :aria-expanded="isWorkspaceExpanded(workspace.id)"
          @click.stop="toggleWorkspace(workspace.id)"
        >
          <font-awesome-icon
            :icon="['fas', 'chevron-down']"
            :class="{ collapsed: !isWorkspaceExpanded(workspace.id) }"
            fixed-width
          />
        </button>
        <div class="workspace-tree-actions">
          <button
            type="button"
            class="workspace-tree-action"
            :title="`Create project in ${workspace.name}`"
            :aria-label="`Create project in ${workspace.name}`"
            @click.stop="emit('createProject', workspace.id)"
          >
            <font-awesome-icon :icon="['fas', 'folder-plus']" fixed-width />
          </button>
          <button
            v-if="workspace.kind === 'local' && workspaces.filter((item) => item.kind === 'local').length > 1"
            type="button"
            class="workspace-tree-action workspace-tree-delete-action"
            :title="`Delete ${workspace.name}`"
            :aria-label="`Delete ${workspace.name}`"
            @click.stop="emit('deleteWorkspace', workspace.id)"
          >
            <font-awesome-icon :icon="['fas', 'trash-can']" fixed-width />
          </button>
        </div>
      </div>

      <div
        v-if="detailsWorkspaceId === workspace.id"
        class="workspace-tree-details"
        @click.stop
      >
        <label>
          <span>Workspace name</span>
          <input
            v-model="workspaceNameDraft"
            :disabled="workspace.kind !== 'local'"
            :aria-label="`Workspace name for ${workspace.name}`"
            @keydown.enter.prevent="saveWorkspaceName(workspace)"
            @keydown.escape.prevent="closeWorkspaceDetails"
          />
        </label>
        <p v-if="workspace.kind === 'notion'">This workspace is managed by Notion.</p>
        <div v-else class="workspace-tree-details-actions">
          <button type="button" class="workspace-tree-action" title="Cancel" aria-label="Cancel" @click="closeWorkspaceDetails">
            <font-awesome-icon :icon="['fas', 'xmark']" fixed-width />
          </button>
          <button
            type="button"
            class="workspace-tree-action"
            title="Save workspace name"
            aria-label="Save workspace name"
            :disabled="!workspaceNameDraft.trim() || workspaceNameDraft.trim() === workspace.name"
            @click="saveWorkspaceName(workspace)"
          >
            <font-awesome-icon :icon="['fas', 'check']" fixed-width />
          </button>
        </div>
      </div>

      <div v-if="isWorkspaceExpanded(workspace.id)" class="workspace-tree-children">
        <div v-if="projectsInWorkspace(workspace.id).length === 0" class="workspace-tree-empty">
          No projects yet
        </div>
        <section
          v-for="project in projectsInWorkspace(workspace.id)"
          :key="project.id"
          class="workspace-tree-project-group"
        >
          <div class="workspace-tree-row">
            <button
              type="button"
              class="workspace-tree-select workspace-tree-project"
              :class="{
                active: project.id === selectedProjectId,
                'drop-target': activeDropTarget === `project:${project.id}`,
                dragging: draggedItem?.kind === 'project' && draggedItem.id === project.id,
              }"
              draggable="true"
              title="Drag to another workspace, or drop a page here"
              :aria-label="`${project.name}, drag to another workspace or drop pages here, ${stateLabel(workspaceKindForProject(project), project.syncState, project.syncMessage)}`"
              @dragstart="startDrag($event, { kind: 'project', id: project.id })"
              @dragend="finishDrag"
              @dragover="dragOverProject($event, project.id)"
              @dragleave="dragLeave($event, `project:${project.id}`)"
              @drop="dropOnProject($event, project.id)"
              @click="selectProject(workspace.id, project.id)"
            >
              <font-awesome-icon
                :icon="['fas', 'folder']"
                fixed-width
                class="workspace-tree-icon"
              />
              <span class="workspace-tree-name">{{ project.name }}</span>
              <span
                v-if="project.category"
                class="project-list-category"
                :style="{ backgroundColor: colorForCategory(project.category) }"
              >
                {{ project.category }}
              </span>
              <span
                v-if="authenticated"
                class="project-list-sync-dot"
                :class="[workspaceKindForProject(project), project.syncState, { authenticated }]"
                :title="stateLabel(workspaceKindForProject(project), project.syncState, project.syncMessage)"
                aria-hidden="true"
              />
            </button>
            <button
              type="button"
              class="workspace-tree-disclosure"
              :aria-label="`${isProjectExpanded(project.id) ? 'Collapse' : 'Expand'} ${project.name}`"
              :aria-expanded="isProjectExpanded(project.id)"
              @click.stop="toggleProject(project.id)"
            >
              <font-awesome-icon
                :icon="['fas', 'chevron-down']"
                :class="{ collapsed: !isProjectExpanded(project.id) }"
                fixed-width
              />
            </button>
            <div class="workspace-tree-actions">
              <button
                v-if="projectsInWorkspace(workspace.id).length > 1"
                type="button"
                class="workspace-tree-action workspace-tree-delete-action"
                :title="`Delete ${project.name}`"
                :aria-label="`Delete ${project.name}`"
                @click.stop="emit('deleteProject', project.id)"
              >
                <font-awesome-icon :icon="['fas', 'trash-can']" fixed-width />
              </button>
            </div>
          </div>

          <div v-if="isProjectExpanded(project.id)" class="workspace-tree-pages">
            <div v-if="loadingProjectIds.includes(project.id)" class="workspace-tree-empty">
              Loading pages...
            </div>
            <div
              v-else-if="(pagesByProject[project.id] ?? []).length === 0"
              class="workspace-tree-empty"
            >
              No pages yet
            </div>
            <div
              v-if="!loadingProjectIds.includes(project.id)"
              class="workspace-tree-page-drop-zone"
              :class="{ active: activeDropTarget === `page-slot:${project.id}:0` }"
              aria-hidden="true"
              @dragover="dragOverPageSlot($event, project.id, 0)"
              @dragleave="dragLeave($event, `page-slot:${project.id}:0`)"
              @drop="dropOnPageSlot($event, project.id, 0)"
            />
            <template
              v-for="(page, pageIndex) in pagesByProject[project.id] ?? []"
              :key="page.id"
            >
              <div class="workspace-tree-row workspace-tree-page-row">
                <button
                  type="button"
                  class="workspace-tree-select workspace-tree-page"
                  :class="{
                    active: page.id === selectedPageId,
                    dragging: draggedItem?.kind === 'page' && draggedItem.id === page.id,
                  }"
                  draggable="true"
                  title="Drag to reorder or move to another project"
                  :aria-label="`${page.title}, drag to reorder or move to another project, ${stateLabel(workspaceKindForProject(project), page.syncState, page.syncMessage)}`"
                  @dragstart="startDrag($event, { kind: 'page', id: page.id })"
                  @dragend="finishDrag"
                  @click="selectPage(workspace.id, project.id, page.id)"
                >
                  <font-awesome-icon :icon="['fas', 'file-lines']" fixed-width class="workspace-tree-icon" />
                  <span class="workspace-tree-name">{{ page.title }}</span>
                  <span
                    v-if="authenticated"
                    class="page-list-sync-dot"
                    :class="[workspaceKindForProject(project), page.syncState, { authenticated }]"
                    :title="stateLabel(workspaceKindForProject(project), page.syncState, page.syncMessage)"
                    aria-hidden="true"
                  />
                </button>
                <div class="workspace-tree-actions">
                  <button
                    type="button"
                    class="workspace-tree-action workspace-tree-delete-action"
                    :title="`Delete ${page.title}`"
                    :aria-label="`Delete ${page.title}`"
                    @click.stop="emit('deletePage', page.id)"
                  >
                    <font-awesome-icon :icon="['fas', 'trash-can']" fixed-width />
                  </button>
                </div>
              </div>
              <div
                class="workspace-tree-page-drop-zone"
                :class="{ active: activeDropTarget === `page-slot:${project.id}:${pageIndex + 1}` }"
                aria-hidden="true"
                @dragover="dragOverPageSlot($event, project.id, pageIndex + 1)"
                @dragleave="dragLeave($event, `page-slot:${project.id}:${pageIndex + 1}`)"
                @drop="dropOnPageSlot($event, project.id, pageIndex + 1)"
              />
            </template>
            <button
              type="button"
              class="workspace-tree-create-page"
              @click="emit('createPage', workspace.id, project.id)"
            >
              <font-awesome-icon :icon="['fas', 'file-circle-plus']" fixed-width />
              New page
            </button>
          </div>
        </section>
        <button
          type="button"
          class="workspace-tree-add-project"
          @click="emit('createProject', workspace.id)"
        >
          <font-awesome-icon :icon="['fas', 'folder-plus']" fixed-width />
          Add project
        </button>
      </div>
    </section>
    <button type="button" class="workspace-tree-add-workspace" @click="emit('createWorkspace')">
      <font-awesome-icon :icon="['fas', 'folder-plus']" fixed-width />
      Add workspace
    </button>
  </div>
</template>
