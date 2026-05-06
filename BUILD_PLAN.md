# Jot - BUILD_PLAN.md

## Product Definition

Jot is a browser side panel that gives each project a large editable page for
capturing and shaping web context without breaking flow.

Core Principle:
Capture into a living document, not a fixed database.

---

## Core Experience

### Project Page
- Each project opens into one rich editable page.
- Users can type, paste, format, rearrange, and refine content directly.
- Saved highlights and future drops become editable page content.
- The page is the primary workspace; sectioned capture buckets are no longer the
  main model.

### Highlight Capture
- User selects text on a web page.
- A compact inline Save button appears.
- Saving inserts the selected text into the current project page.
- Captures include a compact citation line with page title and URL.

### Drag and Drop
- Highlighted or selected web content can later be dragged into the side panel.
- Drops insert at the visible editor position.
- The page reacts as a document surface, not a set of category zones.

### Project Switching
- Project selector remains available in the side panel.
- Each project has separate stored page content.
- The first version starts with one page per project.

---

## UX Flows

### Flow A - Write Freely
1. Open Jot.
2. Select a project.
3. Type directly into the project page.
4. Content saves locally.

### Flow B - Save Highlight
1. Highlight text on a web page.
2. Click Save.
3. If the side panel editor has focus, insert at the cursor.
4. Otherwise append to the end of the current project page.

### Flow C - Drag Into Page
1. Highlight or select content on a web page.
2. Drag into Jot.
3. Drop at the intended document position.
4. Jot inserts source-aware editable content.

### Flow D - Return to Source
1. Click a source citation or restored source affordance.
2. Open the original page.
3. Later versions attempt highlight restoration.
4. Fallback opens the source URL only.

---

## Side Panel Structure

[ Project selector ]        [ Save state ]

[ Editor toolbar ]

------------------------------------------------

Editable project page

------------------------------------------------

---

## Data Model

### Project

```ts
type Project = {
  id: string
  name: string
  status: 'active' | 'archived'
  tags: string[]
}
```

### ProjectPage

```ts
type ProjectPage = {
  id: string
  projectId: string
  title: string
  content: DocumentContent
  createdAt: string
  updatedAt: string
}
```

### DocumentContent

Tiptap JSON is the canonical local document format. It stores editable rich text
content and can later carry hidden source metadata through custom nodes or marks.

---

## Extension Architecture

Content Script:
- Detects text selection.
- Shows inline Save UI.
- Sends selected text and source metadata to the background script.
- Later handles drag start and richer source metadata.

Side Panel App:
- Displays project selector and rich page editor.
- Persists editor content locally.
- Handles live highlight insertion when the editor is open.
- Later handles drag/drop insertion previews.

Background Script:
- Receives capture messages.
- Attempts live insertion into the side panel.
- Falls back to appending into stored project page content.
- Later handles Notion auth and sync.

Data Flow:

User Action -> Content Script -> Background Script -> Side Panel Editor or Local
Storage -> Future Notion Sync

---

## Notion Direction

Notion integration is deferred until the local document model is stable.

Likely mapping:
- Jot projects map to Notion pages or project records.
- Jot project pages map to Notion page blocks.
- Source citations can become links, callouts, or synced metadata.

Avoid designing around a capture database until the document-page workflow is
proven.

---

## Build Plan

### Phase 0 - Setup
- WXT, Vue 3, TypeScript, Pinia, and side panel shell.
- Storage-backed local project/page stub.

### Phase 1 - Rich Project Page MVP
- Add Tiptap editor.
- Replace sectioned zones with one rich editable page.
- Persist one page per project in local storage.
- Insert highlighted web text into the page with compact citations.
- Migrate existing mock captures into starter page content once.

### Phase 2 - Drag Into Editor
- Drag highlighted web content into Jot.
- Show editor insertion preview.
- Insert source-aware blocks at drop position.

### Phase 3 - Page Management
- Create, rename, switch, and archive pages inside a project.
- Keep one active page per project.
- Preserve local storage compatibility.

### Phase 4 - Deep Linking
- Store source URL, text, and optional DOM metadata.
- Reopen source pages.
- Attempt text restoration and scroll-to-highlight.
- Fallback to opening the source URL.

### Phase 5 - Notion Sync
- Add OAuth.
- Map Jot project pages to Notion pages or blocks.
- Sync local edits and captured source content.
- Add conflict handling only after the sync shape is proven.

---

## Risks and Considerations

Editor Complexity:
- Tiptap gives strong document behavior but adds dependency and schema concerns.

Source Metadata:
- Compact visible citations are the first version.
- Hidden metadata can become a later setting after the capture format is proven.

Notion Sync:
- Defer until the page model is stable to avoid locking Jot into the wrong
  storage shape.

---

## Final Positioning

Jot is not:
- a capture database
- a task manager
- a rigid Notion schema

Jot is:
The fastest way to turn web context into a living project page.
