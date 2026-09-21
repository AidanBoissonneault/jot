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
- `queues/syncQueueConsumer.ts` — background synchronization execution, acknowledgement, retry, and status events.
- `services/workerRuntime.ts` — initialized service graph, installation state, locking, and Notion mutation orchestration shared by routes and queues.
- `auth.ts` and `notionAuth.ts` — application authentication persistence and Notion OAuth/webhook lifecycle behavior.
- `notionRequest.ts` — authenticated Notion transport, retry, backoff, rate limiting, and file upload.
- `blockConversion.ts`, `managedBlocks.ts`, and `importManagedBlocks.ts` — Tiptap/Notion conversion and stable managed-block identity.
- `projectDatabase.ts`, `projectDatabaseValues.ts`, `projectSync.ts`, and `rootPages.ts` — project database and legacy page-tree synchronization.
- `syncEvents.ts`, `syncQueueMessages.ts`, and `types.ts` — durable event delivery, queue shaping, and shared domain contracts.
- `htmlPages.ts` and `workerUtils.ts` — isolated HTML rendering and stateless worker helpers.

## Entry point

`worker.ts` creates the Hono app, registers each route feature, initializes the runtime per request, delegates Queue batches, and exports the durable object.
