/** Adds a lightweight drag handle for moving top-level editor blocks. */
import { Extension } from '@tiptap/core';
import { Plugin, Selection } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';

type BlockLocation = { index: number };

export const JottathingBlockDragHandle = Extension.create({
  name: 'jottathingBlockDragHandle',

  addProseMirrorPlugins() {
    return [
      new Plugin({
        view: (view) => createDragHandleView(view),
      }),
    ];
  },
});

function createDragHandleView(view: EditorView) {
  const scrollRoot = (view.dom.closest('.editor') as HTMLElement | null) ?? view.dom.parentElement ?? view.dom;
  const handle = document.createElement('button');
  handle.type = 'button';
  handle.draggable = true;
  handle.className = 'jottathing-block-drag-handle';
  handle.setAttribute('aria-label', 'Drag block to move');
  handle.title = 'Drag to move block';
  handle.textContent = '';
  handle.classList.add('is-hidden');
  scrollRoot.append(handle);

  let hovered: BlockLocation | null = null;
  let dragged: BlockLocation | null = null;
  let dragBlocks: Array<{ element: HTMLElement; block: BlockLocation }> = [];
  let markedElement: HTMLElement | null = null;

  function clearDropMarker() {
    markedElement?.classList.remove('jottathing-drop-before', 'jottathing-drop-after');
    markedElement = null;
  }

  function hideHandle() {
    hovered = null;
    handle.classList.add('is-hidden');
  }

  function blockElementFromTarget(target: EventTarget | null): HTMLElement | null {
    if (!(target instanceof Element)) return null;
    let element: Element | null = target;
    while (element && element !== view.dom) {
      if (element.parentElement === view.dom && element instanceof HTMLElement) return element;
      element = element.parentElement;
    }
    return null;
  }

  function blockForElement(element: HTMLElement | null): BlockLocation | null {
    if (!element || !view.dom.contains(element)) return null;
    try {
      const position = view.posAtDOM(element, 0);
      return topLevelBlockAtPosition(view.state.doc, position);
    } catch {
      return null;
    }
  }

  function topLevelElementAtIndex(index: number): HTMLElement | null {
    for (const child of Array.from(view.dom.children)) {
      if (child instanceof HTMLElement && blockForElement(child)?.index === index) return child;
    }
    return null;
  }

  function topLevelElements() {
    const blocks: Array<{ element: HTMLElement; block: BlockLocation }> = [];
    const seen = new Set<number>();
    for (const child of Array.from(view.dom.children)) {
      if (!(child instanceof HTMLElement)) continue;
      const block = blockForElement(child);
      if (block && !seen.has(block.index)) {
        blocks.push({ element: child, block });
        seen.add(block.index);
      }
    }
    blocks.sort((left, right) => left.block.index - right.block.index);
    return blocks;
  }

  function dropTargetAtY(clientY: number): { element: HTMLElement; block: BlockLocation; after: boolean } | null {
    let previous: { element: HTMLElement; block: BlockLocation } | null = null;
    for (const candidate of dragBlocks) {
      const rect = candidate.element.getBoundingClientRect();
      if (clientY < rect.top + rect.height / 2) {
        return { ...candidate, after: false };
      }
      if (clientY <= rect.bottom) {
        return { ...candidate, after: true };
      }
      previous = candidate;
    }
    return previous ? { ...previous, after: true } : null;
  }

  function positionHandle(element: HTMLElement, block: BlockLocation) {
    const rootRect = scrollRoot.getBoundingClientRect();
    const blockRect = element.getBoundingClientRect();
    const left = blockRect.left - rootRect.left + scrollRoot.scrollLeft - 27;
    const top = blockRect.top - rootRect.top + scrollRoot.scrollTop + 1;
    handle.style.left = `${Math.max(3, left)}px`;
    handle.style.top = `${top}px`;
    handle.dataset.blockIndex = String(block.index);
    handle.classList.remove('is-hidden');
  }

  function updateHoveredBlock(target: EventTarget | null) {
    if (dragged || target === handle || (target instanceof Node && handle.contains(target))) return;
    const element = blockElementFromTarget(target);
    const block = blockForElement(element);
    if (!element || !block) return;
    hovered = block;
    positionHandle(element, block);
  }

  function handlePointerMove(event: PointerEvent) {
    updateHoveredBlock(event.target);
    if (dragged || blockForElement(blockElementFromTarget(event.target))) return;
    if (hovered) {
      const blockElement = topLevelElementAtIndex(hovered.index);
      const handleRect = handle.getBoundingClientRect();
      const blockRect = blockElement?.getBoundingClientRect();
      const pointerNearHandle =
        event.clientX >= handleRect.left - 8 && event.clientX <= handleRect.right + 8 &&
        event.clientY >= handleRect.top - 8 && event.clientY <= handleRect.bottom + 8;
      const pointerAlongBlockEdge = !!blockRect &&
        event.clientX < blockRect.left &&
        event.clientY >= blockRect.top - 3 && event.clientY <= blockRect.bottom + 3;
      if (pointerNearHandle || pointerAlongBlockEdge) return;
    }
    hideHandle();
  }

  function handlePointerLeave(event: PointerEvent) {
    if (event.relatedTarget === handle || (event.relatedTarget instanceof Node && handle.contains(event.relatedTarget))) {
      return;
    }
    if (!dragged) hideHandle();
  }

  function handleDragStart(event: DragEvent) {
    event.stopPropagation();
    if (!hovered) {
      event.preventDefault();
      return;
    }
    dragged = hovered;
    dragBlocks = topLevelElements();
    event.dataTransfer?.setData('text/plain', 'jottathing-block');
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
    scrollRoot.classList.add('is-dragging-block');
    topLevelElementAtIndex(dragged.index)?.classList.add('jottathing-is-dragged');
  }

  function handleDragOver(event: DragEvent) {
    if (!dragged) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    const rootRect = scrollRoot.getBoundingClientRect();
    if (event.clientY < rootRect.top + 28) scrollRoot.scrollTop = Math.max(0, scrollRoot.scrollTop - 12);
    else if (event.clientY > rootRect.bottom - 28) scrollRoot.scrollTop += 12;
    const dropTarget = dropTargetAtY(event.clientY);
    clearDropMarker();
    if (!dropTarget) return;
    dropTarget.element.classList.add(dropTarget.after ? 'jottathing-drop-after' : 'jottathing-drop-before');
    markedElement = dropTarget.element;
  }

  function handleDrop(event: DragEvent) {
    if (!dragged) return;
    event.preventDefault();
    const source = dragged;
    const dropTarget = dropTargetAtY(event.clientY);
    finishDrag();
    if (!dropTarget) return;
    moveTopLevelBlock(view, source.index, dropTarget.block.index, dropTarget.after);
    hideHandle();
  }

  function finishDrag() {
    if (dragged) topLevelElementAtIndex(dragged.index)?.classList.remove('jottathing-is-dragged');
    clearDropMarker();
    dragged = null;
    dragBlocks = [];
    scrollRoot.classList.remove('is-dragging-block');
    hideHandle();
  }

  function handleDragEnd() {
    if (dragged) finishDrag();
  }

  scrollRoot.addEventListener('pointermove', handlePointerMove);
  scrollRoot.addEventListener('pointerleave', handlePointerLeave);
  scrollRoot.addEventListener('dragover', handleDragOver);
  scrollRoot.addEventListener('drop', handleDrop);
  handle.addEventListener('dragstart', handleDragStart);
  handle.addEventListener('dragend', handleDragEnd);

  return {
    update() {
      if (!hovered || !view.dom.isConnected) return;
      const element = topLevelElementAtIndex(hovered.index);
      const current = blockForElement(element);
      if (element && current) {
        hovered = current;
        positionHandle(element, current);
      } else {
        hideHandle();
      }
    },
    destroy() {
      scrollRoot.removeEventListener('pointermove', handlePointerMove);
      scrollRoot.removeEventListener('pointerleave', handlePointerLeave);
      scrollRoot.removeEventListener('dragover', handleDragOver);
      scrollRoot.removeEventListener('drop', handleDrop);
      handle.removeEventListener('dragstart', handleDragStart);
      handle.removeEventListener('dragend', handleDragEnd);
      clearDropMarker();
      handle.remove();
      scrollRoot.classList.remove('is-dragging-block');
    },
  };
}

function topLevelBlockAtPosition(doc: ProseMirrorNode, position: number): BlockLocation | null {
  if (!doc.childCount) return null;
  const safePosition = Math.max(0, Math.min(position, doc.content.size));
  let found: BlockLocation | null = null;
  doc.forEach((node, offset, index) => {
    if (found || (safePosition >= offset + node.nodeSize && index !== doc.childCount - 1)) return;
    if (safePosition >= offset && (safePosition < offset + node.nodeSize || index === doc.childCount - 1)) {
      found = { index };
    }
  });
  return found;
}

function moveTopLevelBlock(view: EditorView, fromIndex: number, targetIndex: number, after: boolean) {
  const { state } = view;
  if (
    fromIndex < 0 || targetIndex < 0 ||
    fromIndex >= state.doc.childCount || targetIndex >= state.doc.childCount
  ) return;

  const source = state.doc.child(fromIndex);
  const targetBoundary = targetIndex + (after ? 1 : 0);
  const destinationIndex = targetBoundary > fromIndex ? targetBoundary - 1 : targetBoundary;
  const remaining: ProseMirrorNode[] = [];
  state.doc.forEach((node, _offset, index) => {
    if (index !== fromIndex) remaining.push(node);
  });
  const safeDestinationIndex = Math.max(0, Math.min(destinationIndex, remaining.length));
  if (safeDestinationIndex === fromIndex || (targetIndex === fromIndex && !after)) return;

  let insertPosition = 0;
  for (let index = 0; index < safeDestinationIndex; index += 1) {
    insertPosition += remaining[index].nodeSize;
  }

  const transaction = state.tr
    .delete(blockPositionAtIndex(state.doc, fromIndex),
      blockPositionAtIndex(state.doc, fromIndex) + source.nodeSize)
    .insert(insertPosition, source);
  transaction.setSelection(
    Selection.near(transaction.doc.resolve(Math.min(insertPosition + 1, transaction.doc.content.size)), 1),
  );
  view.dispatch(transaction.scrollIntoView());
  view.focus();
}

function blockPositionAtIndex(doc: ProseMirrorNode, targetIndex: number): number {
  let position = 0;
  for (let index = 0; index < targetIndex; index += 1) {
    position += doc.child(index).nodeSize;
  }
  return position;
}
