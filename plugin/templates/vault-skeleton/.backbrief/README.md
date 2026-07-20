# .backbrief/ — machine state, not content

Written by the Backbrief skills and scripts; do not edit by hand.
Human-readable exception: `roadmap.md` — read it any time.

| Path | What | In git? |
|---|---|---|
| `state.yaml` | ladder/rung progress, resume points | yes |
| `roadmap.md` | human-readable list of deferred setup steps: what each unlocks, the degradation, the exact resume command (updated at every skip; rendered by `/backbrief status`) | yes |
| `waitlist.yaml` | observed unsupported tools (connector demand) | yes |
| `training/` | this team's private training data: `task-decisions.jsonl` (A3 verdicts), `feedback.jsonl` (Phase-B feedback loop) | yes — it is what raises task autonomy |
| `secrets.env` | credentials collected in Phase B | **no — gitignored** |
| `cache/` | update-check and vault-context caches | no — gitignored |
| `snapshots/` | pre-deploy n8n workflow snapshots (rollback) | no — gitignored |
| `deploy/` | environment report from B0 (`check-env.js --save`) — infra facts (hosts, versions), no secrets | yes — useful for support/debug |
| `pipeline-state.json` | deploy-resolved ids (workflows, channels, webhook URL) | yes |
