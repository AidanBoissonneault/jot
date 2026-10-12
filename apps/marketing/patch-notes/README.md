# Patch notes

Add one Markdown file per release in `posts/`, named after its version, such as `v2.md`.
Vite loads every `posts/*.md` file automatically, and the Patch notes page displays the newest dates first.

Use this format:

```md
---
version: v2
date: YYYY-MM-DD
title: A short release title
---

Write a short opening paragraph here.

## Included

- Describe a user-facing change.
- Describe another change.
```

The page supports paragraphs, `##` and `###` headings, and `-` or `*` bullet lists. Use an ISO date (`YYYY-MM-DD`) and keep the version and date in the file's front matter.
