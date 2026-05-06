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
corepack pnpm compile
corepack pnpm build
```

The current storage client is a typed local stub backed by extension storage.
OAuth and real Notion REST calls are intentionally deferred until the document
page model is stable.
