<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { EditorContent, useEditor } from '@tiptap/vue-3';
import { TextSelection } from '@tiptap/pm/state';
import StarterKit from '@tiptap/starter-kit';
import {
  decodeJotSource,
  JOT_SOURCE_ATTR,
  JotLink,
} from '@/src/extensions/jotLink';
import { PortableTextEditingKit } from '@/src/extensions/textFormatting';
import {
  createCapturedContent,
  createLinkedHeadingContent,
} from '@/src/services/notionClient';
import { useJotStore } from '@/src/stores/jot';
import type { DocumentContent } from '@/src/types/capture';
import type {
  CaptureSelectionPayload,
  OpenSourceRequestMessage,
} from '@/src/types/messages';

const JOT_DRAG_MIME = 'application/x-jot-capture';
const blockTypes = [
  { label: 'Paragraph', value: 'paragraph' },
  { label: 'Heading 1', value: 'heading-1' },
  { label: 'Heading 2', value: 'heading-2' },
  { label: 'Heading 3', value: 'heading-3' },
  { label: 'Heading 4', value: 'heading-4' },
  { label: 'Heading 5', value: 'heading-5' },
  { label: 'Heading 6', value: 'heading-6' },
  { label: 'Quote', value: 'blockquote' },
  { label: 'Code block', value: 'codeBlock' },
] as const;
const fontSizes = [
  { label: 'Default', value: '' },
  { label: '12', value: '12px' },
  { label: '14', value: '14px' },
  { label: '16', value: '16px' },
  { label: '18', value: '18px' },
  { label: '24', value: '24px' },
  { label: '32', value: '32px' },
] as const;
const textColors = [
  { label: 'Default', value: '' },
  { label: 'Gray', value: '#6b6f76' },
  { label: 'Red', value: '#c2410c' },
  { label: 'Yellow', value: '#a16207' },
  { label: 'Green', value: '#15803d' },
  { label: 'Blue', value: '#173494' },
  { label: 'Purple', value: '#7e22ce' },
] as const;
const highlightColors = [
  { label: 'None', value: '' },
  { label: 'Yellow', value: '#fef08a' },
  { label: 'Green', value: '#bbf7d0' },
  { label: 'Blue', value: '#bfdbfe' },
  { label: 'Pink', value: '#fbcfe8' },
  { label: 'Gray', value: '#e4e4e7' },
] as const;

const store = useJotStore();
const saveTimer = ref<number>();
const pageTitleDraft = ref('');
const editorStateVersion = ref(0);
let activePageId = '';
let isApplyingStoredContent = false;

const editor = useEditor({
  extensions: [
    StarterKit.configure({
      heading: {
        levels: [1, 2, 3, 4, 5, 6],
      },
      link: false,
    }),
    JotLink,
    PortableTextEditingKit,
  ],
  content: {
    type: 'doc',
    content: [{ type: 'paragraph' }],
  },
  editorProps: {
    attributes: {
      'aria-label': 'Project page editor',
    },
    handleClick: (_view, _pos, event) => {
      const anchor =
        event.target instanceof Element ? event.target.closest('a') : null;

      if (!anchor?.href) {
        return false;
      }

      event.preventDefault();

      const sourcePayload = decodeJotSource(
        anchor.getAttribute(`data-${kebabCase(JOT_SOURCE_ATTR)}`),
      );

      if (sourcePayload) {
        void browser.runtime.sendMessage({
          type: 'jot.openSourceRequest',
          payload: sourcePayload,
        } satisfies OpenSourceRequestMessage);
        return true;
      }

      void browser.tabs.create({ active: true, url: anchor.href });
      return true;
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
    editorStateVersion.value += 1;

    if (isApplyingStoredContent) {
      return;
    }

    window.clearTimeout(saveTimer.value);
    saveTimer.value = window.setTimeout(() => {
      void store.saveCurrentPageContent(editor.getJSON() as DocumentContent);
    }, 450);
  },
  onSelectionUpdate: () => {
    editorStateVersion.value += 1;
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

const activeBlockType = computed(() => {
  editorStateVersion.value;

  if (!editor.value) {
    return 'paragraph';
  }

  for (const level of [1, 2, 3, 4, 5, 6]) {
    if (editor.value.isActive('heading', { level })) {
      return `heading-${level}`;
    }
  }

  if (editor.value.isActive('blockquote')) {
    return 'blockquote';
  }

  if (editor.value.isActive('codeBlock')) {
    return 'codeBlock';
  }

  return 'paragraph';
});

const activeFontSize = computed(() => {
  editorStateVersion.value;
  return String(editor.value?.getAttributes('textStyle').fontSize ?? '');
});

const activeTextColor = computed(() => {
  editorStateVersion.value;
  return String(editor.value?.getAttributes('textStyle').color ?? '');
});

const activeHighlightColor = computed(() => {
  editorStateVersion.value;
  return String(editor.value?.getAttributes('textStyle').backgroundColor ?? '');
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

function setBlockType(event: Event) {
  const value = (event.target as HTMLSelectElement).value;
  const chain = editor.value?.chain().focus();

  if (!chain) {
    return;
  }

  if (value === 'paragraph') {
    chain.setParagraph().run();
    return;
  }

  if (value.startsWith('heading-')) {
    chain
      .toggleHeading({ level: Number(value.replace('heading-', '')) as 1 | 2 | 3 | 4 | 5 | 6 })
      .run();
    return;
  }

  if (value === 'blockquote') {
    chain.toggleBlockquote().run();
    return;
  }

  if (value === 'codeBlock') {
    chain.toggleCodeBlock().run();
  }
}

function setFontSize(event: Event) {
  const value = (event.target as HTMLSelectElement).value;

  if (value) {
    editor.value?.chain().focus().setFontSize(value).run();
  } else {
    editor.value?.chain().focus().unsetFontSize().run();
  }
}

function setTextColor(event: Event) {
  const value = (event.target as HTMLSelectElement).value;

  if (value) {
    editor.value?.chain().focus().setTextColor(value).run();
  } else {
    editor.value?.chain().focus().unsetTextColor().run();
  }
}

function setHighlightColor(event: Event) {
  const value = (event.target as HTMLSelectElement).value;

  if (value) {
    editor.value?.chain().focus().setHighlightColor(value).run();
  } else {
    editor.value?.chain().focus().unsetHighlightColor().run();
  }
}

function setLink() {
  if (!editor.value) {
    return;
  }

  const existingHref = editor.value.getAttributes('link').href;
  const href = window.prompt('Paste link URL', existingHref ?? '');

  if (href === null) {
    return;
  }

  const trimmedHref = href.trim();

  if (!trimmedHref) {
    editor.value.chain().focus().extendMarkRange('link').unsetLink().run();
    return;
  }

  editor.value
    .chain()
    .focus()
    .extendMarkRange('link')
    .setLink({ href: trimmedHref })
    .run();
}

function clearFormatting() {
  editor.value?.chain().focus().unsetAllMarks().clearNodes().run();
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

function kebabCase(value: string) {
  return value.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
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
          <div class="toolbar-group block-group" aria-label="Block style">
            <select
              class="toolbar-select block-select"
              aria-label="Block type"
              :disabled="!editor"
              :value="activeBlockType"
              @change="setBlockType"
            >
              <option
                v-for="blockType in blockTypes"
                :key="blockType.value"
                :value="blockType.value"
              >
                {{ blockType.label }}
              </option>
            </select>

            <select
              class="toolbar-select compact-select"
              aria-label="Font size"
              :disabled="!editor"
              :value="activeFontSize"
              @change="setFontSize"
            >
              <option
                v-for="fontSize in fontSizes"
                :key="fontSize.value"
                :value="fontSize.value"
              >
                {{ fontSize.label }}
              </option>
            </select>
          </div>

          <div class="toolbar-group" aria-label="Inline formatting">
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
              :class="{ active: editor?.isActive('underline') }"
              :disabled="!editor"
              title="Underline"
              @click="editor?.chain().focus().toggleUnderline().run()"
            >
              U
            </button>
            <button
              type="button"
              :class="{ active: editor?.isActive('strike') }"
              :disabled="!editor"
              title="Strikethrough"
              @click="editor?.chain().focus().toggleStrike().run()"
            >
              S
            </button>
            <button
              type="button"
              :class="{ active: editor?.isActive('code') }"
              :disabled="!editor"
              title="Inline code"
              @click="editor?.chain().focus().toggleCode().run()"
            >
              &lt;/&gt;
            </button>
            <button
              type="button"
              :class="{ active: editor?.isActive('superscript') }"
              :disabled="!editor"
              title="Superscript"
              @click="editor?.chain().focus().toggleSuperscript().run()"
            >
              x2
            </button>
            <button
              type="button"
              :class="{ active: editor?.isActive('subscript') }"
              :disabled="!editor"
              title="Subscript"
              @click="editor?.chain().focus().toggleSubscript().run()"
            >
              x2
            </button>
          </div>

          <div class="toolbar-group color-group" aria-label="Color">
            <select
              class="toolbar-select compact-select"
              aria-label="Text color"
              :disabled="!editor"
              :value="activeTextColor"
              @change="setTextColor"
            >
              <option
                v-for="color in textColors"
                :key="color.value"
                :value="color.value"
              >
                {{ color.label }}
              </option>
            </select>

            <select
              class="toolbar-select compact-select"
              aria-label="Highlight"
              :disabled="!editor"
              :value="activeHighlightColor"
              @change="setHighlightColor"
            >
              <option
                v-for="color in highlightColors"
                :key="color.value"
                :value="color.value"
              >
                {{ color.label }}
              </option>
            </select>
          </div>

          <div class="toolbar-group" aria-label="Lists and inserts">
            <button
              type="button"
              :class="{ active: editor?.isActive('link') }"
              :disabled="!editor"
              title="Link"
              @click="setLink"
            >
              Link
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
              :class="{ active: editor?.isActive('taskList') }"
              :disabled="!editor"
              title="Task list"
              @click="editor?.chain().focus().toggleTaskList().run()"
            >
              []
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
              :class="{ active: editor?.isActive('codeBlock') }"
              :disabled="!editor"
              title="Code block"
              @click="editor?.chain().focus().toggleCodeBlock().run()"
            >
              Code
            </button>
            <button
              type="button"
              :disabled="!editor"
              title="Divider"
              @click="editor?.chain().focus().setHorizontalRule().run()"
            >
              HR
            </button>
          </div>

          <div class="toolbar-group utility-group" aria-label="History and cleanup">
            <button
              type="button"
              :disabled="!editor"
              title="Clear formatting"
              @click="clearFormatting"
            >
              Tx
            </button>
            <button
              type="button"
              :disabled="!editor"
              title="Undo"
              @click="editor?.chain().focus().undo().run()"
            >
              Undo
            </button>
            <button
              type="button"
              :disabled="!editor"
              title="Redo"
              @click="editor?.chain().focus().redo().run()"
            >
              Redo
            </button>
          </div>
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
  gap: 6px;
  align-items: stretch;
}

.toolbar-group {
  display: inline-flex;
  flex: 0 1 auto;
  flex-wrap: wrap;
  gap: 3px;
  align-items: center;
  min-width: 0;
  padding-right: 6px;
  border-right: 1px solid var(--jot-border);
}

.toolbar-group:last-child {
  padding-right: 0;
  border-right: 0;
}

.block-group {
  flex: 1 1 214px;
}

.color-group,
.utility-group {
  flex: 0 1 auto;
}

.toolbar button,
.page-controls button,
.toolbar-select {
  min-width: 30px;
  min-height: 30px;
  padding: 0 8px;
  border-color: var(--jot-border);
  background: var(--jot-surface-muted);
  color: var(--jot-text);
  font-weight: 700;
}

.toolbar-select {
  width: auto;
  max-width: 100%;
}

.block-select {
  flex: 1 1 126px;
  min-width: 126px;
}

.compact-select {
  flex: 0 1 88px;
  min-width: 78px;
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
.editor :deep(.tiptap ol),
.editor :deep(.tiptap pre) {
  margin: 0 0 0.85rem;
}

.editor :deep(.tiptap h1),
.editor :deep(.tiptap h2),
.editor :deep(.tiptap h3),
.editor :deep(.tiptap h4),
.editor :deep(.tiptap h5),
.editor :deep(.tiptap h6) {
  margin: 0 0 0.75rem;
  line-height: 1.22;
}

.editor :deep(.tiptap h1) {
  font-size: 1.8rem;
}

.editor :deep(.tiptap h2) {
  font-size: 1.55rem;
}

.editor :deep(.tiptap h3) {
  font-size: 1.32rem;
}

.editor :deep(.tiptap h4) {
  font-size: 1.14rem;
}

.editor :deep(.tiptap h5) {
  font-size: 1rem;
}

.editor :deep(.tiptap h6) {
  color: var(--jot-muted);
  font-size: 0.9rem;
  text-transform: uppercase;
}

.editor :deep(.tiptap ul),
.editor :deep(.tiptap ol) {
  padding-left: 1.35rem;
}

.editor :deep(.tiptap ul[data-type="taskList"]) {
  padding-left: 0;
  list-style: none;
}

.editor :deep(.tiptap li[data-type="taskItem"]) {
  display: grid;
  grid-template-columns: 22px minmax(0, 1fr);
  gap: 4px;
  align-items: start;
}

.editor :deep(.tiptap li[data-type="taskItem"] > label) {
  display: grid;
  place-items: center;
  min-height: 1.45em;
}

.editor :deep(.tiptap li[data-type="taskItem"] input) {
  margin: 0;
}

.editor :deep(.tiptap code) {
  border-radius: 4px;
  background: var(--jot-surface-muted);
  padding: 0.1em 0.28em;
  font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
  font-size: 0.9em;
}

.editor :deep(.tiptap pre) {
  overflow: auto;
  border-radius: 6px;
  background: #111113;
  color: #f4f4f5;
  padding: 12px;
}

.editor :deep(.tiptap pre code) {
  background: transparent;
  color: inherit;
  padding: 0;
}

.editor :deep(.tiptap hr) {
  margin: 1.1rem 0;
  border: 0;
  border-top: 1px solid var(--jot-border-strong);
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
