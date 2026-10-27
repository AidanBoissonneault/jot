# Jottathing

Jottathing is a Chrome MV3 side panel extension for turning web context into editable
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
node --import tsx scripts/jottathing-sync-smoke.ts --help
corepack pnpm build
corepack pnpm zip
```

## Notion sync worker

Jottathing syncs through a Cloudflare Worker. The production extension build reads
`VITE_API_URL` from `.env.local`; this repository currently points at
`https://sync.jottathing.byaidan.com`.

For local development, start the worker:

```sh
corepack pnpm dev:server
```

The public API and production OAuth callback use
`https://sync.jottathing.byaidan.com` and
`https://sync.jottathing.byaidan.com/auth/notion/callback` respectively. The old
`sync.inkwell.byaidan.com` hostname remains available as a compatibility alias.

The worker uses Supabase for session, token, and sync metadata. Apply
`apps/worker/schema.supabase.sql`. `apps/worker/wrangler.toml` deploys the public
`jottathing-sync` entry point; `apps/worker/wrangler.core.toml` configures the existing
secret-bearing backend. Store secrets on the Cloudflare Worker with `wrangler secret put NAME`
rather than in either config file.

For Notion webhook verification, apply the webhook setup migration in
`apps/worker/migrations/003_notion_webhook_setup.sql` and set a random 32-byte-or-longer
`NOTION_WEBHOOK_SETUP_TOKEN` secret on the backend Worker. Call `POST /webhooks/notion/setup/arm` with
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
account deletion cascade. Create both `jottathing-sync-queue` and `jottathing-sync-dlq` Queues before
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
the current Notion token and advances the global signed OAuth generation when deletion completes.
OAuth flows already in progress must restart after a wipe; a new flow after completion can connect.

Apply `apps/worker/migrations/010_serialize_notion_logout.sql` after migration 009 and before
deploying the updated logout route. It serializes logout with OAuth callbacks, disables sync first,
and clears server-side Notion tokens and the current session together. Local documents remain intact.

After reconciling the connected database's migration history, apply
`apps/worker/migrations/20261005031402_harden_rls_auto_enable_and_queue_index.sql`. It removes
direct API execution grants from the RLS auto-enable helper without changing its DDL event trigger,
and indexes queued payloads by installation.

For an existing database that still uses the previous persistence names, apply
`apps/worker/migrations/20261027150302_rename_jottathing_database_objects.sql` after that migration
and before deploying the renamed Worker. It renames the live tables, columns, indexes, and policies
in place and preserves their data. Fresh databases initialized from `schema.supabase.sql` already
use the Jottathing names and do not need this migration.

### Local sync smoke driver

The CLI exercises the authenticated project and page routes against a loopback Worker only. Start
the Worker on port 8787, then set `JOTTATHING_SESSION_COOKIE` in your shell to the `jottathing_session`
cookie pair from your local authenticated session. The CLI does not print or persist this value.

```sh
node --import tsx scripts/jottathing-sync-smoke.ts create
node --import tsx scripts/jottathing-sync-smoke.ts edit --text "Updated paragraph one.\n\nUpdated paragraph two — café 東京 🧪."
node --import tsx scripts/jottathing-sync-smoke.ts status --wait
node --import tsx scripts/jottathing-sync-smoke.ts archive
```

To run create, rapid edits, sync polling, and archival in one pass, use
`node --import tsx scripts/jottathing-sync-smoke.ts smoke`. Run `node --import tsx scripts/jottathing-sync-smoke.ts help` for options. State is
stored under the ignored `.tmp/jottathing-sync-smoke/` directory so an interrupted run can be archived
later with the `archive` command.
