import type { EditorState, Transaction } from '@tiptap/pm/state';
import { Selection } from '@tiptap/pm/state';

export type BlockMoveDirection = 'up' | 'down';

export type SelectedTopLevelBlock = {
  index: number;
  start: number;
  end: number;
  canMoveUp: boolean;
  canMoveDown: boolean;
};

/** Finds the single top-level block containing the current editor selection. */
export function selectedTopLevelBlock(
  state: EditorState,
): SelectedTopLevelBlock | null {
  const { doc, selection } = state;

  if (!doc.childCount || selection.from < 0 || selection.from > doc.content.size) {
    return null;
  }

  const resolvedFrom = doc.resolve(selection.from);
  const index = Math.min(resolvedFrom.index(0), doc.childCount - 1);
  let start = 0;

  for (let childIndex = 0; childIndex < index; childIndex += 1) {
    start += doc.child(childIndex).nodeSize;
  }

  const end = start + doc.child(index).nodeSize;

  // Moving a selection spanning multiple blocks would be ambiguous. A node
  // selection may end exactly on its containing block's trailing boundary.
  if (selection.from < start || selection.to > end) {
    return null;
  }

  return {
    index,
    start,
    end,
    canMoveUp: index > 0,
    canMoveDown: index < doc.childCount - 1,
  };
}

/** Moves the selected top-level block one position and keeps the selection in it. */
export function moveSelectedTopLevelBlock(
  state: EditorState,
  dispatch: ((transaction: Transaction) => void) | undefined,
  direction: BlockMoveDirection,
): boolean {
  const selectedBlock = selectedTopLevelBlock(state);

  if (
    !selectedBlock ||
    (direction === 'up' && !selectedBlock.canMoveUp) ||
    (direction === 'down' && !selectedBlock.canMoveDown)
  ) {
    return false;
  }

  if (!dispatch) {
    return true;
  }

  const { doc, selection } = state;
  const movingNode = doc.child(selectedBlock.index);
  const adjacentNode = doc.child(
    direction === 'up' ? selectedBlock.index - 1 : selectedBlock.index + 1,
  );
  const newStart = direction === 'up'
    ? selectedBlock.start - adjacentNode.nodeSize
    : selectedBlock.start + adjacentNode.nodeSize;
  const positionDelta = newStart - selectedBlock.start;
  const transaction = state.tr
    .delete(selectedBlock.start, selectedBlock.end)
    .insert(newStart, movingNode);

  try {
    transaction.setSelection(
      Selection.fromJSON(
        transaction.doc,
        shiftSelectionJson(selection.toJSON(), positionDelta),
      ),
    );
  } catch {
    transaction.setSelection(
      Selection.near(transaction.doc.resolve(newStart + Math.min(1, movingNode.nodeSize))),
    );
  }

  dispatch(transaction.scrollIntoView());
  return true;
}

function shiftSelectionJson(selection: unknown, delta: number): Record<string, unknown> {
  const shifted = { ...(selection as Record<string, unknown>) };

  for (const key of ['anchor', 'head']) {
    if (typeof shifted[key] === 'number') {
      shifted[key] = shifted[key] + delta;
    }
  }

  return shifted;
}
