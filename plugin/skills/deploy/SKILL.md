---
# SPDX-License-Identifier: MIT
name: deploy
description: >
  Deploy the automatic Backbrief pipeline to the user's n8n (steps B0–B8,
  incl. B5.5 Anthropic key): hosting choice, tenant.yaml completion, guided
  Zoom/Slack/GitHub/tracker/Anthropic credentials with live verification,
  workflow import + deploy + self-test, history import, registration; every
  skip lands in .backbrief/roadmap.md. Use when the user says "/backbrief:deploy",
  "deploy the pipeline", "make it automatic", "set up the automation",
  "разверни пайплайн", "подключи автоматизацию", "сделай чтобы само",
  or picks the deploy option at the A4 wrap-up fork.
---

# Backbrief — deploy (B0–B8)

1. Read `${CLAUDE_PLUGIN_ROOT}/procedures/_conventions.md` — global rules
   (language mirroring, one-ask-per-step, skip semantics, secrets handling,
   telemetry guard). Non-negotiable.
2. Read `${CLAUDE_PLUGIN_ROOT}/procedures/_capabilities.md` and bind each
   capability to the best tool available in THIS session (MCP first, CLI
   fallback — see the table).
3. Execute `${CLAUDE_PLUGIN_ROOT}/procedures/deploy.md` step by step. Do not
   skip a rung's ARTIFACT gate (every B rung ends with a passing live test);
   do not batch questions; resume from `.backbrief/state.yaml` when rungs are
   already completed.

Claude-specific bindings (override the generic table where richer tools exist):
- `slack.*`   → Slack MCP tools if connected, else `curl` per _capabilities.md
- `tracker.*` → Linear MCP tools if connected, else Linear GraphQL via `curl`
- `fs.*`, `git.*`, `run.*` → built-in Read/Write/Edit/Bash tools
