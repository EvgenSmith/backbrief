// SPDX-License-Identifier: BUSL-1.1
// TaskCrafter Stage 3 — Router: resolve Linear team/state/assignee/priority/labels per task.
//
// Input: items with normalizer_output.tasks[] + matcher_decision per task.
// Output: same items, each task augmented with `router_payload` containing all
//         Linear API fields needed by Stage 6 Executor.
//
// Pure deterministic logic — no API calls, no AI. All tracker ids are
// deploy-resolved (test-creds.js / deploy-pipeline.js) into the TENANT
// regions below and cached in .backbrief/pipeline-state.json.

// Team mapping (team_inferred → tracker teamId + default Todo stateId).
// Prod policy kept: create in "Todo" for all teams — no Triage even where a
// team supports it. TEAM_MAP / USER_MAP are deploy-resolved (B5) into the
// TENANT_TRACKER region; the resolver picks the workflow state of type
// 'unstarted' named "Todo" (fallback: the first unstarted state — tracker
// workspaces vary) and records its pick in pipeline-state.
//
// USER_HOME_TEAM implements "one person — one board": every assignee has
// exactly ONE home team (roster[].home_team). The router uses it as an
// override: a task with a resolvable owner_lastname routes to that person's
// board, ignoring the content-inferred team (weaker signal). No home team →
// fall back to team_inferred; both empty → flag_for_triage.

// ── __TENANT_TRACKER_BEGIN__ ─ do not hand-edit; rendered by tenant-render.js from tenant.yaml ──
const TRACKER_KIND = 'linear';
const VALID_TRACKER_TEAM = new Set(['ENG', 'GRW', 'PRD']); // config keys (team_mapping); null also valid
const TEAM_TO_ID = {}; // deploy-resolved team UUIDs (pipeline-state)
const TEAM_MAP = {}; // deploy-resolved: teamId + the team's Todo state
const USER_MAP = {}; // deploy-resolved tracker user ids by lastname
const LABEL_FROM_CALL_ID = null; // provenance label "backbrief", deploy-resolved
const TRACKER_URL_BASE = 'https://linear.app/your-workspace';
const TEAM_DISPLAY = {
  ENG: 'engineering',
  GRW: 'growth',
  PRD: 'product',
};
const COMMENT_THRESHOLD = 0.75;
const FLAG_THRESHOLD_DISCOVERY = 0.55;
const FLAG_THRESHOLD_PLANNING = 0.35;
const CROSS_CALL_TTL_DAYS_CONFIRMED = 14;
const CROSS_CALL_TTL_HOURS_PENDING = 48;
// ── __TENANT_TRACKER_END__ ──
// ── __TENANT_ROSTER_BEGIN__ ─ do not hand-edit; rendered by tenant-render.js from tenant.yaml ──
const OWNER_LASTNAME = 'Novak';
const OWNER_ALIASES_PATTERN = 'elena n|elena|novak|el'; // longest-first, regex alternation
const INTERNAL_DOMAINS = ['acme.dev'];
const FIRSTNAME_TO_LASTNAME = {
  Andrei: 'Petrov',
  'Andrei P': 'Petrov',
  Andy: 'Petrov',
  El: 'Novak',
  Elena: 'Novak',
  'Elena N': 'Novak',
  Maria: 'Ivanova',
  'Maria I': 'Ivanova',
  Masha: 'Ivanova',
  Sam: 'Okafor',
  Sammy: 'Okafor',
  W: 'Chen',
  Wei: 'Chen',
  'Wei C': 'Chen',
};
const SURNAME_ALIAS_MAP = {};
const CYRILLIC_LASTNAME_MAP = {};
const EMAIL_TO_LASTNAME = {
  andrei: 'Petrov',
  andy: 'Petrov',
  chen: 'Chen',
  el: 'Novak',
  elena: 'Novak',
  ivanova: 'Ivanova',
  maria: 'Ivanova',
  masha: 'Ivanova',
  novak: 'Novak',
  okafor: 'Okafor',
  petrov: 'Petrov',
  sam: 'Okafor',
  sammy: 'Okafor',
  w: 'Chen',
  wei: 'Chen',
};
const USER_HOME_TEAM = {
  Chen: 'PRD',
  Ivanova: 'GRW',
  Novak: 'PRD',
  Okafor: 'GRW',
  Petrov: 'ENG',
};
const LASTNAME_TO_TEAM = USER_HOME_TEAM; // participant→team bias (same data, both prod const names kept)
const SLACK_USER_ID_BY_LASTNAME = {}; // deploy-resolved (pipeline-state) + per-roster overrides
// ── __TENANT_ROSTER_END__ ──

// Reverse map for feedback log
const LINEAR_ID_TO_LASTNAME = Object.fromEntries(
  Object.entries(USER_MAP).map(([lastname, id]) => [id, lastname])
);

// Priority: Anthropic enum → Linear integer
const PRIORITY_MAP = { urgent: 1, high: 2, medium: 3, low: 4 };

// Provenance label — applied to all CREATE operations. Deploy get-or-creates
// the label (features.tracker.provenance_label) and resolves its UUID into the
// TENANT_TRACKER region; null until resolved → created issues carry no label.

function resolveAssignee(ownerLastname) {
  if (!ownerLastname || typeof ownerLastname !== 'string') {
    return { assigneeId: null, flag_for_triage: true, reason: 'no_owner_lastname' };
  }
  const trimmed = ownerLastname.trim();
  const uid = USER_MAP[trimmed];
  if (!uid) {
    return { assigneeId: null, flag_for_triage: true, reason: `lastname_unknown_${trimmed}` };
  }
  return { assigneeId: uid, flag_for_triage: false, reason: null };
}

function resolveTeam(teamInferred) {
  if (!teamInferred) {
    return { teamId: null, flag_for_triage: true, reason: 'no_team_inferred' };
  }
  const entry = TEAM_MAP[teamInferred];
  if (!entry) {
    return { teamId: null, flag_for_triage: true, reason: `unknown_team_${teamInferred}` };
  }
  return {
    teamId: entry.teamId,
    teamName: entry.name,
    todoStateId: entry.todoStateId,
    flag_for_triage: false,
  };
}

// Assignee-driven team override: when the task has an owner_lastname with a
// known home team → use the home team (ignore the content-inferred one).
// owner_lastname empty/unknown → fall back to team_inferred. Returns
// { team_key, route_note } — route_note is set only on an actual override
// (debug marker in metadata; not surfaced per-task in the Slack preview).
function resolveTeamForTask(t) {
  const home = USER_HOME_TEAM[t.owner_lastname];
  if (home) {
    if (t.team_inferred && t.team_inferred !== home) {
      return { team_key: home, route_note: `team_override_${t.team_inferred}_to_${home}_per_${t.owner_lastname}_home` };
    }
    return { team_key: home, route_note: null };
  }
  return { team_key: t.team_inferred, route_note: null };
}

// === main ===
const items = $input.all();
const out = [];

for (const it of items) {
  const j = it.json || {};
  const no = j.normalizer_output;
  if (!no || !Array.isArray(no.tasks)) {
    out.push({ json: { ...j, __taskcrafter_error: 'router_no_normalizer_output' } });
    continue;
  }

  const routed_tasks = no.tasks.map(task => {
    const t = { ...task };

    // Skip / cross-call-dup / match-done / intra-batch-dup decisions don't need
    // routing — no Linear write. V1.0 added `skip_match_done` (F1) and
    // `skip_intra_batch_dup` (F2) from matcher-decide.
    if (
      t.matcher_decision === 'skip' ||
      t.matcher_decision === 'skip_cross_call_dup' ||
      t.matcher_decision === 'skip_match_done' ||
      t.matcher_decision === 'skip_intra_batch_dup' ||
      t.matcher_decision === 'skip_same_target_dup'
    ) {
      t.router_payload = null;
      t.router_skipped = true;
      // V1.7.27 (2026-07-09, D.2): cross-call fingerprint dup (title|owner within
      // 14d) is button-less in Slack, so a reviewer can't approve THIS week's
      // genuine recurring-call instance (weekly-call dedup false-positive; P1-6).
      // Build a parallel CREATE-shape payload — same mechanism flag_for_review
      // uses for «➕ Create new instead» — so 09b can offer «➕ Create anyway» and
      // 11 can swap router_payload <- router_payload_create_alt on click.
      // router_payload stays null: default flow still treats it as skipped (no
      // auto-create, no composer body); the alt materialises only on explicit
      // click. No best_match here (dup short-circuits before rerank) → no
      // assignee-inherit; unresolved assignee → unassigned create (team triages).
      if (t.matcher_decision === 'skip_cross_call_dup') {
        const { team_key, route_note } = resolveTeamForTask(t);
        const teamRes = resolveTeam(team_key);
        const assigneeRes = resolveAssignee(t.owner_lastname);
        if (!teamRes.flag_for_triage) {
          t.router_payload_create_alt = {
            action: 'create_new',
            teamId: teamRes.teamId,
            teamName: teamRes.teamName,
            stateId: teamRes.todoStateId,
            stateName: 'Todo',
            assigneeId: assigneeRes.assigneeId,
            assigneeLastname: assigneeRes.assigneeId ? t.owner_lastname : null,
            priority: PRIORITY_MAP[t.priority] || 3,
            labelIds: LABEL_FROM_CALL_ID ? [LABEL_FROM_CALL_ID] : [],
          };
          if (route_note) t.router_route_note = route_note;
        } else {
          t.router_payload_create_alt = null;
          t.router_create_alt_warning = `team_unresolved_${teamRes.reason}`;
        }
      }
      return t;
    }

    // For UPDATE_* intents (planning mode with explicit_ref) — minimal payload
    if (t.matcher_decision === 'use_explicit_ref') {
      const issue = t.matcher_explicit_ref_issue;
      if (!issue) {
        t.router_payload = null;
        t.router_warning = 'explicit_ref_issue_missing';
        return t;
      }

      // Build update / comment payload depending on intent
      const payload = {
        action: t.intent,  // 'update_status' | 'update_assignee' | 'update_priority' | 'comment_only'
        target_issue_id: issue.id,
        target_issue_identifier: issue.identifier,
        target_issue_url: issue.url,
        comment_context: {
          call_date: j.start_time || j.classification?.start_time || null,
          quote: t.transcript_quote,
        },
      };

      if (t.intent === 'update_status' && t.intent_change_value) {
        // Map state name → stateId. Use issue's TEAM state model.
        // For now, defer to Composer/Executor to resolve; Router records intent only.
        payload.target_state_name = t.intent_change_value;
      } else if (t.intent === 'update_assignee' && t.intent_change_value) {
        const newAssignee = resolveAssignee(t.intent_change_value);
        payload.target_assignee_id = newAssignee.assigneeId;
        payload.target_assignee_lastname = newAssignee.assigneeId ? t.intent_change_value : null;
        if (newAssignee.flag_for_triage) {
          t.router_flag_for_triage = true;
          t.router_flag_reason = newAssignee.reason;
        }
      } else if (t.intent === 'update_priority' && t.intent_change_value) {
        payload.target_priority = PRIORITY_MAP[t.intent_change_value] || 3;
      }

      t.router_payload = payload;
      return t;
    }

    // For COMMENT-on-match: comment + optional label
    if (t.matcher_decision === 'comment_on_match' || t.matcher_decision === 'flag_for_review') {
      const target = (t.matcher_candidates || []).find(c => c.id === t.best_match_id);
      t.router_payload = {
        action: 'comment_on_existing',
        target_issue_id: t.best_match_id,
        target_issue_identifier: t.best_match_identifier,
        target_issue_url: t.best_match_url,
        comment_context: {
          call_date: j.start_time || null,
          quote: t.transcript_quote,
          source_thread_ts: j.slack_root_ts || null,
        },
        // For flag_for_review: Stage 5 preview shows multiple buttons (comment vs create)
        // — Router still preps comment payload; Stage 6 picks based on user click.
        flagged: t.matcher_decision === 'flag_for_review',
      };
      // V0.9 (2026-06-02, P0-1 fix): for flag_for_review tasks, ALSO build a
      // parallel CREATE-shape payload (router_payload_create_alt) so that when
      // user clicks «➕ Create new instead», 11-parse-slack-action can swap
      // router_payload <- router_payload_create_alt and 12-build-linear-mutation
      // sees the right CREATE fields. Without this swap, approve_alt was
      // hitting Linear with a COMMENT-shape payload and failing silently.
      if (t.matcher_decision === 'flag_for_review') {
        // Assignee-driven team override (see resolveTeamForTask).
        const { team_key, route_note } = resolveTeamForTask(t);
        const teamRes = resolveTeam(team_key);
        const assigneeRes = resolveAssignee(t.owner_lastname);
        // F5: when owner_lastname is missing/unknown, fall back to the
        // assignee of the existing matched issue (best_match) — "default to
        // the existing issue's assignee" reviewer heuristic.
        let assigneeId = assigneeRes.assigneeId;
        let assigneeLastname = assigneeRes.assigneeId ? t.owner_lastname : null;
        let assigneeInherited = false;
        if (!assigneeId) {
          const existingMatch = (t.matcher_candidates || []).find(c => c.id === t.best_match_id);
          const existingAssignee = existingMatch && existingMatch.assignee;
          if (existingAssignee && existingAssignee.id) {
            assigneeId = existingAssignee.id;
            assigneeLastname = (existingAssignee.displayName || existingAssignee.name || '').split(' ').pop() || 'inherited';
            assigneeInherited = true;
          }
        }
        if (!teamRes.flag_for_triage) {
          t.router_payload_create_alt = {
            action: 'create_new',
            teamId: teamRes.teamId,
            teamName: teamRes.teamName,
            stateId: teamRes.todoStateId,
            stateName: 'Todo',
            assigneeId,
            assigneeLastname,
            assigneeInherited,
            priority: PRIORITY_MAP[t.priority] || 3,
            labelIds: LABEL_FROM_CALL_ID ? [LABEL_FROM_CALL_ID] : [],
          };
          if (route_note) t.router_route_note = route_note;
        } else {
          // Team can't be resolved → can't build create-alt; UI button will
          // still appear but click will degrade to existing graceful-fail path.
          t.router_payload_create_alt = null;
          t.router_create_alt_warning = `team_unresolved_${teamRes.reason}`;
        }
      }
      return t;
    }

    // CREATE_NEW — full payload
    if (t.matcher_decision === 'create_new') {
      // Assignee-driven team override. See resolveTeamForTask.
      const { team_key, route_note } = resolveTeamForTask(t);
      const teamRes = resolveTeam(team_key);
      const assigneeRes = resolveAssignee(t.owner_lastname);

      if (teamRes.flag_for_triage) {
        t.router_flag_for_triage = true;
        t.router_flag_reason = teamRes.reason;
        t.router_payload = null;
        return t;
      }

      t.router_payload = {
        action: 'create_new',
        teamId: teamRes.teamId,
        teamName: teamRes.teamName,
        stateId: teamRes.todoStateId,
        stateName: 'Todo',
        assigneeId: assigneeRes.assigneeId,
        assigneeLastname: assigneeRes.assigneeId ? t.owner_lastname : null,
        priority: PRIORITY_MAP[t.priority] || 3,
        labelIds: LABEL_FROM_CALL_ID ? [LABEL_FROM_CALL_ID] : [],
        // Composer (Stage 4) will fill in title + description_markdown
      };
      if (route_note) t.router_route_note = route_note;

      if (assigneeRes.flag_for_triage) {
        t.router_flag_for_triage = true;
        t.router_flag_reason = assigneeRes.reason;
        // Still proceed with unassigned create — team lead will triage in Linear
      }

      return t;
    }

    // Unknown matcher_decision — defensive
    console.warn(`[router] unknown matcher_decision: ${t.matcher_decision}`);
    t.router_payload = null;
    t.router_warning = `unknown_matcher_decision_${t.matcher_decision}`;
    return t;
  });

  const counts = routed_tasks.reduce((acc, t) => {
    const a = t.router_payload?.action || 'no_action';
    acc[a] = (acc[a] || 0) + 1;
    return acc;
  }, {});
  const triage_count = routed_tasks.filter(t => t.router_flag_for_triage).length;
  console.log(`[router] actions: ${JSON.stringify(counts)} · triage_flags: ${triage_count}`);

  out.push({
    json: {
      ...j,
      __taskcrafter_stage: 'routed',
      normalizer_output: {
        ...no,
        tasks: routed_tasks,
      },
      router_action_counts: counts,
      router_triage_count: triage_count,
    },
  });
}

return out;
