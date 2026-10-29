import { afterEach, describe, expect, it, vi } from 'vitest';
import { nextTick, reactive, ref, shallowRef } from 'vue';
import { EditorState, TextSelection } from '@tiptap/pm/state';
import { Schema } from '@tiptap/pm/model';

const editorHarness = vi.hoisted(() => ({ options: null as unknown }));
const syncHarness = vi.hoisted(() => ({ flushPendingSyncOps: vi.fn(async () => undefined) }));

vi.mock('@tiptap/vue-3', () => ({
  useEditor: (options: unknown) => {
    editorHarness.options = options;
    return { value: undefined };
  },
}));
vi.mock('@/src/extensions/codeNotebook', () => ({ CodeNotebook: {} }));
vi.mock('@/src/extensions/jottathingBlockIds', () => ({
  JottathingBlockIds: {},
  normalizeJottathingBlockIds: (content: unknown) => content,
}));
vi.mock('@/src/extensions/jottathingLink', () => ({
  decodeJottathingSource: () => undefined,
  JOTTATHING_SOURCE_ATTR: 'jottathingSource',
  JottathingLink: {},
}));
vi.mock('@/src/extensions/media', () => ({ MediaKit: {} }));
vi.mock('@/src/extensions/syncConflictBlock', () => ({
  JottathingSyncConflict: { configure: () => ({}) },
}));
vi.mock('@/src/extensions/textFormatting', () => ({ PortableTextEditingKit: {} }));
vi.mock('@/src/services/notionClient', () => ({ notionClient: syncHarness }));

import { useJottathingEditor } from '@/entrypoints/sidepanel/composables/useJottathingEditor';
import { useEditorPersistence } from '@/entrypoints/sidepanel/composables/useEditorPersistence';

afterEach(() => {
  editorHarness.options = null;
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('editor block-focus autosave', () => {
  it('saves and flushes after typing settles even while focus stays in the same block', async () => {
    vi.useFakeTimers();
    const schema = new Schema({
      nodes: {
        doc: { content: 'block+' },
        paragraph: { content: 'text*', group: 'block' },
        text: { group: 'inline' },
      },
    });
    const firstParagraph = schema.node('paragraph', null, [schema.text('one')]);
    const secondParagraph = schema.node('paragraph', null, [schema.text('two')]);
    const doc = schema.node('doc', null, [firstParagraph, secondParagraph]);
    const firstBlockState = EditorState.create({
      schema,
      doc,
      selection: TextSelection.create(doc, 1),
    });
    const movedWithinBlockState = EditorState.create({
      schema,
      doc,
      selection: TextSelection.create(doc, 2),
    });
    const secondBlockState = EditorState.create({
      schema,
      doc,
      selection: TextSelection.create(doc, firstParagraph.nodeSize + 1),
    });
    const saveEditorContent = vi.fn(async () => undefined);

    useJottathingEditor({
      editorStateVersion: ref(0),
      handlers: { handleDrop: () => false, showContextMenu: () => undefined },
      isApplyingStoredContent: ref(false),
      saveEditorContent,
      resolveSyncConflict: async () => undefined,
    });

    const callbacks = editorHarness.options as {
      onCreate: (event: { editor: { state: EditorState } }) => void;
      onUpdate: () => void;
      onSelectionUpdate: (event: { editor: { state: EditorState } }) => void;
      onBlur: () => void;
    };
    callbacks.onCreate({ editor: { state: firstBlockState } });

    callbacks.onUpdate();
    callbacks.onSelectionUpdate({ editor: { state: movedWithinBlockState } });
    expect(saveEditorContent).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(499);
    expect(saveEditorContent).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(saveEditorContent).toHaveBeenCalledTimes(1);
    await vi.runAllTimersAsync();
    expect(syncHarness.flushPendingSyncOps).toHaveBeenCalledWith({ force: true });

    callbacks.onSelectionUpdate({ editor: { state: secondBlockState } });
    expect(saveEditorContent).toHaveBeenCalledTimes(2);

    callbacks.onBlur();
    expect(saveEditorContent).toHaveBeenCalledTimes(3);
    await vi.runAllTimersAsync();
    expect(syncHarness.flushPendingSyncOps).toHaveBeenCalledTimes(3);
  });

  it('retries the same block after local persistence fails', async () => {
    const saveCurrentPageContent = vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const persistence = createPersistenceHarness({ saveCurrentPageContent });
    await persistence.hydratePage();

    await persistence.saveEditorContentOptimistically();
    await persistence.saveEditorContentOptimistically();

    expect(saveCurrentPageContent).toHaveBeenCalledTimes(2);
  });

  it('retries the exit-time snapshot after local persistence fails', async () => {
    vi.stubGlobal('window', { clearTimeout: vi.fn() });
    const savePageContentSnapshot = vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const persistence = createPersistenceHarness({ savePageContentSnapshot });
    await persistence.hydratePage();

    await persistence.saveEditorContentInBackground();
    await persistence.saveEditorContentInBackground();

    expect(savePageContentSnapshot).toHaveBeenCalledTimes(2);
  });
});

function createPersistenceHarness(saveMethods: {
  saveCurrentPageContent?: ReturnType<typeof vi.fn>;
  savePageContentSnapshot?: ReturnType<typeof vi.fn>;
}) {
  const content = {
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: 'edited' }] }],
  };
  const page = {
    id: 'page-1',
    projectId: 'project-1',
    title: 'Untitled Page',
    content: { type: 'doc', content: [{ type: 'paragraph' }] },
  };
  const store = reactive({
    currentPage: undefined as typeof page | undefined,
    currentProject: undefined,
    saveCurrentPageContent: saveMethods.saveCurrentPageContent ?? vi.fn(async () => true),
    savePageContentSnapshot: saveMethods.savePageContentSnapshot ?? vi.fn(async () => true),
  }) as never;
  const editor = shallowRef({ getJSON: () => content, commands: { setContent: vi.fn() } }) as never;

  const persistence = useEditorPersistence(
    editor,
    store,
    ref(page.title),
    ref(false),
    ref(false),
    ref(0),
    ref(false),
    ref(undefined),
  );
  const hydratePage = async () => {
    (store as { currentPage?: typeof page }).currentPage = page;
    await nextTick();
  };

  return { ...persistence, hydratePage };
}
