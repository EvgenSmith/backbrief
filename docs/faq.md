<!-- SPDX-License-Identifier: MIT -->
# FAQ

## General

**What is Backbrief, in one sentence?**
A kit that turns your team's call transcripts into tracked tasks and a company memory
vault — plain markdown in your own git repo, tasks in your own tracker — starting manual
in ~15 minutes, graduating to a fully automatic pipeline.

**What does it cost?**
The kit is free forever. Phase A runs on your existing Claude subscription (no API key).
Phase B costs you: your n8n (cloud plan or a small VPS) and your own Anthropic API usage
per call. There is no Backbrief fee and no Backbrief server.

**Why free? What's the catch?**
No catch, but no altruism either: the kit builds an audience and a waitlist for a future
hosted version. Since you bring your own keys, giving the kit away costs us nothing —
and the opt-in telemetry (counters only, see `docs/telemetry.md`) tells us what to build
next.

**I don't have a terminal / I'm not technical. Can I still get this?**
Not the kit — it needs Node and a filesystem (see the README's "Where you can run
it"). The hosted version is what you want: join the waitlist from any browser at
<https://backbrief-telemetry.backbrief.workers.dev/waitlist>, no setup required.

**What's actually the artifact? Another meeting summary?**
No. The main artifact is **team context**: what's happening, what was agreed
(a dedicated Agreements section — the thing teams lose most often), next steps and on
whom — each anchored with (MM:SS) links back into the call. Tasks in the tracker are the
operational projection of that context, deduplicated against your live backlog.

## Privacy & data

**Does any of my call content reach Backbrief servers?**
No. There are no Backbrief servers in the data path. Content flows only between systems
you configure: your Zoom, your n8n, your Anthropic key, your git repo, your Slack, your
tracker. Details and the full data-flow table: `docs/privacy-and-consent.md`.

**What about telemetry?**
Opt-in, default no, structurally content-free (counters and step enums; the gateway has
no free-text field and its source is published in `gateway/`). See `docs/telemetry.md`.

**Does it route 1:1/board/legal calls somewhere private?**
No — deliberately not in v0.1. There is no privacy routing: every call files into a
team folder and posts to the digest channel, and everyone with vault-repo read access
sees every filed call. Don't feed calls you wouldn't share with that whole audience.
The feature (auto-routing sensitive calls into private slices with DM delivery) exists
in the reference production deployment and ships when demand shows — say so during
setup (waitlist interest: privacy). Details: `docs/privacy-and-consent.md`.

**Does Backbrief record my calls?**
No. It is BYO-transcript: it processes recordings your own tools already made (Zoom Cloud
Recording, or exports from Fireflies/Otter/Granola pasted in manually). Recording-consent
obligations stay yours — see `docs/privacy-and-consent.md`.

## Requirements & compatibility

**What do I need for Phase A (manual mode)?**
Claude Code with a Claude subscription (or any AGENTS.md-convention agent, e.g. Codex),
Node ≥ 18, git, and 3–5 recent call transcripts. No API keys, no servers. ≤15 minutes to
the first filed transcripts and digest.

**And for Phase B (automatic pipeline)?**
Everything above plus: an n8n instance (cloud trial or Docker — `docs/n8n-hosting.md`),
Zoom with Cloud Recording (`docs/zoom-s2s-setup.md`), and your own Anthropic API key.
Slack, GitHub, and Linear each take ~5 minutes and each is individually skippable.
Guided deploy budget: ≤60 minutes.

**I don't use Zoom. Am I stuck?**
For *automatic capture*, Zoom is the only shipped source in v0.1. Manual mode accepts
transcripts from anywhere (`.vtt`, `.txt`, `.md`, Zoom/Fireflies exports). Google
Meet/Teams capture is a planned fast-follow — naming your tool during setup puts it on
the counted waitlist that orders that roadmap.

**Which trackers are supported?**
Linear ships as the full connector (`docs/linear-setup.md`). Anything else — Jira
included — is file-only tasks in v0.1 (`tasks/*.tasks.md` with paste-ready blocks) plus
a counted connector-waitlist entry; no adapters or setup guides for other trackers
ship. The skeleton is yours to adapt (`PRD.md` is the rebuildable spec).

**No Slack?**
Digests are still generated per call and stay in the vault; task approval falls back to
chat with your agent (file-only tasks, A3). To be precise about what switches off:
TaskCrafter proposals, the feedback collector, and the error-DM trap don't deploy —
their delivery surface is Slack in v0.1 (the deploy says so per workflow) — and the
optional Drive archive plus part of the duplicate-webhook fast-path ride the Slack
branch today (redeliveries are still caught at the commit stage; nothing is written
twice). Your chat tool goes on the waitlist if you name it.

**GitLab instead of GitHub?**
Waitlist-only in v0.1. Without a git remote the vault stays local (manual mode fully
works); the automatic pipeline needs GitHub for vault commits in this release.

**Which languages work?**
Conversation mirrors your language (EN and RU are first-class, shipped as language
packs). Digest/task narrative follows the language of the call; all structure
(frontmatter keys, filenames, enums) stays English — that's what keeps the vault
greppable and agent-readable. One honest caveat: the Slack digest chrome (buttons,
section labels, footer) stays English in v0.1 — the narrative mirrors the call
language, but UI strings are only partially translated.

**Does it work outside Claude?**
Yes — the procedures are agent-agnostic. Codex (or any agent honoring `AGENTS.md`) runs
the same flows via the root `AGENTS.md` router. Claude Code just gets the nicest
packaging (plugin + skills).

## Using it

**Can I stop at any step?**
Yes — that's a design rule. Every step ends with an artifact you keep, and every
component is a feature flag: stop after A1 and you have a vault with digests; skip Slack
and digests stay in the vault; skip the tracker and you get task files. Nothing breaks
when something is off.

**What happens if I uninstall?**
Nothing dramatic — the point of the design. Your vault is plain markdown/YAML in your own
repo, tasks are in your tracker, and the kit holds no state of its own. Delete the plugin
tomorrow; everything it made remains yours.

**Can I edit the templates and prompts?**
Yes. Vault conventions live *in your vault* and are yours to edit — the pipeline reads
your copies: `docs/conventions.md` (the writing contract, one WHY per rule),
`docs/templates/` (frontmatter templates + the controlled vocabulary, copied in at init),
`docs/company.md` (your company profile), the summarizer style doc
(`docs/skills/summarizer.md`), and `AGENTS.md`. Tuning knobs (thresholds, models, caps)
live in `tenant.yaml` with production-calibrated defaults.

**Why are the conventions the way they are (spaces in filenames, closed frontmatter,
lastname tokens)?**
Every rule carries a one-line WHY right next to it in `docs/conventions.md` in your vault,
and the shipped frontmatter templates carry a "WHY THIS SHAPE" note — together they are
the full, self-contained rationale you need to run or adapt the kit.

**What are the L0/L1/L2 autonomy levels?**
L0 (every task proposal needs an Approve/Skip click) is what **v0.1 ships**. L1
(auto-create high-confidence tasks, buttons only for the rest) and L2 (autopilot,
buttons only on flagged cases) are **reserved for a future release** — the
`autonomy_level` knob is parsed but not yet enforced (see PRD §12). The Approve/Skip
clicks are still logged as a training signal, so those higher levels can be earned by
your own measured acceptance rate once they ship.

**How much does a call cost in API tokens (Phase B)?**
Rough shape: the summarizer reads the transcript (capped at ~60K characters by default);
the dedup matcher is the most expensive stage (it runs on the strongest model over your
backlog candidates — its input was aggressively compacted for exactly this reason); the
composer runs on a small model. Every model is swappable per stage in `tenant.yaml`
(`llm:` block) with documented downgrade trade-offs. (Per-stage token metering surfaced
in `/backbrief status` is planned — not in v0.1.)

**How do updates work?**
`claude plugin update backbrief` or `git pull`. The kit holds no state (everything lives
in your vault), so updating is always safe; after a kit update, re-running
`deploy-pipeline.js` migrates the live pipeline (idempotent, snapshot-first, drift-checked).
`/backbrief status` tells you when a newer version exists.

**Something failed mid-pipeline. Did I lose the call?**
Designed not to: failures land in a durable DLQ (`pipeline/dlq/<date>/` in your vault
repo) plus a DM to the owner, and `redrive-dlq.js` recreates the lost artifacts. An LLM
outage degrades to a stub digest rather than dropping the call. `/backbrief status` shows
DLQ entries and offers the redrive. See `PRD.md` §8.

**Where do I get help?**
GitHub Issues on this repo. Include `/backbrief status` output (it contains no call
content) — it answers the first five questions we'd ask.
