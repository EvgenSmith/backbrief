---
type: transcript
schema_version: 1
team: engineering
topic: "API rate limit incident review"
date: 2026-10-12
time: "10:00"
duration_min: 42
participants: [Okafor, Sidorova]
language: en
source: zoom
digest_version: v1
filed_by: plugin
filer_model: claude-sonnet-4-6
pipeline_version: "0.1.0"
source_id: "DEMOuuid0004x=="
platform: zoom
call_type: review
tags: [incident, api, postmortem]
action_items:
  - title: "Add per-clinic rate limits to the public booking API"
    owner: Okafor
    helpers: []
    status: post-call
    priority: urgent
    ts: "12:30"
    tracker_ref: ENG-318
  - title: "Alert when booking API 429s exceed 1% for five minutes"
    owner: Okafor
    helpers: []
    status: post-call
    priority: high
    ts: "26:15"
    tracker_ref: ENG-302
  - title: "Write the customer-facing incident note"
    owner: Sidorova
    helpers: []
    status: post-call
    priority: high
    ts: "33:40"
    tracker_ref: null
---

# API rate limit incident review — 2026-10-12

## Summary

### What happened (01:45)
- Saturday 09:10–09:52: one clinic chain's integration retried in a loop and exhausted the **global** API rate limit
- **212** clinics saw booking errors for 42 minutes; no data was lost

### Root cause (08:00)
- Rate limits are global, not per clinic, so one noisy client affects everyone
- The 429 alert existed but fired only on the hourly rollup

## Decisions

1. Rate limits become per clinic, with the global limit kept as a backstop (12:30)

## Agreements

1. Sidorova ↔ Okafor: the per-clinic limit ships before any new API feature (14:05)

## Next steps

### 📋 Post-call
1. Add per-clinic rate limits to the public booking API — **Okafor** _[urgent]_ (12:30)
   > "per-clinic limits, this week, nothing else goes in first"
2. Alert when booking API 429s exceed 1% for five minutes — **Okafor** _[high]_ (26:15)
   > "we need a five-minute alert, not the hourly one"
3. Write the customer-facing incident note — **Sidorova** _[high]_ (33:40)
   > "I'll write the note to the affected clinics today"

### ✅ Done on call
None.

### 👀 Monitoring
None.

## Open questions

1. Should the noisy chain get a dedicated limit, or be asked to fix its retries? — waiting for their engineering contact (37:20)

## Key insights

1. A monitoring gap turned a 5-minute problem into a 42-minute outage — alert granularity matters more than thresholds (27:00)

## Transcript

Raw transcript: not retained · Recording: not retained
