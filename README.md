# Jot

Jot is a Chrome MV3 side panel extension for turning web context into editable
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
corepack pnpm build
```

## Notion sync server

Jot syncs through a small single-user sidecar server. Create a public Notion
integration and set its redirect URI to
`http://localhost:8787/auth/notion/callback`.

Start the server:

```sh
corepack pnpm dev:server
```

Put the Jot social OAuth credentials and Notion OAuth credentials in
`apps/sync-server/.env`, then open the side panel and sign in with Google,
GitHub, or Apple. After the Jot account is active, connect Notion. Jot then
syncs into a root Notion page named `Jot`; each Jot project becomes a child page
under it, and that project's pages are synced inside the project page.

Create a MySQL database, apply `apps/sync-server/schema.mysql.sql`, then copy
`apps/sync-server/.env.example` to `apps/sync-server/.env` and fill in the
Better Auth, social OAuth, Notion OAuth, MySQL, and `JOT_TOKEN_ENCRYPTION_KEY`
values before starting the server. The encryption key is server-only; use a
long random value.

The extension defaults to `http://localhost:8787`. Use the side panel to log in
or log out of Jot; logout also disconnects Notion for that session. The server
stores Better Auth account records, encrypted Notion OAuth tokens, and sync
metadata in MySQL. It still writes local diagnostic logs to
`apps/sync-server/.data` by default; set `JOT_SYNC_DATA_DIR` to move those logs.

claude --resume 1079bbf6-1786-450a-af1a-b7e48515756d
