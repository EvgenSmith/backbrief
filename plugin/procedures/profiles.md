<!-- SPDX-License-Identifier: MIT -->
# Backbrief procedure — `profiles` (A2 team profiles)

> **Before executing:** read `_conventions.md` (global rules) and `_capabilities.md`
> (bind capabilities — this procedure uses `slack.users()`, `tracker.*`, `fs.*`,
> `run.script`, `telemetry.*`; every one has a no-MCP fallback).
> Single source of truth for step A2.
>
> **Triggers:** `/backbrief profiles` (`/backbrief:profiles`), "set up the team",
> router after A1.
> **Time budget:** ≤ 5 min. **Questions:** 1 primary ask (source choice) + ≤2
> confirmations; the 5-question survey runs only on the explicit fallback branch.

---

## PREFLIGHT                                                    [gate: A0 vault exists]

DO:
  1. `[SCRIPT: state.js get]`:
     - No vault / `steps.a0` missing → route to the `start` procedure (A0) first.
     - `steps.a1` skipped/missing → fine: A2 still runs; the enrichment step (A2.3)
       degrades and says so.
     - Profiles already exist (`team/*.md` non-empty) → SAY so, offer:
       *refresh all / add a member / skip to tasks*. Refresh = re-run below, merging
       into existing files (never discard confirmed data; `status: confirmed` fields
       are only changed on explicit user instruction).
  2. `[SCRIPT: state.js get stack]` — when `stack.chat` ≠ `slack`, A2.1 opens with
     **recognition, not the Slack default** (mirrors the B2/B3 preflights in
     `deploy.md`): *"At setup you said the team lives in <tool> — that connector is
     on the waitlist (demand noted). For team info I can work from docs you upload,
     Linear, or five quick questions — which one?"* → offer sources 2–4 of the A2.1
     menu with no Slack default; "connect Slack anyway" stays available on request.
  3. `[SCRIPT: state.js set steps.a2 in_progress]`
  4. TELEMETRY: `[SCRIPT: telemetry.js event step_started A2]`

---

## Step A2.1 — intent-first source ask                          [pattern P1 · rung is OPTIONAL (§13)]

SAY: *"I'll build a profile file per team member — role, responsibility zones, name
aliases — so every future digest and task knows who's who. Where should I pull team
info from?"*
(**persona = solo** — reword: *"I'll build a profile file per person you meet with —
clients, partners, collaborators — so digests and tasks know who's who."* Sources below
work the same; the survey branch asks about counterparties instead of team members.)

ASK (the rung's one primary question):
*"1. **Slack** — best signal: names, titles, statuses (I'll help connect it if needed) ·
2. **Linear** — team rosters and assignments ·
3. **Docs you upload** — job descriptions, org chart, vacancies ·
4. **Five quick questions** — no tools needed. (Enter = 1)"*
  → default: Slack.
  (`stack.chat` ≠ `slack` → use the PREFLIGHT recognition opener instead — the tool
  they named is on the waitlist; no Slack default, sources 2–4 lead.)

**Intent first, discovery second:** do NOT check for any connection before this answer.

## Step A2.2 — source branches

- **Branch 1 — Slack.** Only now resolve capability `slack.users()`:
  - Available (MCP or `$SLACK_BOT_TOKEN` + CLI fallback) → pull users + titles + custom
    statuses. CONFIRM: *"Pull from the whole workspace or specific channels?
    (Enter = whole workspace)"*
  - **Capture identity preventively** while pulling — for each member take the Slack
    `id` (`U…`) → profile `slack_user_id` and `profile.email` → profile `email`
    (the shipped app manifest carries the `users:read.email` scope for exactly this;
    if the scope is missing, skip emails silently — **never ask for emails here**).
    Emails make Zoom attendance resolution and Slack @mentions exact later (B1/B3).
  - Not available → SAY: *"No Slack connection yet — takes ~2 minutes: <one-paragraph
    connect guide for THIS agent: MCP connector / bot token per docs/slack-app-setup.md>.
    Say 'done' when connected, or pick another source."* Waiting is fine; falling back
    to another branch is fine.
- **Branch 2 — Linear.** Same pattern via `tracker.*`: available → pull team
  memberships + active assignments, **and each user's email when the users query returns
  it** → profile `email` (same preventive capture, never an extra question). SAY the
  reuse incentive: *"connecting Linear now also powers task dedup in the next step."*
  (Another tracker named here — Jira, Asana, … — is the "any other tool" case below:
  waitlist + next-best branch; no adapter or guide ships in v0.1.)
- **Branch 3 — Docs.** Ask for file paths or pasted text. [LLM] extract people, roles,
  zones from job descriptions / org chart / vacancy pages. **Do not add an email
  question** — if the pipeline phase is entered later, B1 asks once for the email domain.
- **Branch 4 — survey.** Exactly 5 questions, one message each, with progress marks:
  (1/5) names of team members · (2/5) role/title per person, one line each ·
  (3/5) who owns what area · (4/5) name variants/nicknames used on calls ·
  (5/5) who runs most meetings. Enter skips any single question. **No email question**
  (same B1 deferral as Branch 3).
- **Any other tool named** (HR system, Notion, Teams, …): intent-first treatment
  (_conventions.md §8, §13) — `[SCRIPT: telemetry.js event connector_demand --tool=<slug>]`
  + `[SCRIPT: state.js waitlist-observe <slug> --step A2]`, offer *(a)* self-connect via
  generic MCP docs, *(b)* the waitlist (email, optional:
  `[SCRIPT: telemetry.js waitlist --interest=connector --tool=<slug> --email=<typed> --source-step=A2]`),
  or *(c)* "set it up for me" → hands-on waitlist (§13 option 4),
  then continue with the next-best branch. Never a dead end.

ERROR: a source call fails mid-pull → keep the partial data, offer exactly:
retry / another source / survey top-up. **Never discard what was gathered.**

## Step A2.3 — transcript auto-enrichment                       [always runs]

DO: [LLM] read all filed transcripts (`**/transcripts/*.md`):
  - who speaks about what → topic frequency per speaker → responsibility-zone evidence;
  - who assigns / receives action items;
  - name variants **as actually spoken** — native-script spellings, declensions,
    diminutives, display names, handles (this is the alias name-map — see
    `aliases` in `plugin/templates/frontmatter/team-profile.md`).
  Merge with A2.2 data; **source data wins on conflicts**, transcript evidence fills
  gaps and adds zone evidence lines (quote + call + timestamp).
  - No transcripts filed (A1 skipped) → SAY so in one line, proceed on source data only.
  - **Company profile enrichment (same pass, free):** while mining the transcripts for
    people-evidence, also harvest **product names, partners/customers, and recurring
    vocabulary** → update `docs/company.md` (Products & terminology / Market & customers
    / Current priorities sections; keep the ≤60-line cap, drop the weakest line when full)
    and propose matching `glossary` entries for tenant.yaml (canonical spelling + ASR
    variants heard). Remove `(inferred — correct me)` / `(from site — correct me)`
    suffixes from lines now backed by transcript evidence. When `docs/company.md` has a
    `website:` and the session has web access, a quick site re-check is optional here —
    same rules as A0.9: no question, one degradation line when offline, site-sourced
    lines keep the `(from site — correct me)` suffix.
  - **Web lookup (LinkedIn titles) is opt-in only** — offer once: *"Want me to also check
    public LinkedIn profiles for titles? I'll only do it if you say yes."* Run only on an
    explicit yes (capability `web.fetch`), never silently.

## Step A2.4 — review table                                     [≤1 confirm]

SAY: *"Here's the team as I understand it:"* + compact table
(Name · Role · Zones · Aliases · Source) **+ the `docs/company.md` delta from A2.3 in
the same message** (one combined confirm — the company doc never gets its own question).
ASK: *"Corrections? Tell me in words — or Enter to write the files."*
DO: [LLM] apply corrections conversationally, re-show only the changed rows.

## Step A2.5 — write                                            [ARTIFACT gate]

DO:
  1. Write `team/<Lastname>.md` per member from
     `plugin/templates/frontmatter/team-profile.md`:
     - frontmatter: `type: member`, `schema_version: 1`, `lastname` (canonical Latin —
       MUST equal the basename; collisions → `<Lastname>-<Firstinitial>.md` + distinct
       lastname values), `first_names`, `aliases` (every observed form incl. cross-script
       variants + handles), `role`, `team` (tenant tag), `zones` (kebab-case EN),
       `typical_partners`, `languages`, `email` / `slack_user_id` / `tracker_handle`
       **when the source gave them** (email stays optional, never asked for —
       preventive capture only), `status: draft`, `sources` (which branches fed it),
       `last_updated`.
     - body: Role / Responsibility zones **with evidence quotes** (zones without
       evidence marked "(inferred — pending review)") / Typical topics / Typical
       partners / Notes.
     - Flat folder, never nested; no compensation/performance/HR data, ever.
  2. `[SCRIPT: validate-vault.js]` — alias collisions across profiles are an error;
     fix (usually: qualify the alias or move it to the right person) and re-run.
  3. `[SCRIPT: state.js set steps.a2 completed]` and
     `[SCRIPT: state.js set counters.profiles <N>]`.

ARTIFACT: `team/<Lastname>.md` profiles — the "it knows us" moment.
SAY: *"<N> profiles written to `team/`. From now on, digests and tasks resolve
'Masha' / 'М. Иванова' / '@maria' to the same person and her zone."*

TELEMETRY: `[SCRIPT: telemetry.js event step_completed A2 --source=<slack|tracker|docs|survey> --count=<members>]`
(enums/ints only — never names.)

SKIP (whole rung): SAY (P3): *"Skipping profiles — tasks will still extract, but owners
stay raw name-guesses and the before/after demo loses its punch. Re-enable any time:
`/backbrief profiles`."* → `[SCRIPT: state.js set steps.a2 skipped]` +
`[SCRIPT: state.js set steps.a2_skip_reason <slug|short-reason>]` +
`[SCRIPT: telemetry.js event step_skipped A2]` (roadmap auto-refreshes — §13).

HANDOFF: *"Next: `/backbrief tasks` — I extract tasks from your calls and (if you want)
put them in your tracker, checked against your live backlog. This is the core."*
