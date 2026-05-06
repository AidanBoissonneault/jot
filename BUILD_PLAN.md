# Jot — BUILD_PLAN.md

## Product Definition

Jot is a browser side tab that lets users highlight or drag content from the web directly into structured Notion projects.

Core Principle:
Capture without breaking flow.

---

## Core Features

### Sidebar (Persistent UI)
- Project selector
- Quick note input
- Sectioned drop zones:
  - Notes
  - Tasks
  - Ideas
  - Links
- Chronological activity feed

---

### Highlight Capture
- User selects text on page
- Mini capture UI appears
- Options:
  - Save instantly
  - Add note
  - Drag to sidebar

---

### Drag and Drop (Signature Feature)
- Drag highlighted text into sidebar
- Drop into section to classify:
  - Notes → Quote
  - Tasks → Checkbox
  - Ideas → Tagged note
  - Links → URL capture

---

### Notion Integration
- Notion is the source of truth
- All captures stored in Notion databases
- Sidebar reads and writes via API

---

## UX Flows

### Flow A — Quick Save
1. Highlight text  
2. Click save  
3. Added to current project  

### Flow B — Drag Save
1. Highlight text  
2. Drag to sidebar  
3. Drop into section  
4. Saved to Notion  

### Flow C — Return to Context
1. Open sidebar  
2. Click capture  
3. Page opens  
4. Highlight restored  

---

## Sidebar Structure

[ Project ▼ ]

[ + Quick note... ]

-------------------

Notes
  - quote
  - quote

Tasks
  - checkbox
  - checkbox

Ideas
  - idea

Links
  - link

-------------------

Recent Activity
  - mixed chronological feed

---

## Drag Interaction Design

Step 1 — Highlight  
User selects text

Step 2 — Drag Start  
Floating preview appears with selected text

Step 3 — Sidebar Reaction  
Sidebar expands if closed  
Drop zones highlight on hover

Step 4 — Drop Behavior  
Notes → Quote block  
Tasks → Checkbox  
Ideas → Tagged note  
Links → URL only  

Step 5 — Save  
Immediately pushed to Notion  
Appears in sidebar

---

## Data Model

### Capture

type Capture = {
  id: string
  projectId: string

  type: 'quote' | 'task' | 'idea' | 'link'

  content: string
  note?: string

  sourceUrl: string
  pageTitle: string

  highlightMeta?: {
    text: string
    xpath?: string
    offset?: number
  }

  createdAt: string
}

---

## Deep Linking System

Stored Data:
- URL
- Highlight text
- Optional DOM selector

Restore Logic:
1. Open page
2. Inject script
3. Locate closest text match
4. Scroll and highlight

Fallback:
- Open page only

---

## Repository Structure

jot/
├── apps/
│   ├── extension/
│   │   ├── background/
│   │   ├── content/
│   │   ├── sidebar/
│   │   └── popup/
│   └── web/
├── packages/
│   ├── notion-client/
│   ├── capture-engine/
│   ├── drag-system/
│   ├── ui/
│   └── types/
├── config/
└── docs/

---

## Extension Architecture

Content Script:
- Detects text selection
- Shows mini capture UI
- Handles drag start
- Extracts text, DOM metadata, URL

Sidebar App:
- Displays project data
- Handles drop zones
- Sends capture events

Background Script:
- Handles Notion OAuth
- Sends API requests
- Maintains local cache

Data Flow:

User Action → Content Script → Background Script → Notion API → Sidebar Update

---

## Notion Setup

Database: Captures

Properties:
- Name (title)
- Project (relation)
- Type (select)
- URL (url)
- Page Title (text)
- Content (rich text)
- Note (rich text)
- Created (date)
- Done (checkbox)

Database: Projects

Properties:
- Name
- Status
- Tags

---

## Notion Integration

Requirements:
- OAuth authentication
- REST API usage

Core Operations:
- Create page (capture)
- Query database (sidebar)
- Update page (tasks, notes)

---

## Build Plan

Phase 0 — Setup (1–2 days)
- Initialize extension scaffold
- Setup Notion API client
- Basic sidebar UI

Phase 1 — Capture MVP (3–5 days)
- Detect text selection
- Implement save button
- Push capture to Notion
- Display captures in sidebar

Phase 2 — Drag System (3–4 days)
- Drag from highlighted text
- Sidebar drop zones
- Capture classification

Phase 3 — Deep Linking (3–5 days)
- Store highlight metadata
- Restore highlight on revisit
- Scroll and highlight

Phase 4 — Polish (ongoing)
- UI and UX improvements
- Animation smoothing
- Error handling
- Loading states

---

## Risks and Considerations

Notion API Latency:
- Mitigation: optimistic UI updates

Highlight Restoration Reliability:
- Mitigation: fallback to URL

Drag UX Complexity:
- Requires careful polish

---

## Final Positioning

Jot is not:
- a notes app
- a task manager
- a Notion replacement

Jot is:
The fastest way to move ideas from the web into Notion projects.
