import { Schema } from '@tiptap/pm/model';
import { EditorState, NodeSelection, TextSelection } from '@tiptap/pm/state';
import { describe, expect, it } from 'vitest';
import {
  moveSelectedTopLevelBlock,
  selectedTopLevelBlock,
} from '@/src/extensions/blockMovement';

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'text*', group: 'block' },
    horizontalRule: {
      group: 'block',
      atom: true,
      attrs: { inkwellBlockId: { default: null } },
    },
    text: { group: 'inline' },
  },
});

describe('top-level block movement', () => {
  it('moves the active block down and keeps the caret at the same offset', () => {
    const state = stateWithCaret(['Alpha', 'Bravo', 'Charlie'], 1, 3);
    let movedState = state;

    expect(moveSelectedTopLevelBlock(
      state,
      (transaction) => { movedState = state.apply(transaction); },
      'down',
    )).toBe(true);

    expect(blockTexts(movedState)).toEqual(['Alpha', 'Charlie', 'Bravo']);
    expect(movedState.selection.anchor).toBe(blockStart(movedState, 2) + 1 + 3);
  });

  it('moves the active block up and preserves a text selection', () => {
    let state = stateWithCaret(['Alpha', 'Bravo', 'Charlie'], 2, 1);
    const start = blockStart(state, 2);
    state = state.apply(
      state.tr.setSelection(TextSelection.create(state.doc, start + 1, start + 5)),
    );
    let movedState = state;

    moveSelectedTopLevelBlock(
      state,
      (transaction) => { movedState = state.apply(transaction); },
      'up',
    );

    expect(blockTexts(movedState)).toEqual(['Alpha', 'Charlie', 'Bravo']);
    expect(movedState.doc.textBetween(
      movedState.selection.from,
      movedState.selection.to,
    )).toBe('Char');
  });

  it('reports and enforces document boundaries', () => {
    const firstBlockState = stateWithCaret(['Alpha', 'Bravo'], 0, 0);
    const lastBlockState = stateWithCaret(['Alpha', 'Bravo'], 1, 0);

    expect(selectedTopLevelBlock(firstBlockState)).toMatchObject({
      canMoveUp: false,
      canMoveDown: true,
    });
    expect(selectedTopLevelBlock(lastBlockState)).toMatchObject({
      canMoveUp: true,
      canMoveDown: false,
    });
    expect(moveSelectedTopLevelBlock(firstBlockState, undefined, 'up')).toBe(false);
    expect(moveSelectedTopLevelBlock(lastBlockState, undefined, 'down')).toBe(false);
  });

  it('moves an atomic media-style block without losing its attributes or node selection', () => {
    const firstParagraph = schema.node('paragraph', null, schema.text('Alpha'));
    const divider = schema.node('horizontalRule', { inkwellBlockId: 'stable-block-id' });
    const lastParagraph = schema.node('paragraph', null, schema.text('Bravo'));
    const doc = schema.node('doc', null, [firstParagraph, divider, lastParagraph]);
    let state = EditorState.create({ doc });
    state = state.apply(
      state.tr.setSelection(NodeSelection.create(doc, firstParagraph.nodeSize)),
    );
    let movedState = state;

    moveSelectedTopLevelBlock(
      state,
      (transaction) => { movedState = state.apply(transaction); },
      'up',
    );

    expect(movedState.doc.child(0).type.name).toBe('horizontalRule');
    expect(movedState.doc.child(0).attrs.inkwellBlockId).toBe('stable-block-id');
    expect(movedState.selection).toBeInstanceOf(NodeSelection);
    expect(movedState.selection.from).toBe(0);
  });

  it('does not move a selection spanning more than one top-level block', () => {
    let state = stateWithCaret(['Alpha', 'Bravo'], 0, 0);
    state = state.apply(
      state.tr.setSelection(TextSelection.create(
        state.doc,
        blockStart(state, 0) + 1,
        blockStart(state, 1) + 2,
      )),
    );

    expect(selectedTopLevelBlock(state)).toBeNull();
    expect(moveSelectedTopLevelBlock(state, undefined, 'down')).toBe(false);
  });
});

function stateWithCaret(texts: string[], blockIndex: number, textOffset: number) {
  const doc = schema.node('doc', null, texts.map((text) =>
    schema.node('paragraph', null, text ? schema.text(text) : undefined),
  ));
  const state = EditorState.create({ doc });
  const anchor = blockStart(state, blockIndex) + 1 + textOffset;

  return state.apply(state.tr.setSelection(TextSelection.create(doc, anchor)));
}

function blockStart(state: EditorState, blockIndex: number) {
  let start = 0;

  for (let index = 0; index < blockIndex; index += 1) {
    start += state.doc.child(index).nodeSize;
  }

  return start;
}

function blockTexts(state: EditorState) {
  return Array.from({ length: state.doc.childCount }, (_, index) =>
    state.doc.child(index).textContent,
  );
}
