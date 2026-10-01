# Inkwell

Inkwell is a Chrome MV3 side panel extension for turning web context into editable
project pages without breaking flow.

## Stack

- WXT
- Vue 3
- TypeScript
- Pinia
- Tiptap
- PostCSS
- Custom Pico.css-inspired CSS variables

## Commands

```sh
corepack pnpm install
corepack pnpm dev
corepack pnpm dev:server
corepack pnpm compile
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
corepack pnpm zip
```

## Notion sync worker

Inkwell syncs through a Cloudflare Worker. The production extension build reads
`VITE_API_URL` from `.env.local`; this repository currently points at
`https://sync.inkwell.byaidan.com`.

For local development, start the worker:

```sh
corepack pnpm dev:server
```

Create a public Notion integration and set its redirect URI to
`https://sync.inkwell.byaidan.com/auth/notion/callback` for production, or
`http://localhost:8787/auth/notion/callback` for local development.

The worker uses Supabase for session, token, and sync metadata. Apply
`apps/worker/schema.supabase.sql`, then set the Worker secrets listed in
`apps/worker/wrangler.toml` with `wrangler secret put <NAME>`.

For Notion webhook verification, apply the webhook setup migration in
`apps/worker/migrations/003_notion_webhook_setup.sql` and set a random 32-byte-or-longer
`NOTION_WEBHOOK_SETUP_TOKEN` Worker secret. Call `POST /webhooks/notion/setup/arm` with
`Authorization: Bearer <setup-token>`; the response contains a one-time callback URL. Create the
Notion webhook subscription using that URL within ten minutes. The random URL segment prevents
unauthenticated callers from racing the initial verification request. Retrieve Notion's
verification token once with `GET /webhooks/notion/verification-token` using the same bearer, then
paste the returned token into Notion's webhook verification UI. To rotate after losing it, delete
the saved token with the protected `DELETE /webhooks/notion/verification-token` endpoint, arm setup
again, and recreate the subscription. Reset temporarily disables verification for the old URL.

Before deploying the connection deletion retry behavior, also apply
`apps/worker/migrations/004_connection_deletion_receipts.sql`. It adds a minimal hashed receipt so
the extension can finish local cleanup safely when a successful server deletion response is lost.

Before deploying the content-free queue changes, apply
`apps/worker/migrations/005_sync_queue_payloads.sql`. Queue messages then carry only random job
references; queued document payloads live in an installation-owned table and are removed by the
account deletion cascade. Create both `inkwell-sync-queue` and `inkwell-sync-dlq` Queues before
deploying the Worker consumers.

Apply `apps/worker/migrations/006_restrict_block_version_rpc.sql` to existing databases before
deploying the latest Worker. It restricts the sync-version write RPC to the Supabase service role.

Apply `apps/worker/migrations/007_harden_privileged_rpc_search_path.sql` after migrations 003 through
006 and before deploying the latest Worker. It pins name resolution for service-role RPCs, qualifies
their table references, and removes direct access to the webhook setup table from client roles.

Apply `apps/worker/migrations/008_atomic_notion_oauth_session.sql` before deploying the latest
OAuth callback. It commits the account credentials, installation, sync state, and hashed browser
session in one service-role-only transaction, preserving the current connection when a login fails.

Apply `apps/worker/migrations/009_serialize_connection_deletion.sql` after migration 008 and before
deploying the latest Worker. It serializes OAuth commits with Delete connection, so deletion revokes
the current Notion token and any OAuth callback that races with the deletion is rejected and revoked.
