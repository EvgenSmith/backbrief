---
# ============================================================================
# Backbrief transcript frontmatter — spec v1 (schema_version: 1)
# One call = one .md: this frontmatter head + the digest body (digest.md
# template) + an optional identically-named .vtt sibling.
# Keys are a CLOSED SET per schema_version — the validator rejects unknown
# keys. Enum values: frontmatter/controlled-vocabulary.yaml. All keys and
# enum values are English tokens; narrative values (topic, action-item
# titles) follow the call's language.
# Example values below describe a fictional team.
# ============================================================================

# --- identity (required) ---
type: transcript                # fixed
schema_version: 1               # frontmatter spec version; migrations bump it
team: product                   # one of tenant.yaml vault.teams[].tag, or the mixed tag
topic: "Pricing model review"   # human-readable, call's language OK
date: 2026-07-10
time: "13:00"                   # tenant-local, quoted
duration_min: 47
participants: [Ivanova, Petrov] # canonical Latin lastnames (roster tokens)
language: en                    # dominant call language, ISO 639-1
source: zoom                    # transcript origin, enum controlled-vocabulary.yaml
digest_version: v0              # v0 = pre-profiles, v1 = regenerated with team context

# --- provenance (required when auto-filed; omit for manual filing) ---
filed_by: plugin                # manual | plugin | pipeline
filer_model: claude-sonnet-4-6  # model that wrote the digest
pipeline_version: "0.1.0"       # kit VERSION that produced the file
source_id: "EXAMPLEmeetingUUIDx0token9w=="   # platform-native id (e.g. Zoom meeting UUID) — replay/dedup key

# --- optional ---
sub_tag: null                   # subteam tag when the team has vault.teams[].subteams[]
platform: zoom                  # where the call happened, enum controlled-vocabulary.yaml
call_type: review               # enum controlled-vocabulary.yaml
tags: [pricing, self-serve]     # freeform kebab-case EN; extend per AGENTS.md rule
external_participants: [Smith]  # non-roster attendees, Latin
recording_url: "https://example.zoom.us/rec/share/EXAMPLE"  # share URL; enables clickable (MM:SS) deep links
transcript_file: "2026-07-10 1300 pricing model review w Ivanova,Petrov.vtt"  # sibling, when raw_retention >= vtt
references_prior_calls:         # vault-relative paths, max 5 — the context the digest was built on
  - "product/transcripts/2026-06-12 1300 pricing v1 kickoff w Ivanova.md"

# --- action items mirror (agent-readable projection of the body; quotes stay in the body) ---
action_items:
  - title: "Rewrite pricing page copy for the self-serve tier"
    owner: Ivanova              # roster lastname or null
    helpers: [Petrov]
    status: post-call           # post-call | done-on-call | monitoring
    priority: high              # low | medium | high | urgent
    ts: "14:32"                 # MM:SS anchor into the call
    tracker_ref: null           # filled by A3 when a tracker issue is created/commented (e.g. "LIN-142")
---

<!-- Body: the context digest — see frontmatter/digest.md for the template.
     Field rules (validator-enforced):
     1. `participants` uses roster lastnames only. Unknown speakers go to
        `external_participants` — or ask; never guess. Anything email-shaped
        is dropped with a warning.
     2. `action_items` is a mirror, not the source — the digest body is
        authoritative for humans; the mirror lets agents query commitments
        without parsing prose. `tracker_ref` is the A3 backlink closing the
        loop call -> task.
     3. `references_prior_calls` max 5 — the "context, not summaries" receipt.
     4. Unknown keys are rejected; new enum values enter only via tenant.yaml
        + the vault AGENTS.md, never ad-hoc in one file. -->

<!-- WHY THIS SHAPE (decision → because):
     · Frontmatter is the retrieval surface; the folder tree is only routing —
       `rg 'team: product'` works even on a misfiled file, because frontmatter
       survives moves.
     · Closed key set per schema_version — structure that cannot drift stays
       queryable; anything freeform belongs in `tags` (the one open field).
     · Email-shaped participants are dropped with a warning — email-shaped
       names have leaked before; roster lastnames are the safe token.
     · No sensitivity key — privacy routing is deliberately not part of v0.1
       (every call files into team folders; waitlist interest: privacy).
     · Date-first filename + this head = the corpus is a timeline that any
       agent can parse cold.
     Full rationale: docs/conventions.md in the rendered vault; decision
     rationale: the "WHY THIS SHAPE" note above + docs/conventions.md in your vault. -->
