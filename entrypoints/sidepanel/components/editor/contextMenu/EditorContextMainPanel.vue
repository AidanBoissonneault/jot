<script setup lang="ts">
/** @file Text, clipboard, source, style, and mark actions. */
import type { EditorContextMenuContext } from '../editorContextMenuContext';

const props = defineProps<{ context: EditorContextMenuContext }>();
const {
  editor,
  editorContextMenuHasSelection,
  cutEditorSelectionToClipboard,
  copyEditorSelectionFromContextMenu,
  pasteClipboardTextIntoEditor,
  activeBlockType,
  blockTypes,
  setContextBlockType,
  activeFontSize,
  fontSizes,
  setContextFontSize,
  runContextMarkCommand,
  openContextLinkPanel,
  editorContextMenuPanel,
  editorContextMenuSource,
  editorContextMenuSourceHost,
  openEditorContextSource,
} = props.context;
</script>

<template>
  <div class="context-menu-stack">
    <div class="context-menu-row">
      <button
        type="button"
        class="context-menu-button text-action"
        :disabled="!editorContextMenuHasSelection"
        title="Cut"
        aria-label="Cut"
        @mousedown.prevent
        @click="cutEditorSelectionToClipboard"
      >
        Cut
      </button>
      <button
        type="button"
        class="context-menu-button text-action"
        :disabled="!editorContextMenuHasSelection"
        title="Copy"
        aria-label="Copy"
        @mousedown.prevent
        @click="copyEditorSelectionFromContextMenu"
      >
        Copy
      </button>
      <button
        type="button"
        class="context-menu-button text-action"
        title="Paste"
        aria-label="Paste"
        @mousedown.prevent
        @click="pasteClipboardTextIntoEditor"
      >
        Paste
      </button>
    </div>

    <div class="context-menu-divider" />

    <div class="context-menu-row">
      <select
        class="context-menu-select wide"
        aria-label="Text style"
        :value="activeBlockType"
        @change="setContextBlockType"
      >
        <option v-for="blockType in blockTypes" :key="blockType.value" :value="blockType.value">
          {{ blockType.label }}
        </option>
      </select>
      <select
        class="context-menu-select"
        aria-label="Font size"
        :value="activeFontSize"
        @change="setContextFontSize"
      >
        <option v-for="fontSize in fontSizes" :key="fontSize.value" :value="fontSize.value">
          {{ fontSize.label }}
        </option>
      </select>
    </div>

    <div class="context-menu-row">
      <button
        type="button"
        class="context-menu-button"
        :class="{ active: editor?.isActive('bold') }"
        title="Bold"
        aria-label="Bold"
        @mousedown.prevent
        @click="runContextMarkCommand('bold')"
      >
        <font-awesome-icon :icon="['fas', 'bold']" fixed-width />
      </button>
      <button
        type="button"
        class="context-menu-button"
        :class="{ active: editor?.isActive('italic') }"
        title="Italic"
        aria-label="Italic"
        @mousedown.prevent
        @click="runContextMarkCommand('italic')"
      >
        <font-awesome-icon :icon="['fas', 'italic']" fixed-width />
      </button>
      <button
        type="button"
        class="context-menu-button"
        :class="{ active: editor?.isActive('underline') }"
        title="Underline"
        aria-label="Underline"
        @mousedown.prevent
        @click="runContextMarkCommand('underline')"
      >
        <font-awesome-icon :icon="['fas', 'underline']" fixed-width />
      </button>
      <button
        type="button"
        class="context-menu-button"
        :class="{ active: editor?.isActive('strike') }"
        title="Strikethrough"
        aria-label="Strikethrough"
        @mousedown.prevent
        @click="runContextMarkCommand('strike')"
      >
        <font-awesome-icon :icon="['fas', 'strikethrough']" fixed-width />
      </button>
      <button
        type="button"
        class="context-menu-button"
        :class="{ active: editor?.isActive('code') }"
        title="Inline code"
        aria-label="Inline code"
        @mousedown.prevent
        @click="runContextMarkCommand('code')"
      >
        <font-awesome-icon :icon="['fas', 'code']" fixed-width />
      </button>
      <button
        type="button"
        class="context-menu-button"
        :class="{ active: editor?.isActive('link') }"
        title="Link"
        aria-label="Link"
        @mousedown.prevent
        @click="openContextLinkPanel"
      >
        <font-awesome-icon :icon="['fas', 'link']" fixed-width />
      </button>
      <button
        type="button"
        class="context-menu-button"
        title="Color"
        aria-label="Color"
        @mousedown.prevent
        @click="editorContextMenuPanel = 'color'"
      >
        <span aria-hidden="true" class="context-color-icon">A</span>
      </button>
    </div>

    <template v-if="editorContextMenuSource">
      <div class="context-menu-divider" />
      <button
        type="button"
        class="context-menu-button source-action"
        :title="`View the original text on ${editorContextMenuSourceHost}`"
        :aria-label="`View Source: ${editorContextMenuSourceHost}`"
        @mousedown.prevent
        @click="openEditorContextSource"
      >
        <span>View Source:</span>
        <span v-if="editorContextMenuSourceHost" class="source-action-host">
          {{ editorContextMenuSourceHost }}
        </span>
      </button>
    </template>
  </div>
</template>
