/** @file Editor context menu state, source lookup, positioning, and clipboard workflows. */
import { computed, nextTick, ref, watch, type ShallowRef } from 'vue';
import type { Editor } from '@tiptap/core';
import type { EditorView } from '@tiptap/pm/view';
import {
  decodeInkwellSource,
  isAccessibleInkwellSource,
  INKWELL_SOURCE_ATTR,
  safeInkwellSourceUrl,
} from '@/src/extensions/inkwellLink';
import { sourceFromProjectState } from '@/src/extensions/sourceRegistry';
import type { useInkwellStore } from '@/src/stores/inkwell';
import type { OpenSourceRequestMessage, SourceOpenPayload } from '@/src/types/messages';

/** Owns context-menu placement, captured selection, source lookup, and clipboard actions. */
export function useEditorContextMenu(
  editor: ShallowRef<Editor | undefined>,
  store: ReturnType<typeof useInkwellStore>,
  applyLink: (href: string) => void,
) {
  const editorContextMenuRef = ref<HTMLElement | null>(null);
  const editorContextMenu = ref({ visible: false, left: 0, top: 0 });
  const editorContextMenuHasSelection = ref(false);
  const editorContextMenuSource = ref<SourceOpenPayload | null>(null);
  const editorContextMenuPanel = ref<'main' | 'link' | 'color'>('main');
  const contextMenuLinkDraft = ref('');
  let editorContextSelection: { from: number; to: number } | null = null;

  const editorContextMenuSourceHost = computed(() => {
    const payload = editorContextMenuSource.value;
    const sourceUrl = payload ? safeInkwellSourceUrl(payload) : null;
    try {
      return sourceUrl ? new URL(sourceUrl).hostname.replace(/^www\./, '') : '';
    } catch {
      return '';
    }
  });

  function clamp(value: number, min: number, max: number) {
    return Math.min(Math.max(value, min), max);
  }

  function showEditorContextMenu(view: EditorView, event: MouseEvent) {
    const pos = view.posAtCoords({ left: event.clientX, top: event.clientY });
    event.preventDefault();
    view.focus();
    editorContextSelection = {
      from: view.state.selection.from,
      to: view.state.selection.to,
    };
    editorContextMenuHasSelection.value = !view.state.selection.empty;
    editorContextMenuSource.value =
      sourceForContextTarget(event.target) ?? sourceForEditorContext(view, pos?.pos);
    contextMenuLinkDraft.value = String(editor.value?.getAttributes('link').href ?? '');
    editorContextMenuPanel.value = 'main';
    editorContextMenu.value = {
      visible: true,
      left: clamp(event.clientX, 8, Math.max(8, window.innerWidth - 320)),
      top: clamp(event.clientY, 8, Math.max(8, window.innerHeight - 48)),
    };
    void nextTick(() => placeEditorContextMenu(event.clientX, event.clientY));
  }

  function placeEditorContextMenu(clientX: number, clientY: number) {
    const menu = editorContextMenuRef.value;
    if (!menu) return;
    const rect = menu.getBoundingClientRect();
    editorContextMenu.value = {
      ...editorContextMenu.value,
      left: clamp(clientX, 8, Math.max(8, window.innerWidth - rect.width - 8)),
      top: clamp(clientY, 8, Math.max(8, window.innerHeight - rect.height - 8)),
    };
  }

  function restoreEditorContextSelection() {
    if (!editor.value || !editorContextSelection) return;
    const docSize = editor.value.state.doc.content.size;
    const from = clamp(editorContextSelection.from, 0, docSize);
    const to = clamp(editorContextSelection.to, from, docSize);
    editor.value.commands.setTextSelection({ from, to });
  }

  function hideEditorContextMenu() {
    editorContextMenu.value.visible = false;
    editorContextMenuSource.value = null;
    editorContextMenuPanel.value = 'main';
  }

  function sourceForEditorContext(view: EditorView, clickedPosition?: number) {
    const sources = new Map<string, SourceOpenPayload>();
    const blockIds = new Set<string>();
    const { from, to, empty } = view.state.selection;
    if (!empty) {
      view.state.doc.nodesBetween(from, to, (node) => {
        collectNodeSources(node, sources, blockIds);
        return true;
      });
    }
    collectProjectStateSources(blockIds, sources);
    if (sources.size === 1) return sources.values().next().value ?? null;
    if (sources.size > 1 || typeof clickedPosition !== 'number') return null;

    const resolved = view.state.doc.resolve(clamp(clickedPosition, 0, view.state.doc.content.size));
    for (let depth = resolved.depth; depth >= 0; depth -= 1) {
      collectNodeSources(resolved.node(depth), sources, blockIds);
    }
    collectNodeSources(resolved.nodeBefore, sources, blockIds);
    collectNodeSources(resolved.nodeAfter, sources, blockIds);
    collectProjectStateSources(blockIds, sources);
    return sources.size === 1 ? (sources.values().next().value ?? null) : null;
  }

  function sourceForContextTarget(target: EventTarget | null) {
    if (!(target instanceof Element)) return null;
    const sourceElement = target.closest('[data-inkwell-source]');
    const source = decodeInkwellSource(sourceElement?.getAttribute('data-inkwell-source'));
    if (isAccessibleInkwellSource(source)) return source;

    const blockId = target
      .closest('[data-inkwell-block-id]')
      ?.getAttribute('data-inkwell-block-id');
    const stateSource = sourceFromProjectState(store.currentProject?.stateContent, blockId);
    return isAccessibleInkwellSource(stateSource) ? stateSource : null;
  }

  function collectNodeSources(
    node: {
      attrs?: Record<string, unknown>;
      marks?: readonly { attrs?: Record<string, unknown> }[];
    } | null,
    sources: Map<string, SourceOpenPayload>,
    blockIds: Set<string>,
  ) {
    if (!node) return;
    collectSource(node.attrs?.[INKWELL_SOURCE_ATTR], sources);
    const blockId = node.attrs?.inkwellBlockId;
    if (typeof blockId === 'string' && blockId) blockIds.add(blockId);
    for (const mark of node.marks ?? []) collectSource(mark.attrs?.[INKWELL_SOURCE_ATTR], sources);
  }

  function collectProjectStateSources(
    blockIds: Set<string>,
    sources: Map<string, SourceOpenPayload>,
  ) {
    for (const blockId of blockIds) {
      collectSource(sourceFromProjectState(store.currentProject?.stateContent, blockId), sources);
    }
  }

  function collectSource(value: unknown, sources: Map<string, SourceOpenPayload>) {
    const payload = decodeInkwellSource(value);
    if (!isAccessibleInkwellSource(payload) || !payload) return;
    const key = [
      payload.sourceUrl,
      payload.highlightMeta.xpath,
      payload.highlightMeta.offset,
      payload.highlightMeta.text,
    ].join('\n');
    sources.set(key, payload);
  }

  async function openEditorContextSource() {
    const payload = editorContextMenuSource.value;
    if (!payload || !isAccessibleInkwellSource(payload)) return;
    hideEditorContextMenu();
    await browser.runtime
      .sendMessage({
        type: 'inkwell.openSourceRequest',
        payload,
      } satisfies OpenSourceRequestMessage)
      .catch(async () => {
        const url = safeInkwellSourceUrl(payload);
        if (url) await browser.tabs.create({ active: true, url });
      });
  }

  function handleEditorContextMenuPointerDown(event: PointerEvent) {
    if (!editorContextMenu.value.visible) return;
    const target = event.target;
    if (target instanceof Node && editorContextMenuRef.value?.contains(target)) return;
    hideEditorContextMenu();
  }

  function handleEditorContextMenuKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape' && editorContextMenu.value.visible) {
      event.preventDefault();
      hideEditorContextMenu();
    }
  }

  function getEditorSelectedText() {
    if (!editor.value) return '';
    restoreEditorContextSelection();
    const { from, to, empty } = editor.value.state.selection;
    if (empty) return '';
    return editor.value.state.doc.textBetween(from, to, '\n').trimEnd();
  }

  async function copyEditorSelectionToClipboard(closeAfterCopy = true) {
    const selectedText = getEditorSelectedText();
    if (!selectedText) return;
    await navigator.clipboard.writeText(selectedText);
    if (closeAfterCopy) hideEditorContextMenu();
  }

  async function copyEditorSelectionFromContextMenu() {
    await copyEditorSelectionToClipboard();
  }

  async function cutEditorSelectionToClipboard() {
    if (!editor.value) return;
    restoreEditorContextSelection();
    if (editor.value.state.selection.empty) return;
    await copyEditorSelectionToClipboard(false);
    editor.value.chain().focus().deleteSelection().run();
    hideEditorContextMenu();
  }

  async function pasteClipboardTextIntoEditor() {
    if (!editor.value) return;
    const text = await navigator.clipboard.readText();
    if (!text) return;
    restoreEditorContextSelection();
    editor.value.chain().focus().insertContent(text).run();
    hideEditorContextMenu();
  }

  function openContextLinkPanel() {
    restoreEditorContextSelection();
    contextMenuLinkDraft.value = String(editor.value?.getAttributes('link').href ?? '');
    editorContextMenuPanel.value = 'link';
  }

  function applyContextLink() {
    restoreEditorContextSelection();
    applyLink(contextMenuLinkDraft.value);
    contextMenuLinkDraft.value = '';
    hideEditorContextMenu();
  }

  function removeContextLink() {
    restoreEditorContextSelection();
    applyLink('');
    contextMenuLinkDraft.value = '';
    hideEditorContextMenu();
  }

  watch(
    () => store.currentPage?.id,
    () => hideEditorContextMenu(),
  );

  return {
    editorContextMenuRef,
    editorContextMenu,
    editorContextMenuHasSelection,
    editorContextMenuSource,
    editorContextMenuSourceHost,
    editorContextMenuPanel,
    contextMenuLinkDraft,
    showEditorContextMenu,
    placeEditorContextMenu,
    restoreEditorContextSelection,
    hideEditorContextMenu,
    openEditorContextSource,
    handleEditorContextMenuPointerDown,
    handleEditorContextMenuKeydown,
    copyEditorSelectionFromContextMenu,
    cutEditorSelectionToClipboard,
    pasteClipboardTextIntoEditor,
    openContextLinkPanel,
    applyContextLink,
    removeContextLink,
  };
}
