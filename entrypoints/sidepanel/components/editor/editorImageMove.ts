/**
 * @file ProseMirror helpers for placing the caret and moving selected image nodes.
 */
import { NodeSelection, TextSelection } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import type { InkwellImageMovePayload } from '@/src/extensions/inkwellImageMove';

/** Moves the editor selection to the document position under a pointer event. */
export function moveEditorSelectionToDrop(view: EditorView, event: DragEvent): void {
  const dropPos = view.posAtCoords({ left: event.clientX, top: event.clientY });

  if (typeof dropPos?.pos === 'number') {
    view.dispatch(
      view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(dropPos.pos))),
    );
  }
}

/** Moves an existing image node to a drop position and selects it afterward. */
export function moveImageNodeAtDrop(
  view: EditorView,
  event: DragEvent,
  payload: InkwellImageMovePayload,
): boolean {
  const imageType = view.state.schema.nodes.image;
  const source = findImageMoveSource(view, payload);
  const dropPos = view.posAtCoords({ left: event.clientX, top: event.clientY });

  if (!imageType || !source || typeof dropPos?.pos !== 'number') {
    return false;
  }

  const sourceFrom = source.pos;
  const sourceTo = sourceFrom + source.node.nodeSize;

  if (dropPos.pos >= sourceFrom && dropPos.pos <= sourceTo) {
    view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, sourceFrom)));
    return true;
  }

  const rawInsertPos = imageBlockInsertPos(view.state.doc, dropPos.pos);
  const movedNode = imageType.create(payload.attrs);
  const insertPos = clampDocumentPosition(
    dropPos.pos > sourceFrom ? rawInsertPos - source.node.nodeSize : rawInsertPos,
    view.state.doc.content.size - source.node.nodeSize,
  );
  const tr = view.state.tr.delete(sourceFrom, sourceTo).insert(insertPos, movedNode);

  if (tr.doc.nodeAt(insertPos)?.type === imageType) {
    tr.setSelection(NodeSelection.create(tr.doc, insertPos));
  } else {
    tr.setSelection(TextSelection.near(tr.doc.resolve(insertPos)));
  }

  view.dispatch(tr.scrollIntoView());
  return true;
}

/** Creates a move payload when a selected image is dragged from a browser tab. */
export function readSelectedImageMovePayload(
  view: EditorView,
  event: DragEvent,
): InkwellImageMovePayload | null {
  const { selection } = view.state;

  if (
    !(selection instanceof NodeSelection) ||
    selection.node.type !== view.state.schema.nodes.image ||
    !isChromeExtensionBlobImageDrop(event)
  ) {
    return null;
  }

  return {
    kind: 'image',
    pos: selection.from,
    attrs: selection.node.attrs,
  };
}

function imageBlockInsertPos(doc: EditorView['state']['doc'], pos: number): number {
  const safePos = clampDocumentPosition(pos, doc.content.size);
  const $pos = doc.resolve(safePos);

  if ($pos.depth === 0) {
    return safePos;
  }

  const blockStart = $pos.before(1);
  const blockEnd = $pos.after(1);
  const blockMiddle = blockStart + (blockEnd - blockStart) / 2;

  return safePos <= blockMiddle ? blockStart : blockEnd;
}

function clampDocumentPosition(pos: number, max: number): number {
  return Math.min(Math.max(pos, 0), Math.max(max, 0));
}

function isChromeExtensionBlobImageDrop(event: DragEvent): boolean {
  const plainText = event.dataTransfer?.getData('text/plain') ?? '';
  const html = event.dataTransfer?.getData('text/html') ?? '';

  return (
    /^blob:chrome-extension:\/\//i.test(plainText.trim()) ||
    /\bsrc\s*=\s*(?:"blob:chrome-extension:\/\/|'blob:chrome-extension:\/\/|blob:chrome-extension:\/\/)/i.test(
      html,
    )
  );
}

function findImageMoveSource(view: EditorView, payload: InkwellImageMovePayload) {
  const imageType = view.state.schema.nodes.image;
  const nodeAtPayloadPos = view.state.doc.nodeAt(payload.pos);

  if (nodeAtPayloadPos?.type === imageType) {
    return { pos: payload.pos, node: nodeAtPayloadPos };
  }

  const payloadBlockId = String(payload.attrs.inkwellBlockId ?? '');
  const payloadSrc = String(payload.attrs.src ?? '');
  let fallback: { pos: number; node: NonNullable<typeof nodeAtPayloadPos> } | null = null;

  view.state.doc.descendants((node, pos) => {
    if (fallback || node.type !== imageType) {
      return true;
    }

    if (payloadBlockId && node.attrs.inkwellBlockId === payloadBlockId) {
      fallback = { pos, node };
      return false;
    }

    if (payloadSrc && node.attrs.src === payloadSrc) {
      fallback = { pos, node };
      return false;
    }

    return true;
  });

  return fallback;
}
