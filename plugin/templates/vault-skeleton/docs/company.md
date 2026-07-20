---
# Backbrief company profile — filled at A0 by /backbrief start (the agent
# infers what it can and states it for correction; no survey needed), then
# enriched at A2 from real calls. Field docs + a filled example:
# docs/templates/company-profile.md. Keep the whole file <= 60 lines — it is
# injected into every digest/task run (prompt budget).
type: company
schema_version: 1
name: ""                          # company display name — mirrors tenant.yaml tenant.name
website: null                     # inferred from the corp email domain / git remote, or volunteered;
                                  # A0 fetches it (when web access exists) to pre-fill this file —
                                  # site-sourced lines carry "(from site — correct me)"
what_we_do: ""                    # one line, plain words
products: []                      # product/project names — these feed the ASR glossary
stage: ""                         # e.g. pre-seed | seed | series-a | bootstrapped | enterprise
team_size: null
market: ""                        # who buys/uses it, one line
sources: []                       # survey|inference|transcripts|web (web = company site fetch)
last_updated: null
---

# Company profile

## What we do
<!-- 2–4 lines: what the company makes, for whom, current stage. -->

## Products & terminology
<!-- One line per product/term: canonical spelling + what it is. New entries
     here should also land in tenant.yaml glossary (ASR variants). -->

## Market & customers
<!-- Who buys it; named partners/segments that come up on calls. -->

## Current priorities
<!-- 3–5 dated bullets — what the company pushes right now. Stale priorities
     mislead the summarizer more than none: date every line. -->

## Notes for the summarizer
<!-- Anything that disambiguates calls: internal jargon, codenames, metrics. -->
