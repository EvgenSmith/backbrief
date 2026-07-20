---
# SPDX-License-Identifier: MIT
name: status
description: >
  Health check for the Backbrief pipeline and vault: webhook liveness, last
  call processed, DLQ entries, component flags, vault/task counters, deferred
  setup steps (.backbrief/roadmap.md) with the deterministic next rung, and the
  kit update check. Read-only, asks nothing. Use when the user says
  "/backbrief:status", "is the pipeline alive?", "what's new in my vault",
  "did my last call get filed?", "what did I skip?", "статус", "жив ли пайплайн",
  "что с пайплайном", "проверь пайплайн", or after any suspected failure.
---

# Backbrief — status

1. Read `${CLAUDE_PLUGIN_ROOT}/procedures/_conventions.md` — global rules
   (language mirroring, error tone, telemetry guard). Non-negotiable.
2. Read `${CLAUDE_PLUGIN_ROOT}/procedures/_capabilities.md` and bind each
   capability to the best tool available in THIS session.
3. Execute `${CLAUDE_PLUGIN_ROOT}/procedures/status.md` step by step: gather
   via scripts (`state.js`, `status.js`, `check-update.js`), render the one
   compact report, then OFFER recovery actions (redrive, redeploy, triage) —
   never auto-run them. All numbers come from script output, never estimates.

Claude-specific bindings (override the generic table where richer tools exist):
- `run.script(...)` → Bash: `node ${CLAUDE_PLUGIN_ROOT}/scripts/<name> …`
- `web.fetch`       → WebFetch (release notes when an update is available)
