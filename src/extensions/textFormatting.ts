import {
  Extension,
  Mark,
  Node,
  mergeAttributes,
  textblockTypeInputRule,
  wrappingInputRule,
} from '@tiptap/core';
import { Plugin } from '@tiptap/pm/state';

type TextStyleAttrs = {
  backgroundColor?: string | null;
  color?: string | null;
  fontSize?: string | null;
};

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    fontSize: {
      setFontSize: (fontSize: string) => ReturnType;
      unsetFontSize: () => ReturnType;
    };
    highlightColor: {
      setHighlightColor: (color: string) => ReturnType;
      unsetHighlightColor: () => ReturnType;
    };
    subscript: {
      toggleSubscript: () => ReturnType;
    };
    superscript: {
      toggleSuperscript: () => ReturnType;
    };
    taskList: {
      toggleTaskList: () => ReturnType;
    };
    textColor: {
      setTextColor: (color: string) => ReturnType;
      unsetTextColor: () => ReturnType;
    };
    underline: {
      setUnderline: () => ReturnType;
      toggleUnderline: () => ReturnType;
      unsetUnderline: () => ReturnType;
    };
  }
}

function renderTextStyle(attrs: TextStyleAttrs) {
  const declarations = [
    attrs.color ? `color: ${attrs.color}` : '',
    attrs.backgroundColor ? `background-color: ${attrs.backgroundColor}` : '',
    attrs.fontSize ? `font-size: ${attrs.fontSize}` : '',
  ].filter(Boolean);

  return declarations.length ? { style: declarations.join('; ') } : {};
}

function currentTextStyleAttributes(state: any) {
  const markType = state.schema.marks.textStyle;

  if (!markType) {
    return {};
  }

  const storedMark = state.storedMarks?.find((mark: any) => mark.type === markType);

  if (storedMark) {
    return storedMark.attrs;
  }

  const { $from } = state.selection;
  const activeMark = $from.marks().find((mark: any) => mark.type === markType);
  return activeMark?.attrs ?? {};
}

function setTextStyleAttribute(
  attribute: keyof TextStyleAttrs,
  value: string | null,
) {
  return ({ commands, state }: { commands: any; state: any }) => {
    const nextAttrs = {
      ...currentTextStyleAttributes(state),
      [attribute]: value,
    };

    if (!nextAttrs.color && !nextAttrs.backgroundColor && !nextAttrs.fontSize) {
      return commands.unsetMark('textStyle');
    }

    return commands.setMark('textStyle', nextAttrs);
  };
}

const TextStyle = Mark.create({
  name: 'textStyle',
  priority: 101,

  addAttributes() {
    return {
      backgroundColor: {
        default: null,
        parseHTML: (element) => element.style.backgroundColor || null,
        renderHTML: () => ({}),
      },
      color: {
        default: null,
        parseHTML: (element) => element.style.color || null,
        renderHTML: () => ({}),
      },
      fontSize: {
        default: null,
        parseHTML: (element) => element.style.fontSize || null,
        renderHTML: () => ({}),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'span[style]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes, renderTextStyle(HTMLAttributes)), 0];
  },

  addCommands() {
    return {
      setFontSize:
        (fontSize: string) =>
        ({ commands, state }) =>
          setTextStyleAttribute('fontSize', fontSize)({ commands, state }),
      unsetFontSize:
        () =>
        ({ commands, state }) =>
          setTextStyleAttribute('fontSize', null)({ commands, state }),
      setHighlightColor:
        (color: string) =>
        ({ commands, state }) =>
          setTextStyleAttribute('backgroundColor', color)({ commands, state }),
      unsetHighlightColor:
        () =>
        ({ commands, state }) =>
          setTextStyleAttribute('backgroundColor', null)({ commands, state }),
      setTextColor:
        (color: string) =>
        ({ commands, state }) =>
          setTextStyleAttribute('color', color)({ commands, state }),
      unsetTextColor:
        () =>
        ({ commands, state }) =>
          setTextStyleAttribute('color', null)({ commands, state }),
    };
  },
});

const Underline = Mark.create({
  name: 'underline',

  parseHTML() {
    return [
      { tag: 'u' },
      {
        style: 'text-decoration-line',
        consuming: false,
        getAttrs: (value) => String(value).includes('underline') && null,
      },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    return ['u', HTMLAttributes, 0];
  },

  addCommands() {
    return {
      setUnderline:
        () =>
        ({ commands }) =>
          commands.setMark(this.name),
      toggleUnderline:
        () =>
        ({ commands }) =>
          commands.toggleMark(this.name),
      unsetUnderline:
        () =>
        ({ commands }) =>
          commands.unsetMark(this.name),
    };
  },
});

const Superscript = Mark.create({
  name: 'superscript',
  excludes: 'subscript',

  parseHTML() {
    return [{ tag: 'sup' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['sup', HTMLAttributes, 0];
  },

  addCommands() {
    return {
      toggleSuperscript:
        () =>
        ({ commands }) =>
          commands.toggleMark(this.name),
    };
  },
});

const Subscript = Mark.create({
  name: 'subscript',
  excludes: 'superscript',

  parseHTML() {
    return [{ tag: 'sub' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['sub', HTMLAttributes, 0];
  },

  addCommands() {
    return {
      toggleSubscript:
        () =>
        ({ commands }) =>
          commands.toggleMark(this.name),
    };
  },
});

const TaskList = Node.create({
  name: 'taskList',
  group: 'block list',
  content: 'taskItem+',

  parseHTML() {
    return [{ tag: 'ul[data-type="taskList"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['ul', mergeAttributes(HTMLAttributes, { 'data-type': 'taskList' }), 0];
  },

  addCommands() {
    return {
      toggleTaskList:
        () =>
        ({ commands }) =>
          commands.toggleList(this.name, 'taskItem'),
    };
  },

  addInputRules() {
    return [
      wrappingInputRule({
        find: /^\s*([-+*])\s\[( |x)]\s$/,
        type: this.type,
      }),
    ];
  },
});

const TaskItem = Node.create({
  name: 'taskItem',
  content: 'paragraph block*',
  defining: true,

  addAttributes() {
    return {
      checked: {
        default: false,
        parseHTML: (element) => element.getAttribute('data-checked') === 'true',
        renderHTML: (attributes) => ({
          'data-checked': attributes.checked ? 'true' : 'false',
        }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'li[data-type="taskItem"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    const isChecked = HTMLAttributes['data-checked'] === 'true';

    return [
      'li',
      mergeAttributes(HTMLAttributes, { 'data-type': 'taskItem' }),
      ['label', ['input', { type: 'checkbox', ...(isChecked ? { checked: 'checked' } : {}) }]],
      ['div', 0],
    ];
  },

  addKeyboardShortcuts() {
    return {
      Enter: () => this.editor.commands.splitListItem(this.name),
      Tab: () => this.editor.commands.sinkListItem(this.name),
      'Shift-Tab': () => this.editor.commands.liftListItem(this.name),
    };
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          handleClick: (view, _position, event) => {
            const target = event.target;

            if (!(target instanceof HTMLInputElement) || target.type !== 'checkbox') {
              return false;
            }

            const taskItem = target.closest('li[data-type="taskItem"]');

            if (!taskItem) {
              return false;
            }

            const position = view.posAtDOM(taskItem, 0);
            const node = view.state.doc.nodeAt(position);

            if (!node || node.type.name !== this.name) {
              return false;
            }

            view.dispatch(
              view.state.tr.setNodeMarkup(position, undefined, {
                ...node.attrs,
                checked: target.checked,
              }),
            );
            return true;
          },
        },
      }),
    ];
  },

  addInputRules() {
    return [
      textblockTypeInputRule({
        find: /^\s*([-+*])\s\[( |x)]\s$/,
        type: this.type,
        getAttributes: (match) => ({
          checked: match[2] === 'x',
        }),
      }),
    ];
  },
});

export const PortableTextEditingKit = Extension.create({
  name: 'portableTextEditingKit',

  addExtensions() {
    return [TextStyle, Underline, Superscript, Subscript, TaskList, TaskItem];
  },
});
