---
# SPDX-License-Identifier: MIT
name: start
description: >
  Initialize the Backbrief memory vault and file the first call transcripts
  (ladder steps A0–A1: 5-question survey, vault skeleton, transcript intake,
  context digests). Use when the user says "/backbrief:start", "set up
  backbrief", "turn my calls into tasks", "начни установку", "настрой
  backbrief", "разложи звонки", or pastes a first transcript when no vault
  exists yet.
---

# Backbrief — start (A0–A1)

1. Read `${CLAUDE_PLUGIN_ROOT}/procedures/_conventions.md` — global rules (language
   mirroring, one-ask-per-step, question budget, telemetry guard, skip semantics).
   Non-negotiable.
2. Read `${CLAUDE_PLUGIN_ROOT}/procedures/_capabilities.md` and bind each capability
   to the best tool available in THIS session (MCP first, CLI fallback — see table).
3. Execute `${CLAUDE_PLUGIN_ROOT}/procedures/start.md` step by step. Do not skip a
   step's ARTIFACT gate; do not batch questions; PREFLIGHT before anything else.

Claude-specific bindings (override the generic table where richer tools exist):
- `fs.*`, `git.*` → built-in Read/Write/Edit/Bash tools
- `run.script` → Bash: `node ${CLAUDE_PLUGIN_ROOT}/scripts/<name> …`
- `telemetry.*` → `run.script(telemetry.js …)` — hard no-op without opt-in
