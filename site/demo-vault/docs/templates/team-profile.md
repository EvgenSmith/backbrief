---
# ============================================================================
# Backbrief team profile — spec v1 (schema_version: 1). File: team/<Lastname>.md
# (basename MUST equal the `lastname` field; flat folder, never nested).
# MINIMAL VIABLE PROFILE: only type / schema_version / lastname / status are
# required — everything else improves resolution; nothing breaks without it.
# Deliberately ~1 page: the floor A2 fills from Slack/tracker/docs/survey +
# transcript enrichment in minutes — a team can grow it far beyond.
# SSOT: this file is the source of truth for a person; the tenant.yaml roster
# is generated FROM it at B1 — edit here, then re-run generate-tenant.js.
# Keys and enum values are English tokens; narrative content and aliases may
# be any language/script. Example values below describe a fictional person.
# NO compensation, performance, or HR data here — ever. No emails of
# EXTERNAL people either — `email:` below is for roster members only.
# ============================================================================
type: member
schema_version: 1
lastname: Carter                  # canonical token — must match filename, roster, action_items.owner
first_names: [Emma]
aliases:                          # * everything speech/transcripts/chat call this person:
  - Em                            #   nicknames / diminutives
  - Emmy                          #   spellings ASR actually produces; for teams that speak an
                                  #   inflected language, also native-script and declined forms
                                  #   (the cases that actually appear in speech — typically 3–4)
  - "Emma C."                     #   display-name variants (Zoom, calendar)
  - "@emma"                       #   chat handle as typed
role: "Growth Lead"
team: growth                      # must match a vault.teams[].tag in tenant.yaml
zones: [onboarding-emails, paid-acquisition, landing-pages]   # kebab-case EN responsibility areas;
                                  # optional — the AI fills these from transcripts, leave empty on manual fill
typical_partners: [Brooks, Kim]        # lastnames this person most often works/decides with
languages: [en]
email: "emma@acme.dev"            # optional; corp email — resolves Slack/tracker identity and Zoom
                                  # attendance; leave empty if unknown (deploy pulls it from Slack
                                  # where scopes allow, or asks once — never required)
slack_user_id: "U0XXXXXXX"        # optional; enables task-button assignee resolution
tracker_handle: "emma@acme.com"   # optional; tracker (Linear) user key
status: draft                     # draft -> confirmed (person reviewed it) -> stale (departed; never delete)
sources: [slack, transcripts]     # where A2 pulled this from: slack|tracker|docs|survey|transcripts|web
last_updated: 2026-07-10
---

# Emma Carter — Growth Lead

## Role
<!-- 2–3 lines: mandate, who they report to if known, seniority signal. -->

## Responsibility zones
<!-- One bullet per zone with EVIDENCE — a transcript quote or source line.
     Zones without evidence are marked "(inferred — pending review)". -->
- **onboarding-emails** — owns the sequence; evidence: "I'll rewrite email two this week" (2026-07-03 call, 14:32)
- **paid-acquisition** — (inferred from Slack title — pending review)

## Typical topics
<!-- Keywords or regexes for retrieval and speaker-attribution, one per line.
     Plain words are fine — the agent upgrades them to regexes over time: -->
- /onboarding|welcome (sequence|email)/i
- /CAC|paid channel|creative/i

## Typical partners
<!-- Who they decide with, and on what — one line each. -->
- **Kim** — landing pages handoff (design → copy)

## Notes
<!-- Optional free-form: working preferences, decision style, time zone. -->

<!-- Rules (validator-enforced):
     1. `aliases` is the name-map: every form ASR and chat actually produce.
        It is what resolves "Em" / "Emma C." / "@emma" to one owner token;
        A2 transcript enrichment appends observed variants automatically.
     2. Alias collisions across profiles are a validator ERROR (ambiguous
        assignee resolution).
     3. `status: stale`, never delete — departed members keep resolving in
        historical digests. -->

<!-- WHY THIS SHAPE (decision → because):
     1. `lastname` is THE canonical token — the same string keys filenames
        ("w Carter"), transcript participants, action_items.owner,
        and tracker assignees; change it here and
        everything stops resolving. Surname collision: use "Lastname-F"
        consistently everywhere, including this filename.
     2. Flat team/ folder is load-bearing — the pipeline finds a profile by
        listing the folder and matching <Lastname>.md; a subfolder makes the
        person invisible (this exact bug shipped once in the reference
        production system).
     3. `aliases` here are the master name-map; the tenant.yaml roster is
        generated from this file at B1 — never maintain two lists by hand.
     4. `zones` are kebab-case EN because they are retrieval/routing tokens,
        not prose.
     5. Topics are regex-friendly because they drive speaker attribution in
        transcript enrichment.
     6. No external emails, no compensation/performance/HR data — profiles
        are shared vault content, read by every agent session.
     7. ~1 page on purpose — the file is injected whole into the summarizer
        for every call this person attends; size is a token budget.
     Full rationale: the "WHY THIS SHAPE" note above + docs/conventions.md in your vault. -->
