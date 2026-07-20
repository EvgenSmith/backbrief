<!-- SPDX-License-Identifier: MIT -->
# n8n hosting (deploy step B0): cloud trial vs Docker VPS

Phase B runs on **n8n** — an open-source workflow orchestrator. It is the always-on
service that reacts to your Zoom webhooks; the plugin deploys the Backbrief workflows
into it via the n8n API. You need exactly one n8n instance, and there are two supported
ways to get it. ("Neither — I don't want to run infra" is a valid answer too: it puts you
on the hosted waitlist and Phase A manual mode keeps working.)

## Decision table

| | **n8n Cloud** | **Docker on your VPS** |
|---|---|---|
| Time to running | ~5 min (sign-up) | ~20–30 min (incl. HTTPS) |
| Cost | free trial, then paid plan | VPS you already have / ~$5/mo; n8n itself free (sustainable-use license) |
| Maintenance | none | updates, backups, TLS are yours |
| Data residency | n8n's cloud (EU-hosted for personal workspaces) | entirely yours |
| Public HTTPS URL (required for Zoom webhooks) | built-in | you provide (reverse proxy or tunnel) |
| Fit | fastest start, small teams | privacy-maximalist / self-host-everything teams |

Both are first-class: the deploy tooling talks to the same n8n API either way.

## Option 1 — n8n Cloud

1. Sign up at `n8n.io` → create a workspace. Your base URL looks like
   `https://<workspace>.app.n8n.cloud`.
2. Create an API key: n8n → **Settings → n8n API** → create.
3. Into `.backbrief/secrets.env`:

   ```bash
   N8N_BASE_URL=https://<workspace>.app.n8n.cloud
   N8N_API_KEY=...
   ```

**Plan constraints the kit is built around** (verified in production — these are facts,
not warnings):

- **Code nodes: 60 s execution timeout, ~150–200 MB heap.** This is why the optional MP4
  archiving uploads in 8 MB chunks — a naive single upload of a long recording OOMs.
  Nothing for you to do; just don't "simplify" the chunking.
- **No OS environment variables for user code**, and the **Variables feature is gated by
  plan** (`GET /variables` returns a licensing 403 on entry plans). Consequently the kit
  does **not** use `$env`/`$vars` at runtime: secrets are injected into the (encrypted)
  workflow definitions at deploy time — the `INJECT_SECRETS` mechanism. This is the
  designed-for path, not a workaround; `check-env.js` probes and records your instance's
  capabilities.
- **Execution logs retain run data — including full transcript text — for the plan's
  retention window (typically ~30 days).** Whoever can log into your n8n can read your
  calls there. Treat the n8n account as the widest content surface in the whole system:
  enable 2FA, don't share the login, prefer a dedicated account over a personal one.

## Option 2 — Docker on your own server

1. Run n8n (pin a recent version; check n8n docs for current):

   ```bash
   docker run -d --restart unless-stopped --name n8n \
     -p 5678:5678 \
     -v n8n_data:/home/node/.n8n \
     -e N8N_HOST=n8n.yourdomain.com \
     -e WEBHOOK_URL=https://n8n.yourdomain.com/ \
     docker.n8n.io/n8nio/n8n
   ```

2. **Public HTTPS is mandatory** — Zoom only delivers webhooks to a valid public HTTPS
   endpoint. Put a reverse proxy with TLS in front (Caddy is the least-effort option:
   two-line config, automatic certificates), or a stable tunnel if you know what you're
   doing. `WEBHOOK_URL` must be the public URL, or n8n will register webhooks with an
   unreachable address.
3. **Persist the volume** (`n8n_data` above) — it holds your workflows, credentials, and
   the pipeline's dedup state. Back it up like you mean it.
4. Create an API key in the n8n UI (**Settings → n8n API**) and fill
   `N8N_BASE_URL`/`N8N_API_KEY` in `.backbrief/secrets.env` as in Option 1.
5. Sizing: the pipeline is webhook-driven and lightweight — the smallest 1–2 GB VPS is
   plenty. Updates: `docker pull` + recreate the container; the volume carries state, and
   re-running `deploy-pipeline.js` afterwards verifies nothing drifted.

Self-hosted instances have no Code-node timeout/heap caps by default, but the shipped
workflows keep the cloud-safe patterns anyway — they must run identically on both.

## Verify (either option)

```bash
node plugin/scripts/check-env.js
```

Probes: network egress, docker presence (Option 2), n8n reachability + version, API key
validity, and instance capabilities (incl. the Variables licensing probe). Its output is
the B0 artifact — an environment report with a recommendation, printed to the terminal;
add `--save` to also write it to `.backbrief/deploy/environment.md`.

## Neither? — hosted waitlist

If running an orchestrator is exactly what you don't want to do, say so at B0: the
deploy procedure captures a hosted-waitlist entry (email, explicit —
see `docs/telemetry.md`), records the deferred deploy in your vault's
`.backbrief/roadmap.md`, and exits gracefully. Phase A manual mode keeps working
unchanged, and your vault is already accumulating.
