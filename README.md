<!-- SPDX-License-Identifier: MIT -->
# Backbrief

**Turn your team's call transcripts into tracked tasks and a company memory vault — plain markdown in your own git repo, tasks in your own tracker.**

Backbrief is a free, MIT-licensed Claude Code plugin — and an agent-portable kit designed to run under any `AGENTS.md`-convention agent (a Codex entrypoint ships; designed, not yet field-tested). Bring your own Claude subscription or API key; there are **zero Backbrief servers** in the loop. Start manual: your first filed transcripts and context digest in ≤15 minutes and at most 5 questions. Graduate when ready: a guided ~60-minute deploy turns the same conventions into a fully automatic pipeline on your own n8n.

Two things to know up front:

- **It is an opinionated kit.** It ships pre-wired for one recommended stack — Zoom cloud recordings → git vault on GitHub → Slack digests → Linear tasks, with an optional Google Drive recording archive, orchestrated by your own n8n — because that is the exact stack it ran on in production for 3.5 months and 200+ calls. See [The recommended stack (and why)](#the-recommended-stack-and-why).
- **It is deliberately a strong skeleton, not a polished product.** The durable value is the conventions, templates, procedures, and the single-file pipeline spec ([`PRD.md`](PRD.md)) — portable enough to hand to any competent AI and say "rebuild this on my stack". The reference implementation automates the recommended stack; the skeleton is yours to adapt.

The main artifact is not a summary. It is **team context**: what's happening, what was agreed, next steps and on whom — with (MM:SS) deep links back into the call.

## What it actually produces

Four files in your own repo, plus what lands in your team's chat. Every shape below is the real output shape — filled in on a fictional team.

<details open>
<summary><b>1. The vault</b> — created in step A0, before you've fed it anything</summary>

```
acme-vault/
├── AGENTS.md              ← the rules your agents inherit (what may be written, where)
├── README.md
├── tenant.yaml            ← your config: teams, roster, channels, feature flags
├── .gitignore             ← keeps .backbrief/secrets.env out of git from the first commit
├── docs/
│   ├── company.md         ← what your company does — injected into every future digest
│   ├── conventions.md     ← the writing contract: naming, frontmatter, vocabulary
│   ├── skills/summarizer.md
│   └── templates/         ← digest · transcript · tasks · team-profile · task-4block
├── team/                  ← one file per person (step A2)
├── product/
│   ├── README.md
│   └── transcripts/       ← one .md per call, + optional .vtt sibling
├── engineering/transcripts/
├── growth/transcripts/
├── general/transcripts/   ← the mixed route: calls that belong to no single team
├── tasks/                 ← one .tasks.md per call — the audit trail
└── .backbrief/
    ├── roadmap.md         ← every step you skipped, what it costs, how to resume
    └── training/          ← your Approve/Skip decisions, local, yours
```

Team folders are created as they emerge — a solo vault gets `general/` only. No database, no lock-in: it's markdown in a git repo you own.
</details>

<details>
<summary><b>2. A filed call</b> — frontmatter an agent can query, body a human reads</summary>

```yaml
---
type: transcript
team: product
topic: "Pricing model review"
date: 2026-07-10
duration_min: 47
participants: [Ivanova, Petrov]        # canonical lastnames, not raw display names
external_participants: [Smith]
recording_url: "https://example.zoom.us/rec/share/EXAMPLE"
action_items:                          # agent-readable mirror of the body
  - title: "Rewrite pricing page copy for the self-serve tier"
    owner: Ivanova
    status: post-call
    priority: high
    ts: "14:32"                        # anchor back into the recording
    tracker_ref: GRW-214               # filled in once the issue exists
---
```

```markdown
## Summary

### Self-serve tier pricing (12:04)
- Current $49 floor blocks the SMB segment; **$19 entry** proposed, **60-day** trial
- Petrov: migration for **existing annual plans** is the open risk

## Decisions
1. Ship the $19 self-serve tier before the Q3 campaign — the campaign
   creative already assumes it (16:40)

## Agreements
1. Ivanova ↔ Petrov: pricing page copy freezes Friday so eng can cut the
   release branch Monday (22:15)

## Next steps
### 📋 Post-call
1. Rewrite pricing page copy for the self-serve tier — **Ivanova** _[high]_ (14:32)
   > "we need to rewrite pricing for self-serve by Friday"

### 👀 Monitoring
1. Annual-plan migration path, until the release branch cuts — **Petrov** (22:40)
```

**Decisions ≠ Agreements ≠ Next steps.** Agreements — who owes what to whom — are what teams lose most often, and they never become tickets. Every anchor is real or absent; one fabricated timestamp kills the deep-link promise.
</details>

<details>
<summary><b>3. The task pass</b> — checked against your live backlog <i>before</i> anything is created</summary>

**4 tasks → `tasks/2026-07-10 1300 pricing model review w Ivanova,Petrov.tasks.md`**

| # | task | owner | prio | verdict |
|---|---|---|---|---|
| 1 | Rewrite pricing page copy for the self-serve tier | Ivanova | high | ✏️ **CREATE** → GRW-214 |
| 2 | Pricing revamp — call adds a Friday deadline + owner | Ivanova | — | 💬 **COMMENT** on GRW-180 |
| 3 | Update the billing FAQ | ? | med | ⚠️ **FLAG** — 60% like GRW-102, owner unresolved |
| 4 | Ask legal about the annual-plan wording | Petrov | med | ✏️ **CREATE** (file-only) |

Row 2 is the point: the call restated an issue that already existed, so it gets a comment, not a duplicate. Row 3 is unsure and says so instead of guessing. In v0.1 nothing reaches your tracker without your approval — and every decision, including the ones you skip, is logged to `.backbrief/training/` on your own disk, as this team's private signal for raising autonomy in a later release.

Without a tracker connected the same file *is* the deliverable: each accepted task carries a copy-paste-ready block.
</details>

<details>
<summary><b>4. A person</b> — why "Masha", "М. Иванова" and "@maria" stop being three people</summary>

```yaml
---
type: member
lastname: Ivanova
first_names: [Maria]
aliases: [Masha, Маша, Маше, Маши, "Maria I.", "@maria"]   # every form heard on calls
role: "Growth Lead"
team: growth
zones: [onboarding-emails, paid-acquisition, landing-pages]
typical_partners: [Petrov, Sidorova]
languages: [en, ru]
status: draft            # → confirmed once she reviews her own file
---
```

Built from Slack / your tracker / docs you upload — or five questions if you'd rather connect nothing. Responsibility zones come with the call quote that evidenced them; anything inferred is marked as inferred. No compensation, performance, or HR data — ever.

</details>

<details>
<summary><b>5. What the team sees</b> — the two-phase Slack thread (pipeline only)</summary>

Zoom finishes the recording immediately but takes 15–60 min to produce the transcript. Waiting for both would mean nothing appears for an hour, so delivery is split — and the split is a state machine, not a retry loop: the same call arriving twice never posts twice.

**~1 minute after the call — root post:**

```
Title: [Pricing model review]
Duration: [47 min]
Started at [Jul 10, 13:00 GMT-4]
Organizer: [maria@acme.dev]
Recording: https://example.zoom.us/rec/share/EXAMPLE
```

**When the transcript lands — reply in that same thread:**

```
> Participants: Maria Ivanova, Ivan Petrov

💬 Summary
   Self-serve tier pricing (12:04) — $49 floor blocks SMB; $19 entry proposed…
   Migration risk (22:15) — existing annual plans need a path before launch

✅ Decisions (1)
   Ship the $19 self-serve tier before the Q3 campaign (16:40)

👀 Monitoring (1) — ongoing observation
   Annual-plan migration path, until the release branch cuts — Petrov (22:40)

📁 Vault: 2026-07-10 1300 pricing model review w Ivanova,Petrov.md
_via Backbrief_
```

Every post comes from your own **@Backbrief** bot in your own workspace and carries the `via Backbrief` footer. Task proposals arrive as a separate message with Approve / Skip buttons — those clicks are what write to your tracker.

Skip Slack entirely and everything still files to the vault; the digest simply lives in git instead of a channel.

</details>

## Quickstart (3 lines — pick one)

```bash
claude plugin marketplace add EvgenSmith/backbrief && claude plugin install backbrief   # Claude Code → NEW session → /backbrief:start
git clone https://github.com/EvgenSmith/backbrief && cd backbrief && codex             # Codex / any AGENTS.md agent → say "set up backbrief" (designed, not yet field-tested)
git clone https://github.com/EvgenSmith/backbrief                                      # manual → follow plugin/procedures/start.md yourself
```

No terminal? The kit needs one (see [Where you can run it](#where-you-can-run-it)) — or join the hosted-version waitlist from any browser: <https://backbrief-telemetry.backbrief.workers.dev/waitlist>.

## Install via marketplace (Claude Code)

```bash
claude plugin marketplace add EvgenSmith/backbrief
claude plugin install backbrief
```

Plugins load at session start — run the install from your shell, then launch `claude` (or, if you installed from inside a running session, open a **new** session first): `/backbrief:start` won't exist in the session you installed from.

The plugin cache carries Phase A (skills, procedures, templates, scripts); the Phase B deploy tooling additionally needs the full kit checkout: `git clone https://github.com/EvgenSmith/backbrief`.

Then invoke the skills — each one asks one thing at a time, ends every step with a visible artifact, and lets you skip any step:

| Skill | Steps | What it does |
|---|---|---|
| `/backbrief:start` | A0–A1 | Initialize the vault, file your first call transcripts, produce the first context digest |
| `/backbrief:profiles` | A2 | Build team profiles from Slack / tracker / docs (or a 5-question form) |
| `/backbrief:tasks` | A3–A4 | Extract tasks from calls, dedup against your live backlog, before/after demo |
| `/backbrief:deploy` | B0–B8 | Guided deploy of the automatic pipeline to your own n8n |
| `/backbrief:status` | — | Pipeline health, drift check, DLQ peek, deferred-steps roadmap, update check |

Prerequisites: Node ≥ 18 and git. Claude Code with a Claude subscription (Phase A needs no API key at all — the agent itself is the LLM), or any AGENTS.md-capable agent (see [Where you can run it](#where-you-can-run-it)). Phase B additionally needs your own n8n (cloud trial or Docker) and your own Anthropic API key.

## The recommended stack (and why)

Backbrief is opinionated on purpose: these six defaults are the stack the pipeline ran on in production, and every threshold and failure-handling rule in the kit was calibrated there.

| Tool | Role | Why this default |
|---|---|---|
| **Zoom** (cloud recording + audio transcript) | capture | the `recording.completed` webhook plus Zoom's built-in `.vtt` transcription is the pipeline's only trigger — no Backbrief bot ever joins your calls (`docs/zoom-s2s-setup.md`) |
| **Google Drive** (optional, off by default) | recording archive | two jobs: permanent recording links (Zoom share links expire in ~24 h) and keeping MP4/`.vtt` bulk **out of the vault and out of your agent's context window** — the vault stays plain text an agent can grep and load without spending tokens on media |
| **Git vault on GitHub** | memory | conventions, profiles, transcripts, and digests as plain markdown with history, diffs, backup, and access control you own; the pipeline writes each call as one atomic commit (`docs/github-setup.md`) |
| **Slack** | delivery | digests land where the team already is: root post in ~1 min, digest thread, Approve/Skip task buttons — every post comes from the **@Backbrief** bot and carries a "via Backbrief" footer (`docs/slack-app-setup.md`) |
| **Linear** | tasks | the only tracker with a full v0.1 connector: live-backlog dedup, one-click create/comment, per-team learning from your Approve/Skip decisions (`docs/linear-setup.md`; any other tracker = file-only tasks + counted waitlist) |
| **n8n** (yours: cloud trial or Docker) | orchestration | an always-on, webhook-driven runtime you can own outright for ~$5/mo; the deploy scripts drive it through its API (`docs/n8n-hosting.md`) |

**Your stack differs?** Every setup step offers the same four choices:

1. **Use the recommended tool** — the wired golden path above.
2. **Skip it** — the step is recorded in your vault's `.backbrief/roadmap.md` with a one-sentence note on what degrades and the exact command to resume later. Never a dead end.
3. **Bring your own tool** — an honest "adapt the skeleton" pointer ([`PRD.md`](PRD.md) is the rebuildable spec), plus a counted connector-waitlist entry so demand decides what gets built next. No half-built adapters or setup guides for tools outside the stack.
4. **"Set it up for me"** — the hosted waitlist (in-flow, or from any browser: <https://backbrief-telemetry.backbrief.workers.dev/waitlist>).

For a full rebuild on a different stack, [`PRD.md`](PRD.md) is the spec: hand that one file to a competent team or AI and rebuild the pipeline 1:1. `pipeline/` is the reference implementation of the recommended stack — not the only possible one.

## Where you can run it

Hard requirement on every surface: **a filesystem and Node ≥ 18**. Backbrief builds a vault of files and its scripts run in a terminal — a browser tab alone cannot hold it.

| Surface | What works | What doesn't | Status |
|---|---|---|---|
| **Claude Code** (CLI or IDE terminal) | everything: skills, procedures, scripts, pipeline deploy | — | **tested** — the surface the kit is built and verified on |
| **Codex CLI / other `AGENTS.md` agents** (Cursor, Amp, …) | the same procedures via [`AGENTS.md`](AGENTS.md) routing + CLI fallbacks (`curl`, `node`) | no plugin packaging — the agent reads the procedure files directly | **designed, not yet field-tested** — it should work by construction; please report what breaks |
| **claude.ai chat** (or any browser-only chat) | read-only guidance: paste a transcript plus `plugin/templates/frontmatter/digest.md` into the chat and get a Backbrief-formatted digest back to keep | the kit itself — no filesystem and no Node means no vault, no state, no scripts, no deploy | **not supported** for the kit proper; preview the digest format here, then install Claude Code — or skip the terminal entirely: [hosted waitlist](https://backbrief-telemetry.backbrief.workers.dev/waitlist) |
| **Manual** (you + any agent with shell and file access) | clone the repo and walk `plugin/procedures/*.md` step by step | nothing — you drive | supported by design; the procedures are plain markdown |

## What v0.1 is (and is not)

- **Production-tested core:** capture → vault → Slack digest → Linear tasks with live-backlog dedup ran for 3.5 months / 200+ calls on the recommended stack before being generalized into this kit.
- **Known constraints are documented, not hidden:** [`PRD.md`](PRD.md) §12 is the honest ledger — platform gaps, an accepted state race, two dead-by-construction discriminator patterns, a non-functional `update_status` intent.
- **Connector reality:** Linear is the only full tracker connector. Any other tracker (Jira included), GitLab, and other tools are counted-waitlist entries, built when demand says so — no adapters or setup guides for them ship in v0.1.
- **No privacy routing in v0.1:** auto-routing 1:1/board/legal calls into private slices, DM delivery, and confidential handling are deliberately not shipped — every call files into team folders and posts to the digest channel, and everyone with vault-repo read access sees every filed call. It exists in the reference production deployment and ships when demand shows (waitlist interest: privacy). See `docs/privacy-and-consent.md`.
- **Launch surfaces:** Claude Code is tested; the Codex/`AGENTS.md` path is designed but not yet field-tested (see the matrix above).

## Privacy stance

This segment is privacy-sensitive, so the promise is structural, not aspirational:

- **Your content never leaves your infrastructure.** Transcripts, names, and vault paths go only to endpoints *you* configure: your git remote, your Slack workspace, your tracker, your n8n, your Anthropic API key.
- **BYO keys, zero Backbrief servers.** There is no Backbrief backend processing your data — ever. The only outbound calls the kit itself can make are optional and content-free-by-design: an opt-in anonymous telemetry ping + update check (declined → the kit calls nothing but the GitHub Releases API), and, if you don't skip it, a one-time fetch of *your own* company website during setup to draft your company profile (via the agent's web tool, on a URL you control). Your call transcripts, summaries, and tasks are processed only by your own Anthropic key in Phase B.
- **Telemetry is opt-in, default no, and structurally content-free.** You are asked once, in plain words, during setup. If you decline, the kit makes zero calls to our gateway (update checks fall back to the GitHub Releases API). If you opt in, events are counters and step enums only — the gateway API has no free-text field and rejects unknown keys. The full allowlist is published in [`gateway/schema.md`](gateway/schema.md), and the ~450-line worker that receives events lives in [`gateway/`](gateway/) — audit it: the code that receives your telemetry cannot accept content.
- **Secrets never live in config.** Credentials stay in your environment / `.backbrief/secrets.env` (gitignored); the tenant-config validator hard-fails on token-shaped values.

One honest limitation, stated up front: **privacy routing is not in v0.1** — there are no private slices and no per-call access separation; the whole vault is one shared surface. Don't feed calls you wouldn't share with everyone who can read the vault repo. Recording third parties may require their consent in your jurisdiction — see `docs/privacy-and-consent.md` for both.

## Trust & audit

Auditing third-party skills before running them is the right habit — ours included. The kit is built to make that audit short:

- **Zero npm dependencies.** Everything under `plugin/scripts/` is plain Node ≥ 18 stdlib — no install step, no supply chain to poison.
- **Small, single-purpose surface.** ~20 scripts plus plain-JavaScript pipeline nodes in `pipeline/code/` — readable in one sitting.
- **No hidden network.** The only outbound calls are the two disclosed above (opt-in telemetry / update check, and the setup-time fetch of your own company site you can skip); the gateway that receives telemetry is published in [`gateway/`](gateway/).
- **Ask your agent.** Before your first run, tell it: *"Read `plugin/scripts/` and `plugin/procedures/` and tell me what each script does, what it writes, and where anything is sent."* The kit is small enough for that answer to be complete.

## Take what you want

The plugin is the convenient wrapper, not the value. Every piece below stands alone — use it without ever installing anything:

- **Conventions + templates** — the vault writing contract, frontmatter templates, controlled vocabulary, and vault skeleton (`plugin/templates/`, copied into every vault as `docs/conventions.md` + `docs/templates/`)
- **Procedures** — `plugin/procedures/*.md`: the step-by-step playbooks, readable by any agent or human
- **The spec** — [`PRD.md`](PRD.md): the single-file rebuildable pipeline spec; hand it to any competent AI and rebuild on your own stack

## Repo layout

```
plugin/      Claude Code plugin: skills, agent-agnostic procedures, templates, zero-dep scripts (MIT)
pipeline/    generalized n8n automation — workflows, code nodes, fixtures (BSL 1.1)
gateway/     telemetry gateway source, published for transparency (MIT)
site/        product landing page: static, zero-dependency, Cloudflare Pages (MIT)
docs/        setup checklists (Zoom, Slack, GitHub, Linear, n8n hosting), privacy, FAQ (MIT)
AGENTS.md    entrypoint for Codex and other AGENTS.md-convention agents (designed, not yet field-tested)
```

## Licensing

**Everything you and your agent touch is MIT. The n8n automation is source-available (BSL): free to run for yourself, not free to resell as a service.**

- Root [`LICENSE`](LICENSE) (MIT) covers the whole repository **except** the `pipeline/` directory.
- [`pipeline/LICENSE`](pipeline/LICENSE) is the Business Source License 1.1: production use is permitted, including internal/self-hosted use for your own organization; offering the pipeline (or a derivative) as a hosted or managed service to third parties is not. Each release converts to Apache-2.0 four years after it ships.
- Every source file carries an SPDX header (`MIT` or `BUSL-1.1`); see [`CONTRIBUTING.md`](CONTRIBUTING.md).

## Versioning

Single source of truth: the [`VERSION`](VERSION) file (SemVer). The plugin manifest and release git tags must match it (CI-enforced). Changes are tracked in [`CHANGELOG.md`](CHANGELOG.md). Update with `claude plugin update backbrief` or `git pull` — the kit holds no state, so updating is always safe; your state lives in your vault (`tenant.yaml`, `.backbrief/`).
