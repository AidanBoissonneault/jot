# Inkwell API source

Last edited: September 2026  
Author: Aidan Boissonneault

This directory contains the Cloudflare Worker API and separates transport, feature routes, orchestration, and domain conversion so the entry point only composes features.

## Features

- `routes/authRoutes.ts` — CORS, legal documents, Notion OAuth, application sessions, logout, and diagnostic logs.
- `routes/notionRoutes.ts` — YouTube embed presentation plus Notion workspace-page search and creation.
- `routes/syncMutationRoutes.ts` — page, block, project, and project-source pushes into Notion.
- `routes/syncQueryRoutes.ts` — synchronization status, event streaming, validation, reload, pull, and stale-state recovery.
- `routes/webhookRoutes.ts` — Notion webhook verification and remote-change notifications.
- `routes/mediaRoutes.ts` — validated media upload and signed Notion URL refresh.
- `queues/syncQueueConsumer.ts` — loads installation-owned sync payloads from Supabase, executes them, and cleans up both normal and dead-letter queue references.
- `services/workerRuntime.ts` — initializes shared services and exposes the runtime facade used by routes and queues.
- `services/workerInstallationState.ts` — resolves sessions and connected installations, then locks state updates per installation.
- `services/workerNotionOperations.ts` — composes Notion cache, block transport, managed-block sync, and page mutation helpers.
- `services/notionBlockOperations.ts` — paginated child reads and focused Notion page/block create, update, delete, and append operations.
- `services/workerStorePersistence.ts` — normalized worker state, diagnostic logs, and Supabase installation-state persistence.
- `services/notionObjectCache.ts` — validates cached Notion pages, databases, and thread blocks, then clears stale local mappings.
- `auth.ts` and `notionAuth.ts` — application authentication persistence and Notion OAuth/webhook lifecycle behavior.
- `notionRequest.ts` — authenticated Notion transport, retry, backoff, rate limiting, and file upload.
- `services/workerSyncOperations.ts` — authenticated HTTP page and project synchronization.
- `services/workerQueueOperations.ts` — stores sync payloads in Supabase, publishes opaque Queue references, and performs background page, block, and project synchronization.
- `blockConversion.ts` — stable exports for the focused converters in `blockConversion/`.
- `blockConversion/tiptapToNotion.ts` and `blockConversion/notionToTiptap.ts` — separate outbound and inbound conversion; `valueReaders.ts` and `youtubeUrls.ts` contain shared helpers.
- `managedBlocks.ts`, `managedBlockOperations.ts`, and `importManagedBlocks.ts` — full-document replacement, granular operations, and remote import.
- `managedBlockIdentity.ts` and `managedBlockReconciliation.ts` — stable local identity, order analysis, and remote reconciliation.
- `projectDatabase.ts` — project row lifecycle, composed around discovery, row, and state helpers.
- `projectDatabaseDiscovery.ts` — database discovery, parent creation, schema upgrades, managed views, and candidate ranking.
- `projectDatabaseRows.ts` and `projectDatabaseValues.ts` — managed-row queries, Notion row mapping, and database schema/value shaping.
- `projectDatabaseState.ts` — project state containers and nested thread toggle import, update, and archive operations.
- `projectSync.ts` and `rootPages.ts` — project folder and legacy page-tree synchronization.
- `syncEvents.ts`, `syncQueueMessages.ts`, and `types.ts` — durable event delivery, queue shaping, and shared domain contracts.
- `htmlPages.ts` and `workerUtils.ts` — isolated HTML rendering and stateless worker helpers.

## Entry point

`worker.ts` creates the Hono app, registers each route feature, initializes the runtime per request, delegates Queue batches, and exports the durable object.
