<!-- SPDX-License-Identifier: MIT -->
# Backbrief procedure — `start` (A0 survey + vault skeleton · A1 transcript intake)

> **Before executing:** read `_conventions.md` (global rules — non-negotiable) and
> `_capabilities.md` (bind every capability to the best tool in THIS session).
> This file is the single source of truth for steps A0–A1.
> The full question → answers → config-effect map lives in `_question-graph.md`
> (data file — update it in the same change whenever this flow changes).
>
> **Triggers:** `/backbrief start` (namespaced: `/backbrief:start`), "set up backbrief",
> "turn my calls into tasks" — and any other skill invoked with no vault present
> (the router redirects here).
> **Time budget:** A0 ≤ 3 min, A1 ≤ 7 min. **Question budget:** ≤ 5 to the vault skeleton
> (the first artifact). Corrections and CONFIRMs do not spend questions.

---

## PREFLIGHT                                                    [gate: none]

DO:
  0. **Surface / Node gate — do this FIRST, before running any script.** Backbrief
     setup runs local scripts (Node ≥ 18) and writes a folder of markdown files;
     bind `fs.write` + `run.script` per `_capabilities.md`. If THIS session cannot
     do both — a chat-only surface with no terminal, no Node, or no filesystem
     (e.g. plain Claude.ai chat) — do **not** lead anyone into the A0 scripts and
     do **not** fake a vault. Exit honestly toward the hosted waitlist:
     SAY: *"Backbrief's setup runs a few local scripts (Node ≥ 18) and writes a
     folder of files you own, so it needs a terminal — Claude Code, or a checkout
     of the kit. This chat can't run those. Want the hosted version, where we run
     the pipeline for you? Sign up in your browser:
     https://backbrief-telemetry.backbrief.workers.dev/waitlist — that form works from anywhere."* →
     the browser form is the primary path on a no-script surface (this gate's
     whole premise is that scripts can't run here — never promise to record an
     email you have no way to record). Only if the user types an email anyway
     AND telemetry can actually run on this surface:
     `[SCRIPT: telemetry.js waitlist --interest=hosted --source-step=A0 --email=<typed>]`;
     otherwise repeat the form URL. Then STOP — never pretend a script ran.
     (Script-capable surfaces continue to step 1.)
  1. `[SCRIPT: state.js get]` — output `null` = fresh install; proceed to A0.
  2. If state exists and `steps.a0` = `completed`:
     SAY: *"You already have a vault at `<path>` (set up <date>). Continue where you left
     off (<next incomplete rung>), or re-run setup? Re-running is safe — it only adds
     missing pieces."* → route per the answer (re-run continues below; init-vault.js is
     create-if-missing, nothing gets clobbered).
  3. If state exists and any `steps.<rung>` is `in_progress` (session died
     mid-rung): re-enter that rung from its start and say so in one line — safe,
     every script is idempotent (create-if-missing, content-hash dedup,
     diff-before-write). If a `steps.<rung>_substep` key exists, use it as a
     finer re-entry point — but nothing guarantees one was written, so never
     rely on it.
  4. Detect the conversation language from the user's messages; lock it for the session
     (_conventions.md §1). All SAY/ASK lines below are canonical EN — translate naturally.

---

## Rung A0 — adaptive mini-survey → vault skeleton

> Design intent: the user should feel *recognized*, not interviewed.
> Everything inferable is stated as a correctable assumption. Worst case 5 questions;
> typical case 4 (Q4 is droppable).

### Step A0.1 — frame                                           [no question]

SAY: *"I'll set up a memory vault for your team's calls — plain markdown files you own,
in a folder I create now. Five quick questions max, then you'll see the structure.
You can stop after any step and keep what you got."*

(Telemetry note: no tenant.yaml exists yet, so no event can fire here — the A0 events
are fired retroactively at Step A0.8, after consent is recorded. This is by design:
consent precedes the first ping, always.)

### Step A0.2 — inferences                                      [no question]

DO: [LLM] Infer and STATE (never ask):
  - **Company name** ← git remote org / git config email domain / cwd folder name.
    SAY: *"I'll set this up for **<Company>** — correct me if that's wrong."*
    (A correction is free; it doesn't spend a question.)
    **No-git/no-cwd fallback** (a script-capable surface that simply lacks a git remote
    or a meaningful cwd — a fresh terminal or a bare checkout; pure chat already exited at
    the PREFLIGHT surface gate): infer the company from the user's own words so far (they
    usually name it); if genuinely nothing to infer from, fold it into Q1's sentence —
    *"Where should the vault live, and what's the company called? (Enter = `./my-vault`)"*
    — it must never become a separate 6th question.
  - **Language** ← already detected at PREFLIGHT. Record both the conversation language
    and any additional languages the user mentions the team speaks.
  - **Timezone** (never a separate question) ← infer from the user's stated
    location, the conversation language/locale, or the session's own timezone. STATE it as
    a correctable assumption and pass it to init-vault (`--timezone`, A0.8):
    SAY (fold into the company line when possible): *"Call filenames will timestamp in
    **<timezone>** — tell me if your team works in another zone."* Only when nothing at all
    is inferable, use UTC — but still say so once; **never stamp UTC silently**.
  - **Owner** (never a separate question) ← infer who owns this vault: the
    person setting it up (git `user.name` / `user.email`, or their own self-reference).
    STATE it as a correctable assumption — *"I'll set **<you>** as the vault owner — the one
    who gets pipeline alerts and 1:1 routing. Someone else?"* — and record it at A0.8
    (`state.js set owner <lastname-or-email-local>`). B1 resolves it to the roster entry and
    stamps `is_owner: true` (fixes the S4 hard-fail on fresh vaults). When genuinely
    unknowable at A0, skip silently — B1 confirms the owner once the roster exists.

### Step A0.3 — ASK (Q1): vault location

ASK: *"Where should the vault live? (Enter = `./<company>-vault` in the current folder —
a new git-ready directory)"*
  → default: `./<company>-vault`. Accept any path; if the path is inside an existing repo
  with unrelated history, warn in one sentence — do not block.

### Step A0.4 — ASK (Q2): persona (whose calls; headcount folds in)

ASK: *"Whose calls will this vault hold?
1. **Mostly mine** — I work solo (founder, consultant, one-person business) ·
2. **My team's** — I lead one team inside a larger company ·
3. **The whole company's** — I lead the company or its leadership calls.
Add a rough headcount if you like — e.g. '3 — about 40 people'. (Enter = 3)"*
  → `persona: solo | team_lead | company_lead` (default `company_lead`).
  [LLM] parse any volunteered headcount into `team_size_bucket`: `lt10` | `10-50` |
  `gt50` (default `lt10` when none volunteered) — **no separate size question**.
  The bucket selects the Q3 fork; the persona shapes Q4 and the skeleton (A0.8).

### Step A0.5 — ASK (Q3): stack fork

- **If `team_size_bucket = lt10` — golden path:**
  ASK: *"Teams your size usually haven't locked in tooling, so I offer our proven default
  stack: **Zoom** (call recordings) + **Slack** (team channel) + **Linear** (tasks) +
  **GitHub** (vault sync). Take the golden path, or tell me what you already use instead?
  (Enter = golden path)"*
  → default: golden path → stack map `{calls: zoom, chat: slack, tracker: linear, git: github}`,
  `stack_path: golden`. An "I use X instead" answer → [LLM] parse the free text into the
  same stack map (unmentioned slots keep the golden default); `stack_path: custom`.
- **If ≥10 — established tooling:**
  ASK: *"What does the team already use for (a) call recording, (b) team chat,
  (c) task tracking? One line is fine — e.g. 'Meet, Slack, Jira'."*
  → [LLM] parse the free text into the same stack map; `stack_path: custom`.
  **Do not challenge unknown/unsupported tools here** — they get the intent-first
  treatment at the rung where they matter (A3 tracker, B2/B3/B5 connectors). This stays
  one question.

DO: record every named **unsupported** tool into `.backbrief/waitlist.yaml` as
`observed` after the vault exists (A0.8, via `state.js waitlist-observe`) — capture is
free; the waitlist *offer* comes only when the tool would actually be used
(_conventions.md §8, §13). The stack answers are **consumed later**: B1 (generate-tenant)
sets flags from them, and B2/B3/B4 open with recognition instead of re-pitching a tool
the user already rejected.

### Step A0.6 — ASK (Q4): team names                            [persona-shaped · droppable]

- **persona = solo** → **DROP this question entirely** (no team folders; everything
  routes through `general/`). Solo worst case is 4 questions.
- **persona = team_lead** →
  ASK: *"What's the team called — one word, e.g. `product`? Any sub-areas worth their own
  folders (design, qa), or Enter for just `<team>`? (Teams are how calls get routed:
  each call files into its team's folder, and tasks map to that team in your tracker.)"*
  → `--teams <team>[,subareas]`.
- **persona = company_lead** →
  ASK: *"Name the teams/functions calls usually belong to (e.g. product, marketing), or
  Enter to start with just `general` — I'll suggest more once I've read your transcripts.
  (Teams are how calls get routed: each call files into its team's folder, and tasks map
  to that team in your tracker.)"*
  → default: `general` only (no team folders beyond the mixed route).
- **Drop this question entirely** (any persona) if the user already listed teams in Q3's
  free text — that keeps the worst case at 5 questions with telemetry included.

### Step A0.7 — ASK (Q5): telemetry opt-in

ASK: *"Last one: may I send anonymous usage pings — which setup step you reached and
event counters, **never** call content, names, or task text? Helps us fix the rough
edges. (Enter = no)"*
  → default: **no**. Consent can never default to yes (_conventions.md §7).

### Step A0.8 — build the skeleton                              [ARTIFACT gate]

DO:
  1. `[SCRIPT: init-vault.js <path> --company "<Company>" --persona <solo|team_lead|company_lead>
     --teams <tag,tag> --languages <xx,yy> --timezone <tz> --telemetry <yes|no>
     [--internal-domains <d,d>]]`
     — creates the tree (create-if-missing; the persona shapes only the team-folder
     layout — solo gets no team folders, everything routes through `general/`) + the
     minimal tenant.yaml (tenant name, `tenant.persona`, languages, `tenant.timezone`
     from the A0.2 inference, teams, telemetry flag; `install_id` generated only on
     consent). Pass `--timezone <tz>` from the A0.2 timezone inference so filenames stop
     silently stamping UTC. Omit `--teams` when Q4 was dropped or defaulted to
     general-only.
  2. `[SCRIPT: state.js set steps.a0 in_progress]` — the **first possible state
     write** (state lives inside the vault dir init-vault just created). Stamp it
     immediately: a session dying between here and the `completed` write below
     leaves a resumable marker for PREFLIGHT step 3.
  3. `[SCRIPT: validate-vault.js --vault <path>]` — must exit 0 on a fresh skeleton.
  4. State writes (all via `[SCRIPT: state.js set …]`, run inside the vault or with
     `--vault <path>`):
     - `steps.a0 completed`
     - `persona <solo|team_lead|company_lead>`
     - `owner <lastname-or-email-local>` — the A0.2 owner inference; B1
       (generate-tenant.js) matches it to the roster and sets `is_owner: true`. Skip this
       write only when the owner was genuinely unknowable at A0.
     - `stack '{"calls":"…","chat":"…","tracker":"…","git":"…"}'`
     - `stack_path <golden|custom>`
     - `team_size_bucket <lt10|10-50|gt50>`
  5. For every Q3-observed **unsupported** tool, count the demand AND mirror it locally
     (the roadmap-pricing signal must not be under-counted):
     - `[SCRIPT: telemetry.js event connector_demand --tool=<tool-slug>]` (fires only on
       telemetry consent; slug only, no prose)
     - `[SCRIPT: state.js waitlist-observe <tool-slug> --step A0]` (local mirror — the
       script owns `.backbrief/waitlist.yaml`)
  6. TELEMETRY (fired now, retroactively — first possible send after consent):
     - `[SCRIPT: telemetry.js event install]`
     - `[SCRIPT: telemetry.js event step_started A0]`
     - `[SCRIPT: telemetry.js event step_completed A0 --team-size-bucket=<v> --stack-path=<golden|custom> --persona=<v>]`
     (All three silently no-op when consent was "no" — never mention pings again.)

ARTIFACT (show, don't tell): the vault skeleton — render the tree.
SAY: *"Done — your vault is at `<path>`. Open `AGENTS.md` to see how the memory is
organized: every call becomes a markdown file with structured frontmatter any AI agent
can read. Nothing leaves this folder."* (Pattern P5: *"Everything I make is plain
markdown/YAML in your folder. Delete the plugin tomorrow — the vault, digests, and tasks
remain yours."*)

(No privacy briefing here — privacy routing is deliberately not part of v0.1; every
call files into team folders and posts to the digest channel. If the user asks for
private 1:1/board/legal handling: say so honestly, capture demand —
`[SCRIPT: state.js waitlist-observe privacy --step A0]` + on a typed email
`[SCRIPT: telemetry.js waitlist --interest=privacy --email=<typed> --source-step=A0]` —
and point at `docs/privacy-and-consent.md`.)

### Step A0.9 — company profile draft                           [no question]

DO: [LLM] draft `docs/company.md` from the A0 facts + the same inference sources as
A0.2 (git remote / user's words / transcripts pasted so far), using
`plugin/templates/frontmatter/company-profile.md`:
  - frontmatter `type: company`, `schema_version: 1`, `name` (MUST equal tenant name),
    `website`, `what_we_do`, `products`, `stage`, `team_size`, `market`, `sources`,
    `last_updated` (closed key set — validate-vault.js rejects anything else); body
    sections in template order (*What we do / Products & terminology / Market &
    customers / Current priorities / Notes for the summarizer*), empty sections render
    `None.`.
  - **Website enrichment (no question, never blocks):** infer the company site from
    the corp email domain (`gene@acme.dev` → `https://acme.dev`) or the git remote org,
    or use a URL the user already volunteered → frontmatter `website:`. If THIS session
    has web access (capability `web.fetch` — Claude Code WebFetch, or `curl`), fetch the
    homepage (+ `/about` or `/product` only when trivially reachable, e.g. linked from
    the homepage) and extract what-we-do / products / customers-for-whom into the
    matching fields — **each site-sourced line suffixed `(from site — correct me)`**,
    `sources` gains `web`. No web access (offline Codex etc.) → one line: *"No web
    access in this session — skipping the site lookup; the profile stays
    inference-only."* and move on. Site inference failed → `website: null`, no mention.
  - **Every inferred line is suffixed `(inferred — correct me)`** — corrections are
    free, this step asks nothing.
  - Hard cap ≤60 lines — the file is prompt budget (it is injected into every digest
    and task-extraction context; A2 enriches it from real transcripts).
SAY (one line): *"I also drafted `docs/company.md` — a 1-page company profile that makes
digests and tasks smarter. Skim it later and correct anything marked as inferred."*

ERROR:
  - Path not writable → offer an alternate path (does not spend a question).
  - Script failure → one-line cause + exactly: retry / pick another path / manual
    (point at `plugin/templates/vault-skeleton/` to copy by hand). (_conventions.md §10)

SKIP:
  - Q4/Q5 are skippable with Enter (defaults). **A0 itself is not skippable** — it is the
    entry rung (`[REQUIRED]`, _conventions.md §13). A user who only wants task extraction
    on a pasted transcript gets **zero-questions mode**: SAY the vault will be created
    with all defaults in one shot, run A0.8 with defaults (`--telemetry no`,
    `--persona company_lead`, golden stack), then jump straight to A1.2 with their paste.

---

## Rung A1 — transcript intake, filing, digest v0               [REQUIRED for value]

### Step A1.1 — the one ask

DO: `[SCRIPT: state.js set steps.a1 in_progress]`
TELEMETRY: `[SCRIPT: telemetry.js event step_started A1]`
SAY: *"Now feed me your last 3–5 team calls and I'll show you what your memory looks
like. I take `.vtt`, `.txt`, `.md`, Zoom exports, Fireflies exports — file paths, a
folder, or just paste a transcript."*

  - Accept 1 file minimum (never block on "need 3"); gently note that 3+ makes the
    profiles rung (A2) and the before/after demo (A4) much better.
  - Pasted text → write it to a temp file (or pipe to stdin) so the script can run on it.
  - User has nothing at hand → offer the paths: *"Zoom: web portal → Recordings →
    download the Audio Transcript (.vtt). Fireflies: notebook → download transcript.
    Or paste text straight in."* Still nothing →
SKIP: `[SCRIPT: state.js set steps.a1 skipped]` +
  `[SCRIPT: state.js set steps.a1_skip_reason <no-transcripts|other-tool-slug>]` +
  `[SCRIPT: telemetry.js event step_skipped A1]` (the state write auto-refreshes
  `.backbrief/roadmap.md` — §13). **When the reason names a transcript/notes tool we
  don't support** (e.g. the user says "everything's in Otter/Grain/Fathom"), also count
  it: `[SCRIPT: telemetry.js event connector_demand --tool=<slug>]` +
  `[SCRIPT: state.js waitlist-observe <slug> --step A1]`. SAY (P3): *"Skipped — no transcripts filed yet.
  Concretely: profiles (A2) can still run from your tools, but digests and the demo need
  at least one call. Come back with a file any time — `/backbrief start`."*
  → HANDOFF.

### Step A1.2 — normalize                                       [per input file]

DO:
  1. `[SCRIPT: normalize-transcript.js <file>]` → JSON
     `{format, source_guess, detected_language, title, date, duration_min, timing,
     segments[{speaker, ts_mmss, text}]}`.
  2. Exit 1 (unknown format) → **[LLM] fallback, announced** (_conventions.md §6):
     SAY: *"This one isn't a format I recognize — I'll parse it by reading; per-line
     timestamps may be lost."* Extract speaker turns and whatever timing is recoverable.
  3. Missing metadata (no title/date in a pasted blob) → [LLM] infer from content.
     CONFIRM only if the date is genuinely undecidable: *"When was this call?
     (Enter = today)"*

### Step A1.3 — classify                                        [deterministic first]

DO: [LLM] per call:
  1. **team** ← Q4 team list (tenant.yaml `vault.teams[]` tags + descriptions) +
     content match; default = the mixed tag (`general`). Deterministic cues first
     (title keywords, participant hints), LLM content classification second.
  2. **call_type / platform / language** ← from the normalized metadata + content
     (controlled vocabulary values only).
  (No sensitivity classification — privacy routing is not part of v0.1; every call
  files into its team folder. A user asking for private handling of a 1:1/board/legal
  call → honest one-liner + waitlist capture, as in A0.8.)

### Step A1.4 — file + digest                                   [per call]

DO:
  1. **Dedup first** (idempotency): compute the sha256 of the raw transcript text, take
     the first 16 hex chars as `<hash>`. `[SCRIPT: state.js get filed.<hash>]` → a path
     means this call is already filed: skip with a one-line note, continue the batch.
  2. **Load the vault context first** (when the files exist): `docs/company.md`
     (company facts — products, vocabulary, customers) and `docs/skills/summarizer.md`
     (house style + per-team emphases). Both are written to be injected whole; never
     write a digest without them once they exist.
  3. [LLM] Write the **context-digest v0** body per `plugin/templates/frontmatter/digest.md`
     — fixed section order: *Summary (themed, timestamped) · Decisions · Agreements ·
     Next steps (📋 Post-call / ✅ Done on call / 👀 Monitoring) · Open questions ·
     Key insights · Transcript*. Rules:
     - **Context, not a summary**: what's happening, what was agreed, what happens next
       and on whom.
     - Every section anchors to **(MM:SS)** timestamps from the normalized segments;
       with a recording share-URL, render anchors as clickable deep links. No segment
       timing (`timing: false`) → say so once at the top of the digest, never fake anchors.
     - Narrative in the **call's language**; all frontmatter keys/enum values EN.
     - Keep the v0 caveat block (top of the template) — it is removed at the A4 regen.
     - Empty sections render as `None.`, never disappear.
  4. Write the file (capability `fs.write`):
     `<team-folder>/transcripts/YYYY-MM-DD HHMM <topic-slug> w <Lastname1,Lastname2>.md`
     - Route = the classified team's folder (`<team>/transcripts`; unresolved/mixed →
       `general/transcripts`).
     - Naming spec (shipped into every vault as `docs/conventions.md`; template:
       `plugin/templates/vault-skeleton/docs/conventions.md`): date-first,
       tenant-local time no colon, slug 2–6 lowercase
       ASCII-English words (translate/transliterate non-English topics; the original
       lives in frontmatter `topic:`), max 4 lastnames, 5+ participants → omit the
       `w` part, basename ≤ 100 chars. Unresolvable lastname → ask, never guess.
     - Frontmatter per `plugin/templates/frontmatter/transcript.md`: `type: transcript`,
       `schema_version: 1`, `team`, `topic`, `date`, `time`, `duration_min`,
       `participants` (roster lastnames; unknown speakers → `external_participants`,
       never emails), `language`, `source` (from `source_guess`),
       `digest_version: v0`, provenance (`filed_by: plugin`, `filer_model`,
       `pipeline_version` = kit VERSION, `source_id` when known), plus the
       `action_items:` mirror extracted from Next steps (with `ts`, `status`,
       `priority`; `tracker_ref: null` until A3).
  5. Raw sibling: when `features.raw_retention` ≥ `vtt`, write the normalized/raw
     transcript as an identically-named `.vtt` next to the `.md`.
  6. `[SCRIPT: state.js set filed.<hash> "<vault-relative path>"]`.
  7. After the whole batch: `[SCRIPT: validate-vault.js]` — findings → fix the files,
     re-run until 0 errors. Increment the counter:
     `[SCRIPT: state.js set counters.calls_processed <new total>]`.

### Step A1.5 — present                                         [ARTIFACT gate]

SAY (per batch, compact): *"Filed <N> calls: `<paths>`. Here's the digest of the most
recent one:"* → render one digest inline. Then: *"Anything misfiled or misread — tell me
in words, I'll fix the file."*
DO: [LLM] apply conversational corrections directly to the files; re-run
`[SCRIPT: validate-vault.js]` after edits.

ARTIFACT: filed transcripts + per-call context-digest v0 with timestamps.

DO: `[SCRIPT: state.js set steps.a1 completed]`
TELEMETRY:
  - `[SCRIPT: telemetry.js event step_completed A1]`
  - `[SCRIPT: telemetry.js event calls_processed --count=<N>]`

ERROR: a single-file parse failure never aborts the batch — file the rest, then report
the failure with exactly: retry / skip that file / paste its text instead.

HANDOFF: *"Next: I build profiles of your team so digests and tasks know who owns what —
`/backbrief profiles`, ~3 minutes. Or stop here: the vault is already yours."*
