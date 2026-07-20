<!-- SPDX-License-Identifier: MIT -->
# Privacy & consent

Call transcripts are among the most sensitive data a team produces: other people's
voices, HR matters, money, legal exposure. This page states what the kit does and does
not do with that data, and what *you* remain responsible for. It is not legal advice.

## Privacy routing is NOT in v0.1 — read this first

Privacy routing (auto-routing 1:1/board/legal calls into private slices, DM delivery,
confidential handling) is deliberately **not part of v0.1** — every call files into
team folders and posts to the digest channel. There is no `private/` folder, no
sensitivity classification, and no per-call access separation in the shipped kit.

Two practical consequences:

1. **Everyone with read access to the vault repo (and the digest channel) sees every
   filed call.** The access boundary is the repo and the channel — nothing finer.
2. **Don't feed calls you wouldn't share with that whole audience.** For 1:1s, board,
   legal, HR, comp: either don't record them, or don't hand the recording to the kit.

If your team needs privacy routing, say so (waitlist interest: `privacy` — the setup
flow captures it, or run
`node plugin/scripts/telemetry.js waitlist --interest=privacy --email=you@company.com`).
It exists in the reference production deployment and ships when demand shows.

## The architecture is the privacy policy

- **Backbrief does not record anyone.** The kit is **BYO-transcript**: it processes
  recordings and transcripts that already exist in *your* Zoom account (or that you
  export from another tool and hand to it). There is no Backbrief bot joining calls, no
  Backbrief capture, no Backbrief storage. Half the consent problem is removed
  structurally — but only half; see the consent section below.
- **Zero Backbrief servers touch your content.** Transcripts, digests, names, and vault
  paths flow only between systems **you** configure and own: your Zoom, your n8n, your
  Anthropic API key, your git repo, your Slack, your tracker. There is no Backbrief
  backend in the data path — ever.
- **Telemetry is opt-in, default no, and structurally content-free** — counters and step
  enums only, no free-text fields at all. Full spec: `docs/telemetry.md`; the gateway
  source is published in `gateway/` so the claim is auditable.
- **The one place an email is stored: the waitlist, and only if you submit it.** When you
  ask us to build a connector or host the pipeline (`telemetry.js waitlist --interest=… --email=…`),
  the row keeps your email + the interest + — if you also opted into telemetry — your
  anonymous `install_id`, so we can tie your request to where in setup it came from. The
  email is used only to contact you about that request; it is never joined to call
  content (there is none in the gateway) and never sold. Don't want the linkage? Submit
  the waitlist without telemetry enabled, or skip it and self-connect.
- **Secrets never live in config or the vault.** They stay in `.backbrief/secrets.env`
  (gitignored) and inside your n8n; the tenant validator hard-fails on token-shaped
  values in `tenant.yaml`.

## Where your call content actually goes (Phase B, everything enabled)

| Destination | What | Your control |
|---|---|---|
| Your git repo | digest `.md`; (if `raw_retention: vtt`) raw `.vtt` transcript; **committed team profiles** (`team/*.md` — names, roles, optional emails) and the **feedback training log** (`.backbrief/training/…` — task decisions + quotes, kept on purpose so the extractor learns) | repo access; `raw_retention: none` keeps digests only; profiles/training are plain files you can prune |
| Your Slack workspace | root post, digest thread, task proposals | `features.slack.enabled`; channel choice |
| Your tracker (Linear) | task titles/descriptions with transcript quotes | `features.tracker.enabled` |
| Anthropic API (your key) | full transcript text per call, for summarization/extraction | your key, your account. Per Anthropic's commercial terms, API inputs/outputs are not used to train models by default — verify the current terms yourself |
| Your n8n instance | **execution logs retain full transcript text** for the retention window (~30 days on cloud) | n8n account access — 2FA, minimal logins; this is the widest content surface in the system |
| Google Drive (optional, **off by default**) | MP4 recording archive | `features.drive.enabled`, domain-restricted folder |
| Zoom Cloud | the original recording (was there before the kit) | your Zoom retention settings |

What never appears in any of the above lists: any Backbrief-operated service.

## Recording consent — your obligations

Consent law is jurisdiction-dependent (one-party vs all-party consent states/countries;
GDPR requires a lawful basis for processing recordings of identifiable people). The kit
cannot make you compliant; these practices keep honest teams out of trouble:

1. **Turn on the platform's recording notice.** Zoom's recording disclaimer prompts every
   joiner to consent or leave — enable it (Account Settings → Recording). This is your
   single highest-leverage control.
2. **Announce it anyway.** "This call is recorded and summarized for the team" at the
   top of the call costs nothing and removes ambiguity — especially for phone/bridged
   participants who may not see the prompt.
3. **External participants: get explicit consent** and know your NDA obligations. In
   v0.1 an external participant's call files into a team folder like any other —
   nothing routes or restricts it for you; the asking (and any narrower handling) is
   on you.
4. **Interviews, 1:1s, HR, legal: keep them out of the kit.** There is no private
   routing in v0.1 — a sensitive call you feed in is as visible as any other. For the
   most sensitive conversations, the correct setting is: **don't record them** (or at
   least don't hand the recording to the kit).
5. **History import (B7) re-processes old recordings.** The consent basis that covered
   the original recording must cover this processing too — and every imported call
   lands team-visible. Review the import plan before confirming; leave out anything
   you would not share vault-wide.
6. **Have a one-paragraph internal policy** (what's recorded, where summaries go, who
   can read the vault, how to opt a call out) and link it in your Slack digest channel
   topic.

## Vault access is the confidentiality model

In v0.1 the vault is **one shared surface**: everyone with read access to the repo sees
everything in it. That model is honest as long as repo access matches it:

- Keep the vault repo **private**; add collaborators deliberately
  (`docs/github-setup.md`).
- **Git history is retroactive** — a later cleanup does not un-share what was committed
  before. Decide the audience before you widen access.
- Finer-grained separation (private slices for 1:1/board/legal with their own access
  boundary) is exactly what the privacy-routing feature adds — waitlist interest:
  `privacy`.

## Data minimization knobs

| Knob | Effect |
|---|---|
| `features.raw_retention: none` | digests only; raw transcripts are discarded after processing |
| `features.drive.enabled: false` (default) | no MP4 archive is made |
| feed selectively | the kit only ever sees the transcripts you (or your Zoom webhook) hand it — not recording a call, or not importing it at B7, is full opt-out |
| n8n execution-log pruning | shorten the window during which transcripts are readable in execution logs |

## Deletion requests

To remove a person's data: delete the relevant vault files (git-tracked, so use history
rewriting or a fresh-history export if the deletion must be thorough), delete the raw
recording in Zoom/Drive, and remember n8n execution logs age out on their own. The kit
keeps no copy anywhere else — that is the point of owning the corpus.
