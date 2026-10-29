<script setup lang="ts">
/** Renders a compact, direct-action editor toolbar. */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { EditorToolbarContext } from './editorToolbarContext';
import EditorToolbarPopover from './toolbar/EditorToolbarPopover.vue';

const props = defineProps<{ context: EditorToolbarContext }>();
const context = props.context;
const {
  editor,
  activeEditorMenu,
  toggleEditorMenu,
  activeEditorMarks,
  activeBlockType,
  blockTypes,
  setBlockType,
  activeFontSize,
  fontSizes,
  setFontSize,
  setFontSizeValue,
  runEditorMarkCommand,
  activeTextColor,
  textColors,
  setTextColor,
  activeHighlightColor,
  highlightColors,
  setHighlightColor,
  runEditorListCommand,
  recordingPhase,
  toggleAudioRecording,
} = context;

const fontSizeDraft = ref('');
const fontSizeError = computed(() => {
  const value = fontSizeDraft.value.trim();
  if (!value) return '';
  const size = Number(value);
  return /^\d{1,3}$/.test(value) && size >= 8 && size <= 72 ? '' : 'Use 8–72';
});

watch(
  activeFontSize,
  (value) => {
    fontSizeDraft.value = value.replace(/px$/, '');
  },
  { immediate: true },
);

const inlineFormattingControls = [
  { command: 'bold', label: 'Bold', icon: ['fas', 'bold'] },
  { command: 'italic', label: 'Italic', icon: ['fas', 'italic'] },
  { command: 'underline', label: 'Underline', icon: ['fas', 'underline'] },
  { command: 'strike', label: 'Strikethrough', icon: ['fas', 'strikethrough'] },
  { command: 'code', label: 'Inline code', icon: ['fas', 'code'] },
] as const;

function commitFontSizeDraft() {
  if (fontSizeError.value) return;
  const value = fontSizeDraft.value.trim();
  setFontSizeValue(value ? `${Number(value)}px` : '');
}

function closeToolbarOnOutsidePointer(event: PointerEvent) {
  if (!(event.target instanceof Element)) {
    context.closeEditorMenu();
    return;
  }
  if (event.target.closest('.tool-popover, .toolbar-popover-trigger')) return;
  context.closeEditorMenu();
}

function closeToolbarOnEscape(event: KeyboardEvent) {
  if (event.key !== 'Escape' || !activeEditorMenu.value) return;
  context.closeEditorMenu();
}

function runHistory(command: 'undo' | 'redo') {
  editor.value?.chain().focus()[command]().run();
}

onMounted(() => {
  document.addEventListener('pointerdown', closeToolbarOnOutsidePointer);
  document.addEventListener('keydown', closeToolbarOnEscape);
});
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', closeToolbarOnOutsidePointer);
  document.removeEventListener('keydown', closeToolbarOnEscape);
});
</script>

<template>
  <div class="editor-tools" aria-label="Editor toolbar">
    <div class="editor-toolbar-row editor-toolbar-format-row" role="toolbar" aria-label="Text formatting">
      <label class="toolbar-symbol-select" title="Block style">
        <font-awesome-icon :icon="['fas', 'heading']" fixed-width />
        <font-awesome-icon class="toolbar-symbol-chevron" :icon="['fas', 'chevron-down']" fixed-width />
        <select
          class="toolbar-symbol-select__native"
          aria-label="Block style"
          :disabled="!editor"
          :value="activeBlockType"
          @change="setBlockType"
        >
          <option v-for="blockType in blockTypes" :key="blockType.value" :value="blockType.value">
            {{ blockType.label }}
          </option>
        </select>
      </label>

      <div class="font-size-control" :class="{ invalid: Boolean(fontSizeError) }">
        <input
          v-model="fontSizeDraft"
          class="font-size-input"
          type="text"
          inputmode="numeric"
          maxlength="3"
          aria-label="Font size"
          aria-describedby="font-size-validation"
          :aria-invalid="Boolean(fontSizeError)"
          :disabled="!editor"
          placeholder="14"
          @blur="commitFontSizeDraft"
          @keydown.enter.prevent="commitFontSizeDraft"
        />
        <label class="font-size-presets" title="Font size presets">
          <font-awesome-icon class="toolbar-symbol-chevron" :icon="['fas', 'chevron-down']" fixed-width />
          <select
            class="toolbar-symbol-select__native"
            aria-label="Font size presets"
            :disabled="!editor"
            :value="activeFontSize"
            @change="setFontSize"
          >
            <option v-for="fontSize in fontSizes" :key="fontSize.value" :value="fontSize.value">
              {{ fontSize.label || 'Default' }}
            </option>
          </select>
        </label>
      </div>
      <span v-if="fontSizeError" id="font-size-validation" class="font-size-error" role="alert">
        {{ fontSizeError }}
      </span>
      <span v-else id="font-size-validation" class="visually-hidden">Enter a size from 8 to 72.</span>

      <button
        v-for="control in inlineFormattingControls"
        :key="control.command"
        type="button"
        class="tool-icon-button"
        :class="{ active: activeEditorMarks[control.command] }"
        :disabled="!editor"
        :title="control.label"
        :aria-label="control.label"
        :aria-pressed="activeEditorMarks[control.command]"
        @mousedown.prevent
        @click="runEditorMarkCommand(control.command)"
      >
        <font-awesome-icon :icon="control.icon" fixed-width />
      </button>
    </div>

    <div class="editor-toolbar-row editor-toolbar-actions-row" role="toolbar" aria-label="More editor actions">
      <label class="toolbar-symbol-select" title="Text color">
        <span class="toolbar-text-color-icon" aria-hidden="true">A</span>
        <font-awesome-icon class="toolbar-symbol-chevron" :icon="['fas', 'chevron-down']" fixed-width />
        <select
          class="toolbar-symbol-select__native"
          aria-label="Text color"
          :disabled="!editor"
          :value="activeTextColor"
          @change="setTextColor"
        >
          <option v-for="color in textColors" :key="color.value" :value="color.value">
            {{ color.label }}
          </option>
        </select>
      </label>
      <label class="toolbar-symbol-select" title="Highlight color">
        <font-awesome-icon :icon="['fas', 'highlighter']" fixed-width />
        <font-awesome-icon class="toolbar-symbol-chevron" :icon="['fas', 'chevron-down']" fixed-width />
        <select
          class="toolbar-symbol-select__native"
          aria-label="Highlight color"
          :disabled="!editor"
          :value="activeHighlightColor"
          @change="setHighlightColor"
        >
          <option v-for="color in highlightColors" :key="color.value" :value="color.value">
            {{ color.label }}
          </option>
        </select>
      </label>

      <span class="toolbar-divider" aria-hidden="true" />

      <button
        type="button"
        class="tool-icon-button"
        :class="{ active: editor?.isActive('bulletList') }"
        :disabled="!editor"
        title="Bulleted list"
        aria-label="Bulleted list"
        :aria-pressed="editor?.isActive('bulletList') ?? false"
        @mousedown.prevent
        @click="runEditorListCommand('bullet')"
      >
        <font-awesome-icon :icon="['fas', 'list-ul']" fixed-width />
      </button>
      <button
        type="button"
        class="tool-icon-button"
        :class="{ active: editor?.isActive('orderedList') }"
        :disabled="!editor"
        title="Numbered list"
        aria-label="Numbered list"
        :aria-pressed="editor?.isActive('orderedList') ?? false"
        @mousedown.prevent
        @click="runEditorListCommand('ordered')"
      >
        <font-awesome-icon :icon="['fas', 'list-ol']" fixed-width />
      </button>
      <button
        type="button"
        class="tool-icon-button"
        :class="{ active: editor?.isActive('taskList') }"
        :disabled="!editor"
        title="Checklist"
        aria-label="Checklist"
        :aria-pressed="editor?.isActive('taskList') ?? false"
        @mousedown.prevent
        @click="runEditorListCommand('task')"
      >
        <font-awesome-icon :icon="['fas', 'list-check']" fixed-width />
      </button>

      <span class="toolbar-divider" aria-hidden="true" />

      <button
        type="button"
        class="tool-icon-button toolbar-popover-trigger"
        :class="{ active: activeEditorMenu === 'link' }"
        :disabled="!editor"
        title="Insert or edit link"
        aria-label="Insert or edit link"
        :aria-expanded="activeEditorMenu === 'link'"
        @mousedown.prevent
        @click="toggleEditorMenu('link')"
      >
        <font-awesome-icon :icon="['fas', 'link']" fixed-width />
      </button>
      <button
        type="button"
        class="tool-icon-button toolbar-popover-trigger"
        :class="{ active: activeEditorMenu === 'media' }"
        :disabled="!editor"
        title="Insert media"
        aria-label="Insert media"
        :aria-expanded="activeEditorMenu === 'media'"
        @mousedown.prevent
        @click="toggleEditorMenu('media')"
      >
        <font-awesome-icon :icon="['fas', 'photo-film']" fixed-width />
      </button>
      <button
        type="button"
        class="tool-icon-button"
        :class="{ active: recordingPhase === 'recording' }"
        :disabled="!editor"
        :title="recordingPhase === 'recording' ? 'Stop recording' : 'Record audio note'"
        :aria-label="recordingPhase === 'recording' ? 'Stop recording' : 'Record audio note'"
        @mousedown.prevent
        @click="toggleAudioRecording"
      >
        <font-awesome-icon :icon="recordingPhase === 'recording' ? ['fas', 'stop'] : ['fas', 'microphone']" fixed-width />
      </button>

      <span class="toolbar-divider" aria-hidden="true" />

      <button
        type="button"
        class="tool-icon-button"
        :disabled="!editor"
        title="Undo"
        aria-label="Undo"
        @mousedown.prevent
        @click="runHistory('undo')"
      >
        <font-awesome-icon :icon="['fas', 'rotate-left']" fixed-width />
      </button>
      <button
        type="button"
        class="tool-icon-button"
        :disabled="!editor"
        title="Redo"
        aria-label="Redo"
        @mousedown.prevent
        @click="runHistory('redo')"
      >
        <font-awesome-icon :icon="['fas', 'rotate-right']" fixed-width />
      </button>
    </div>

    <Transition name="toolbar-popover">
      <EditorToolbarPopover v-if="activeEditorMenu" :context="context" />
    </Transition>
  </div>
</template>
