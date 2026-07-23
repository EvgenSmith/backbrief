<!-- SPDX-License-Identifier: MIT -->
# Backbrief procedure — `tasks` (A3 extraction + dedup + tracker writes · A4 wrap-up)

> **Before executing:** read `_conventions.md` (global rules) and `_capabilities.md`
> (bind capabilities — this procedure uses `tracker.search`, `tracker.create`,
> `tracker.comment`, `fs.*`, `run.script`, `telemetry.*`).
> Single source of truth for steps A3–A4. The A4 wrap-up is the
> terminal phase of this skill — auto-offered after the first full A3 pass, and
> reachable by name ("show the before/after", "/backbrief wrap-up") via the router.
>
> **Triggers:** `/backbrief tasks` (`/backbrief:tasks`), "get the tasks from this call",
> router after A2, or a transcript pasted with task intent.
> **Time budget:** A3 ≤ 7 min for 3 calls; A4 ≤ 3 min.
> **Questions:** 1 (tracker intent — asked once EVER) + per-task confirmations, which
> ARE the product at autonomy L0; A4 adds 1 (the fork).

---

## PREFLIGHT                                                    [gate: ≥1 filed transcript]

DO:
  1. `[SCRIPT: state.js get]`:
     - No vault → route to `start` (A0).
     - No filed transcript → **inline intake**: accept a paste/file right here, run the
       `start` procedure's sub-steps A1.2–A1.4 on it (normalize → classify → file), then
       continue. Do not send the user away.
     - Profiles missing (`steps.a2` ≠ completed) → proceed; owners degrade to raw
       name-hints, say so once.
  2. If `stack.tracker` / tenant `features.tracker.kind` is already recorded →
     **do not re-ask** at A3.2.
  3. Scope: default = every filed call not yet covered by a `tasks/*.tasks.md` artifact;
     the user may name one call.
  4. `[SCRIPT: state.js set steps.a3 in_progress]`
  5. TELEMETRY: `[SCRIPT: telemetry.js event step_started A3]`

---

## Rung A3 — extraction, dedup, tracker writes

### Step A3.1 — extraction                                      [per call, no question]

DO: **Load the vault context first** (when the files exist): `docs/company.md` (products,
vocabulary, customers — grounds titles and owners) and `docs/skills/summarizer.md`.
Then: [LLM] Backbrief-tasks extraction (TaskCrafter-lite) on the normalized segments /
filed digest.

**Content-hygiene rule (mirrors the pipeline normalizer):** compensation/salary
figures, personal data, and NDA specifics are **never echoed** into a task draft — no
quote, no title fragment; extract the actionable shell ("follow up on the <topic>
discussion") or drop the draft entirely and say so in one line. Applies to every field
below, including `transcript_quote`. (This is content hygiene, not routing — privacy
routing is not part of v0.1.)

Fields per draft:
  - `title` — concrete, at **quote altitude**, never generalized (the known failure
    mode: title says "landing" when the quote says "slide" — stay with the quote);
  - `owner` — resolved through `team/*.md` aliases when profiles exist, else the raw
    name-hint as spoken;
  - `priority`: `low | medium | high | urgent`;
  - `transcript_quote` — exact span; `source_ts_mmss` — its (MM:SS) anchor;
  - `voice_marker` — verbatim trigger phrase when one exists ("grab this as a task",
    a wake-word directive), else null;
  - `intent`: `create | comment_only` (a spoken reference to an existing issue =
    comment_only);
  - `status`: `post-call | done-on-call | monitoring` (controlled vocabulary —
    `plugin/templates/frontmatter/controlled-vocabulary.yaml`).
    Only `post-call` drafts become tracker candidates; `done-on-call` and `monitoring`
    are recorded in the digest, not the tracker.
Narrative fields in the call's language; enum tokens EN.

### Step A3.2 — ASK (once ever): tracker intent                 [pattern P1]

**Recorded-tracker path (the common case):** A0.8 always records `stack.tracker`,
so PREFLIGHT step 2 skips the ASK below — it fires only when no tracker was ever
recorded (fresh/partial state). On the skip path, announce the standing choice,
never skip silently:
  - kind = `linear` → one line: *"Tasks go to Linear — your setup answer —
    connecting now (or say 'file only')."*
  - kind = `other` / a named non-Linear tracker → recognition SAY: *"At setup you
    said tasks live in <tracker> — task automation for it is waitlist-only in
    v0.1, so A3 files tasks to `tasks/*.tasks.md` with paste-ready blocks."*
    File-only mode is announced, not implied.

ASK: *"Where should tasks go?
1. **Linear** — recommended; I'll connect it and check every task against your live
backlog before creating anything ·
2. **Another tracker** (Jira, Asana, …) — tell me which; I'll note it for the connector
waitlist and write a copy-paste file for now ·
3. **File only** — a `tasks.md` per call, no tracker. (Enter = 1)"*
  → default: Linear. Record in tenant.yaml: `features.tracker.kind: linear|other`
  + `features.tracker.enabled: true|false` — **asked once ever** (PREFLIGHT re-reads it).

  - **1 without a connection** → connect guide (Linear MCP or API key per
    `docs/linear-setup.md`) or *"connect later — I'll do file-only now and remember your
    choice."*
  - **2 — own tool (adopted v0.1 scope: no shipped adapter, no setup guide):** be honest
    — Linear is the only connector in v0.1; the skeleton is adaptable (`PRD.md`). Record
    `[SCRIPT: telemetry.js event connector_demand --tool=<slug>]` +
    `[SCRIPT: state.js waitlist-observe <slug> --step A3]` + optional email →
    `[SCRIPT: telemetry.js waitlist --interest=connector --tool=<slug> --email=<typed> --source-step=A3]`
    → proceed file-only (`kind: other`).
  - **3** → file-only; `features.tracker.enabled: false`.
  - **"set it up for me"** (any point) → §13 option 4: hands-on waitlist
    (`--interest=hands_on --source-step=A3`), proceed file-only meanwhile.

### Step A3.3 — dedup against the live backlog                  [only when tracker connected]

DO: per draft:
  1. capability `tracker.search(title keywords + owner + team scope)` → candidate issues.
  2. [LLM] semantic verdict against the candidates — exactly one of:
     - **create** — no match;
     - **comment** — matches an open issue: the call adds context (deadline, owner,
       decision), don't duplicate;
     - **duplicate** — already exists as-is → propose skip;
     - **flag** — ambiguous (~0.4–0.7 similarity) — human call.
  3. No tracker → every draft is `create`, targeting the `tasks/` file only.

### Step A3.4 — per-task confirmation loop                      [the product at L0]

Render each proposal compactly — batches of ≤6 per message are fine, but every task
must be individually actionable:

```
[2/6] ✏️ CREATE — "Rewrite onboarding email #2"
      owner: Maria (growth) · priority: high · (14:32) "<verbatim quote>"
      backlog: no similar issues
[3/6] 💬 COMMENT on ABC-142 "Onboarding revamp"
      the call adds a deadline + owner; comment instead of a duplicate
[4/6] ⚠️ FLAG — looks ~60% like ABC-98; create new / comment / skip?
```

ASK per task or batch: *"approve / edit (tell me what to change) / skip — or
'approve all non-flagged' / 'skip all'."*
  - **approve** → `tracker.create` / `tracker.comment`; confirm with the issue URL
    inline. Write failure → the tracker's error in one line, keep the draft, offer:
    retry / file-only for that task / skip.
  - **edit** → [LLM] apply, re-show, then approve/skip.
  - **skip** → no write.

### Step A3.5 — outcome logging                                 [training seed]

DO: per decision, immediately:
  1. `[SCRIPT: state.js log-decision '{"call_id":"<call file basename>",
     "task_title":"<title>","verdict_proposed":"<create|comment|duplicate|flag>",
     "user_action":"<accepted|edited|skipped>","edit_summary":"<one line, only when
     edited>","tracker_ref":"<ISSUE-KEY, when created/commented>"}']`
     → appends to `.backbrief/training/task-decisions.jsonl`.
  2. TELEMETRY per decision:
     `[SCRIPT: telemetry.js event tasks_verdict --verdict=<accepted|edited|skipped>
     --dedup=<create|comment|duplicate|flag> --tracker=<linear|other|none>]`
  3. Update counters via `[SCRIPT: state.js set …]`: `counters.tasks_extracted`,
     `counters.tasks_accepted`, `counters.tasks_edited`, `counters.tasks_skipped`,
     `counters.duplicates_caught` (duplicate + comment verdicts).

SAY once (first run only — pattern P6 seed): *"I log your approve/skip decisions into
`.backbrief/training/` — that's your team's private training data. It's what will power
raised autonomy (auto-creating the safe tasks) in a future release."*
(v0.1 adopted scope: raised task autonomy (L1/L2 auto-create) is **reserved — ships a
future release**; `features.tracker.autonomy_level` stays L0. Never promise auto-create
now or offer to change the knob.)

### Step A3.6 — file artifact                                   [ARTIFACT gate, per call]

DO:
  1. **Always** write `tasks/<call-file-basename>.tasks.md` from
     `plugin/templates/frontmatter/tasks.md` (the basename pairs
     deterministically with the transcript file).
     Details:
     - frontmatter: `type: tasks`, `schema_version: 1`, `call` (vault-relative
       transcript path), `team`, `date`, `tracker: linear|none`,
       `autonomy_level`, `generated` (ISO), `counts: {extracted, created, commented,
       skipped}` — counts must match the body blocks (the validator checks the
       arithmetic).
     - body: one block per draft **in extraction order, including skipped ones**, with
       the fixed verdict markers `✏️ CREATE · 💬 COMMENT · ⚠️ FLAG · 🔁 DUPLICATE`,
       the quote + (MM:SS), the dedup evidence, and the user's
       `**decision: …**` line (tracker URL when written). File-only mode: every accepted
       CREATE gets a copy-paste block (Title / Assignee / Priority / Description with
       quote + source path) — then this file IS the deliverable and says so.
     - Zero tasks extracted → still write the file: `counts: {extracted: 0, …}` + one
       line *"No actionable items — valid outcome."*
  2. Mirror back: for every created/commented issue, set
     `action_items[].tracker_ref: "<ISSUE-KEY>"` in the source transcript's frontmatter
     (the two-way link: task → call → minute).
  3. `[SCRIPT: validate-vault.js]` after the batch (checks counts arithmetic + backlink
     resolution both ways).
  4. `[SCRIPT: state.js set steps.a3 completed]`

ARTIFACT (show, don't tell — same weight as the A0 tree and the A2 roster board):
per-call `.tasks.md` + created/commented tracker issues. Render a task board, one
row per task, the file names CLICKABLE; validator/counts arithmetic is plumbing —
never narrate it to the user beyond one line ("validate: 0 errors"). Shape:

  **<N> tasks → [`tasks/<call-basename>.tasks.md`](tasks/…)** (per call)
  | | task (one line) | owner | prio | verdict |
  | 1 | XP-экономика: зафиксировать стрики 7/30/90 | Yurkova | P2 | CREATE (file-only) |
  | … | … | … | … | CREATE / COMMENT→<issue URL> / FLAG ⚠ |

  Tracker connected → verdict column carries live issue URLs; file-only → say in
  ONE line why (no tracker in this session) and where it upgrades (B5).

SAY: *"<N> tasks extracted — each row lives in the linked file; edit words or files,
either wins. <Dedup line: M matched existing issues / no live backlog to dedup
against — first run creates only.>"*

TELEMETRY: `[SCRIPT: telemetry.js event step_completed A3 --tracker=<linear|other|none>]`

ERROR: extraction produced zero tasks → say so honestly (*"this call had no actionable
items — that's a valid outcome"*), still write the empty-with-note tasks.md.

SKIP (whole rung): SAY (P3): *"Skipped — task extraction is off for now. Concretely:
digests keep listing next steps, but nothing reaches a tracker and no training data
accumulates. Re-run any time: `/backbrief tasks`."* →
`[SCRIPT: state.js set steps.a3 skipped]` +
`[SCRIPT: state.js set steps.a3_skip_reason <slug|short-reason>]` +
`[SCRIPT: telemetry.js event step_skipped A3]` (roadmap auto-refreshes — §13).
The wrap-up (A4) then runs digest-only.

HANDOFF: after the **first complete pass over the A1 batch**, auto-offer A4:
*"Want to see what all this bought you? 30 seconds — before/after on your own call."*
→ continue below. (Decline → warm close; the router re-offers A4 later.)

---

## Rung A4 — wrap-up: before/after demo, mini-ROI, fork

> Also triggered directly by "show the before/after" / "/backbrief wrap-up" / the router
> when A0–A3 are done. Requires: ≥1 filed call; profiles strongly recommended (without
> them, run the demo digest-only and say the contrast is limited).

### Step A4.1 — before/after demo                               [no question]

DO:
  1. `[SCRIPT: state.js set steps.a4 in_progress]` ·
     TELEMETRY: `[SCRIPT: telemetry.js event step_started A4]`
  2. Pick the richest filed call (most participants × most extracted tasks).
  3. [LLM] Regenerate its digest **with** profiles + `docs/company.md` +
     `docs/skills/summarizer.md` + the other filed calls as context:
     **update the file in place**, set `digest_version: v1`, remove the v0 caveat block
     (per `plugin/templates/frontmatter/digest.md` — git history keeps v0).
     Add `references_prior_calls` (max 5).
  4. Render the contrast as 3–5 concrete deltas — never two walls of text:

```
BEFORE (no team context)                    AFTER (profiles + call history)
"Speaker 2 will handle the launch"      →   "Maria (growth) owns the launch page —
                                             third call in a row; blocked on copy since <date>"
"discussed the pricing doc"             →   "pricing follows the <date> decision (see that call, 22:10);
                                             the open question from then is now resolved"
owner hints: 2 of 6 resolved            →   owners: 6 of 6, matched to tracker handles
```

SAY: *"Same call, same model — the difference is **your** context: profiles + history.
This is what compounds with every call you feed it."*

### Step A4.2 — mini-ROI                                        [deterministic, no LLM estimates]

DO: read the counters via `[SCRIPT: state.js get counters]` and compute (arithmetic
only): N = calls_processed, T = tasks_extracted, A = tasks_accepted (+ edited),
D = duplicates_caught, F = vault file count.
SAY: *"This session: <N> calls processed · <T> tasks extracted, <A> accepted
(<D> caught as duplicates before polluting the backlog) · ~<T×4 + N×10> min of PM
transfer-and-summarize work replaced. Your vault: <F> files, owned by you, readable by
any agent."* (Echo pattern P5.)
(**persona = solo** — reword the middle: *"~<T×4 + N×10> min of after-call
write-up-and-follow-up work replaced"* — a solo user has no PM to hand off to.)

### Step A4.3 — ASK: the fork                                   [the rung's one question]

ASK: *"Want this to happen **automatically for every call** — no pasting, ~1 min after
each recording ends? Three ways:
1. **Self-host it now** — I walk you through the full pipeline (`/backbrief deploy`,
~60 min, your infra, your keys).
2. **Hosted waitlist** — the **Backbrief authors** (the plugin's developers — not me,
not your company) would run the infra for you, you keep the vault. Pick this and I'll
send them your email — email + interest, nothing else — so they ping you when it's ready.
3. **Hands-on help** — the Backbrief authors set it up together with you, in exchange
for weekly feedback; same email consent.
Or stop here — manual mode already works: paste a transcript any time. (Enter = 1)"*
  → default: 1. (Wording rule: name WHO receives the email — an unattributed "we"
  in an agent-rendered dialog is ambiguous three ways; user-tested.)

DO per answer:
  - **1** → `[SCRIPT: state.js set fork deploy]` → HANDOFF to the `deploy` procedure.
  - **2** → ask for the email (optional, never auto-submit) →
    `[SCRIPT: telemetry.js waitlist --interest=hosted --email=<typed> --source-step=A4]`
    + `[SCRIPT: state.js waitlist-observe hosted --step A4 --emailed]` →
    `[SCRIPT: state.js set fork hosted_waitlist]`.
    Confirm: *"Done — your email went to the Backbrief authors' waitlist (their API
    stores email + interest, nothing else). Manual mode keeps working meanwhile."*
  - **3** → email →
    `[SCRIPT: telemetry.js waitlist --interest=hands_on --email=<typed> --source-step=A4]`
    + point at the contact channel (GitHub issue template / office-hours link in the
    README) → `[SCRIPT: state.js set fork hands_on]`.
  - **stop** → warm close → `[SCRIPT: state.js set fork declined]`. The router remembers
    and won't nag — it re-offers only after the user processes 3+ more calls manually.

DO: `[SCRIPT: state.js set steps.a4 completed]`
TELEMETRY: `[SCRIPT: telemetry.js event step_completed A4 --fork=<deploy|hosted_waitlist|hands_on|declined>]`

ARTIFACT: the regenerated v1 digest (in place) + the ROI line + a recorded fork choice.

HANDOFF: per the fork — `deploy` procedure, or: *"Manual mode is yours: paste a
transcript any time, `/backbrief status` shows the vault digest."*
