<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { EditorContent, useEditor } from '@tiptap/vue-3';
import { TextSelection } from '@tiptap/pm/state';
import StarterKit from '@tiptap/starter-kit';
import {
  createCapturedContent,
  createLinkedHeadingContent,
} from '@/src/services/notionClient';
import { useJotStore } from '@/src/stores/jot';
import type { DocumentContent } from '@/src/types/capture';
import type { CaptureSelectionPayload } from '@/src/types/messages';

const JOT_DRAG_MIME = 'application/x-jot-capture';

const store = useJotStore();
const saveTimer = ref<number>();
const pageTitleDraft = ref('');
let activePageId = '';
let isApplyingStoredContent = false;

const editor = useEditor({
  extensions: [StarterKit],
  content: {
    type: 'doc',
    content: [{ type: 'paragraph' }],
  },
  editorProps: {
    attributes: {
      'aria-label': 'Project page editor',
    },
    handleDrop: (view, event) => {
      const payload = readHeadingDropPayload(event);

      if (!payload) {
        return false;
      }

      const dropPosition = view.posAtCoords({
        left: event.clientX,
        top: event.clientY,
      });

      event.preventDefault();

      if (dropPosition) {
        view.dispatch(
          view.state.tr.setSelection(
            TextSelection.near(view.state.doc.resolve(dropPosition.pos)),
          ),
        );
      }

      editor.value
        ?.chain()
        .focus()
        .insertContent(createLinkedHeadingContent(payload))
        .run();

      if (editor.value) {
        void store.saveCurrentPageContent(editor.value.getJSON() as DocumentContent);
      }

      return true;
    },
  },
  onUpdate: ({ editor }) => {
    if (isApplyingStoredContent) {
      return;
    }

    window.clearTimeout(saveTimer.value);
    saveTimer.value = window.setTimeout(() => {
      void store.saveCurrentPageContent(editor.getJSON() as DocumentContent);
    }, 450);
  },
});

const currentProjectModel = computed({
  get: () => store.currentProjectId,
  set: (projectId: string) => {
    void selectProject(projectId);
  },
});

const currentPageModel = computed({
  get: () => store.currentPage?.id ?? '',
  set: (pageId: string) => {
    void selectPage(pageId);
  },
});

const saveLabel = computed(() => {
  if (store.isLoading) {
    return 'Loading';
  }

  if (store.saveStatus === 'saving') {
    return 'Saving';
  }

  if (store.saveStatus === 'error') {
    return 'Save failed';
  }

  return 'Saved';
});

onMounted(() => {
  store.startRuntimeListener();
  store.registerCaptureInsertHandler(insertCaptureAtCursor);
  void store.initialize();
});

onBeforeUnmount(() => {
  window.clearTimeout(saveTimer.value);
  if (editor.value && store.currentPage) {
    void store.saveCurrentPageContent(editor.value.getJSON() as DocumentContent);
  }
  editor.value?.destroy();
});

watch(
  () => store.currentPage,
  (page) => {
    if (!editor.value || !page) {
      return;
    }

    const editorContent = JSON.stringify(editor.value.getJSON());
    const storedContent = JSON.stringify(page.content);
    const isPageChange = activePageId !== page.id;

    if (!isPageChange && editorContent === storedContent) {
      return;
    }

    activePageId = page.id;
    pageTitleDraft.value = page.title;
    isApplyingStoredContent = true;
    editor.value.commands.setContent(page.content, { emitUpdate: false });
    isApplyingStoredContent = false;
  },
);

watch(
  () => store.currentPage?.title,
  (title) => {
    pageTitleDraft.value = title ?? '';
  },
);

async function insertCaptureAtCursor(payload: CaptureSelectionPayload) {
  if (!editor.value || !store.currentPage) {
    return false;
  }

  editor.value.chain().focus().insertContent(createCapturedContent(payload)).run();
  await store.saveCurrentPageContent(editor.value.getJSON() as DocumentContent);
  return true;
}

async function selectProject(projectId: string) {
  await flushEditorContent();
  await store.selectProject(projectId);
}

async function selectPage(pageId: string) {
  if (!pageId || pageId === store.currentPage?.id) {
    return;
  }

  await flushEditorContent();
  await store.selectPage(pageId);
}

async function createPage() {
  await flushEditorContent();
  await store.createPage();
}

async function renamePage() {
  if (!store.currentPage || pageTitleDraft.value === store.currentPage.title) {
    return;
  }

  await flushEditorContent();
  await store.renameCurrentPage(pageTitleDraft.value);
}

async function archivePage() {
  if (!store.currentPage) {
    return;
  }

  const shouldArchive = window.confirm(`Archive "${store.currentPage.title}"?`);

  if (!shouldArchive) {
    return;
  }

  await flushEditorContent();
  await store.archiveCurrentPage();
}

function blurTitleInput(event: Event) {
  (event.target as HTMLInputElement).blur();
}

async function flushEditorContent() {
  window.clearTimeout(saveTimer.value);

  if (editor.value && store.currentPage) {
    await store.saveCurrentPageContent(editor.value.getJSON() as DocumentContent);
  }
}

function readHeadingDropPayload(event: DragEvent) {
  const rawPayload = event.dataTransfer?.getData(JOT_DRAG_MIME);

  if (!rawPayload) {
    return null;
  }

  try {
    const payload = JSON.parse(rawPayload) as CaptureSelectionPayload;
    return payload.highlightMeta.isHeading ? payload : null;
  } catch {
    return null;
  }
}
</script>

<template>
  <main class="shell">
    <header class="topbar">
      <div class="title">
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

    <p v-if="store.errorMessage" class="error">{{ store.errorMessage }}</p>

    <section class="editor-shell" aria-label="Project page">
      <header class="editor-header">
        <div class="page-controls">
          <select
            v-model="currentPageModel"
            aria-label="Page"
            :disabled="store.isLoading || store.pages.length === 0"
          >
            <option
              v-for="page in store.pages"
              :key="page.id"
              :value="page.id"
            >
              {{ page.title }}
            </option>
          </select>

          <button
            type="button"
            class="icon-button"
            :disabled="store.isLoading || !store.currentProjectId"
            title="New page"
            @click="createPage"
          >
            +
          </button>

          <button
            type="button"
            class="archive-button"
            :disabled="store.isLoading || !store.currentPage"
            title="Archive page"
            @click="archivePage"
          >
            Archive
          </button>
        </div>

        <div class="page-title">
          <input
            v-model="pageTitleDraft"
            aria-label="Page title"
            :disabled="store.isLoading || !store.currentPage"
            @blur="renamePage"
            @keydown.enter="blurTitleInput"
          >
          <p>{{ saveLabel }}</p>
        </div>

        <div class="toolbar" aria-label="Editor toolbar">
          <button
            type="button"
            :class="{ active: editor?.isActive('paragraph') }"
            :disabled="!editor"
            title="Paragraph"
            @click="editor?.chain().focus().setParagraph().run()"
          >
            P
          </button>
          <button
            type="button"
            :class="{ active: editor?.isActive('heading', { level: 1 }) }"
            :disabled="!editor"
            title="Heading"
            @click="editor?.chain().focus().toggleHeading({ level: 1 }).run()"
          >
            H
          </button>
          <button
            type="button"
            :class="{ active: editor?.isActive('bold') }"
            :disabled="!editor"
            title="Bold"
            @click="editor?.chain().focus().toggleBold().run()"
          >
            B
          </button>
          <button
            type="button"
            :class="{ active: editor?.isActive('italic') }"
            :disabled="!editor"
            title="Italic"
            @click="editor?.chain().focus().toggleItalic().run()"
          >
            I
          </button>
          <button
            type="button"
            :class="{ active: editor?.isActive('bulletList') }"
            :disabled="!editor"
            title="Bullet list"
            @click="editor?.chain().focus().toggleBulletList().run()"
          >
            -
          </button>
          <button
            type="button"
            :class="{ active: editor?.isActive('orderedList') }"
            :disabled="!editor"
            title="Ordered list"
            @click="editor?.chain().focus().toggleOrderedList().run()"
          >
            1.
          </button>
          <button
            type="button"
            :class="{ active: editor?.isActive('blockquote') }"
            :disabled="!editor"
            title="Quote"
            @click="editor?.chain().focus().toggleBlockquote().run()"
          >
            "
          </button>
          <button
            type="button"
            :disabled="!editor"
            title="Undo"
            @click="editor?.chain().focus().undo().run()"
          >
            U
          </button>
          <button
            type="button"
            :disabled="!editor"
            title="Redo"
            @click="editor?.chain().focus().redo().run()"
          >
            R
          </button>
        </div>
      </header>

      <editor-content v-if="editor" class="editor" :editor="editor" />
    </section>
  </main>
</template>

<style scoped>
.shell {
  display: grid;
  grid-template-rows: auto auto 1fr;
  min-height: 100vh;
  padding: 14px;
}

.topbar {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 10px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--jot-border);
}

.title h1,
.title p,
.page-title input,
.editor-header p {
  margin: 0;
}

.title h1 {
  font-size: 1.25rem;
  font-weight: 750;
}

.title p,
.editor-header p {
  color: var(--jot-muted);
}

.error {
  margin: 10px 0 0;
  color: var(--jot-warning);
}

.editor-shell {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  min-height: 0;
  margin-top: 12px;
  border: 1px solid var(--jot-border);
  border-radius: var(--jot-radius);
  background: var(--jot-surface);
  box-shadow: var(--jot-shadow);
}

.editor-header {
  display: grid;
  gap: 10px;
  padding: 10px;
  border-bottom: 1px solid var(--jot-border);
}

.page-controls {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  gap: 6px;
}

.page-title {
  display: grid;
  gap: 3px;
}

.page-title input {
  width: 100%;
  min-width: 0;
  border: 0;
  background: transparent;
  color: var(--jot-text);
  font-size: 1rem;
  font-weight: 700;
}

.page-title input:focus {
  outline: 2px solid color-mix(in srgb, var(--jot-accent) 34%, transparent);
  outline-offset: 2px;
}

.toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.toolbar button,
.page-controls button {
  min-width: 30px;
  min-height: 30px;
  padding: 0 8px;
  border-color: var(--jot-border);
  background: var(--jot-surface-muted);
  color: var(--jot-text);
  font-weight: 700;
}

.page-controls .archive-button {
  min-width: 72px;
}

.toolbar button.active {
  border-color: var(--jot-accent);
  background: var(--jot-accent);
  color: white;
}

.editor {
  min-height: 0;
  overflow: auto;
}

.editor :deep(.tiptap) {
  min-height: calc(100vh - 190px);
  padding: 16px;
}

.editor :deep(.tiptap:focus) {
  outline: none;
}

.editor :deep(.tiptap > *:first-child) {
  margin-top: 0;
}

.editor :deep(.tiptap p),
.editor :deep(.tiptap blockquote),
.editor :deep(.tiptap ul),
.editor :deep(.tiptap ol) {
  margin: 0 0 0.85rem;
}

.editor :deep(.tiptap h1) {
  margin: 0 0 0.9rem;
  font-size: 1.45rem;
  line-height: 1.2;
}

.editor :deep(.tiptap blockquote) {
  padding-left: 12px;
  border-left: 3px solid var(--jot-accent);
  color: var(--jot-text);
}

.editor :deep(.tiptap a) {
  color: var(--jot-accent-strong);
  overflow-wrap: anywhere;
}
</style>
