---
# SPDX-License-Identifier: MIT
name: profiles
description: >
  Build one profile file per team member (ladder step A2): role, responsibility
  zones, and the alias name-map that lets digests and tasks resolve any spoken
  name variant to one owner. Use when the user says "/backbrief:profiles",
  "set up the team", "who is who on my team", "собери профили команды",
  "кто есть кто", or right after transcripts were filed (A1 handoff).
---

# Backbrief — profiles (A2)

1. Read `${CLAUDE_PLUGIN_ROOT}/procedures/_conventions.md` — global rules.
   Non-negotiable.
2. Read `${CLAUDE_PLUGIN_ROOT}/procedures/_capabilities.md` and bind each capability
   to the best tool available in THIS session (MCP first, CLI fallback).
3. Execute `${CLAUDE_PLUGIN_ROOT}/procedures/profiles.md` step by step. Intent-first:
   ask where team info should come from BEFORE checking any connection. One primary
   ask; never skip the review-table ARTIFACT gate.

Claude-specific bindings (override the generic table where richer tools exist):
- `slack.users()` → Slack MCP users-list tool if connected, else `curl` per table
- `tracker.*` → Linear MCP if connected, else GraphQL via `curl` (other trackers: waitlist, no adapter)
- `fs.*` → built-in Read/Write/Edit; `run.script` → Bash: `node ${CLAUDE_PLUGIN_ROOT}/scripts/<name> …`
- `web.fetch` (LinkedIn enrichment) → WebFetch, ONLY after an explicit user yes
