// SPDX-License-Identifier: BUSL-1.1
// State lookup — check workflow static data for prior Phase 1 post.
//
// When Zoom delivers the second `recording.completed` (now with TRANSCRIPT),
// we want to find the slack_root_ts that Phase 1 already posted, and reply
// in the SAME thread instead of creating a duplicate root.
//
// Storage: `$getWorkflowStaticData('global').recordings[<uuid>]` — persists
// inside the workflow JSON itself (no extra infra, free on Cloud Starter).
//
// Idempotency:
//   - First webhook (no transcript)        → state lookup returns null → Phase 1 fires
//   - Second webhook (with transcript)     → state lookup returns prior ts → Phase 2 uses it
//   - Zoom retry of first webhook (no ts)  → state lookup returns prior ts but has_transcript=false
//                                            → skip flag set, workflow ends silently
//   - Both webhooks arrive close together  → V1.8.1: NOT acceptable anymore — see the
//     grace-window re-read below. (Observed in the reference deployment 2026-07-10:
//     a 5-min call got recording.completed and transcript_completed delivered 54 ms
//     apart → the transcript exec saw no state → oneshot → DUPLICATE root post +
//     TaskCrafter preview landed as a channel root. Short calls batch both Zoom
//     events together, so this fires regularly.)

// V1.8.1 race guard: n8n persists staticData at execution END, so a concurrent
// phase-1 execution's save is invisible to $getWorkflowStaticData here — the race
// window is the whole phase-1 runtime. Fix: when we're about to run oneshot
// (transcript present, no prior state), wait ~35 s (phase-1 finishes in seconds),
// then re-read the workflow's staticData via the n8n public API (reads the DB,
// not our stale in-memory snapshot). If phase 1 landed meanwhile → thread mode.
//
// Graceful degradation: if the API key / base URL were never injected (deploy
// always injects both — see pipeline-nodes.js SECRETS) or helpers are absent
// (offline test harness), the guard is OFF and behavior is the pre-V1.8.1
// oneshot fallback. The harness path stays fully synchronous — no top-level await.
const N8N_API_KEY = '__N8N_API_KEY_PLACEHOLDER__';   // injected at deploy (pipeline-nodes.js SECRETS)
const N8N_BASE    = '__BACKBRIEF_N8N_BASE_URL__';    // injected at deploy (SECRETS ← N8N_BASE_URL env)
const WORKFLOW_ID = ($workflow && $workflow.id) || '';
const httpHelpers = this && this.helpers;             // absent in the offline test harness
const guardReady  = !!(httpHelpers && WORKFLOW_ID
  && !N8N_API_KEY.includes('PLACEHOLDER') && !N8N_BASE.startsWith('__'));

const data = $getWorkflowStaticData('global');
const j = $input.first().json;
const uuid = j.zoom_meeting_uuid || '';
data.recordings = data.recordings || {};
const prior = data.recordings[uuid] || null;

// Decide pipeline mode + build the output item. Pure function of (prior, j) so the
// race guard below can re-run it after the grace-window re-read.
//   - skip_phase2_duplicate: Phase 2 already finalized (vault committed + thread reply
//     posted). Any subsequent webhook for the same meeting is a Zoom retry of the
//     transcript event — skip entirely.
//   - skip_phase1_retry    : Phase 1 already posted, this webhook has no transcript yet
//     (Zoom retry of the MP4-only event).
//   - run_phase1           : no prior post, no transcript — minimal post + save
//   - run_phase2_thread    : prior post exists + transcript present — thread reply only
//   - run_full_oneshot     : no prior post + transcript present — fallback single-shot
function decide(prior) {
  let mode;
  if (prior?.phase2_completed_at)            mode = 'skip_phase2_duplicate';
  else if (prior && !j.has_transcript)       mode = 'skip_phase1_retry';
  else if (!prior && !j.has_transcript)      mode = 'run_phase1';
  else if (prior && j.has_transcript)        mode = 'run_phase2_thread';
  else                                       mode = 'run_full_oneshot';

  // Hard short-circuit on skip modes — emit 0 items so downstream nodes don't fire.
  // This is how we guarantee «no duplicate Slack posts per Zoom meeting».
  if (mode === 'skip_phase1_retry' || mode === 'skip_phase2_duplicate') {
    console.log(`[state-lookup] skip mode=${mode} uuid=${uuid} prior_ts=${prior?.slack_root_ts || 'n/a'} — ending execution`);
    return [];
  }

  // V1.5.12: MP4 fallback for Phase 2 path. recording.transcript_completed
  // webhook contains only TRANSCRIPT file in recording_files[] — no MP4. We fall back
  // to mp4_* saved during Phase 1 so Drive uploader branch (forked downstream of Slack thread
  // reply on Phase 2 path) can find a valid download URL + access_token.
  return [{ json: {
    ...j,
    prior_slack_root_ts : prior?.slack_root_ts || null,
    prior_slack_channel : prior?.slack_channel || null,
    prior_posted_at     : prior?.posted_at     || null,
    prior_phase2_at     : prior?.phase2_completed_at || null,
    __pipeline_mode     : mode,
    // Overwrite mp4_* with fallback (use Phase 1 value if Phase 2 didn't carry MP4)
    mp4_present          : j.mp4_present       || prior?.mp4_present       || false,
    mp4_download_url     : j.mp4_download_url  || prior?.mp4_download_url  || null,
    mp4_access_token     : j.mp4_access_token  || prior?.mp4_access_token  || null,
    mp4_file_size_bytes  : j.mp4_file_size_bytes  || prior?.mp4_file_size_bytes  || 0,
    mp4_recording_file_id: j.mp4_recording_file_id || prior?.mp4_recording_file_id || null,
  } }];
}

// V1.8.1 race guard: ONLY when we'd otherwise run oneshot (transcript, no prior)
// and both deploy-time injections landed. Returned promise is awaited by n8n;
// the offline test harness never enters this branch (no this.helpers, placeholder
// key) and keeps the fully synchronous path below.
if (!prior && j.has_transcript && guardReady) {
  return (async () => {
    try {
      console.log(`[state-lookup] transcript event with no prior state (uuid=${uuid}) — grace window 35s, then DB re-read (race guard)`);
      await new Promise(r => setTimeout(r, 35000));
      const resp = await httpHelpers.httpRequest({
        method: 'GET',
        url: `${N8N_BASE}/api/v1/workflows/${WORKFLOW_ID}`,
        headers: { 'X-N8N-API-KEY': N8N_API_KEY, 'Accept': 'application/json' },
        json: true, returnFullResponse: true, ignoreHttpStatusErrors: true,
      });
      if (resp && resp.statusCode >= 200 && resp.statusCode < 300) {
        const st = resp.body?.staticData;
        const rec = (st?.global?.recordings || st?.recordings || {})[uuid] || null;
        if (rec && rec.slack_root_ts) {
          console.log(`[state-lookup] race guard HIT: phase-1 state appeared during grace window (root_ts=${rec.slack_root_ts}) — switching to thread mode`);
          // Also merge into our in-memory snapshot so the end-of-execution save
          // doesn't clobber phase-1's record with an empty one.
          data.recordings[uuid] = { ...rec, ...(data.recordings[uuid] || {}) };
          return decide(rec);
        }
        console.log('[state-lookup] race guard: still no phase-1 state after grace window — genuine oneshot');
      }
    } catch (e) {
      console.log(`[state-lookup] race guard failed (${e.message}) — falling back to oneshot`);
    }
    return decide(null);
  })();
}

return decide(prior);
