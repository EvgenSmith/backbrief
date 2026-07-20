<!-- SPDX-License-Identifier: MIT -->
# Backbrief pipeline — stack-agnostic functional spec

> **Single-file rebuildable spec** (v1.8 lineage). This document describes the automatic
> call-processing pipeline functionally: hand this file alone to a competent team or AI
> on any stack and say "rebuild this" — they should get a 1:1 functional reconstruction.
> The concrete reference implementation (n8n + Anthropic + GitHub + Slack + Google
> Drive + Linear) ships in [`pipeline/`](pipeline/) and is marked as stack-specific in
> §11. Everything tenant-specific (people, teams, folders, channels, patterns,
> thresholds) is read from **`tenant.yaml`** — this spec names the fields it depends on.
>
> Provenance: distilled from 3.5 months of production operation (200+ processed calls)
> at the team that built it, then generalized to multi-tenant. The failure-handling
> rules in §8 and the constraints in §12 are paid-for knowledge, not speculation.
>
> **Kit v0.1 scope note — privacy routing.** Sensitivity classification and privacy
> routing (§7 and every `sensitivity`/`private/`/owner-DM mention in the flows) are
> documented here as part of the reference production deployment, but they are
> **deliberately not part of the shipped kit v0.1**: the kit files every call into
> team folders and posts to the digest channel. The feature ships when demand shows —
> demand is captured as waitlist interest `privacy`. A rebuild targeting kit-v0.1
> parity should treat §7 as future/reference scope, not required scope.
>
> Licensing note: this spec is MIT; the reference implementation under `pipeline/` is
> BSL 1.1 (see `pipeline/LICENSE`).

---

## 1. Vision

**Problem.** In async/remote teams the primary context of the company is created on
calls — and dies there. Decisions get lost between meetings, agreements are forgotten,
action items never reach the tracker.

**Solution.** Every cloud-recorded call automatically produces up to five outputs (each
behind a tenant feature flag):

1. **Chat root post** in the digest channel — title, duration, recording link — within
   ~1 minute of the recording finishing.
2. **Recording archive** (optional, off by default) — MP4 uploaded to a
   domain-restricted Drive folder; a permanent link replaces the platform's short-TTL
   share link.
3. **Vault commit** — a markdown file with frontmatter + context digest (summary,
   decisions, agreements, next steps with owners, open questions, insights, all with
   (MM:SS) anchors) + optionally the raw `.vtt` transcript as a sibling file — committed
   to the team's own git repo. Lands after the platform finishes transcription,
   typically 15–60 minutes later.
4. **Chat thread reply** — the digest rendered under the root post, with a link to the
   vault file.
5. **TaskCrafter proposals** — tracker-issue drafts (CREATE / COMMENT-on-existing /
   FLAG) deduplicated against the **live backlog**, rendered as chat messages with
   Approve/Skip buttons (posted under the user-facing "Backbrief · tasks" header).
   Human in the loop; clicks become tracker writes; every verdict is logged as
   training data.

**Goals.** Shared context, persistence, decisions captured, tasks not forgotten, and an
**agent-readable vault**: any retrieval AI can grep frontmatter, walk references, query
by team/date/participant.

**Opinionated reference stack.** The kit is deliberately opinionated: the recommended
stack is Zoom cloud recordings (capture + `.vtt` transcription), a git vault on GitHub
(memory), Slack (delivery), Linear (tasks), optional Google Drive (recording archive —
permanent links, with heavy media kept out of the vault and out of the agent's context
window), orchestrated by the team's own n8n. That is the stack this pipeline ran on in
production, and every default and threshold in this spec was calibrated there. This
document is the portable half of the kit: rebuild it on any stack —
[`pipeline/`](pipeline/) is the reference implementation of the recommended one, not
the only possible one.

**Non-goals.** Real-time intervention during calls. Replacing the tracker or the chat
tool. Recording calls (BYO transcript). Confidential material is protected by
**folder-access separation, not by stopping the pipeline** (§7): title-matched 1:1s file
into the private vault slice and DM the owner; only the legacy opt-in heuristic
(`confidential_stop_heuristic`) hard-stops with no vault write and no channel post.

---

## 2. Trigger

Source: a meeting-platform webhook fired when a cloud recording completes. Reference:
a Zoom app subscribed to `recording.completed` (setup: `docs/zoom-s2s-setup.md`).

**Signature contract (Zoom-shaped; any rebuild needs an equivalent):**

- Header `x-zm-request-timestamp` (UNIX seconds).
- Header `x-zm-signature` = `"v0=" + HMAC_SHA256(secret, "v0:" + timestamp + ":" + json_body)`.
- Verify **before doing anything else**; mismatch → 401, no further processing.
- **Replay window:** reject when `|now − timestamp| > replay_window_sec`
  (`pipeline.knobs.replay_window_sec`, default **900 s**). Production lesson: the window
  was originally 300 s and a >5-minute host clock skew rejected *every* webhook,
  including the platform's own retries — a total silent outage. HMAC still gates
  forgery, so a wider window is low-risk; monitor host NTP regardless.

**Validation handshake.** The platform periodically posts an `endpoint.url_validation`
event and disables the subscription if it isn't answered with the token-derived hash.
The webhook entry node handles both event types.

**Payload (fields used downstream):**

```
event: "recording.completed",
download_token: <short-TTL token for MP4 + .vtt downloads>,
payload.object: {
  uuid, id, topic, host_email, start_time, duration,
  participant_user_names: [<display names>],
  recording_files: [{file_type: "MP4"|"M4A"|"TRANSCRIPT"|…, status, file_size, download_url, id}, …],
  share_url: <browser link to the platform's recording page>
}
```

> **No roster on the transcript event.** The transcript-ready webhook carries an empty
> participant list (platform gap). Two-layer workaround: (a) seed the host's lastname
> from `host_email` — internal domains only, applied *after* sensitivity classification
> so it can never change routing; (b) fetch the full roster via Server-to-Server OAuth
> `GET /past_meetings/{uuid}/participants` when S2S credentials are configured (deploy
> step B2). See §12.

---

## 3. State machine

Recordings arrive in **two phases**:

- **Phase 1** — `recording.completed` *without* a transcript (transcription of long
  calls takes 15–60 min). The root post must go out immediately; the vault commit waits.
- **Phase 2** — the transcript is ready: either a later webhook with the same meeting
  UUID, or an all-at-once event for short calls.

A dispatcher maps every incoming event to one of **five run modes** by inspecting stored
state keyed on the meeting UUID:

| Run mode | Condition | Behavior |
|---|---|---|
| `run_full_oneshot` | first sighting, transcript attached | full pipeline in one execution |
| `run_phase1` | first sighting, no transcript | root post + state save, exit |
| `run_phase2_thread` | Phase 1 exists, transcript now present | digest + thread reply + vault commit + sub-workflows |
| `skip_phase1_retry` | Phase 1 done, event still has no transcript (platform retry) | hard short-circuit, emit nothing |
| `skip_phase2_duplicate` | Phase 2 already finalized | hard short-circuit, emit nothing |

There is no dedicated replay mode — an admin replay is a re-POST of the webhook body
into this same dispatcher.

**State store.** Key-value keyed on meeting UUID, recording `phase1_completed_at` /
`phase2_completed_at` (+ commit sha). **TTL split:** completed entries kept 30 days;
phase-1-only entries (transcript never arrived) purged after 7 days.

---

## 4. Pipeline stages

### 4a. Phase 1 (instant, ~1 minute)

```
verify-webhook (HMAC + replay window + validation handshake)
  → extract-metadata (1:1 title gate, MP4 fields, stable event id, noise filters:
      duration < knobs.min_duration_min or single-participant phantom calls → drop)
  → sensitivity-gate (annotate one of six levels + route; never drops an item — §7)
  → IF confidential (legacy heuristic, off by default) → owner DM flow → STOP
  → state-lookup (decide run mode)
  → IF run_full_oneshot OR run_phase1:
       build root post → chat.postMessage to the routed channel
       → capture root_ts → state-save (Phase 1)
       → fire-and-forget: drive-uploader sub-workflow          (if drive enabled, §4c)
  → IF run_phase2_thread → continue to §4b
```

Root post format (one compact block):

```
Title: [<topic>]
Duration: [<N> min]
Started at [<MMM DD, HH:MM, tenant.timezone label>]
Organizer: [<host_email>]
Recording: <drive_url>  (platform link: <share_url>)
```

Channel routing reads `features.slack.digest_channel` with optional
`features.slack.per_team_channels` overrides per team tag (and
`features.slack.board_channel` for board calls). Chat disabled → the whole chat surface
no-ops; the vault path still runs.

### 4b. Phase 2 (after the transcript)

```
attach .vtt
  → apply-glossary (tenant glossary[]: ASR mis-hearings → canonical spellings,
      compiled to regexes at render; e.g. "sky dock" → "SkyDock")
  → vault-context loader (fetches from the vault repo: team profiles
      (vault.profiles_folder), the summarizer style doc (vault.summarizer_skill_path),
      up to 5 prior related digests; cached — knobs.vault_cache_ttl_*.
      This is what makes digest N+1 smarter than digest N.)
  → build LLM request (system prompt assembled from: JSON contract + tenant team
      taxonomy + sensitivity triggers + language clause (§5a) + vault context;
      model llm.summarizer)
  → LLM call: classify + digest + decisions + agreements + action items + insights
       ↳ onError → stub-digest fallback → continue (self-heals, no DLQ — the call is
         filed with a minimal digest rather than lost)
  → parse-response (strict JSON, tolerant of truncation)
       ↳ onError → mark error → DLQ (§8)
  → build-commit-payload (filename per naming spec, frontmatter, folder cascade §7;
      participant fail-soft: unresolvable or email-shaped names dropped with a warning)
  → build git tree body (ONE tree: .md + .vtt as siblings, inline UTF-8)
  → atomic Git-Data commit:
       get base → create tree → create commit → update ref (force:false)
       ↳ any step error → mark error → DLQ (payload already built, so the DLQ entry
         carries the artifacts for redrive)
  → state-mark-committed (2xx only)
  → switch on status: 2xx → created · 422 (non-fast-forward race) → duplicate, no
      clobber · else → error → DLQ → owner DM
  → build thread reply (digest rendered for chat) → post under root
  → fire-and-forget: taskcrafter sub-workflow (§4d)
  → state-finalize (phase2_completed_at + TTL purge; the error branch leaves the record
      open so a platform retry self-heals)
```

Why atomic Git-Data instead of two sequential file PUTs: the 2-PUT approach is racy
(second PUT fails → `.md` without its `.vtt` sibling, or ref moved between PUTs). One
tree = both files or neither; `force:false` turns concurrent writers into a clean 422
handled as "duplicate = success".

### 4c. Drive uploader (sub-workflow, optional)

Gated on `features.drive.enabled` + `features.raw_retention: vtt_mp4`. Triggered
fire-and-forget from Phase 1 — a failure here cannot poison main state.

Why Drive exists at all: platform share links expire (~24 h on Zoom, §12), and
committing MP4s to the vault would bloat a plain-text repo that agents grep and load as
context. The archive buys permanent recording links without spending vault space — or
context-window tokens — on media.

```
webhook recv → normalize payload (validate MP4 fields; throw with diagnostic if the
    download token is absent/expired)
  → init resumable upload session
  → build chunk plan: one item per 8 MB Range slice
  → loop (batch size 1): download chunk (Range GET) → upload chunk (Content-Range PUT)
      → final chunk (2xx, not 308) → exit loop
  → rewrite the root post in place with the permanent Drive URL
```

Why chunked: the reference runtime's code nodes have a 60 s timeout and ~150–200 MB
heap; a single PUT of a 400 MB MP4 OOMs. 8 MB slices with a per-iteration timeout reset
empirically support 100+ minute recordings.

### 4d. TaskCrafter (sub-workflow)

Multi-stage extraction → human-in-the-loop tracker writes. Fire-and-forget after the
Phase-2 thread reply. Gated on `features.tracker.enabled`; `kind: other` or unmapped
teams degrade to file-only task artifacts in the vault. TaskCrafter is the internal
stage name; its user-facing chat surfaces render as "Backbrief · tasks" (language-pack
`ui_strings`).

```
00. webhook recv
01. build normalizer request (system prompt: strict schema; team-inference rules
    generated from features.tracker.team_mapping + vault.teams[].description;
    participant→team bias from roster[].home_team; voice-directive rules from
    extraction.voice.wake_words + language-pack verb lists)
    → LLM call (llm.normalizer)
02. parse → array of task drafts {title, owner_lastname, priority, team_inferred,
    intent: create|comment_only|update_status, transcript_quote, source_ts_mmss}
03. per-team tracker search (candidate retrieval from the live backlog)
    → aggregate, dedupe, top-K per task
04. build rerank request — de-duplicated candidate corpus + per-task candidate ids
    (compaction matters: deduplicating the corpus cut input tokens ~76% with identical
    scores — the matcher is the expensive stage)
    → LLM call (llm.matcher — strongest model, thinking enabled)
05. matcher decide → per task: matcher_decision ∈ {create_new, comment_on_match,
    flag_for_review, skip_match_done, skip_cross_call_dup, skip_intra_batch_dup,
    skip_same_target_dup, use_explicit_ref} + persist draft to per-call dedup state
06. router: team, assignee (roster → tracker user id), priority, initial state,
    provenance label
07. build composer request (issue descriptions in the 4-block house template —
    plugin/templates/frontmatter/task-4block.md) → LLM call (llm.composer)
08. parse composer response
09. build chat blocks (per-task section + buttons by decision kind)
    ↳ inline deterministic discriminator (§9): pattern checks append a ⚠️ marker line
      to suspicious proposals. Advisory only — never blocks posting.
10. save pending state → post to the digest thread
… user clicks a button (minutes to days later) …
11. interactivity webhook → resolve task by message_ts + task_id from pending state
    → derive action kind ∈ {approve_create, approve_comment, approve_update,
      approve_alt, skip_single, bulk_skip, bulk_approve_safe, bulk_noop, idempotent}
12. build tracker mutation (create / comment / update) → execute
13. handle result: mark executed (idempotency) · update draft outcome
    (pending → created/commented/updated, 14 d confirmed TTL; pending → skipped,
    non-blocking) · ephemeral ack to the clicker · thread reply ("✅ Created PRD-142")
```

**Cross-call dedup.** Drafts persist with `fingerprint = lowercase(title) + "|" +
owner_lastname`, checked on subsequent calls. TTL split (tenant-tunable via
`features.tracker.thresholds`):

- `pending` (never clicked) — blocks re-proposal for **48 h**, then expires;
- `created/commented/updated` (click-confirmed) — blocks for **14 days**, so the next
  weekly meeting doesn't re-propose what was already created;
- `skipped` — non-blocking (the team deliberately said no).

Matcher thresholds (defaults calibrated on production data): `comment: 0.75`,
`flag_discovery: 0.55`, `flag_planning: 0.35`. These, together with the autonomy level
(L0 buttons-for-everything → L2 autopilot with buttons only on flags; v0.1 enforces L0,
L1/L2 reserved — §12), are the per-team learning dials.

### 4e. Feedback collector (cron retraining loop)

Schedule: every 6 hours.

```
list recent TaskCrafter posts in the digest channel (window: now − 72 h)
  → read thread replies (free-text human feedback)
  → filter posts with unprocessed comments
  → LLM parser (llm.feedback): classify each comment into structured signals
      {already_exists, already_done, duplicate_in_batch, wrong_title, wrong_owner,
       wrong_team, good}
      — phrase exemplars per language come from the shipped language packs
        (e.g. EN "that task already exists" → already_exists); classification is by
        meaning, so unlisted languages degrade gracefully
  → build digest message → post to the thread
  → mark processed (reaction marker = idempotency guard)
```

Output: rows appended to `vault.training_data_path`
(default `.backbrief/training/feedback.jsonl`) — the input to the offline eval loop (§9),
sibling of the Phase-A `task-decisions.jsonl` verdict log.

### 4f. Error trap (global safety net)

A standalone workflow registered as the main workflow's error handler. The runtime
invokes it on any *unhandled* failure (one the inline DLQ path didn't catch); it DMs the
pipeline owner (`roster[].is_owner`) a red-alert with execution/workflow identifiers and
points at the durable DLQ entry + `redrive-dlq.js`. It sits **beneath** the inline
"mark error → DLQ" path (§8), not in any data flow.

---

## 5. Data schemas

### 5a. LLM digest output (strict JSON, validated)

**Language rule** (replaces any hardcoded output-language mandate): narrative fields are
written in `tenant.primary_language`; if the transcript's dominant language differs and
is in `tenant.languages`, mirror the transcript. Classification fields are **always**
English kebab-case code tokens — never translated. Proper nouns, lastnames, and tracker
identifiers stay as-is.

```jsonc
{
  "topic_slug":      "kebab-case-en",
  "team_tag":        "<one of vault.teams[].tag or the mixed tag>",
  "sub_tag":         "<vault.teams[].subteams[].tag> | null",
  "call_type":       "standup|planning|review|demo|discovery|1on1|all-hands|external|mixed",
  "tags":            ["freeform-kebab-en", ...],
  "sensitivity":     "public|restricted|external-nda|personal-1on1|board-private|confidential",
  "chat_summary":    "<600–1200 chars, themed '### Topic (MM:SS)' sections>",
  "decisions":       [{ "title": "...", "context": "..." }, ...],
  "agreements":      [{ "who": "<A> ↔ <B>", "commitment": "...", "ts_mmss": "MM:SS" }, ...],
  "action_items":    [{
      "title":            "...",
      "assignee_hint":    "<roster Lastname or null>",
      "priority":         "low|medium|high|urgent",
      "estimate":         "<freeform>",
      "voice_marker":     "<verbatim trigger phrase if any, else null>",
      "transcript_quote": "<exact span>",
      "source_ts_mmss":   "<MM:SS or null>",
      "status":           "post-call|done-on-call|monitoring"
  }, ...],
  "open_questions":  [{ "question": "...", "why_deferred": "..." }, ...],
  "key_insights":    [{ "insight": "...", "implication": "..." }, ...]
}
```

Deltas vs the v1.8 production schema: `agreements` added (mutual commitments that are
*not* tracker-shaped tasks — the highest-loss category in practice); `next_24_48h`
dropped (duplicated action items; urgency lives in `priority`); `category` renamed to
`status`; output language driven by tenant config.

**Token budget.** `llm.summarizer.max_tokens` default 16384 (4096 truncated 60+ minute
calls in production). On truncation the parser logs a warning and downstream runs on
best-effort partial JSON — degraded output beats a dead pipeline.

### 5b. Vault `.md` structure

Full conventions: shipped in the vault skeleton's `AGENTS.md` and templates
(`plugin/templates/`). Summary of the contract:

```
<routed-folder>/transcripts/YYYY-MM-DD HHMM <topic-slug> w <Lastname1,Lastname2>.md
<routed-folder>/transcripts/<same basename>.vtt      # sibling when raw_retention ≥ vtt

Naming: date-first (sorts chronologically), ASCII English slug, ≤4 lastnames
(5+ participants → omit the "w" part), ≤100 chars, no exotic separators.
Folder is team-root-relative (e.g. product/transcripts/), chosen by the routing
cascade in §7.
```

Frontmatter (YAML; closed key set per `schema_version`, validated): `type: transcript`,
`team`, `topic`, `date`, `time`, `duration_min`, `participants` (roster lastnames),
`sensitivity`, `language`, `source` (zoom/fireflies/…), provenance
(`filed_by: pipeline`, `filer_model`, `pipeline_version`, `source_id` = platform meeting
UUID — the replay/dedup key), optional `sub_tag`/`recording_url`/`transcript_file`/
`external_partner`, `references_prior_calls` (max 5 — the receipt of which prior memory
made this digest smarter), and an `action_items` mirror (agent-readable projection of
the body).

Body sections, fixed order (machine-addressable by heading): Summary (themed, (MM:SS)
anchors) · Decisions · Agreements · Next steps (📋 post-call / ✅ done-on-call /
👀 monitoring) · Open questions · Key insights · Transcript (link to the `.vtt`
sibling). Empty sections render as "None." — parseability beats prettiness.

That is the manual/plugin (A1) digest profile. The Phase-B pipeline emitter ships the
production-verbatim body variant — `Summary (Quick brief)` · Decisions · `Action items` ·
Open questions · Key insights · `Next 24-48h` · Transcript — which the vault lint
accepts as a second first-class profile, keyed on `filed_by: pipeline` (§12).

### 5c. TaskCrafter proposal → chat blocks

Per task: one section block + (where actionable) a button row. `action_id` schema:

```
tc.approve.<task_id>        per-task approve (CREATE / UPDATE)
tc.approve_alt.<task_id>    FLAG only: "Create new instead"
tc.skip.<task_id>           per-task skip
tc.bulk_approve_safe        bulk approve all non-flagged
tc.bulk_skip_all            bulk skip
```

Decision markers in section headers:

```
✏️ CREATE  💬 COMMENT  ⚠️ FLAG  🔄 UPDATE  🏁 DONE  ⏸ SKIP
🔁 DUP (cross-call)  📋 BATCH-DUP (intra-batch)  🎯 SAME-TARGET
```

Discriminator append (when verdict = needs_review):
`⚠️ discriminator (high|medium|low): _<concern>_; _<concern>_`

---

## 6. External integrations (reference stack)

| System | Auth | Endpoints | Direction |
|---|---|---|---|
| Meeting platform (Zoom) | S2S OAuth + HMAC webhook | inbound `POST /webhook/backbrief-zoom`; `GET /past_meetings/{uuid}/participants`; recordings list (history import) | RX / TX |
| Chat (Slack) | bot token | `chat.postMessage`, `chat.update`, `users.lookupByEmail`, history + reactions (feedback collector) | TX |
| Chat interactivity | signing secret | inbound button-click POSTs | RX |
| LLM (Anthropic Messages API) | API key (n8n credential) | `POST /v1/messages`, prompt caching on the system block | TX |
| Git host (GitHub Git Data) | fine-grained PAT, contents-RW on the vault repo only | `GET /commits`, `POST /git/trees`, `POST /git/commits`, `PATCH /git/refs` (atomic commit) | TX |
| Git host (GitHub Contents) | same PAT | `PUT …/contents/pipeline/dlq/<…>` (durable DLQ persist only) | TX |
| Drive (Google, optional) | OAuth2 refresh token | resumable upload: POST init → PUT chunks | TX |
| Tracker (Linear GraphQL) | API key | `POST /graphql` (search + mutations) | TX/RX |
| Orchestrator API (n8n) | personal API key | `GET/PUT /workflows/{id}` (deploy/drift management) | admin |

All human-readable names (channel names, team keys, emails) are resolved to platform IDs
at deploy time and cached in `.backbrief/pipeline-state.json` — the user is never asked
for an ID a script can resolve.

---

## 7. Sensitivity routing + safety [reference deployment — NOT in kit v0.1]

> Scope note: this whole section describes the reference production deployment. Kit
> v0.1 ships **without** privacy routing (owner decision — see the scope note in the
> preamble): no sensitivity classification, no private slices, no DM delivery; every
> call files into its team folder. Waitlist interest: `privacy`.

Six sensitivity values; routing is **folder + channel**, and confidentiality is enforced
by folder-access separation, not by stopping the pipeline. All patterns and routes are
tenant config (`sensitivity.*`), shown here with the reference deployment's defaults:

| Level | Trigger | Vault folder (route template) | Chat |
|---|---|---|---|
| `public` | regular team call | `{team}/transcripts` | digest channel (or per-team override) |
| `restricted` | `restricted_topics` regex (finance/fundraising/legal/…) | `{team}/transcripts` | no public post; private channel if mapped, else vault-only |
| `external-nda` | non-internal participant domain OR `external_partners` match | `general/transcripts` + `external_partner` frontmatter | participants' private channel, else vault-only |
| `personal-1on1` | `one_on_one_titles` match | `private/1on1/{other}/transcripts` | **DM to owner only** — full pipeline still runs |
| `board-private` | `board_titles` match | `private/board/transcripts` | board channel if set, else owner DM |
| `confidential` | legacy heuristic (opt-in): exactly 2 participants incl. owner, no 1:1 title | **none — pipeline stops** | owner DM only |

**Detection order** (deterministic first, LLM second):

1. Title patterns (1:1 → `personal-1on1`; board → `board-private`; legal titles → the
   legal private slice + at least `restricted`; hiring titles → at least `restricted`).
2. Participant email domains vs `tenant.internal_domains` + known partners →
   `external-nda`.
3. LLM classification (topic semantics) — may **raise** sensitivity, never lower a
   level set by rules 1–2.
4. Default `public` — but a rules-engine *failure* defaults to `restricted` + a warning,
   never to `public` (production leak-class fix: an exception in the gate once defaulted
   a sensitive call into a public folder).

**Folder cascade** (in the commit-payload builder — decides the team folder):
(1) private-domain override scanning **title + LLM tags** for legal/board/hiring signals
(forces the private folder even when the LLM mis-guessed the team — fixes the
"legal call filed in a team folder" leak class); (2) LLM team when ≠ mixed;
(3) owner tiebreak via `roster[].home_team`. A folder↔sensitivity `max()` safety net
escalates any `private/` path to at least its slice's level and stamps
`sensitivity_override` in frontmatter.

**Hard rules** (not configurable):

- `confidential` never touches the repo — and is never embedded in DLQ artifacts.
- 1:1s file under `private/1on1/<Other>/`, never a team folder; filenames under
  `private/1on1/` keep neutral slugs (filenames leak via listings even where content
  doesn't).
- Filenames Latin-only: non-Latin lastnames go through the tenant alias maps +
  transliteration fallback; email-shaped "lastnames" are dropped with a warning
  (leak guard).
- Never silently file across the private/public boundary in either direction — the
  interactive surfaces warn and confirm.

---

## 8. Failure handling

### Per-stage wiring

| Failure point | Behavior |
|---|---|
| HMAC mismatch / stale timestamp | 401 / reject; nothing executes |
| Platform URL-validation event | special branch answers the token hash |
| LLM timeout / 5xx (after retry ×3) | error output → **stub-digest fallback** → pipeline continues; no DLQ (self-heal: a filed call with a minimal digest beats a lost call) |
| LLM schema-invalid JSON | parse error → mark error → DLQ → owner DM |
| Git commit 2xx | created → thread reply |
| Git update-ref 422 (non-fast-forward race) | duplicate → treated as success, no clobber, no DM |
| Git get-base / create-tree / create-commit error | mark error → DLQ — the entry carries the built `.md`+`.vtt` so redrive needs no re-processing |
| MP4 token expired (Drive sub) | throw with diagnostic; visible in the execution log |
| Drive chunk failure mid-loop | continue; remaining chunks still attempt |
| TaskCrafter LLM failure | that sub-execution dies; the proposal post simply doesn't appear (main pipeline unaffected) |
| Tracker write failure | thread reply explains the API error class (e.g. permission vs bad input) |
| Anything unhandled | global error trap → owner DM (§4f) |

### Durable DLQ

Failures produce (a) a DM to the owner and (b) a **durable JSON entry** committed to the
vault repo at `<vault.dlq_folder>/<YYYY-MM-DD>/<execution-id>.json`, recoverable with
`plugin/scripts/redrive-dlq.js` even after the orchestrator's execution-log retention
ages out. **Artifact embedding is folder-gated:** entries for `private/` or unresolved
paths are metadata-only; only public-folder artifacts embed the `.md`/`.vtt` content.
Redrive hard rule: never writes into private slices or outside the vault.

DM format:

```
🚨 Pipeline failure — exec <id>
Topic: <topic> · Failed node: <node> · Sensitivity: <level>
Meeting UUID: <uuid> · HTTP: <code> · Error: <first 1500 chars>
Retry hint: orchestrator UI → retry from failed node, or replay the webhook
            (within the replay window), or redrive-dlq.js for the artifacts.
```

### Idempotency

- State keyed on meeting UUID → the two `skip_*` run modes prevent double-processing of
  platform retries.
- Git 422 = duplicate = success.
- Button clicks: an `executed[task_id]` mark prevents double-execution when the chat
  platform delivers an action twice.
- Deploys are snapshot-first atomic PUTs; re-deploy with no changes is a no-op (§11).

---

## 9. Self-improving loop

**Generator** (LLM, unchanged across tenants): normalizer → matcher → composer (§4d).

**Discriminator** (deterministic JS, no LLM call): a pure function inside the
chat-blocks builder checks each proposal against nine failure-mode patterns distilled
from production observations — e.g. *possible existing-issue match* (mid-band matcher
score on a planning call), *title generalizes beyond the quote*, *no owner and no
fallback target*, *urgent priority without any deadline marker in the quote*,
*near-miss duplicate score band*, *"decide on the call" language routed as CREATE*, and
an *everything-became-CREATE* tripwire. ≥2 patterns firing adds a compound bonus.
Output: `{verdict: ok|needs_review, confidence, concerns[]}` rendered as a one-line ⚠️
marker — **advisory only, never blocks**. Word lists are language-pack data
(`pipeline/lang/*.pack.json`); the pattern logic is shared. Per-tenant tuning:
`features.tracker.discriminator_overrides`.

**Eval** (offline): the feedback collector (§4e) turns thread comments into labeled
rows; a harness computes precision/recall/F1 per discriminator/prompt version on a
holdout split. The production pattern set won its place by measured F1 against
alternatives, not taste.

**Retraining cadence** (weekly, human-run): inspect failures by signal class
(`already_exists`, `wrong_title`, `wrong_owner`, …) → adjust JS pattern thresholds/word
lists, or a prompt variant where a pattern genuinely needs semantics → evaluate on
holdout → deploy if F1 improves. The Phase-A `task-decisions.jsonl` verdict log and the
Phase-B `feedback.jsonl` share one home (`.backbrief/training/`) and one purpose: this
loop. The autonomy ladder (L0 → L2; L1/L2 reserved for a future release — §12) is the
product face of the same data — teams raise autonomy when *their own measured
acceptance* supports it.

---

## 10. Acceptance criteria (per call)

A successful run delivers, in order:

1. ✅ Phase-1 root post within ~1 min of the recording-completed event, in the routed
   channel, with title/duration/start/organizer/recording link.
2. ✅ (If Drive enabled) MP4 archived; root post updated in place with the permanent
   link.
3. ✅ Vault commit at the sensitivity-routed path — naming spec + frontmatter +
   digest body + `.vtt` sibling (per `raw_retention`) — git status 2xx.
4. ✅ Thread reply with the rendered digest under the root.
5. ✅ TaskCrafter proposals in the same thread, buttons clickable, suspicious ones
   ⚠️-marked.
6. ✅ Button click → tracker write within ~5 s, ephemeral ack + thread confirmation
   with the issue URL.
7. ✅ Within the next 6 h cron tick, free-text feedback on proposals is parsed into
   training data.

If any of 1–4 fails, the owner gets a DLQ DM and the recording is recoverable (webhook
replay within the window, or DLQ redrive).

Disabled components must **no-op cleanly**: e.g. Slack off ⇒ 1, 4, 5 skipped, vault
commit still lands; tracker off ⇒ 5–6 become a `tasks/` file in the vault.

---

## 11. Implementation notes (n8n reference stack — change with stack)

**Shape:** five workflows — `main` (orchestrator), `taskcrafter`, `drive-uploader`,
`feedback-collector`, `error-trap` — as importable JSON skeletons in
`pipeline/workflows/`, with all Code-node sources as files in `pipeline/code/**`.

**Code-node constraints** (n8n cloud): 60 s execution timeout, ~150–200 MB heap, no
non-stdlib `require`, **no global `fetch`** — use the runtime's HTTP helper. Production
incident worth repeating: a node that silently fell back on a missing global `fetch`
injected an *empty* vault context on every call for over a week — the deploy self-test
now probes the HTTP helper explicitly at install time.

**Config/secret injection.** Repo code carries placeholders, never values:

- `TENANT_*` regions — rendered from `tenant.yaml` + language packs +
  `.backbrief/pipeline-state.json` by `pipeline/tenant-render.js` (deterministic, so an
  unchanged re-deploy is a byte-identical no-op);
- `__*_PLACEHOLDER__` secrets — resolved at deploy by `INJECT_SECRETS` with the order
  **env var → preserve-from-live → warn loudly**. Never downgrade a live secret to a
  placeholder (that exact bug caused the week-long outage above). The Anthropic key
  prefers an n8n **credential** over a code constant, with inline injection as the
  documented fallback for plans without the credentials API.

**Deploy path** (`plugin/scripts/deploy-pipeline.js`): GET live → snapshot to
`.backbrief/snapshots/` (rollback = PUT it back) → render tenant regions → inject
secrets → **one atomic PUT per workflow** → re-activate → fire a synthetic signed
fixture webhook and assert the run mode + visible outputs. First run imports the
skeletons (`--import`); **re-runs always take the atomic-PUT path — there is
deliberately no re-bootstrap command** (a bootstrap that re-POSTs workflows from a
frozen skeleton once silently reverted live fixes; the kit ships without that footgun).
`check-drift.js` diffs live vs rendered-repo per node with secrets and tenant values
normalized on both sides — real secrets never appear in diff output.

**Retry semantics** (learned the hard way): the orchestrator's "retry execution"
replays the workflow **snapshot captured at execution time**, not current code. To apply
a fix to an already-failed event: DLQ redrive (preferred), webhook replay within the
replay window, or wait for the next live event. Never "retry" and assume the fix ran.

---

## 12. Known constraints / accepted compromises

Documented deliberately — a rebuild that "fixes" these without understanding them will
regress something else.

- **No participant roster on the transcript event.** The platform's transcript-ready
  webhook carries an empty participant list. Mitigation: host-email lastname seed
  (internal-only, applied post-classification so it can never change routing) until
  S2S OAuth participants API is configured at deploy step B2. With S2S configured the
  full roster is fetched per call.
- **Secrets are inlined into workflow definitions on entry-level cloud plans.** The
  reference runtime's cloud Starter tier exposes no user env vars to code nodes and
  gates the Variables feature by license (`GET /variables` → 403). Inlining into the
  encrypted workflow definition — behind the instance's API auth — via `INJECT_SECRETS`
  is therefore the *mechanism*, not a workaround. Rotate on schedule; revisit on
  self-host/higher plans.
- **State-store race on parallel webhooks.** The dedup state read-modify-write is
  non-atomic; two simultaneous webhooks for the same UUID can race the check. Accepted
  for rarity (the platform staggers its events); the full fix is an external atomic
  store.
- **Matcher thinking/effort params must be probed exactly.** An invalid
  thinking/effort combination for the configured matcher model fails as a silent
  request-level 400 (production: three weeks unnoticed). The creds test therefore sends
  the matcher probe with the tenant's *exact* params, and model downgrades are explicit,
  documented choices.
- **Two discriminator patterns are currently dead by construction:** they gate on
  `score === null`, but the matcher stage always emits a numeric score (`0` in the
  degraded/no-candidates case they were meant to backstop). The offline harness
  overstates their recall. Reconcile matcher output semantics with the pattern gates
  before re-enabling — shipped as-is to keep prod/harness parity honest.
- **Tracker `update_status` intent is non-functional** — degrades to an "update it
  manually" note in the proposal. A real implementation needs per-team workflow-state
  resolution against the tracker's schema.
- **FLAG → "Create new instead" with an unresolved team** fails the tracker's input
  validation; pending fix is a null-payload guard at the interactivity stage that emits
  a warning instead.
- **Autonomy levels L1/L2 are reserved, not shipped.** `features.tracker.autonomy_level`
  is parsed and validated, and the Approve/Skip decisions are logged as the training
  signal that would gate them — but v0.1 enforces **L0 only** (every proposal needs a
  click). L1 (auto-create high-confidence tasks) and L2 (autopilot) ship a future
  release; the FAQ and status nudge say so. Implementing them means gating the BlockKit
  builder + Linear-mutation stages on the level + the logged acceptance rate.
- **Slack-off tenants run a reduced graph.** With `features.slack.enabled: false`
  the Slack builders end their branches (`return []`), and everything wired
  downstream of them in `main.json` goes with them: the Phase-2 state *finalize*
  never stamps (`skip_phase2_duplicate` fast-path never engages — redeliveries are
  instead caught at the commit stage as an identical-tree duplicate, at the cost of
  re-running the LLM stage; the state-TTL purge also rides that branch), and the
  optional Drive archive trigger is unreachable. TaskCrafter / feedback / error-trap
  simply don't deploy (their surface is Slack; the deploy gates say so). Restructuring
  `main.json` so state finalize and the Drive trigger are Slack-independent is a
  planned fast-follow — shipped as-is because the vault commit (the core artifact)
  is upstream of all Slack nodes and unaffected.
- **Two digest-body profiles, one validator.** The manual/plugin flow (A1,
  `plugin/templates/frontmatter/digest.md`) writes `Summary · Decisions · Agreements ·
  Next steps · …`; the Phase-B pipeline emitter (`build-commit-payload-v2.js`,
  production-verbatim) writes `Summary (Quick brief) · Decisions · Action items · … ·
  Next 24-48h`. Deliberate v0.1 shape: the pipeline body stays prod-verbatim instead of
  being reshaped to the template (prod-parity beats uniformity). `validate-vault.js`
  accepts both as first-class profiles — keyed on `filed_by: pipeline` — and the offline
  e2e harness cross-checks the emitter's committed `.md` through the real validator for
  both tenant fixtures, so the two profiles cannot silently drift apart again. Unifying
  the bodies belongs to the digest-v1 regen, not v0.1.
- **Transcript quality ceiling is the input's.** Third-party exports
  (Fireflies/Otter/…) are noisier than native platform transcripts; extraction quality
  follows. The glossary + language packs mitigate systematic ASR errors; they don't
  create signal that isn't there.

---

## 13. Glossary

- **Phase 1 / Phase 2** — first (recording done, no transcript) vs second (transcript
  ready) webhook for the same recording.
- **Run mode** — the dispatcher's classification of an incoming event (full / phase1 /
  phase2-thread / two skip modes).
- **Context digest** — the vault `.md` body: summary, decisions, **agreements**, next
  steps with owners, open questions, insights — all (MM:SS)-anchored. The product's
  main artifact ("a backbrief" in product terms).
- **Sensitivity / privacy routing** — folder + channel routing by sensitivity
  (`public / restricted / external-nda / personal-1on1 / board-private / confidential`).
  Part of the reference deployment (§7); **not in kit v0.1** — every call files to a team
  folder and posts to the digest channel (§12). Waitlist interest: `privacy`.
- **TaskCrafter** — the extraction→dedup→propose→approve sub-pipeline (§4d); internal
  name — its user-facing chat surfaces are branded "Backbrief · tasks".
- **Discriminator** — deterministic advisory checker appending ⚠️ markers to suspicious
  task proposals; never blocks (§9).
- **Cross-call dedup** — a task created after Monday's call is not re-proposed by
  Friday's recap; 14 d confirmed / 48 h pending TTLs.
- **Voice marker** — a verbatim phrase that triggered action-item extraction (wake-word
  directives like "backbrief, make that a task", or urgency phrases like "by end of
  week" — lists ship per language in `pipeline/lang/`).
- **DLQ** — durable dead-letter entry in the vault repo + owner DM; recoverable via
  `redrive-dlq.js`.
- **TENANT_INJECT / INJECT_SECRETS** — deploy-time rendering of tenant config / secrets
  into node code (§11).

---

## 14. Reconstruction checklist

Given this file alone, a rebuild on any stack should verify, in order:

- [ ] Webhook endpoint verifies HMAC + replay window and answers the URL-validation
      handshake.
- [ ] State store keyed on meeting UUID with the five run modes (incl. both `skip_*`
      short-circuits on replayed events).
- [ ] Sensitivity engine (reference deployment only — NOT kit v0.1, see §7): six
      levels, deterministic-first detection order, rules-failure defaults to
      `restricted`, folder cascade + escalation net, `confidential` stop honored
      when enabled.
- [ ] Phase-1 root post within ~1 min; channel routing honors per-team overrides and
      no-ops when chat is disabled.
- [ ] Single strict-JSON LLM call: classification + digest + decisions + agreements +
      action items (§5a), with the tenant language clause and stub-fallback self-heal.
- [ ] Vault commit: naming spec + frontmatter + digest body + `.vtt` sibling, written
      **atomically**, 422-as-duplicate semantics.
- [ ] Thread reply rendering the digest.
- [ ] Chunked recording archive running async of the main pipeline (when enabled).
- [ ] TaskCrafter: normalizer → live-backlog retrieval → matcher → router → composer →
      discriminator → buttons → interactivity → tracker write, with cross-call dedup
      TTLs and verdict logging.
- [ ] Durable folder-gated DLQ + owner DM + global error trap; redrive tool refuses
      private slices.
- [ ] Feedback collector cron parsing free-text into the seven signal classes →
      training data file.
- [ ] Every `features.*` flag off ⇒ clean no-op of exactly that surface.
- [ ] §10 acceptance criteria pass on a real call.
