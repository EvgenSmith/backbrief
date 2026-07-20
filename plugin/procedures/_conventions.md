<!-- SPDX-License-Identifier: MIT -->
# Backbrief procedures — global conventions

> Read this file **before executing any procedure** in this directory. Every skill wrapper
> (`plugin/skills/*/SKILL.md`) and the root `AGENTS.md` route here first. These rules apply
> to every step of every procedure and are non-negotiable: procedures are the single source
> of truth for *what* each step does; this file governs *how* every step is conducted.
> Telemetry wire format: [`gateway/schema.md`](../../gateway/schema.md).
>
> **Scope note (despite the filename):** this file governs procedure EXECUTION — dialogue
> style, question budgets, skip semantics, telemetry. Vault FILE conventions (naming,
> frontmatter, folders) live in the rendered vault's `docs/conventions.md`
> (template: `plugin/templates/vault-skeleton/docs/conventions.md`).

## 0. How to read a procedure file

Each procedure is a numbered sequence of steps. A step may use the block grammar
(`ASK / DO / ARTIFACT / SKIP`) and/or inline tags:

| Tag | Meaning |
|---|---|
| `SAY:` | Agent statement. Canonical EN sample line — translate naturally at runtime (§1) |
| `ASK (Qn):` | A question that counts against the question budget (§3). `→ default:` = what Enter/no-answer means |
| `CONFIRM:` | Lightweight yes/no checkpoint; not counted against the budget, but keep ≤2 per rung |
| `[SCRIPT: name]` | Deterministic helper from `plugin/scripts/` — **must** be used instead of free-form LLM work (§6) |
| `[LLM]` | Free-form model work (extraction, digest writing, classification) |
| `[MCP: server]` | Call through the user's MCP connection; always has a no-MCP fallback (`_capabilities.md`) |
| `ARTIFACT:` | The one artifact this rung hands the user (§2) |
| `TELEMETRY:` | Event fired via `[SCRIPT: telemetry.js]` — hard no-op unless opted in (§7) |
| `ERROR:` / `SKIP:` | Failure recovery / explicit skip semantics (§4, §10) |
| `HANDOFF:` | How the rung ends and what it offers next (§9) |

Execution rules: run steps in order (unless state says resume, §5); never skip a step's
ARTIFACT gate; never batch questions; a step is done only when its artifact exists and
has been shown.

## 1. Language mirroring

- **Conversation mirrors the user's language.** Detect it from their messages and lock it
  for the session. RU and EN are first-class; any other language: best effort.
- **All structural elements are English**: frontmatter keys, flags, file and folder names,
  script names, YAML keys, command names. **Never translate** file paths, flag names,
  YAML keys, or commands — not even inside a translated sentence.
- Sample lines in procedures are canonical EN. Translate them naturally at runtime; do not
  read them verbatim to a non-EN user.
- Narrative content of digests and tasks is written in the **language of the call**
  (frontmatter keys/values stay EN per the templates).

## 2. One ask → one artifact

- Each rung requests **exactly one thing** and returns **one artifact** the user can keep
  if they stop right there. Never batch two asks into one message.
- Never produce an artifact without saying, in one line, where it is and what it's for.
- Show, don't tell: render the artifact (tree, digest, table, test message), not a
  description of it.

## 3. Question budget & smart defaults

- **≤5 questions before the first artifact** (the vault skeleton at the end of A0).
  Later rungs: one primary ask + ≤2 confirmations.
- Ask a question **only if the answer changes behavior**. Everything inferable is inferred
  and *stated for correction*, not asked (company ← email domain / git remote / folder
  name; team names ← transcripts; language ← the user's speech). A correction is free —
  it does not spend a question.
- Every question shows its default: *"(Enter = Linear)"*. One question per message.
- Plain words — no pipeline jargon ("orchestrator", "webhook") before Phase B; in Phase B
  each term gets a half-sentence gloss on first use.
- Show progress on multi-question stretches: *"(2/4)"*; show rung progress in Phase B:
  *"step B3 of B8"*.

## 4. Skip semantics → feature flags

- **Any rung and any connector may be skipped.** A skip is never a dead end: set the flag,
  state the exact degradation in one sentence, name the re-enable path, and move on.
  Example: *"Skipping Slack — digests will stay in the vault only. You can add Slack later
  with `/backbrief deploy` (step B3)."*
- Skip targets:
  - **rung skips** → `.backbrief/state.yaml` via `[SCRIPT: state.js set]`
    (`steps.<id>: skipped`);
  - **component skips** → `tenant.yaml` feature flags per `plugin/templates/tenant.schema.json`
    (`features.slack.enabled: false`, `features.raw_retention: none`,
    `features.tracker.enabled: false`, `features.drive.enabled: false`,
    `features.history_import.enabled: false`).
- Unsupported-tool answers are **waitlist capture events** (§8), never a "no".
- Skips never block later rungs (deploy ships whatever is enabled).

## 5. Idempotency & resume — `.backbrief/state.yaml`

- Every skill begins with **PREFLIGHT**: `[SCRIPT: state.js get]` on `.backbrief/state.yaml`.
  If the rung already completed → say so and offer *resume / redo / continue to next rung*.
- Re-running never clobbers: vault init is create-if-missing; transcript filing dedupes on
  content hash; tenant generation always shows a diff before overwriting.
- If a session dies mid-rung, the next invocation re-enters from the start of that rung —
  idempotent scripts make this safe (nothing is clobbered or double-created); where a
  `*_substep` key is present in state, it is honored to skip already-done sub-steps.
- `state.yaml` holds rung progress, the stack map, and resume points **only** — never
  secrets, never content.

## 6. Scripts vs LLM

- Deterministic work goes through `plugin/scripts/` helpers (inventory, conventions, and
  exit-code semantics: `_capabilities.md`). The agent runs them and interprets results —
  it does **not** re-implement them.
- If a script fails on genuinely ambiguous input (e.g. an unknown transcript format), the
  agent may fall back to LLM handling **and must say it is doing so** in one sentence.
- Numbers shown to the user (ROI counters, acceptance rates) come from state counters and
  script output — deterministic arithmetic, never LLM estimates.

## 7. Telemetry guard (opt-in, counters only)

- Consent is asked **once**, at A0 (Q5). Strict opt-in: **default = no**. Without consent,
  the plugin works fully and every `telemetry.js` call silently no-ops.
- Events are **step names and counters only**, in the gateway's closed wire format
  (`gateway/schema.md`): event enum `install | step_started | step_completed | step_skipped |
  calls_processed | tasks_verdict | connector_demand | status_run | error`; props are a
  per-event allowlist of ints/enums. **Never** transcript content, task text, names,
  emails, or file paths. The gateway rejects unknown keys — there is nothing to send
  content *in*.
- Every rung fires `step_started` / `step_completed` / `step_skipped` at the marked points
  via `[SCRIPT: telemetry.js event …]`. Shorthand in procedures: `a1_completed` ≡
  `{event: step_completed, step: A1}`.
- `install_id` is a random UUIDv4 generated locally **only at consent** — never derived
  from anything identifying.
- Fire-and-forget: one attempt, 2 s timeout; a dead gateway never blocks or fails a step.
- Emails go to the waitlist endpoint **only** when the user explicitly types one in (§8).
  Never auto-submit an email you happen to know.

## 8. Intent-first + waitlist capture

- **Never lead with tool discovery** ("do you have Slack MCP?"). Lead with the desired
  behavior ("should the call digest go to a shared team channel?"), then offer the
  **supported default** (Slack for chat, Linear for tracker — with connect help). Then:
  - user names another **supported** tool → guide them to connect it;
  - user names an **unsupported** tool → record demand anonymously:
    `[SCRIPT: telemetry.js event connector_demand --tool=<slug>]` (tool slug only) + local
    mirror in `.backbrief/waitlist.yaml`; then offer *(a)* self-connect (point at generic
    MCP docs) or *(b)* the waitlist: *"Leave an email so we can ping you when the <tool>
    connector ships? (optional)"* → on email:
    `[SCRIPT: telemetry.js waitlist --interest=connector --tool=<slug> --email=…]`.
    The waitlist endpoint requires an email; without one, demand still counts via
    `connector_demand`.
- v0.1 adopted scope (owner decisions — do not re-open in dialogue): the modules ship
  connectors for **our stack only** (Zoom, Google Drive, Git/GitHub, Linear, Slack, n8n,
  Anthropic). **Any other tracker (Jira included)** is file-only tasks + waitlist — no
  shipped adapter, no setup guide; the honest own-tool pointer is "adapt the skeleton"
  (`PRD.md` is the rebuildable spec). **GitLab / other git hosting** is waitlist-only at
  B4. **Privacy routing** (auto-routing 1:1/board/legal into private slices, DM delivery)
  is not in v0.1 — a request for it is demand:
  `[SCRIPT: state.js waitlist-observe privacy --step <id>]` + on a typed email
  `[SCRIPT: telemetry.js waitlist --interest=privacy --email=<typed> --source-step=<id>]`.

## 9. Router & handoffs

- Bare `/backbrief` (or "what's next?") = PREFLIGHT + route: read state, name the highest
  completed rung, propose the next one in one sentence.
- Every skill ends with a HANDOFF that does the same.
- Command-name note: Claude Code exposes plugin skills namespaced — `/backbrief:start`;
  the short form `/backbrief start` is the same command. Natural-language triggers work in
  both agents; the A4 wrap-up is reachable by name ("show the before/after") inside `tasks`.

## 10. Error tone

- On any failure: plain-words explanation (≤2 sentences), then **exactly three options**:
  **retry / skip (with named degradation) / do it manually (link to the doc)**.
- Never dump raw tracebacks unless asked — keep them one *"show details"* away.
- In batch processing, a single-item failure never aborts the batch: file the rest, report
  the failure with retry/skip.

## 11. Agent-agnostic execution (Claude + Codex + any agent)

- Procedures reference **capabilities, not vendor tools** ("read the file", "run
  `plugin/scripts/x.js`", "if a Slack connection is available, list users; otherwise …").
  The capability → tool binding lives in `_capabilities.md`; bind once at skill start.
- Every MCP touchpoint has a scripted or ask-the-user fallback — an agent without MCP can
  still complete every rung.
- No Claude-only affordances (no artifacts-UI assumptions, no built-in web-search
  assumptions). **Person-level web lookups are permission-gated**: offer once, run only on
  an explicit yes (e.g. LinkedIn profile enrichment at A2), never silently. Exception: the
  **company-site fetch at A0.9** (the user's own public homepage, inferred or volunteered)
  runs without a question — degrade with one line when no web access exists; never block.

## 12. Shared dialogue patterns (P1–P6)

Procedures cite these by name; use the wording below as the canonical EN base.

- **P1 — Supported-default offer** (A2.1, A3.2, B3, B5):
  *"Should <desired behavior>? The supported default is **<tool>** — I'll help you connect
  it. Using something else? I'll either point you at self-connect docs, or note your tool
  on the connector waitlist so it's prioritized by real demand."*
- **P2 — (retired)** — was the private-content warning; removed together with privacy
  routing (not in v0.1). Kept as a numbering placeholder so P3–P6 citations stay stable.
- **P3 — Skip acknowledgement** (everywhere):
  *"Skipped — <flag> is off. Concretely that means: <one-sentence degradation>. Re-enable
  any time via <rung/skill>."*
- **P4 — Verified-artifact close** (every B rung):
  *"✅ <component> verified — <what the live test proved>. (step B<n> of B8 done)"*
- **P5 — First-artifact framing** (A0.8, echoed at A4):
  *"Everything I make is plain markdown/YAML in your folder. Delete the plugin tomorrow —
  the vault, digests, and tasks remain yours."*
- **P6 — Autonomy seed** (A3.5 first run; `status` when acceptance ≥95%):
  *"Your 30-day acceptance is <X>% over <N> decisions — that's the signal raised task
  autonomy (auto-creating the safe tasks) will key on when it ships."*
  v0.1 adopted scope: raised task autonomy (**L1/L2 auto-create**) is **reserved — it
  ships a future release**; `features.tracker.autonomy_level` stays **L0** (confirm every
  task). This is a **read-only milestone note** — never promise auto-create now, and never
  offer to change the knob (see PRD §12 known-constraints).

<!-- ===================================================================== -->
<!-- APPENDED SECTION (iteration 2, per-step-fork decision). §0–§12 above  -->
<!-- are the original body; this section is self-contained and extends     -->
<!-- §4, §8 and §10. Procedures cite it as "§13".                          -->
<!-- ===================================================================== -->

## 13. Per-step fork — the four options (extends §4, §8, §10)

Every step that connects a tool or component offers the **same four ways out**, in this
order (procedures cite this as the "§13 menu"; it upgrades the §10 three-option menu at
every tool/connector fork):

1. **Our stack** — the supported default: connect it now, guided; live-verified where a
   probe exists (`test-creds.js`).
2. **Skip** — set the flag/state per §4 + say the one-sentence degradation (P3) + record
   the reason: `[SCRIPT: state.js set steps.<id> skipped]` and
   `[SCRIPT: state.js set steps.<id>_skip_reason <slug-or-short-reason>]`.
   Every `steps.*` / `fork` write auto-regenerates `<vault>/.backbrief/roadmap.md` — the
   user-facing mirror of every deferred step (what was skipped, what it costs, how to
   resume). Never write the roadmap by hand; `state.js` owns it
   (`state.js roadmap` regenerates on demand).
3. **Own tool** — the user keeps their tool: be honest that no adapter or setup guide
   ships in v0.1, point at the adapt-the-skeleton path (`PRD.md` — the rebuildable spec —
   plus the tool's own MCP docs), record demand
   (`[SCRIPT: telemetry.js event connector_demand --tool=<slug>]` +
   `[SCRIPT: state.js waitlist-observe <slug> --step <id>]`), then continue on the
   nearest supported path (file-only, manual feed, …). Never a dead end.
4. **"Set it up for me"** — the hands-on waitlist, available at **any** step, not only
   A4/B0. On an explicitly typed email (§7):
   `[SCRIPT: telemetry.js waitlist --interest=hands_on --source-step=<id> --email=<typed>]`
   + `[SCRIPT: state.js waitlist-observe <slug> --step <id> --emailed]`.

Step classification — **state the stakes before the user skips**:

- **REQUIRED for value:** the vault itself (A0) and a calls source (A1 — at least one
  transcript in any format). Phase B adds: hosting (B0), tenant completion (B1), the
  Anthropic API key (B5.5), deploy itself (B6).
- **OPTIONAL with stated degradation:** everything else — A2 profiles, A3 tracker
  connection, B2 Zoom auto-capture, B3 Slack, B4 GitHub (heaviest optional skip),
  B5 tracker creds, B7 history import, B8 registration. Rung headers carry
  `[REQUIRED]` / `[OPTIONAL]` markers; the degradation sentence per step lives in the
  procedure's SKIP block and is mirrored into `.backbrief/roadmap.md`.

At failure points (§10) the same shape applies: retry / skip (+degradation) / manual
(doc link) / "set it up for me" (hands-on waitlist).

The complete question → answers → config-effect map (every fork above, as data) lives in
`_question-graph.md`; update it in the same change whenever any procedure's flow changes.
