# Sidepanel source map

`main.ts` installs Pinia and shared icons, imports the global and sidepanel style
sheets, and mounts `App.vue`.

## Composition boundary

`App.vue` connects the sidepanel features and typed component contexts. Its
visible regions are components, while editor setup, browser lifecycle, sync,
settings, and interaction behavior live in the feature composables below.

## Components

- `components/layout/TopBar.vue` composes `TopBarStatus.vue` and `TopBarActions.vue`.
  `TopBarStatus.vue` composes `ProjectHeaderControls.vue`; the components own
  sync/account status, project/category controls, and primary actions.
  `topBarContext.ts` defines their typed state/action contract.
- `components/editor/EditorPageTitle.vue` shows remote-change notices and page
  selection; `EditorToolbar.vue`, `EditorCanvas.vue`, and `EditorContextMenu.vue`
  own the editor's visible control groups. Their context files define the data
  passed from the coordinator. `editorOptions.ts` holds shared formatting choices;
  `editorImageMove.ts` contains ProseMirror image drag helpers and
  `captureDropPayload.ts` reads capture payloads from drag events and the runtime.
  `components/editor/toolbar/` contains the toolbar popover and one component per
  block, mark, color, link, list, media, recording, and history panel.
  `components/editor/contextMenu/` contains separate main, link, and color panels.
- `components/settings/SettingsPage.vue` composes project details, sync/legal,
  server, Notion parent-page, and interface sections. The section components
  live alongside it; `LegalConsent.vue` owns the consent control.
- `components/lists/` contains the project, page, category, parent-page, sync
  status, category color, and scale preset lists.
- `components/shared/ArchiveConfirmModal.vue` emits confirmation actions; the
  workspace composable owns the archive target and operation.
- `../../src/components/AudioRecorder.vue` owns recording controls and emits
  start/stop actions.

## Composables and helpers

- `composables/useEditorContextMenu.ts` owns context-menu placement, source
  lookup, saved selection, clipboard behavior, and page-change dismissal.
- `composables/useInkwellEditor.ts` configures Tiptap extensions, link opening,
  editor events, and debounced content saves.
- `composables/useEditorToolbar.ts` owns toolbar modes, active panels, panel
  choices, and transitions for recording and link controls.
- `composables/useEditorLinkActions.ts` owns link drafts, link commands, and
  formatting saves.
- `composables/useSidepanelLifecycle.ts` owns startup, global event listeners,
  store reactions, and teardown.
- `composables/useEditorFormatting.ts` owns derived formatting state and Tiptap
  formatting commands.
- `composables/useEditorMedia.ts` owns media URL insertion, local file uploads,
  and media-node upload status.
- `composables/useEditorPersistence.ts` loads the selected page into Tiptap and
  serializes normal and exit-time local saves.
- `composables/useAudioRecording.ts` owns microphone permissions and recorder
  lifecycle; uploaded audio still goes through the shared media flow.
- `composables/useWorkspaceActions.ts` owns page/project selection, create,
  rename, and archive operations.
- `composables/useProjectCategories.ts` and `useInterfaceScale.ts` own their
  persisted preference state.
- `composables/useProjectSettings.ts` and `useSettingsActions.ts` own project
  metadata, server URL, and Notion parent-page settings actions.
- `composables/useTopBarStatus.ts` derives sync feedback and workspace labels.
- `composables/useNotionConnection.ts` owns legal acceptance and the OAuth
  session polling lifecycle.
- `../../src/lib/documentText.ts` converts editor documents into project state
  text.
- `sidepanel.css` is the stylesheet entrypoint. Its `styles/` folder separates
  layout, editor header, settings, editor controls, and Tiptap content styles;
  `../../src/styles/global.css` contains shared design tokens and baselines.

## Worker

The Cloudflare Worker is composed from routes, queue handling, a shared runtime,
and focused synchronization/domain modules. The `projectDatabaseRows.ts` module
owns managed project row queries and row-to-project mappings; `projectDatabase.ts`
composes database discovery, state blocks, and thread operations. See
`../../apps/worker/src/README.md` for the Worker module map.
