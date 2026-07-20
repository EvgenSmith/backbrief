---
# ============================================================================
# Backbrief company profile — spec v1 (schema_version: 1). File: docs/company.md
# (path configurable via tenant.yaml vault.company_profile_path).
# Born at A0 (/backbrief start): the agent INFERS what it can (git remote,
# email domain, transcripts — and the company WEBSITE when it can be inferred
# and fetched; site-sourced lines carry "(from site — correct me)") and states
# it for correction — no extra survey questions. Enriched at A2 (profiles)
# from real calls. Injected (size-capped) into the summarizer/taskcrafter
# context for every run.
# Keep the WHOLE file <= 60 lines — it is prompt budget, spent on every call.
# Keys are English tokens; narrative may be any language. Example values below
# describe a fictional company.
# ============================================================================
type: company
schema_version: 1
name: Acme Robotics               # display name — mirrors tenant.yaml tenant.name
website: "https://acme.dev"       # inferred from the corp email domain / git remote,
                                  # or the URL the user volunteered; null when unknown.
                                  # A0 fetches the homepage (when the agent has web
                                  # access) to fill the fields below — those lines are
                                  # suffixed "(from site — correct me)"
what_we_do: "Autonomous delivery robots for warehouses"   # one line, plain words
products: [SkyDock, FluxAPI, RoverOS]   # product/project names — these feed the ASR glossary
stage: seed                       # e.g. pre-seed | seed | series-a | bootstrapped | enterprise
team_size: 12
market: "Mid-size 3PL warehouses, US + EU"   # who buys/uses it, one line
sources: [inference, web]         # where this came from: survey|inference|transcripts|web
                                  # (web = fetched from the company site)
last_updated: 2026-07-10
---

# Acme Robotics — company profile

## What we do
<!-- 2–4 lines: what the company makes, for whom, current stage. -->
Autonomous delivery robots for warehouses. Hardware (RoverOS units) + a
dispatch API (FluxAPI); SkyDock is the charging/dock product line.

## Products & terminology
<!-- One line per product/term: canonical spelling + what it is. New entries
     here should also land in tenant.yaml glossary (ASR variants). -->
- **SkyDock** — dock + charging station product line
- **FluxAPI** — dispatch/fleet API customers integrate with
- **RoverOS** — the robot firmware/OS

## Market & customers
<!-- Who buys it; named partners/segments that come up on calls. -->
Mid-size third-party-logistics warehouses; pilot with Vostok Labs (EU).

## Current priorities
<!-- 3–5 dated bullets — what the company pushes right now. Stale priorities
     mislead the summarizer more than none: date every line. -->
- 2026-07: close the Vostok Labs pilot → paid contract
- 2026-07: FluxAPI v2 pricing model decision

## Notes for the summarizer
<!-- Anything that disambiguates calls: internal jargon, codenames, metrics. -->
- "the dock" in speech = SkyDock; "units" = RoverOS robots

<!-- WHY THIS SHAPE (decision → because):
     1. Team profiles alone cannot disambiguate a call — product names, stage,
        and market are what resolve "the dock" / "the pilot" to the right thing.
     2. products[] feeds the ASR glossary — one list keeps spellings canonical.
     3. <= 60 lines: the file ships whole into every digest/task prompt —
        every line costs tokens on every call. 4. Dated priorities — undated
        ones go stale silently; the date lets agents discount old lines. -->
