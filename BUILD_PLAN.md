# Jot Build Plan

This roadmap turns the next Jot capabilities into implementation milestones for
the existing WXT/Vue side panel and Fastify sync server.

## Milestone 1: Reliability Foundation

Goal: make Notion sync predictable under rapid edits, project switches, and API
rate limits.

- Add a shared Notion-aware rate limiter around every server-side Notion API
  call.
- Enforce Notion's documented average limit of 3 requests per second per
  integration.
- Handle `429 rate_limited` responses by respecting the `Retry-After` header
  before retrying.
- Add bounded retry/backoff for transient network and Notion 5xx failures.
- Replace the current per-page promise queue with a mergeable sync queue keyed by
  project/page.
- Coalesce superseded writes so only the latest content/title/archive state is
  pushed when multiple writes arrive for the same key.
- Keep stale-page detection intact so queue merging never overwrites a newer
  Notion revision without surfacing the conflict.

Acceptance checks:

- Rapid editor saves for one page produce one final Notion state.
- Rapid saves across different pages remain isolated by queue key.
- Simulated 429 responses pause and retry using `Retry-After`.
- Existing stale sync behavior still returns `stale` instead of overwriting
  remote changes.

## Milestone 2: Optimistic Creation Flow

Goal: let users create and edit projects/files immediately while sync completes
in the background.

- Implement optimistic project creation in the Pinia store.
- Use temporary client IDs for newly created projects and select them
  immediately.
- Reconcile the temporary project with the server-created project when sync
  succeeds.
- Roll back the optimistic project and restore the previous selection when
  creation fails.
- Implement optimistic file/page creation using the same temporary ID and
  reconciliation pattern.
- Load optimistic files/pages immediately with an empty Tiptap document so users
  can start editing before Notion sync completes.
- Keep editor save coalescing compatible with optimistic records by queueing
  content saves until the real page ID exists, then replaying the latest local
  state.
- Add explicit optimistic status fields for projects, pages/files, and media
  uploads: `creating`, `saving`, `saved`, `error`, and `stale`.

Acceptance checks:

- Creating a project immediately shows it in the project selector and editor.
- Creating a page/file immediately shows it in the page selector and editor.
- Edits made before creation sync completes are preserved after reconciliation.
- Failed creation removes the optimistic item and shows a recoverable error.
- Switching projects during optimistic creation does not lose local editor
  content.

## Milestone 3: Media Support

Goal: support embedded images, videos, and audio in the editor and sync them to
Notion where the APIs allow it.

- Extend the Tiptap document model with media nodes using stable attrs:
  `src`, `kind`, `title`, `mimeType`, `uploadState`, and optional Notion/file IDs.
- Add URL-based image insertion first using the Tiptap image extension or a
  compatible custom node.
- Add URL-based video embeds for supported sources, starting with YouTube and
  direct Notion-compatible video URLs.
- Add URL-based audio embeds using Tiptap audio support or a compatible custom
  node.
- Convert supported media nodes to Notion image, video, audio, embed, or file
  blocks during `tiptapDocumentToNotionBlocks`.
- Import supported Notion media blocks back into Tiptap media nodes where safe.
- Add Notion File Upload support after URL embeds are stable.
- Add local audio recording after upload support, guarded by browser capability
  checks and clear microphone permission flow.
- Treat unsupported media as link/bookmark/file fallback blocks rather than
  failing the whole page sync.

Acceptance checks:

- Image, video, and audio URLs render in the side panel editor.
- Supported media syncs into Notion as the correct block type.
- Unsupported media fails gracefully with a visible item-level error.
- Existing text formatting and capture links continue to round-trip.

## Milestone 4: Cleaner UI/UX

Goal: simplify the side panel while preserving full current functionality.

- Rework the side panel into tabs for focused workflows:
  `Editor`, `Projects`, `Media`, and `Sync`.
- Redesign the top bar into a cohesive status/action area with:
  sync status, account state, current project/page context, and primary create
  actions.
- Move project and page management into the `Projects` tab while keeping fast
  current project/page switching available near the editor.
- Move media insertion and upload/recording controls into the `Media` tab.
- Move Notion connection, logout, server URL, parent page selection, and sync
  diagnostics into the `Sync` tab.
- Replace `prompt` and `confirm` flows with inline controls or lightweight
  modals.
- Use compact icon buttons for common toolbar actions where practical while
  preserving accessible labels and tooltips.
- Preserve current capabilities: formatting, capture insertion, source-link
  opening, heading drag/drop, archive, login/logout, and sync state display.

Acceptance checks:

- The first screen remains the usable editor, not a landing page.
- All existing editor toolbar actions remain reachable.
- Project/page creation and archive no longer depend on browser prompts.
- Sync/auth failures are visible without pushing the editor out of view.
- UI fits within the Chrome side panel without incoherent overlap.

## Milestone 5: Testing And Acceptance

Goal: lock the new behavior with focused automated and manual coverage.

- Add sync-server tests for:
  - Notion rate-limit retry and `Retry-After` handling.
  - Queue merging for repeated page saves.
  - Queue isolation across different pages/projects.
  - Stale sync preservation.
  - Optimistic reconciliation payloads.
- Add store-level tests or a focused harness for:
  - Optimistic project creation success and failure.
  - Optimistic page/file creation success and failure.
  - Edits saved before optimistic reconciliation.
  - Project/page switching during pending creation.
  - Media upload status transitions.
- Verify the standard commands:
  - `corepack pnpm compile`
  - `corepack pnpm build`
  - `corepack pnpm --filter @jot/sync-server test`
- Manually test:
  - Login and logout.
  - Create project.
  - Create page/file.
  - Rapid edits.
  - Rapid project switches.
  - Media insertion.
  - Archive project/page.
  - Offline or sync-server error recovery.

## Public Interfaces

- Add shared queue and rate-limit helpers in the sync server, used by all Notion
  request paths.
- Extend document content with media nodes using:
  - `src`
  - `kind`
  - `title`
  - `mimeType`
  - `uploadState`
  - optional Notion/file IDs
- Extend store state with optimistic status fields for projects, pages/files,
  and media uploads.

## Assumptions

- This document is a roadmap/reference, not implementation code.
- "Files" means project pages/files inside Jot, with Notion child pages as the
  sync target unless a later design separates attachments from pages.
- Media support is feasible because Notion supports image, video, audio,
  external file blocks, and File Upload APIs; Tiptap supports image/audio/YouTube
  nodes and can be extended for unsupported embeds.
- Rate-limit behavior follows Notion's official docs: average 3 requests per
  second, handle `429`, and respect `Retry-After`.

## References

- Notion request limits: https://developers.notion.com/reference/request-limits
- Notion files and media:
  https://developers.notion.com/docs/working-with-files-and-media
- Notion block media support: https://developers.notion.com/reference/block
- Tiptap image extension:
  https://tiptap.dev/docs/editor/extensions/nodes/image
- Tiptap audio extension:
  https://tiptap.dev/docs/editor/extensions/nodes/audio
- Tiptap YouTube extension:
  https://tiptap.dev/docs/editor/extensions/nodes/youtube
