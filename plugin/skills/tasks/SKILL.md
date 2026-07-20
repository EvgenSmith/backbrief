---
# SPDX-License-Identifier: MIT
name: tasks
description: >
  Extract tasks from filed calls, dedup them against the live tracker backlog,
  create/comment issues on approval, and log every decision as training data
  (ladder steps A3–A4, incl. the wrap-up: before/after demo, mini-ROI, fork).
  Use when the user says "/backbrief:tasks", "get the tasks from this call",
  "/backbrief wrap-up", "show the before/after", "поставь задачи из звонка",
  "собери задачи в трекер", "покажи до/после", or pastes a transcript with
  task intent.
---

# Backbrief — tasks (A3–A4 incl. wrap-up)

1. Read `${CLAUDE_PLUGIN_ROOT}/procedures/_conventions.md` — global rules.
   Non-negotiable.
2. Read `${CLAUDE_PLUGIN_ROOT}/procedures/_capabilities.md` and bind each capability
   to the best tool available in THIS session (MCP first, CLI fallback).
3. Execute `${CLAUDE_PLUGIN_ROOT}/procedures/tasks.md` step by step. The tracker
   question is asked once EVER (PREFLIGHT re-reads it); every per-task decision is
   individually actionable; every decision is logged; the A4 wrap-up is this skill's
   terminal phase — offer it after the first full pass.

Claude-specific bindings (override the generic table where richer tools exist):
- `tracker.search/create/comment` → Linear MCP if connected, else Linear GraphQL via
  `curl` (other trackers: file-only + waitlist — no adapter ships in v0.1)
- `fs.*` → built-in Read/Write/Edit; `run.script` → Bash: `node ${CLAUDE_PLUGIN_ROOT}/scripts/<name> …`
- `telemetry.*` → `run.script(telemetry.js …)` — hard no-op without opt-in
