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
