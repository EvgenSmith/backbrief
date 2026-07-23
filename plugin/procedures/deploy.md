<!-- SPDX-License-Identifier: MIT -->
# Procedure: `deploy` — B0–B8 automatic pipeline

> Read `_conventions.md` (global rules) and `_capabilities.md` (tool bindings) first.
> Triggers: `/backbrief:deploy`, the A4 fork option 1, "make it automatic".
> Time budget: ≤ 60 minutes end-to-end. Structure: 10 rungs (B0–B8 + B5.5), each = one
> ask → one **verified** artifact (a rung is done only when its live test passes —
> `test-creds.js` green is the proof, never "the user pasted a token").
> Show the rung marker on every rung: *"step B3 of B0–B8"*.
> The question → answer → effect map for every rung: `_question-graph.md`.

## Global deploy rules (apply to every rung below)

- **Secrets:** everything collected from B0 onward (`N8N_BASE_URL`/`N8N_API_KEY`
  at B0, service credentials in B2–B5.5) goes **only** into
  `.backbrief/secrets.env` (gitignored, `chmod 600`) and from there into the
  user's n8n at B6 (INJECT_SECRETS pattern). Secrets never leave the user's
  machine/n8n; at the end of deploy (HANDOFF — after B7/B8, never earlier) offer
  to scrub the local file. State each of these facts in one sentence the first
  time you collect a secret.
- **Rung classification (`_conventions.md` §13) — state the stakes before a skip:**
  `[REQUIRED]` rungs (B0, B1, B5.5, B6) cannot be skipped without ending deploy;
  every `[OPTIONAL]` rung is individually skippable → feature flag in `tenant.yaml` +
  one-sentence degradation (P3) + `[SCRIPT: state.js set steps.b<N>_skip_reason <slug>]`
  + waitlist capture where the skip means "I use another tool" (§8/§13:
  `state.js waitlist-observe <slug> --step B<N>`). Skips never block later rungs —
  B6 deploys whatever is enabled; every skip lands in `.backbrief/roadmap.md`
  automatically (the `steps.*` write regenerates it).
- **Recognition, not re-pitching:** B2/B3/B4 PREFLIGHTs read the A0 stack map
  (`[SCRIPT: state.js get stack]`) — when the user already named a non-default tool at
  setup, open with recognition ("at setup you said Meet…"), never a fresh pitch.
- **The §13 menu applies at every rung:** our stack / skip / own tool (self-connect doc
  + waitlist) / "set it up for me" (hands-on waitlist).
- **Resume:** every completed rung stamps `[SCRIPT: state.js set steps.b<N> completed]`
  (or `skipped`); re-entry jumps to the first incomplete rung.
- **Credential-rung shape (B2–B5.5):** guide → collect → live-test
  `[SCRIPT: test-creds.js <svc>]` → artifact confirmed (P4). Never accept a
  credential without the live test.
- Phase-B jargon gets a half-sentence gloss on first use ("orchestrator — the
  always-on service that reacts to your calls").

## PREFLIGHT

DO:
  1. `[SCRIPT: state.js get]` — if `steps.b<N>` entries exist, name the highest
     completed rung and offer *resume from the next rung / redo a rung*.
  2. Confirm Phase A basics exist: `tenant.yaml` at the vault root and
     `.backbrief/` present. If not → route to `start` (A0) first.
  3. Bind capabilities per `_capabilities.md`.

---

## Step B0 — hosting choice                                [REQUIRED for Phase B | flag: none | gate: none]

PREFLIGHT: Phase B needs the **full kit checkout**
  (`git clone https://github.com/BACKBRIEF_ORG/backbrief`) — a marketplace
  plugin-cache install carries `plugin/` only; every Phase-B script detects the
  missing `pipeline/` tree, says so, and exits 2. Get the checkout first.
TELEMETRY: `step_started B0`
SAY: "We're deploying an automatic pipeline: your call ends → transcript lands
  in the vault → digest goes to the team → tasks get proposed. First: where do
  we run the orchestrator (the always-on service that reacts to your calls)?"
ASK (Q1): "1. **n8n Cloud** — fastest, free trial, no server needed (Enter) ·
  2. **Docker on your own server/VPS** — fully self-hosted ·
  3. **Neither / don't want to run infra** → hosted waitlist."
  → default: 1 (n8n Cloud)

DO:
  1. Option 3 → waitlist capture per `_conventions.md` §8
     (`[SCRIPT: telemetry.js waitlist --interest=hosted --source-step=B0 --email=…]`
     on an explicitly typed email — prefill when known: *"Send your `<email>`?
     (Enter = yes)"*; never background-send). SAY Phase-A manual mode keeps working
     exactly as-is. `[SCRIPT: state.js set steps.b0 skipped]` +
     `[SCRIPT: state.js set steps.b0_skip_reason no-infra]` → END deploy gracefully.
  2. User names **another orchestrator** (Make, Zapier, Pipedream, …) →
     `[SCRIPT: telemetry.js event connector_demand --tool=<slug>]` +
     `[SCRIPT: state.js waitlist-observe <slug> --step B0]`, SAY honestly the pipeline
     ships as n8n workflows only in v0.1, then re-offer 1/2/3 (their tool's demand is
     now counted; §13 option 4 — hands-on — is also on the table).
  3. Options 1/2 → guide the setup from `docs/n8n-hosting.md` (Cloud signup
     walkthrough / the `docker run` one-liner). Have the user set
     `N8N_BASE_URL` and create an API key (`N8N_API_KEY`).
  4. `[SCRIPT: check-env.js --save]` — probes node/git/docker, network egress,
     n8n reachability + API auth + the Variables licensing capability, and
     records `n8n_base_url` into `.backbrief/pipeline-state.json`.

ARTIFACT (show, don't tell):
  The environment report (chat + `.backbrief/deploy/environment.md`): what's
  available, what's chosen, warnings, and the verdict line as recommendation.

ERROR: n8n unreachable → exactly three options: retry / switch hosting option /
  hosted waitlist (P3-style, never a dead end).
DO: `[SCRIPT: state.js set steps.b0 completed]`
TELEMETRY: `step_completed B0` (+ prop `hosting: cloud|docker`)

---

## Step B1 — tenant.yaml                                   [REQUIRED | flag: none | gate: b0]

No user ask — B1 runs on facts Phase A already gathered (one conditional ask below).

DO:
  1. `[SCRIPT: generate-tenant.js]` — completes the A0-born `tenant.yaml`:
     roster with aliases + emails (from `team/*.md` — profile fields win, field-level
     merge), teams/folders from the vault layout, channel placeholders,
     `tenant.about` from `docs/company.md`, and the feature flags
     (schema: `plugin/templates/tenant.schema.json` — `features.slack.*`,
     `features.raw_retention`, `features.drive.enabled`,
     `features.tracker.*`, `features.history_import`). **It consumes the whole A0 stack
     map** — chat ≠ slack flips `features.slack.enabled` off, git ≠ github keeps
     `vault.repo` null, calls ≠ zoom notes that B2 is skip/waitlist territory — the
     notes name the waitlist slugs already observed. The script always prints a diff
     before writing — show that diff and relay its ℹ notes.
  2. **Conditional ask (only when the diff notes flag missing roster emails):**
     ASK: "What's your corp email domain (used to spot external participants)?
     Optionally paste member emails — one lookup makes Slack @mentions and Zoom
     attendance exact. (Enter = skip; name-matching fallback, slightly fuzzier)"
     → write `tenant.internal_domains` / roster `email` fields; on skip, say the
     degradation in one sentence and move on.
  3. SAY: "This file is your pipeline's configuration — human-readable on
     purpose. Tell me in words what to change ('don't store raw recordings',
     'digests to #team-calls') and I'll edit it."
  4. [LLM] conversational edits to `tenant.yaml` on request →
     `[SCRIPT: validate-tenant.js]` after **every** edit; fix errors before moving on.

ARTIFACT: a validated `tenant.yaml` (validator output shown).
DO: `[SCRIPT: state.js set steps.b1 completed]`
TELEMETRY: `step_completed B1`

---

## Step B2 — Zoom S2S credentials                          [OPTIONAL | gate: b1 | skip → no capture webhook]

TELEMETRY: `step_started B2`
PREFLIGHT: `[SCRIPT: state.js get stack]` — when `stack.calls` ≠ `zoom`, open with
  **recognition, not a pitch**: *"At setup you said you record calls with <tool> — that
  connector is waitlist territory for now (demand noted at A0). Skip this step and keep
  feeding transcripts manually, or connect Zoom anyway?"* → on skip, jump to SKIP below
  with reason `<tool-slug>`.
SAY (zoom users): "Now the pipeline needs to hear about your recordings. Zoom setup is a
  ~10-minute checklist — it's the longest step; everything after is shorter."

DO:
  1. Walk `docs/zoom-s2s-setup.md` **one step at a time** (create Server-to-Server
     OAuth app → scopes → event subscription `recording.completed` → copy
     Account ID / Client ID / Client Secret / webhook Secret Token). **Leave the
     event-subscription endpoint URL blank for now** — the pipeline's n8n webhook URL
     doesn't exist until deploy (B6). B6 sends you back here to paste it and pass Zoom's
     validation handshake; that is the step that actually makes recordings arrive.
  2. Collect the four values into `.backbrief/secrets.env` (state the secrets
     rules — first secret collected here).
  3. `[SCRIPT: test-creds.js zoom]` — live: token grant + participants-API
     probe + webhook-secret shape. One sentence on why S2S matters: the plain
     webhook event carries no participant roster — this API is how the
     pipeline learns who was on the call.

ARTIFACT (P4): "✅ Zoom verified — token OK, participants API OK. (step B2 of B0–B8 done)"
ERROR: the script names the failing check (bad scope vs bad secret vs wrong
  account) and the checklist step to revisit — relay that, offer the §13 menu:
  retry / skip / manual / hands-on.
SKIP ("not on Zoom" / "later"): `[SCRIPT: state.js set steps.b2 skipped]` +
  `[SCRIPT: state.js set steps.b2_skip_reason <tool-slug|later>]`.
  No Zoom creds wired ⇒ deploy registers no capture webhook (capture-enablement
  is implicit in credential presence — no tenant flag). P3: "Pipeline runs on
  transcripts you feed it manually; auto-capture off. Using Meet/Teams? →
  connector waitlist." + demand capture
  (`[SCRIPT: telemetry.js event connector_demand --tool=<slug>]` +
  `[SCRIPT: state.js waitlist-observe <slug> --step B2]`).
DO (on success): `[SCRIPT: state.js set steps.b2 completed]`
TELEMETRY: `step_completed B2` | `step_skipped B2`

---

## Step B3 — Slack app                                     [OPTIONAL | flag: features.slack.enabled | gate: b1]

TELEMETRY: `step_started B3`
PREFLIGHT: `[SCRIPT: state.js get stack]` — when `stack.chat` ≠ `slack` (B1 already set
  `features.slack.enabled: false` from it), open with recognition: *"At setup you said
  the team lives in <tool> — that connector is on the waitlist. Keep digests
  vault-only (skip), or connect Slack anyway?"* → on skip, jump to SKIP below.
SAY (slack users): "~5 minutes: Slack gets the digest thread and the task
  Approve/Skip buttons."

DO:
  1. Guide: create the app **from the manifest**
     (`plugin/templates/slack-app-manifest.yaml` — paste-ready; walkthrough:
     `docs/slack-app-setup.md`), install to workspace, then copy **two** values into
     `.backbrief/secrets.env` (state the secrets rules — first Slack secret collected):
     - `SLACK_BOT_TOKEN` — the bot token (`xoxb-…`), from OAuth & Permissions.
     - `SLACK_SIGNING_SECRET` — the app's **Signing Secret** (Basic Information →
       App Credentials). This is **required** the moment interactivity is on: the
       taskcrafter interaction webhook verifies Slack's `X-Slack-Signature` (HMAC-SHA256
       over `v0:timestamp:body`) on every Approve/Skip click and rejects forged/stale
       requests. Without it the button endpoint cannot authenticate callers — do not
       skip it if you want the task buttons.
  2. ASK (Q1): "Which channel should call digests land in?
     (Enter = create/use `#call-digests`)" → write to `features.slack.digest_channel`.
  3. `[SCRIPT: test-creds.js slack]` — auth.test + scope check against the
     shipped manifest + **resolves every roster member's Slack user id**
     (`users.lookupByEmail` per profile email, `users.list` name-match fallback —
     cached in pipeline-state as `slack.user_ids`; this is what makes @mentions real)
     + resolves the channel id (cached) + posts a visible test message to the
     chosen channel. Relay any "email found via Slack" hints into the
     `team/<Lastname>.md` profiles.
  4. **Manual n8n credential (create it here — it isn't auto-created).** In the
     n8n UI: **Credentials → New → "Slack API"**, name it exactly **`backbrief-slack`**,
     paste the same `SLACK_BOT_TOKEN` (`xoxb-…`) as the Access Token, Save. The imported
     workflow nodes reference this credential by name; **you assign it to the flagged
     nodes in the n8n UI at B6 step 4** — `deploy-pipeline.js` never binds
     Slack/GitHub/Linear, it only prints one warning per unassigned node. (Only the
     Anthropic credential is auto-created and auto-bound; Slack/GitHub/Linear are
     created by hand in their own rung — this step is that step for Slack.)

ARTIFACT: the test message in their Slack — "check <#channel> — that's me" +
  "@mentions resolved for <N>/<M> roster members". (P4)
ERROR: script diagnosis (missing scope → reinstall app; `not_in_channel` →
  invite the bot); §13 menu: retry / skip / manual / hands-on.
SKIP ("we don't use Slack"): set `features.slack.enabled: false` +
  `[SCRIPT: state.js set steps.b3 skipped]` +
  `[SCRIPT: state.js set steps.b3_skip_reason <chat-tool-slug|no-slack>]`.
  P3, stated honestly: "Vault commits and per-call digests written into the
  vault keep working. But three workflows do **not** deploy at B6 — their
  gates require Slack: TaskCrafter (no automated task creation/approvals;
  the A3 file-only tasks in `tasks/*.tasks.md` remain), the feedback
  collector, and the error trap (no error DMs — failures are visible only in
  the n8n executions list). The Drive uploader is triggered from the Slack
  branch of the main workflow, so it goes dark too." + waitlist capture of
  their chat tool
  (§8: `connector_demand` + `state.js waitlist-observe <slug> --step B3`).
DO (on success): `[SCRIPT: state.js set steps.b3 completed]`
TELEMETRY: `step_completed B3` | `step_skipped B3`

---

## Step B4 — GitHub vault repo                             [OPTIONAL — heaviest skip | flag: vault.repo | gate: b1]

TELEMETRY: `step_started B4`
PREFLIGHT: `[SCRIPT: state.js get stack]` — when `stack.git` ≠ `github`, open with
  recognition: *"At setup you said <tool> — other git hosting is waitlist-only in v0.1
  (demand noted). Skip (local-only vault, the heaviest skip — I'll spell out the cost),
  or use GitHub just for this vault?"*
SAY: "The pipeline writes your vault through git — that's what makes the
  memory durable and portable. One access note: anyone you give **read access to this
  repo** can read the whole vault — every filed call — so grant collaborators
  deliberately (`docs/github-setup.md`)."

ASK (Q1): "Push the Phase-A vault to a **new private repo** (Enter), or give
  me an existing repo to use?" → default: new private repo

DO:
  1. Collect a fine-grained PAT with **contents: read/write on that one repo**
     (say exactly this scope) into `.backbrief/secrets.env` as `GITHUB_VAULT_PAT`.
  2. Init/remote/push the vault via capability `git.commit` (plain `git`).
     Confirm `.gitignore` excludes `.backbrief/secrets.env` **before** pushing.
  3. Record `vault.repo` ("owner/repo") + `vault.branch` in `tenant.yaml`.
  4. `[SCRIPT: test-creds.js github]` — PAT + push permission + branch commits
     + Git-Data (atomic commit) permission probe.
  5. In the n8n UI, create the **GitHub header credential** the workflow nodes
     reference (Credentials → new "Header Auth" named `backbrief-github`, header
     `Authorization: Bearer <GITHUB_VAULT_PAT>`) — you assign it to the flagged
     nodes in the n8n UI at B6 step 4 (deploy warns, it never auto-binds it).

ARTIFACT: the repo URL with the Phase-A history in it. (P4)
SKIP ("no GitHub"): `vault.repo: null` (local-only vault) +
  `[SCRIPT: state.js set steps.b4 skipped]` +
  `[SCRIPT: state.js set steps.b4_skip_reason <gitlab|other-slug|no-git>]`.
  P3, stated honestly: "⚠️ heaviest skip: the automatic pipeline can't write files
  to your machine, so vault writes go off; digests still reach Slack, tasks still
  work; manual mode keeps filing locally. GitLab/other git? → waitlist." + demand
  capture (GitLab's roadmap signal must not go uncounted):
  `[SCRIPT: telemetry.js event connector_demand --tool=<gitlab|slug>]` +
  `[SCRIPT: state.js waitlist-observe <slug> --step B4]` (GitLab is waitlist-only in
  v0.1 — adopted scope, don't re-open).
DO (on success): `[SCRIPT: state.js set steps.b4 completed]`
TELEMETRY: `step_completed B4` | `step_skipped B4`

---

## Step B5 — tracker credentials                           [OPTIONAL | flag: features.tracker.* | gate: b1]

TELEMETRY: `step_started B5`
Reuse `features.tracker.kind` from A3 — **don't re-ask**.
No-Slack tenant (`features.slack.enabled: false`) → frame it before collecting:
Linear creds here power the digest context lookups only (open issues per
participant); task automation (TaskCrafter) needs Slack in v0.1 and will not
deploy at B6.

DO (kind = linear):
  1. Collect the Linear API key (or reuse the MCP-era key) into
     `.backbrief/secrets.env` as `LINEAR_API_TOKEN`.
  2. `[SCRIPT: test-creds.js linear]` — viewer + resolves every
     `tracker_team_key` + one search query per team (team ids cached) +
     resolves roster members to Linear user ids (email first, name fallback —
     cached in pipeline-state as `tracker.users`; powers assignee resolution).
  3. Map tenant teams ↔ tracker teams: show the mapping table, CONFIRM, write
     to `features.tracker.team_mapping`, re-run `[SCRIPT: validate-tenant.js]`.
  4. In the n8n UI, create the **Linear header credential** the workflow nodes
     reference (Credentials → new "Header Auth" named `backbrief-linear`, header
     `Authorization: <LINEAR_API_TOKEN>`) — you assign it to the flagged nodes
     in the n8n UI at B6 step 4 (deploy warns, it never auto-binds it).

DO (kind = other — adopted v0.1 scope: no shipped adapter, no setup guide):
  1. Recognition, not a pitch: *"At setup you said tasks live in <tool> — no connector
     ships in v0.1 (demand noted). Tasks stay file-first (`tasks/*.tasks.md`); the
     skeleton is adaptable (`PRD.md`). Skip this step, or connect Linear anyway?"*
  2. On skip → the SKIP block below with reason `<tool-slug>`.

ARTIFACT: "✅ Tracker verified — <N> teams mapped." (mapping in tenant.yaml) (P4)
SKIP / other tool: `features.tracker.enabled: false` +
  `[SCRIPT: state.js set steps.b5 skipped]` +
  `[SCRIPT: state.js set steps.b5_skip_reason <tool-slug|file-only>]`.
  P3: "Tasks will be written to `tasks/` files per call instead." + waitlist
  capture of their tool (`state.js waitlist-observe <slug> --step B5`).
DO (on success): `[SCRIPT: state.js set steps.b5 completed]`
TELEMETRY: `step_completed B5` | `step_skipped B5` (+ prop `tracker: linear|other|none`)

---

## Step B5.5 — Anthropic API key                           [REQUIRED | gate: b1]

TELEMETRY: `step_started B5.5`
SAY: "One key the pipeline can't run without: every stage (digest, task extraction,
  dedup) calls the Anthropic API with **your** key — you own the model bill (typically
  cents per call). Two minutes: console.anthropic.com → API keys → Create key."

DO:
  1. Guide: create the key at `console.anthropic.com` (any billing-enabled account /
     workspace works); collect it into `.backbrief/secrets.env` as
     `ANTHROPIC_API_KEY` (secrets rules apply — stated at the first secret).
  2. `[SCRIPT: test-creds.js anthropic]` — live 1-token probe per configured `llm.*`
     stage with the tenant's exact thinking/effort params. On model-unavailable,
     relay the script's downgrade proposal (one ask), write the accepted choice back
     to `tenant.yaml`, re-validate.

ARTIFACT (P4): "✅ Anthropic verified — <N> model configs probed. (step B5.5 of B0–B8 done)"
ERROR: §13 menu — retry / (no skip: this rung is REQUIRED; parking deploy here is fine
  and resume returns to it) / manual (console walkthrough) / hands-on waitlist.
DO (on success): `[SCRIPT: state.js set steps.b5_5 completed]`
TELEMETRY: `step_completed B5.5`

---

## Step B6 — deploy + live test                            [REQUIRED | gate: b0, b1, b5_5 | the verified-deploy gate]

TELEMETRY: `step_started B6`
No user ask. SAY what's about to happen in two lines: import the workflow
skeletons → render your config + inject secrets → activate → assign the
manual credentials once in the n8n UI → fire a synthetic test call.

DO:
  1. `[SCRIPT: validate-tenant.js]` — final consistency (flags vs available creds).
  2. Re-run `[SCRIPT: test-creds.js all]` if anything changed since B5.5 — the
     Anthropic probe (B5.5) must be green before any import; `deploy-pipeline.js`
     creates the `backbrief-anthropic` n8n credential from the key automatically,
     the B3/B4/B5 n8n credentials were created in their rungs. (Enabling
     `features.drive.enabled` later needs a manual n8n credential: in the n8n
     UI create a **Google Drive OAuth2 API** (`googleOAuth2Api`) credential
     named **`backbrief-google-drive`** — the drive-uploader nodes reference it
     by that name; the n8n UI walks the OAuth consent flow, no shipped
     walkthrough doc.)
  3. `[SCRIPT: deploy-pipeline.js --import]` (first run; re-runs drop `--import`)
     — imports `pipeline/workflows/*.json` skeletons via the n8n API, renders
     TENANT regions, injects secrets from the environment/`.backbrief/secrets.env`,
     one atomic PUT per workflow, re-activates, records ids in
     `.backbrief/pipeline-state.json`.
  4. **Assign the manual credentials on the flagged nodes (one-time, n8n UI).**
     `deploy-pipeline.js` auto-creates and auto-binds **only**
     `backbrief-anthropic`; for Slack/GitHub/Linear it prints one
     `WARNING node "<name>" needs the "<cred>" credential assigned once in the
     n8n UI` line per node still carrying a placeholder (default workflow set:
     12 Slack, 5 GitHub, 2 Linear node refs). Open each imported workflow once
     in the n8n UI and pick the named credential (`backbrief-slack` /
     `backbrief-github` / `backbrief-linear` — created at B3/B4/B5) on every
     flagged node, then Save. **Success signal:** re-run
     `[SCRIPT: deploy-pipeline.js]` — it prints no more credential warnings.
     Only then continue to the selftest.
  5. `[SCRIPT: deploy-pipeline.js --selftest]` — signed synthetic webhook →
     asserts: execution success, idempotent re-POST short-circuits, (if Slack
     on) root post appeared, (if GitHub on) test commit landed; disabled
     components correctly no-op.
  6. **Register the capture webhook back in Zoom** — do this whenever Zoom was
     connected at B2. **Without it NO real recordings ever arrive**: Zoom has your app,
     but nothing tells Zoom where to send `recording.completed`, so the pipeline sits idle
     and the user hits "done" on a pipeline that receives nothing. `deploy-pipeline.js`
     just printed the pipeline's n8n **webhook URL** — send the user back to their Zoom
     S2S app to wire it up, one step at a time:
     a. Zoom Marketplace → your Server-to-Server OAuth app → **Feature → Event
        Subscriptions** → add/edit a subscription → paste the n8n webhook URL as the
        **Event notification endpoint URL**.
     b. Click **Validate**. Zoom immediately POSTs a CRC challenge (`endpoint.url_validation`);
        the pipeline answers it automatically (HMAC-SHA256 of Zoom's `plainToken` with your
        webhook **Secret Token**). **Success signal:** Zoom shows a green **"Validated"** —
        that is the handshake passing. (If it spins/errs, the endpoint URL is wrong, the
        workflow is inactive, or the Secret Token in `.backbrief/secrets.env` ≠ the app.)
     c. Ensure the subscription lists the **`recording.completed`** event, **Save**, and
        make sure the subscription is **enabled**.
     d. Send a test event: record a short test call ≥ `pipeline.knobs.min_duration_min`
        (or use Zoom's "send test event" if the app shows it). **Success signal:** within
        ~1–2 min a new transcript file lands in `<team>/transcripts/` and
        `[SCRIPT: status.js]` reports "last call processed" — that proves the loop end to end.
     ERROR (Validate fails): re-copy the webhook URL exactly / re-activate the workflow
     (`[SCRIPT: deploy-pipeline.js]`) / re-check the Secret Token
     (`[SCRIPT: test-creds.js zoom]`) — the same three-option error tone (§10).
  7. Point the Slack app's interactivity URL (if Slack on) at the printed n8n
     webhook URL (manifest placeholder → real URL), then optionally
     `[SCRIPT: deploy-pipeline.js --selftest-interactivity]` (human clicks Skip).
     (This is what activates the `X-Slack-Signature`-verified button endpoint —
     the `SLACK_SIGNING_SECRET` collected at B3 is what authenticates those clicks.)
  8. Offer `[SCRIPT: deploy-pipeline.js --selftest-cleanup]` to remove the
     synthetic Slack posts + revert the synthetic vault commit.
     (The secrets scrub is **not** offered here — it comes at HANDOFF, after
     B7/B8: this cleanup, `import-history.js` (B7), and `check-drift.js` all
     still need the local `.backbrief/secrets.env`.)

ARTIFACT: "🟢 Pipeline is live" report — per-component ✅/⏭(skipped) table +
  "your next recorded call will flow through automatically".
ERROR: any assert fails → name the failing component, then exactly three
  options: retry just that component (`--workflow <key>`) / flag it off in
  tenant.yaml and redeploy (graceful degradation, never all-or-nothing) /
  manual (n8n UI + `docs/n8n-hosting.md`). Rollback for a bad PUT: PUT back the
  snapshot from `.backbrief/snapshots/`.
DO: `[SCRIPT: state.js set steps.b6 completed]`
TELEMETRY: `step_completed B6`

---

## Step B7 — history import                                [OPTIONAL | flag: features.history_import.enabled | gate: b2, b6]

TELEMETRY: `step_started B7`
ASK (Q1): "Backfill the vault from Zoom Cloud recordings? How far back —
  30 (Enter) / 60 / 90 days, or skip?" → default: 30

DO:
  1. Set `features.history_import.enabled: true` + `days` in `tenant.yaml`.
  2. `[SCRIPT: import-history.js --days <n>]` — plan phase: lists recordings
     with per-call skip reasons (no transcript / too short). Show the plan;
     CONFIRM before importing. Remind in one line: imported calls land in
     team folders like any live call — leave out recordings you would not
     share vault-wide (privacy routing is not in v0.1).
  3. `[SCRIPT: import-history.js --days <n> --confirm]` — replays through the
     live webhook, throttled.

ARTIFACT: populated corpus + the import digest (calls found / filed / skipped /
  failed), saved via `--save`.
ERROR: single-call failures never abort the batch — the digest lists them;
  re-running `--confirm` is safe (the state machine dedupes filed calls).
SKIP: `features.history_import.enabled: false` +
  `[SCRIPT: state.js set steps.b7 skipped]` +
  `[SCRIPT: state.js set steps.b7_skip_reason <later|not-needed>]`.
DO (on success): `[SCRIPT: state.js set steps.b7 completed]`
TELEMETRY: `step_completed B7` | `step_skipped B7`; `calls_processed` (+ prop `count: <n>`)

---

## Step B8 — registration                                  [OPTIONAL | flag: none | gate: b6]

TELEMETRY: `step_started B8`
ASK (Q1): "Optional last step: leave an email to register this install — you
  get update pings and a hosted-waitlist priority slot. (Enter = skip, stays
  anonymous)" → default: skip

DO:
  1. On an explicitly typed email:
     `[SCRIPT: telemetry.js waitlist --interest=updates --source-step=B8 --email=<typed>]`
     (links `install_id` to the email — that is the whole point; say so).
     Update pings enabled; `check-update.js` gains the gateway channel when
     telemetry is on.
  2. On skip: say explicitly "staying anonymous — everything still works".
  3. SAY: "`/backbrief status` is your health check from here on."

ARTIFACT: registration confirmation, or the explicit staying-anonymous line.
DO: `[SCRIPT: state.js set steps.b8 completed]` (or `skipped`)
TELEMETRY: `step_completed B8` | `step_skipped B8`

---

## HANDOFF

**Secrets scrub — offer it now, deliberately last (after B7/B8):**
"Secrets are now inside your n8n. Wipe the local `.backbrief/secrets.env`?
(Enter = yes)". On yes, delete the file. Say the cost in one breath before
wiping: the pipeline itself keeps running (its secrets live inside n8n), but
the local tooling loses its env —
`deploy-pipeline.js --selftest-cleanup` needs `SLACK_BOT_TOKEN`/`GITHUB_VAULT_PAT`,
`import-history.js` exits 2 without the `ZOOM_*` vars, and `check-drift.js` /
any redeploy needs `N8N_API_KEY`. To use those tools again later, re-fill
`.backbrief/secrets.env` with the same keys. Never offer the scrub earlier in
the flow — running it before B7 or a drift check breaks them.

"Deploy done. Record a real call to see the full loop, then `/backbrief status`
any time." If any rung was skipped: SAY *"your deferred steps are written to
`.backbrief/roadmap.md`"* and **render that file's Deferred-steps section** (it already
carries the one-line degradation + the re-enable command per skip — regenerated
automatically on every state write; `[SCRIPT: state.js roadmap]` refreshes it on demand).
