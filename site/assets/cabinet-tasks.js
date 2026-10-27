// SPDX-License-Identifier: MIT
/*
 * cabinet-tasks.js — Action items (spec §3.4 to §3.6, Slack post templates
 * in §4), in three tabs:
 *   Proposals       every task Backbrief proposed, waiting and reviewed, under
 *                   a compact "How proposals land" panel (#/tasks, filters in
 *                   the query; #/tasks/history redirects to ?status=reviewed)
 *   Open items      next steps from every call and who owes them
 *   Slack delivery  what is posted after every call, with a live preview
 * It also fills BB.hooks.callAside (the proposal cards in call detail),
 * BB.hooks.sendLog ("Post reviews to Slack") and BB.hooks.slackThread (a
 * call's whole Slack thread, for the Slack thread tab in call detail).
 *
 * Slack after a review. With the task log on (Slack delivery's default) the
 * call's thread carries the task log and each review updates it in place:
 * the group says so in one quiet line (BB.threadNote) and there is nothing to
 * post. Only with the task log off does "Post reviews to Slack" show; its
 * dialog then posts the task log alone unless more is ticked.
 *
 * Words. "Decisions" are what a call decided; approving or skipping a
 * proposal is a review. DUPLICATE reads "Already tracked"; FLAG keeps its
 * chip word and reads "possible duplicate" in prose. Replies and skip
 * reasons are feedback that people read, not model input.
 *
 * Linear writes are guarded: "Create anyway" and "Create new instead" open a
 * confirm sheet with a required owner; every approve, comment and skip can
 * be undone for 10 s (the toast's action, and an Undo button on the fresh
 * outcome row); bulk actions apply only to the cards the filters show.
 *
 * Every demo action writes the overlay through BB (BB.decide, state.edits,
 * state.log_sent, state.delivery, state.channels), saves, then re-renders
 * with BB.refresh(), so the nav count, Overview, call detail, the Calls
 * chips and the Slack preview all follow from one place. /app is read-only:
 * an action with no API behind it is not rendered at all (§3.11).
 *
 * Optional data, read when the build provides it: settings.issues[ref]
 * {title, status, assignee, updated} for the issue a COMMENT, FLAG or
 * DUPLICATE points at. "How proposals land" shows BB.effectiveMetrics(), the
 * same figures as the Overview tiles.
 *
 * The Slack preview (§4) is built from the pipeline's English strings, with
 * emoji written out and links shown as their text: nothing in a preview can
 * be clicked. The thread in call detail links its ▶ times to the transcript.
 *
 * Styles: cabinet-tasks.css. API: the BB block at the top of cabinet.js.
 */
(() => {
  'use strict';
  const BB = window.BB;
  if (!BB) return;
  const { esc, href, plural, fmtDay, joinAnd } = BB;
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const viewEl = () => document.querySelector('[data-view]');
  const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
  const reducedMotion = () => Boolean(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const cap = (s) => (s ? String(s).charAt(0).toUpperCase() + String(s).slice(1) : '');
  const pct = (x) => `${Math.round(Number(x) * 100)}%`;
  const hasSim = (p) => p.similarity !== null && p.similarity !== undefined && p.similarity !== '' && Number.isFinite(Number(p.similarity));
  const joinDot = (parts) => parts.filter(Boolean).join(' · ');
  const NOTE = BB.DEMO_NOTE;
  const UNDO_MS = 10000; // how long a review can be undone from its row
  const CLEAR_BOTTOM = 72; // px kept free above the toast area after an action

  // ================================================================ copy
  const LEDE = {
    log: BB.isDemo
      ? "Every task Backbrief proposed, checked against your Linear backlog. Nothing is filed until someone approves it. Approve here or in the call's Slack thread."
      : "Every task Backbrief proposed, checked against your Linear backlog. Nothing is filed until someone approves it in the call's Slack thread.",
    open: 'Next steps from every call and who owes them. Approved proposals link to their tracker issues.',
    slack: 'Choose what is posted after every call, and where, while seeing the exact post.',
    slackReadOnly: 'What is posted after every call, and where.',
  };
  const WAITING_APP = "Waiting for review in the call's Slack thread.";
  const PLANNING = 'Planning call: teams usually walk through issues that already exist, so review each Create by hand; it often needs a Comment instead. Approving several at once is off for this call.';
  const REASONS = ['Already covered', 'Already done', 'Not a task', 'Wrong owner', 'Wrong team', 'Other'];
  const PRIORITIES = ['urgent', 'high', 'medium', 'low'];
  const VERDICTS = ['CREATE', 'COMMENT', 'FLAG', 'DUPLICATE'];
  const VNAME = { CREATE: 'Create', COMMENT: 'Comment', FLAG: 'Flag', DUPLICATE: 'Already tracked' };
  const STATUS = [['all', 'All'], ['waiting', 'Waiting'], ['reviewed', 'Reviewed'], ['approved', 'Approved'], ['skipped', 'Skipped']];
  // Open items filter: Open (default), Monitoring, Done (done on a call, or closed by a later one), All.
  const ITEM_STATUS = {
    open: ['Open', (a) => isOpen(a)],
    monitoring: ['Monitoring', (a) => a.status === 'monitoring'],
    done: ['Done', (a) => Boolean(a.closed_by) || a.status === 'done-on-call'],
    all: ['All', () => true],
  };
  const BODY_HEADS = [['context', '📌 Context'], ['task', '✅ Task'], ['result', '🎯 Expected result'], ['extra', '📎 Additional information']];
  const SWITCHES = [
    ['summary', 'Summary', "What was discussed and decided, who owns what next, and a link to the call's file."],
    ['transcript_link', 'Transcript link', 'A link to the transcript in this workspace; every ▶ timestamp opens it at that line.'],
    ['recording_link', 'Recording link', "A link to the call's recording."],
    ['task_log', 'Task log', "The proposals and their verdicts, with Approve and Skip buttons, in the call's thread. Replies there are kept as feedback. When off, proposals wait in Action items and the thread says how many."],
  ];
  /** Names of the parts of a post, as the preview captions and the Send dialog show them. */
  const PART = { summary: 'Summary', transcript_link: '📄 Transcript link', recording_link: 'Recording link', task_log: '🛠 Task log' };
  const INCLUDE = [['summary', 'Summary'], ['transcript_link', 'Transcript link'], ['recording_link', 'Recording link'], ['task_log', 'Task log']];
  const SIGNATURE = /\s*🤖 via Backbrief — automated comment from the call\s*$/;

  /** "Replies and skip reasons are kept in acme/vault as feedback; …" (HTML). */
  function feedbackHtml() {
    const repo = repoName();
    return `Replies and skip reasons are kept in ${repo ? `<span class="mono">${esc(repo)}</span>` : 'your repository'} as feedback; your Backbrief team reviews them to tune the backlog check. Nothing here trains an AI model.`;
  }

  // ================================================================ module state
  // Transient UI state lives here and is re-applied on every render: the
  // overlay (BB.state) holds only what a demo action changed.
  const ui = {
    busy: new Map(), // proposal key → {act, label} while an approval runs
    whyOpen: new Set(), // skipped here; the "Why?" chips show
    whySaved: new Set(), // a reason was just picked; "Saved as feedback."
    fresh: new Map(), // proposal key → {until, snap}: its outcome row offers Undo
    draft: null, // Slack delivery draft {delivery, channels}
    previewId: null, // the call in the Slack delivery preview
    changeTarget: null, // the preview block the last delivery change touched
    routed: null, // hash of the last rendered route (BB 'route' event)
    epoch: 0, // bumped by Reset demo, so a running approval is dropped
  };
  let changeObserver = null;

  BB.on('route', (cur) => {
    ui.routed = cur.hash;
    if (cur.prefix !== 'tasks/slack') { ui.draft = null; watchChange(null); }
  });
  BB.on('reset', () => {
    ui.epoch++;
    ui.busy.clear();
    ui.whyOpen.clear();
    ui.whySaved.clear();
    ui.fresh.clear();
    ui.draft = null;
    ui.previewId = null;
    watchChange(null);
  });

  /** True on the first render of a route, false when BB.refresh() re-runs it. */
  function firstRender() {
    const first = !BB.current || ui.routed !== BB.current.hash;
    if (first) { ui.whyOpen.clear(); ui.whySaved.clear(); }
    return first;
  }

  // ================================================================ data helpers
  const ws = () => BB.workspace();
  const settings = () => BB.cached('settings') || null;
  const callIdOf = (key) => String(key).slice(0, String(key).lastIndexOf(':'));
  const cardId = (key) => `p-${String(key).replace(/[^\w-]/g, '-')}`;
  const callRow = (id) => ((ws() && ws().calls) || []).find((c) => c.id === id) || null;
  const entries = () => BB.effectiveProposals().filter((e) => e.proposals && e.proposals.length);
  const pendingOf = (e) => (e ? e.proposals.filter((p) => p.status === 'pending') : []);
  const isPlanning = (e) => Boolean(e) && (e.call_mode === 'planning' || e.call_mode === 'mixed' || Boolean(e.bulk && e.bulk.approve_safe && e.bulk.approve_safe.allowed === false));
  const bulkOff = (e) => Boolean(e && e.bulk && e.bulk.approve_safe && e.bulk.approve_safe.allowed === false);

  function proposalOf(key) {
    const e = BB.effectiveProposals(callIdOf(key));
    return e ? e.proposals.find((p) => p.key === key) || null : null;
  }

  function teamMap() {
    const lin = BB.effectiveSources().find((s) => s.id === 'linear');
    const m = lin && lin.settings && lin.settings.team_mapping;
    return m && typeof m === 'object' ? m : {};
  }
  const teamKey = (team) => (team && teamMap()[team]) || null;
  function teamsList() {
    const m = Object.keys(teamMap());
    if (m.length) return m;
    return [...new Set(((ws() && ws().calls) || []).map((c) => c.team).filter((t) => t && t !== 'general'))].sort();
  }

  function repoName() {
    const gh = BB.effectiveSources().find((s) => s.id === 'github');
    if (gh && gh.account) return gh.account;
    const m = String((ws() && ws().workspace.vault_url) || '').match(/^https:\/\/github\.com\/([^/]+\/[^/]+)/);
    return m ? m[1] : null;
  }

  /** The channel a call's thread lives in: where its digest was posted (base settings, not a later change). */
  function threadChannel(callId) {
    const d = BB.cached(`call:${callId}`);
    if (d && d.slack && d.slack.channel) return d.slack.channel;
    const base = settings() && settings().slack;
    const row = callRow(callId);
    if (base) return (row && base.per_team_channels && base.per_team_channels[row.team]) || base.channel || '#call-digests';
    return BB.effectiveSlack().channel || '#call-digests';
  }

  /** Linear facts about an issue, when the build provides them: settings.issues[ref] = {title, status, assignee, updated}. */
  function issueOf(ref) {
    const all = settings() && settings().issues;
    const i = ref && all && typeof all === 'object' ? all[ref] : null;
    return i && typeof i === 'object' ? i : null;
  }

  /** A FLAG or COMMENT says what the call adds: its title, or the evidence when the title only repeats the issue's. */
  function contextOf(p) {
    if (p.target && p.title === p.target.title && p.evidence) return p.evidence;
    return p.title;
  }

  /** DUPLICATE evidence ends with the issue's state: 'matches ENG-318 "…", done on this call (15:20)'. */
  function dupState(p) {
    const m = String(p.evidence || '').match(/",\s*([^"]+)$/);
    return m ? m[1].trim() : '';
  }

  /** The matched issue's status: Linear's word when known, else what the backlog check said ("Done", "In progress"). */
  function issueStatus(p) {
    const i = p.target && issueOf(p.target.ref);
    if (i && i.status) return cap(String(i.status));
    if (p.verdict !== 'DUPLICATE') return '';
    const s = dupState(p);
    if (/in progress/i.test(s)) return 'In progress';
    if (/done/i.test(s)) return 'Done';
    return '';
  }

  function dupAdvice(p) {
    const s = issueStatus(p);
    if (/progress/i.test(s)) return "Suggested: skip. It's already in progress.";
    if (/done|closed|complete|shipped|cancel/i.test(s)) return "Suggested: skip. It's already done.";
    return "Suggested: skip. It's already tracked.";
  }

  /** "GRW-102 · Billing FAQ refresh · Open · Carter · updated 3 Oct" (HTML). */
  function issueLine(target) {
    const i = issueOf(target.ref) || {};
    return joinDot([
      BB.ref(target.ref),
      esc(i.title || target.title || ''),
      i.status ? esc(cap(String(i.status))) : '',
      i.assignee ? BB.person(i.assignee) : i.assignee === null ? 'unassigned' : '',
      i.updated && fmtDay(i.updated) ? `updated ${esc(fmtDay(i.updated))}` : '',
    ]);
  }

  /** "Seen before" on a FLAG: the same issue flagged on other calls (overview.repeat_flags), with the overlay applied. */
  function seenBefore(p) {
    if (p.verdict !== 'FLAG' || !p.target) return '';
    const rf = ((ws().overview && ws().overview.repeat_flags) || []).find((f) => f.ref === p.target.ref);
    if (!rf) return '';
    const prior = [];
    for (const id of rf.calls || []) {
      if (id === p.call_id) continue;
      const e = BB.effectiveProposals(id);
      const q = e && e.proposals.find((x) => x.verdict === 'FLAG' && x.target && x.target.ref === rf.ref);
      if (q && q.status !== 'pending') prior.push({ date: e.date, status: q.status });
    }
    if (!prior.length) return '';
    prior.sort((a, b) => String(a.date).localeCompare(String(b.date)));
    const n = prior.length;
    const sk = prior.filter((x) => x.status === 'skipped').length;
    const all = (word) => (n === 1 ? word : n === 2 ? `${word} both times` : `${word} all ${n} times`);
    const how = sk === n ? all('skipped') : sk === 0 ? all('approved') : `skipped ${sk} of ${n} times`;
    return `Seen before: flagged on ${joinAnd(prior.map((x) => fmtDay(x.date)))}, ${how}.`;
  }

  /** The comment a COMMENT or FLAG posts on its issue: the edited one, else the default. */
  function defaultComment(p, e) {
    const context = p.verdict === 'FLAG' ? p.title : (p.evidence || p.title);
    const when = [fmtDay(e.date), p.ts].filter(Boolean).join(', ');
    return `From ${e.topic} (${when}): ${context}.${p.quote ? ` “${p.quote}”` : ''}\n\n🤖 via Backbrief — automated comment from the call`;
  }
  const commentText = (p, e) => (typeof p.comment === 'string' ? p.comment : defaultComment(p, e));

  // ---------------------------------------------------------------- approvals
  function knownRefs() {
    const refs = new Set();
    for (const e of BB.effectiveProposals()) {
      for (const p of e.proposals) {
        if (p.target && p.target.ref) refs.add(p.target.ref);
        if (p.decision && p.decision.ref) refs.add(p.decision.ref);
        if (p.on_approve) {
          if (p.on_approve.ref) refs.add(p.on_approve.ref);
          if (p.on_approve.alt && p.on_approve.alt.ref) refs.add(p.on_approve.alt.ref);
        }
      }
    }
    for (const a of BB.effectiveActionItems()) if (a.tracker_ref) refs.add(a.tracker_ref);
    const issues = settings() && settings().issues;
    if (issues && typeof issues === 'object') for (const r of Object.keys(issues)) refs.add(r);
    return refs;
  }

  /** The id an approval files under: the configured one, or the next free number when Edit moved it to another team. */
  function refInTeam(ref, key) {
    if (!key || (ref && String(ref).startsWith(`${key}-`))) return ref || null;
    let max = 0;
    for (const r of knownRefs()) {
      const m = String(r).match(/^([A-Z]+)-(\d+)$/);
      if (m && m[1] === key) max = Math.max(max, Number(m[2]));
    }
    return `${key}-${max + 1}`;
  }

  /** What approving a proposal does, from on_approve (and on_approve.alt for FLAG's "Create new instead"). */
  function approvalPlan(p, alt) {
    const oa = p.on_approve || {};
    const moved = p.changed && p.changed.includes('team') ? teamKey(p.owner_team) : null;
    const assigned = p.owner ? `assigned to ${p.owner}` : 'unassigned';
    // A FLAG with no matched issue (the discriminator's, not the matcher's) can only be created.
    if (p.verdict === 'FLAG' && (alt || !p.target)) {
      const ref = refInTeam((oa.alt && oa.alt.ref) || (!p.target && oa.ref) || null, moved);
      return { action: alt ? 'approve_alt' : 'approve', result: 'created', ref, busy: 'Creating in Linear…', toast: `Created ${ref || 'the issue'} in Linear, ${assigned}.` };
    }
    if (p.verdict === 'COMMENT' || p.verdict === 'FLAG') {
      const ref = oa.ref || (p.target && p.target.ref) || null;
      return { action: 'approve', result: 'commented', ref, busy: ref ? `Commenting on ${ref}…` : 'Commenting in Linear…', toast: ref ? `Comment added to ${ref}.` : 'Comment added.' };
    }
    const ref = refInTeam(oa.ref || null, moved);
    const toast = p.verdict === 'DUPLICATE' && !p.owner
      ? `Created ${ref || 'the issue'} in Linear.`
      : `Created ${ref || 'the issue'} in Linear, ${assigned}.`;
    return { action: 'approve', result: 'created', ref, busy: 'Creating in Linear…', toast };
  }

  /** 'owner: none → Carter', logged with an edited approval. */
  function editSummary(p) {
    if (!p.edited || !p.original) return null;
    const o = p.original;
    const parts = (p.changed || []).map((f) => {
      if (f === 'title') return 'title edited';
      if (f === 'owner') return `owner: ${o.owner || 'none'} → ${p.owner || 'none'}`;
      if (f === 'priority') return `priority: ${o.priority || 'none'} → ${p.priority}`;
      if (f === 'team') return `team: ${o.owner_team || 'none'} → ${p.owner_team}`;
      if (f === 'comment') return 'comment edited';
      return null;
    }).filter(Boolean);
    return parts.join('; ') || null;
  }

  // ================================================================ shared header
  function strip(current) {
    return BB.tabs([
      { key: 'log', href: '#/tasks', label: 'Proposals', count: BB.waitingCount(), mark: true },
      { key: 'open', href: '#/tasks/open', label: 'Open items', count: BB.effectiveActionItems().filter(isOpen).length },
      { key: 'slack', href: '#/tasks/slack', label: 'Slack delivery' },
    ], current, { label: 'Action items' });
  }

  /** Each tab has its own lede, in the page head. */
  function page(tab, html, opts = {}) {
    BB.render('Action items', strip(tab) + html, 'tasks', { eyebrow: opts.eyebrow || '', lede: esc(opts.lede || LEDE[tab] || ''), focus: opts.focus || null });
  }

  /** Re-render after a demo action, then bring the focused element into view, clear of the toasts. */
  async function refreshWith(focus) {
    await BB.refresh({ focus });
    const v = viewEl();
    // BB.render() resolves focus before call detail runs BB.hooks.callAside, so a card
    // in the aside does not exist yet at that point: resolve the target again now.
    let want = null;
    try { want = typeof focus === 'function' ? focus() : typeof focus === 'string' ? document.querySelector(focus) : focus; } catch { want = null; }
    if (want && want.isConnected && v && v.contains(want) && want !== document.activeElement) want.focus({ preventScroll: true });
    const a = document.activeElement;
    if (a && v && v.contains(a)) keepClear(a);
  }

  /** Room to keep under an element: 72 px, or the toast area when a toast sits over it (at most 45% of the screen). */
  function bottomRoom(r) {
    let room = CLEAR_BOTTOM;
    const box = document.querySelector('[data-toasts]');
    if (box && box.children.length) {
      const t = box.getBoundingClientRect();
      if (t.height && t.left < r.right && t.right > r.left) room = Math.max(room, Math.ceil(window.innerHeight - t.top + 8));
    }
    return Math.min(room, Math.round(window.innerHeight * 0.45));
  }

  /**
   * Scroll so an element sits below the sticky header and clear of the toast
   * area at the bottom edge (a tall element keeps its top in view).
   */
  function keepClear(el) {
    if (!el || typeof el.getBoundingClientRect !== 'function') return;
    const r = el.getBoundingClientRect();
    const head = document.querySelector('.app-header');
    const sticky = head && /sticky|fixed/.test(getComputedStyle(head).position);
    const top = (sticky ? Math.max(0, head.getBoundingClientRect().bottom) : 0) + 8;
    const bottom = window.innerHeight - bottomRoom(r);
    let dy = 0;
    if (r.bottom > bottom) dy = r.bottom - bottom;
    if (r.top - dy < top) dy = r.top - top;
    if (Math.abs(dy) >= 1) window.scrollBy({ top: dy, left: 0, behavior: 'instant' });
  }

  /** A toast, then the focused element is moved clear of it (phones: the toast spans the screen). */
  function toast(line1, line2, opts) {
    BB.toast(line1, line2, opts);
    const a = document.activeElement;
    const v = viewEl();
    if (a && v && v.contains(a) && a !== v) keepClear(a);
  }

  /** After a review: the next waiting card in the call, else "Post reviews to Slack" (task log off), else the group or panel. */
  function nextFocus(callId, afterKey, origin) {
    return () => {
      const pend = pendingOf(BB.effectiveProposals(callId));
      const n = afterKey ? Number(String(afterKey).split(':').pop()) : 0;
      for (const p of [...pend.filter((x) => x.n > n), ...pend.filter((x) => x.n <= n)]) {
        const el = document.getElementById(cardId(p.key));
        if (el) return el;
      }
      return document.getElementById(`send-${callId}`)
        || (origin === 'aside' ? document.getElementById('proposals') : document.getElementById(`group-${callId}`));
    };
  }
  const nextCardOf = (callId, afterKey) => {
    const el = nextFocus(callId, afterKey, 'log')();
    return el && el.matches && el.matches('[data-card]') ? el : null;
  };

  // ================================================================ cards and rows
  /** The verdict chip; DUPLICATE reads "Already tracked" on a neutral chip. */
  function vchip(v) {
    if (String(v || '').toUpperCase() === 'DUPLICATE') return '<span class="v v-duplicate tl-v-tracked">Already tracked</span>';
    return BB.verdict(v);
  }

  function actionsHtml(p, id) {
    if (!BB.isDemo) return `<p class="tl-wait">${esc(WAITING_APP)}</p>`;
    const busy = ui.busy.get(p.key);
    const btn = (act, label, primary) => `<button class="btn btn-small${primary ? '' : ' btn-ghost'}" type="button" id="${id}-${act}" data-act="${act}" data-p="${esc(p.key)}"${busy ? ' aria-disabled="true"' : ''}>${esc(busy && busy.act === act ? busy.label : label)}</button>`;
    let buttons;
    if (p.verdict === 'COMMENT') buttons = [btn('approve', 'Add comment', true), btn('edit', 'Edit'), btn('skip', 'Skip')];
    else if (p.verdict === 'FLAG' && p.target) buttons = [btn('approve', 'Comment on existing', true), btn('alt', 'Create new instead'), btn('edit', 'Edit'), btn('skip', 'Skip')];
    else if (p.verdict === 'DUPLICATE') buttons = [btn('skip', 'Skip', true), btn('anyway', 'Create anyway')];
    else buttons = [btn('approve', 'Create issue', true), btn('edit', 'Edit'), btn('skip', 'Skip')];
    return `<div class="decision-actions">${buttons.join('')}</div>`;
  }

  /** "Will post on GRW-102: “…” [Edit]": the comment a COMMENT or FLAG would post, as it stands. */
  function willPostHtml(p, e, id) {
    if (!p.target || !e) return '';
    // The quote inside the comment nests, so it takes single quotes.
    const text = String(commentText(p, e)).replace(SIGNATURE, '').trim().replace(/“/g, '‘').replace(/”/g, '’');
    const body = `“${esc(text)}”`;
    const edited = (p.changed || []).includes('comment');
    const edit = BB.isDemo
      ? `<button class="tl-inline-btn" type="button" id="${id}-cedit" data-act="edit-comment" data-p="${esc(p.key)}" aria-label="Edit the comment for ${esc(p.target.ref)}"${ui.busy.has(p.key) ? ' aria-disabled="true"' : ''}>Edit</button>`
      : '';
    return `<div class="tl-will"><p class="tl-will-text"><span class="tl-will-k">Will post on ${esc(p.target.ref)}:</span> ${edited ? `<mark>${body}</mark>` : body}</p>${edit}</div>`;
  }

  /** The issue a COMMENT or FLAG points at, and the comment it would post there. */
  function issueBox(p, e, id, lead) {
    return `<div class="tl-iss"><p class="tl-iss-line">${lead}</p>${willPostHtml(p, e, id)}</div>`;
  }

  /** "Already tracked as ENG-318 · Done ▶ 15:20", then the issue's title. */
  function trackedBox(p) {
    if (!p.target) return '';
    const i = issueOf(p.target.ref) || {};
    const status = issueStatus(p);
    const at = p.ts || (dupState(p).match(/\((\d{1,3}:\d{2})\)/) || [])[1] || '';
    const line = `Already tracked as ${BB.ref(p.target.ref)}${status ? ` · ${esc(status)}` : ''}${at ? ` ${BB.ts(p.call_id, at)}` : ''}`;
    const sub = joinDot([
      esc(i.title || p.target.title || ''),
      i.assignee ? BB.person(i.assignee) : '',
      i.updated && fmtDay(i.updated) ? `updated ${esc(fmtDay(i.updated))}` : '',
    ]);
    return `<div class="tl-iss"><p class="tl-iss-line">${line}</p>${sub ? `<p class="tl-iss-sub">${sub}</p>` : ''}</div>`;
  }

  /** A waiting proposal: the full §3.4 card (Proposals) or the compact one (call detail). */
  function cardHtml(p, o = {}) {
    const id = cardId(p.key);
    const e = BB.effectiveProposals(p.call_id);
    const busy = ui.busy.has(p.key);
    const ch = new Set(p.changed || []);
    const mark = (on, html) => (on && html ? `<mark>${html}</mark>` : html);
    const owner = mark(ch.has('owner'), p.owner ? BB.person(p.owner) : '<span class="tl-dim">no owner</span>');
    const key = teamKey(p.owner_team);
    const teamTo = p.owner_team ? `${esc(cap(p.owner_team))}${key ? ` → <span class="mono">${esc(key)}</span>` : ''}` : '';
    const team = mark(ch.has('team'), teamTo);
    const prio = mark(ch.has('priority'), p.priority ? esc(cap(p.priority)) : '');
    const at = p.ts ? BB.ts(p.call_id, p.ts) : '';
    let meta = '';
    let note = '';
    let noteCls = '';
    let box = '';
    if (p.verdict === 'COMMENT') {
      meta = joinDot([owner, mark(ch.has('team'), p.owner_team ? esc(cap(p.owner_team)) : ''), prio, at]);
      if (!o.compact && p.evidence) note = `Why a comment: ${esc(p.evidence)}.`;
      if (p.target) box = issueBox(p, e, id, `On ${issueLine(p.target)}`);
    } else if (p.verdict === 'FLAG') {
      meta = joinDot([owner, team, prio, at]);
      if (p.target) {
        note = esc(seenBefore(p));
        noteCls = ' tl-seen';
        box = issueBox(p, e, id, `Possible duplicate${hasSim(p) ? `, ${esc(pct(p.similarity))} similar` : ''}: ${issueLine(p.target)}`);
      } else if (!o.compact && p.evidence) {
        note = `Why flagged: ${esc(p.evidence)}.`;
      }
    } else if (p.verdict === 'DUPLICATE') {
      box = trackedBox(p);
      note = esc(dupAdvice(p));
    } else {
      meta = joinDot([owner, team, prio, at]);
      if (!o.compact && p.evidence) note = `Backlog check: ${esc(String(p.evidence).replace(/\s+in (the )?backlog$/i, ''))}.`;
    }
    const quote = !o.compact && p.quote ? `<blockquote class="evidence"><p>“${esc(p.quote)}”</p></blockquote>` : '';
    const noteHtml = note ? `<p class="decision-meta tl-note${noteCls}">${note}</p>` : '';
    // The issue box sits right above the buttons it explains; on an Already tracked card the
    // suggestion ("Suggested: skip.") follows the box instead.
    const tracked = p.verdict === 'DUPLICATE';
    return `<article class="decision${o.compact ? ' tl-compact' : ''}${busy ? ' is-busy' : ''}" id="${id}" tabindex="-1" aria-labelledby="${id}-t" data-card="${esc(p.key)}"${busy ? ' aria-disabled="true"' : ''}>
      ${vchip(p.verdict)}
      <h3 class="decision-title" id="${id}-t">${mark(ch.has('title'), esc(p.title))}${p.edited ? ' <span class="chip tl-edited">Edited</span>' : ''}</h3>
      ${meta ? `<p class="decision-meta">${meta}</p>` : ''}
      ${quote}
      ${tracked ? `${box}${noteHtml}` : `${noteHtml}${box}`}
      ${actionsHtml(p, id)}
    </article>`;
  }

  function resultHtml(p) {
    const d = p.decision || {};
    if (p.status === 'skipped') return `Skipped${d.reason ? ` · “${esc(d.reason)}”` : ''}`;
    if (d.result === 'created') return `Created${d.ref ? ` ${BB.ref(d.ref)}` : ''}`;
    if (d.result === 'commented') return `Commented${d.ref ? ` on ${BB.ref(d.ref)}` : ''}`;
    if (d.result === 'file-only') return `Not filed: kept as a note${d.reason ? ` · “${esc(d.reason)}”` : ''}`;
    return 'Approved';
  }

  function whyHtml(p, id) {
    if (!BB.isDemo || p.by !== 'you' || p.status !== 'skipped') return '';
    if (ui.whySaved.has(p.key)) return `<p class="tl-why tl-why-saved" id="${id}-why" tabindex="-1">Saved as feedback.</p>`;
    if (!ui.whyOpen.has(p.key) || (p.decision && p.decision.reason)) return '';
    return `<div class="tl-why" id="${id}-why" tabindex="-1" role="group" aria-labelledby="${id}-whyk">
      <span class="tl-why-k" id="${id}-whyk">Why? <span class="tl-dim">Optional</span></span>
      <span class="tl-why-chips">${REASONS.map((r) => `<button class="tl-chip" type="button" data-act="why" data-p="${esc(p.key)}" data-reason="${esc(r.toLowerCase())}">${esc(r)}</button>`).join('')}</span>
    </div>`;
  }

  /** A reviewed proposal: one ruled line (§3.4), or the compact row in call detail. */
  function outcomeHtml(p, o = {}) {
    const id = cardId(p.key);
    const d = p.decision || {};
    const cls = p.status === 'skipped' ? 'is-skipped' : d.result === 'created' || d.result === 'commented' ? 'is-done' : 'is-kept';
    const who = p.owner ? esc(p.owner) : 'no owner';
    const ref = p.target ? BB.ref(p.target.ref) : '';
    let what;
    if (p.verdict === 'COMMENT') what = `on ${ref} <span class="tl-dim">· ${esc(contextOf(p))}</span>`;
    else if (p.verdict === 'FLAG') what = `${esc(p.title)} <span class="tl-dim">· ${joinDot([p.target ? `${hasSim(p) ? `${esc(pct(p.similarity))} similar to` : 'similar to'} ${ref}` : '', who])}</span>`;
    else if (p.verdict === 'DUPLICATE') what = `${esc(p.title)}${p.target ? ` <span class="tl-dim">· already tracked as ${ref}</span>` : ''}`;
    else what = `${esc(p.title)} <span class="tl-dim">· ${who}</span>${p.ts && !o.compact ? ` ${BB.ts(p.call_id, p.ts)}` : ''}`;
    // When it was reviewed: "You · today, 14:07" here, or the training log's time for a review made in Slack.
    const reviewedAt = p.by !== 'you' && p.decided_at && BB.clock(p.decided_at) ? `${fmtDay(p.decided_at)}, ${BB.clock(p.decided_at)}` : '';
    const by = p.by === 'you' ? `<span class="tl-by">You · ${esc(BB.stamp(p.at))}</span>` : reviewedAt ? `<span class="tl-by">${esc(reviewedAt)}</span>` : '';
    const editNote = p.edited && p.edit_summary ? `<span class="tl-edit-sum">${esc(p.edit_summary)}</span>` : '';
    const fresh = ui.fresh.get(p.key);
    const undo = BB.isDemo && p.by === 'you' && fresh && fresh.until > Date.now()
      ? `<span class="tl-undo-at"><button class="tl-inline-btn tl-undo" type="button" id="${id}-undo" data-act="undo" data-p="${esc(p.key)}" data-undo="${esc(p.key)}" aria-label="Undo: ${esc(p.title)}">Undo</button></span>`
      : '';
    return `<div class="outcome ${cls}${o.compact ? ' tl-compact' : ''}" id="${id}" tabindex="-1" data-card="${esc(p.key)}">
      ${vchip(p.verdict)}
      <p class="tl-what">${what}${p.edited ? ' <span class="chip tl-edited">Edited</span>' : ''}${editNote}</p>
      <p class="outcome-result">${resultHtml(p)}${by}${undo}</p>
      ${whyHtml(p, id)}
    </div>`;
  }

  /** "1 possible duplicate", "1 already tracked", "1 more". */
  function restKinds(rest) {
    const f = rest.filter((p) => p.verdict === 'FLAG').length;
    const d = rest.filter((p) => p.verdict === 'DUPLICATE').length;
    const o = rest.length - f - d;
    return [f && plural(f, 'possible duplicate'), d && `${d} already tracked`, o && `${o} more`].filter(Boolean);
  }
  /** "1 possible duplicate and 1 already tracked: review them one by one." */
  function othersPhrase(rest) {
    return `${cap(joinAnd(restKinds(rest)))}: review ${rest.length === 1 ? 'it on its own' : 'them one by one'}.`;
  }
  /** "1 possible duplicate and 1 already tracked stay here to review one by one." */
  function restNote(rest) {
    return `${cap(joinAnd(restKinds(rest)))} ${rest.length === 1 ? 'stays' : 'stay'} here to review ${rest.length === 1 ? 'on its own' : 'one by one'}.`;
  }

  /**
   * "Approve 2 tasks" and "Skip the rest", or the planning-call note. With
   * filters (f) they act on the waiting cards shown, and say so: "Skip 1 shown".
   */
  function bulkHtml(e, f, o = {}) {
    if (!BB.isDemo) return '';
    const all = pendingOf(e);
    const shown = f ? all.filter((p) => matches(p, f)) : all;
    if (!shown.length) return '';
    const filtered = shown.length < all.length;
    const multi = filtered || shown.length > 1;
    const off = bulkOff(e);
    const safe = shown.filter((p) => p.safe);
    const rest = shown.filter((p) => !p.safe);
    const id = e.call_id;
    const btns = [];
    if (!off && safe.length && multi) {
      btns.push(`<button class="btn btn-small" type="button" id="bulk-approve-${esc(id)}" data-act="bulk-approve" data-call="${esc(id)}">${esc(filtered ? `Approve ${safe.length} shown` : `Approve ${plural(safe.length, 'task')}`)}</button>`);
    }
    if (all.length > 1 && multi) {
      btns.push(`<button class="btn btn-small btn-ghost" type="button" id="bulk-skip-${esc(id)}" data-act="bulk-skip" data-call="${esc(id)}">${esc(filtered ? `Skip ${shown.length} shown` : 'Skip the rest')}</button>`);
    }
    const notes = [];
    if (off) {
      if (all.length > 1) notes.push(`<p class="tl-planning">${esc(PLANNING)}</p>`);
    } else {
      const bits = [];
      if (btns.length && safe.length) bits.push(safe.length === 1 ? 'The one the backlog check is sure about.' : `The ${safe.length} the backlog check is sure about.`);
      if (btns.length && rest.length) bits.push(othersPhrase(rest));
      if (filtered && btns.length) {
        const hidden = all.length - shown.length;
        bits.push(`${plural(hidden, 'more proposal')} ${hidden === 1 ? 'waits' : 'wait'} outside these filters.`);
      }
      if (bits.length) notes.push(`<p class="tl-bulk-note">${esc(bits.join(' '))}</p>`);
    }
    if (!btns.length && !notes.length) return '';
    return `<div class="tl-bulk${o.compact ? ' tl-compact' : ''}">${btns.length ? `<div class="tl-bulk-btns">${btns.join('')}</div>` : ''}${notes.join('')}</div>`;
  }

  // ================================================================ How proposals land
  function fmtDuration(min) {
    const m = Math.max(0, Math.round(min));
    if (m < 60) return `${m} min`;
    if (m < 48 * 60) { const h = Math.floor(m / 60); const r = m % 60; return r ? `${h} h ${r} min` : `${h} h`; }
    return `${Math.round(m / 144) / 10} days`;
  }

  /**
   * Accepted as proposed, duplicates prevented and time to review: the core's
   * BB.effectiveMetrics(), the very figures the Overview tiles show (the
   * build's values plus the reviews made here), so the two pages never differ.
   */
  function landHtml(f) {
    const m = BB.effectiveMetrics();
    const va = m && m.verdict_agreement;
    if (!va || !va.decided) return '';
    const tt = m.time_to_decision || {};
    const over48 = Number(tt.over_48h) || 0;
    const cells = [
      [`${va.agreed} of ${va.decided}`, `accepted as proposed${va.edited ? ` · ${va.edited} edited` : ''}`],
      [String(m.duplicates_prevented.confirmed), 'duplicates prevented (confirmed)'],
    ];
    if (Number.isFinite(tt.median_minutes)) cells.push([fmtDuration(tt.median_minutes), `median time to review${over48 ? ` · ${over48} waiting over 48 h` : ''}`]);
    else if (over48) cells.push([String(over48), `${over48 === 1 ? 'proposal' : 'proposals'} waiting over 48 h`]);
    // The link counts the rows the Reviewed filter shows.
    const rows = entries().reduce((n, e) => n + e.proposals.filter((p) => p.status !== 'pending').length, 0);
    const show = rows
      ? `<button class="btn-link tl-land-show" type="button" data-act="show-reviewed" data-land-show${f && f.status === 'reviewed' ? ' hidden' : ''}>${rows === 1 ? 'Show the reviewed one' : `Show the ${rows} reviewed`}</button>`
      : '';
    return `<section class="panel tl-land" aria-labelledby="h-land">
      <div class="tl-land-head"><h2 id="h-land">How proposals land</h2>${show}</div>
      <ul class="tl-land-grid">${cells.map(([v, k]) => `<li><span class="tl-land-v">${esc(v)}</span> <span class="tl-land-k">${esc(k)}</span></li>`).join('')}</ul>
      <p class="tl-land-foot">${feedbackHtml()}</p>
    </section>`;
  }

  // ================================================================ Proposals (§3.4)
  const statusOf = (p) => (p.status === 'pending' ? 'waiting' : p.status);
  function readFilters(q) {
    const v = String(q.verdict || '').toUpperCase();
    return {
      status: STATUS.some(([k]) => k === q.status) ? q.status : 'all',
      verdict: VERDICTS.includes(v) ? v : '',
      owner: q.owner ? String(q.owner) : '',
    };
  }
  function matches(p, f, ignore) {
    const s = statusOf(p);
    return (ignore === 'status' || f.status === 'all' || s === f.status || (f.status === 'reviewed' && s !== 'waiting'))
      && (!f.verdict || p.verdict === f.verdict)
      && (!f.owner || (f.owner === 'none' ? !p.owner : p.owner === f.owner));
  }
  function statusCounts(all, f) {
    const n = { all: 0, waiting: 0, reviewed: 0, approved: 0, skipped: 0 };
    for (const e of all) {
      for (const p of e.proposals) {
        if (!matches(p, f, 'status')) continue;
        n.all++;
        n[statusOf(p)] = (n[statusOf(p)] || 0) + 1;
        if (p.status !== 'pending') n.reviewed++;
      }
    }
    return n;
  }

  function filtersHtml(all, f) {
    const n = statusCounts(all, f);
    const owners = [...new Set(all.flatMap((e) => e.proposals.map((p) => p.owner)).filter(Boolean))].sort();
    if (f.owner && f.owner !== 'none' && !owners.includes(f.owner)) owners.push(f.owner);
    return `<form class="filters tl-filters" aria-label="Filter proposals" data-tl-filters>
      <fieldset class="tl-seg-set"><legend>Status</legend><div class="tl-seg">${STATUS.map(([k, label]) => `<label><input type="radio" name="status" value="${k}"${k === f.status ? ' checked' : ''}><span>${label}</span> <span class="tl-n" data-n="${k}">${n[k] || 0}</span></label>`).join('')}</div></fieldset>
      <label>Verdict <select name="verdict"><option value="">All verdicts</option>${VERDICTS.map((v) => `<option value="${v.toLowerCase()}"${v === f.verdict ? ' selected' : ''}>${VNAME[v]}</option>`).join('')}</select></label>
      <label>Owner <select name="owner"><option value="">Everyone</option>${owners.map((o) => `<option value="${esc(o)}"${o === f.owner ? ' selected' : ''}>${esc(o)}</option>`).join('')}<option value="none"${f.owner === 'none' ? ' selected' : ''}>No owner</option></select></label>
    </form>`;
  }

  /** "All 4 reviewed: 2 created · 1 commented · 1 skipped" */
  function reviewedPhrase(e) {
    const ps = e.proposals;
    const c = (r) => ps.filter((p) => p.status !== 'skipped' && p.decision && p.decision.result === r).length;
    const sk = ps.filter((p) => p.status === 'skipped').length;
    const notes = c('file-only');
    const parts = [
      c('created') && `${c('created')} created`,
      c('commented') && `${c('commented')} commented`,
      notes && `${notes} kept as ${notes === 1 ? 'a note' : 'notes'}`,
      sk && `${sk} skipped`,
    ].filter(Boolean);
    const lead = ps.length === 1 ? 'Reviewed' : `All ${ps.length} reviewed`;
    return `${lead}${parts.length ? `: ${parts.join(' · ')}` : ''}`;
  }

  /** Reviews made here since the last post to Slack (all of them when none was posted). */
  function unpostedCount(e) {
    const mine = e.proposals.filter((p) => p.by === 'you');
    const sent = e.log_sent ? Date.parse(e.log_sent.at) : NaN;
    return Number.isNaN(sent) ? mine.length : mine.filter((p) => !(Date.parse(p.at) <= sent)).length;
  }

  /**
   * "Post reviews to Slack": only while the task log is off (with it on, each
   * review already updated the call's thread in place) and reviews made here
   * wait to be posted.
   */
  function sendButton(e) {
    if (!BB.isDemo || BB.taskLogOn() || !unpostedCount(e)) return '';
    const primary = !pendingOf(e).length;
    return `<button class="btn btn-small${primary ? '' : ' btn-ghost'}" type="button" id="send-${esc(e.call_id)}" data-act="send-log" data-call="${esc(e.call_id)}">Post reviews to Slack</button>`;
  }

  /**
   * "Posted in #product-sync at 13:52" (the pipeline's task log), then either
   * "Updated in the call's Slack thread · today 11:06" (task log on: the thread
   * follows each review) or "Reviews posted to … · today 14:07" (posted by hand).
   */
  function postedLines(e) {
    const out = [];
    const base = settings() && settings().slack;
    if (base && base.delivery && base.delivery.task_log && e.generated) {
      const t = BB.clock(e.generated);
      if (t) out.push(`<p class="tl-sent">Posted in <span class="mono">${esc(threadChannel(e.call_id))}</span> at <span class="mono">${esc(t)}</span></p>`);
    }
    if (BB.taskLogOn()) out.push(BB.threadNote(e, { cls: 'tl-sent' }));
    else if (e.log_sent) out.push(`<p class="tl-sent">Reviews posted to <span class="mono">${esc(e.log_sent.channel || threadChannel(e.call_id))}</span> · ${esc(BB.stamp(e.log_sent.at, ' '))}</p>`);
    return out.join('');
  }

  function groupHtml(e, shown, f) {
    const id = e.call_id;
    const row = callRow(id);
    const pend = pendingOf(e);
    const meta = [BB.teamChip(e.team), row && row.call_type ? `<span>${esc(row.call_type)}</span>` : ''];
    if (pend.length) {
      meta.push(`<span class="chip-mark">${pend.length} waiting</span>`);
      const rev = e.proposals.length - pend.length;
      if (rev) meta.push(`<span class="tl-dim">${rev} reviewed</span>`);
    }
    const status = pend.length ? '' : `<p class="tl-status">${esc(reviewedPhrase(e))}</p>${bulkOff(e) && e.proposals.length > 1 ? '<p class="tl-dim tl-small">Planning call · reviewed one by one.</p>' : ''}`;
    const send = sendButton(e);
    const items = shown.map((p) => `<li>${p.status === 'pending' ? cardHtml(p) : outcomeHtml(p)}</li>`).join('');
    return `<section class="tl-group" id="group-${esc(id)}" tabindex="-1" aria-labelledby="gh-${esc(id)}">
      <header class="tl-head">
        <p class="tl-when"><span>${esc(fmtDay(e.date))}</span>${e.time ? `<span>${esc(e.time)}</span>` : ''}</p>
        <div class="tl-what-call">
          <h2 class="tl-topic" id="gh-${esc(id)}"><a href="${esc(href('call', id))}">${esc(e.topic)}</a></h2>
          <p class="tl-meta">${meta.filter(Boolean).join(' ')}</p>
          ${status}${postedLines(e)}
        </div>
        ${send ? `<div class="tl-send-at">${send}</div>` : ''}
      </header>
      <div class="tl-body">
        ${bulkHtml(e, f)}
        <ol class="tl-items" aria-label="Proposals from ${esc(e.topic)}">${items}</ol>
      </div>
    </section>`;
  }

  function groupsHtml(all, f) {
    const out = [];
    for (const e of all) {
      const shown = e.proposals.filter((p) => matches(p, f)).sort((a, b) => a.n - b.n);
      if (shown.length) out.push(groupHtml(e, shown, f));
    }
    return out.join('') || BB.emptyState('<p>Nothing matches these filters.</p><p><button class="btn btn-small btn-ghost" type="button" data-act="clear-filters">Clear filters</button></p>');
  }

  const shownCount = (all, f) => all.reduce((n, e) => n + e.proposals.filter((p) => matches(p, f)).length, 0);

  function taskLogView(parts, query) {
    const [sub, id] = parts;
    if (sub && !(sub === 'call' && id)) { BB.go('#/tasks', { replace: true }); return; }
    const first = firstRender();
    const all = entries();
    if (sub === 'call' && !all.some((e) => e.call_id === id)) { BB.go('#/tasks', { replace: true }); return; }
    if (!all.length) {
      page('log', BB.emptyState('<p>No proposals yet. After your next call, proposed tasks show up here, checked against your Linear backlog.</p>'));
      return;
    }
    const f = readFilters(query);
    const total = all.reduce((n, e) => n + e.proposals.length, 0);
    page('log', `${landHtml(f)}${filtersHtml(all, f)}
      <p class="sr-only" role="status" data-tl-status></p>
      <div class="tl-groups" data-tl-groups>${groupsHtml(all, f)}</div>`, {
      eyebrow: esc(`${plural(total, 'proposal')} from ${plural(all.length, 'call')}`),
      focus: first && sub === 'call' ? `#group-${CSS.escape(id)}` : null,
    });
    const form = $('[data-tl-filters]', viewEl());
    form.addEventListener('submit', (ev) => ev.preventDefault());
    form.addEventListener('change', () => applyFilters(form));
  }

  function applyFilters(form, focusAfter) {
    const val = (n) => { const el = form.elements.namedItem(n); return el ? el.value : ''; };
    const f = readFilters({ status: val('status'), verdict: val('verdict'), owner: val('owner') });
    const cur = BB.current;
    const base = cur.parts[0] === 'call' && cur.parts[1] ? ['tasks', 'call', cur.parts[1]] : ['tasks'];
    const q = { status: f.status === 'all' ? '' : f.status, verdict: f.verdict.toLowerCase(), owner: f.owner };
    const h = href(...base, q);
    if (location.hash !== h) {
      history.replaceState(null, '', h);
      cur.hash = h;
      cur.query = Object.fromEntries(Object.entries(q).filter(([, v]) => v));
      ui.routed = h;
    }
    const all = entries();
    const n = statusCounts(all, f);
    for (const el of $$('[data-n]', form)) el.textContent = String(n[el.dataset.n] || 0);
    const v = viewEl();
    const box = $('[data-tl-groups]', v);
    if (box) box.innerHTML = groupsHtml(all, f);
    const show = $('[data-land-show]', v);
    if (show) show.hidden = f.status === 'reviewed';
    const st = $('[data-tl-status]', v);
    const count = shownCount(all, f);
    if (st) st.textContent = count ? `${plural(count, 'proposal')} shown.` : 'Nothing matches these filters.';
    if (focusAfter) focusAfter();
  }

  // ================================================================ undo
  /** Remember how to undo a review; its outcome row offers Undo for 10 s. */
  function snapFor(key, d, edit) {
    // The decision object itself identifies the review: two reviews can share a time on a frozen demo clock.
    const snap = { key, obj: d, editTouched: Boolean(edit), prevEdit: edit ? edit.prev : null };
    const until = Date.now() + UNDO_MS;
    ui.fresh.set(key, { until, snap });
    setTimeout(() => expireUndo(key, until), UNDO_MS + 30);
    return snap;
  }

  function expireUndo(key, until) {
    const f = ui.fresh.get(key);
    if (!f || f.until !== until) return;
    ui.fresh.delete(key);
    for (const b of $$(`[data-undo="${CSS.escape(key)}"]`)) {
      const row = b.closest('[data-card]');
      const had = document.activeElement === b;
      (b.closest('.tl-undo-at') || b).remove();
      if (had && row) row.focus({ preventScroll: true });
    }
  }

  /** Put reviews back to waiting, unless they changed since (another review, a reset). */
  async function undoSnaps(snaps) {
    if (!BB.isDemo) return;
    const done = [];
    for (const s of snaps) {
      const d = BB.state.decisions[s.key];
      if (!d || d !== s.obj) continue;
      delete BB.state.decisions[s.key];
      if (s.editTouched) {
        if (s.prevEdit) BB.state.edits[s.key] = s.prevEdit;
        else delete BB.state.edits[s.key];
      }
      ui.fresh.delete(s.key);
      ui.whyOpen.delete(s.key);
      ui.whySaved.delete(s.key);
      done.push(s.key);
    }
    if (!done.length) return;
    BB.save();
    await refreshWith(() => document.getElementById(cardId(done[0])));
    const p = proposalOf(done[0]);
    toast(done.length === 1 ? `Undone. “${p ? p.title : 'The proposal'}” is waiting again.` : `Undone. ${done.length} proposals are waiting again.`, NOTE.linear);
  }

  /** Every approve, comment and skip toast offers Undo (the core shows the action). */
  function reviewToast(line1, snaps) {
    const list = snaps.filter((s) => s && s.obj);
    toast(line1, NOTE.linear, list.length ? { action: { label: 'Undo', run: () => undoSnaps(list) } } : undefined);
  }

  // ================================================================ interactions
  async function approve(key, alt, origin, extra = {}) {
    if (ui.busy.has(key)) return;
    const p = proposalOf(key);
    if (!p || p.status !== 'pending') return;
    const plan = approvalPlan(p, alt);
    const epoch = ui.epoch;
    ui.busy.set(key, { act: extra.act || (alt ? 'alt' : 'approve'), label: plan.busy });
    paintBusy(key);
    await wait(700);
    if (epoch !== ui.epoch) return;
    const card = document.getElementById(cardId(key));
    if (card && !reducedMotion()) { card.classList.add('is-collapsing'); await wait(150); }
    ui.busy.delete(key);
    if (epoch !== ui.epoch) return;
    const now = proposalOf(key);
    if (!now || now.status !== 'pending') return;
    const d = BB.decide(key, { action: plan.action, result: plan.result, ref: plan.ref, reason: null, edited: Boolean(now.edited), edit_summary: editSummary(now) });
    const snap = snapFor(key, d, extra.edit);
    await refreshWith(nextFocus(callIdOf(key), key, origin));
    reviewToast(plan.toast, [snap]);
  }

  /** The busy state, painted in place: the card is aria-disabled and the button says what is happening. */
  function paintBusy(key) {
    const b = ui.busy.get(key);
    for (const card of $$(`[data-card="${CSS.escape(key)}"]`)) {
      card.setAttribute('aria-disabled', 'true');
      card.classList.add('is-busy');
      for (const btn of $$('button', card)) btn.setAttribute('aria-disabled', 'true');
      const btn = b && $(`[data-act="${b.act}"]`, card);
      if (btn) btn.textContent = b.label;
    }
  }

  async function skip(key, origin) {
    if (ui.busy.has(key)) return;
    const p = proposalOf(key);
    if (!p || p.status !== 'pending') return;
    const card = document.getElementById(cardId(key));
    if (card && !reducedMotion()) { card.classList.add('is-collapsing'); await wait(150); }
    const d = BB.decide(key, { action: 'skip', result: 'skipped', reason: null, edited: Boolean(p.edited), edit_summary: editSummary(p) });
    const snap = snapFor(key, d);
    ui.whyOpen.add(key);
    const next = nextFocus(callIdOf(key), key, origin);
    await refreshWith(() => document.getElementById(`${cardId(key)}-why`) || next());
    reviewToast('Skipped.', [snap]);
  }

  async function pickReason(key, reason) {
    const d = BB.state.decisions[key];
    if (!d || !reason) return;
    d.reason = reason;
    BB.save();
    ui.whyOpen.delete(key);
    ui.whySaved.add(key);
    // Carry on with the next waiting card; the last one keeps the "Saved as feedback." line.
    const callId = callIdOf(key);
    await refreshWith(() => nextCardOf(callId, key) || document.getElementById(`${cardId(key)}-why`));
    reviewToast('Skipped. Reason saved as feedback.', [{ key, obj: d, editTouched: false, prevEdit: null }]);
  }

  /** The waiting cards a bulk action covers: those the filters show (Proposals), or all of the call's (call detail). */
  function bulkScope(callId, origin) {
    const e = BB.effectiveProposals(callId);
    if (!e) return null;
    const f = origin === 'log' ? readFilters((BB.current && BB.current.query) || {}) : null;
    const all = pendingOf(e);
    const shown = (f ? all.filter((p) => matches(p, f)) : all).filter((p) => !ui.busy.has(p.key));
    return { e, all, shown, filtered: shown.length < all.length };
  }

  function titlesHtml(list) {
    return `<ul class="plain-list tl-dialog-list">${list.map((x) => `<li>${x}</li>`).join('')}</ul>`;
  }
  function hiddenNote(sc) {
    const hidden = sc.all.length - sc.shown.length;
    return hidden > 0 ? `<p class="tl-dialog-note">${esc(`${plural(hidden, 'more proposal')} ${hidden === 1 ? 'waits' : 'wait'} outside the filters and ${hidden === 1 ? 'stays' : 'stay'} as ${hidden === 1 ? 'it is' : 'they are'}.`)}</p>` : '';
  }

  async function bulkApprove(callId, trigger, origin) {
    const sc = bulkScope(callId, origin);
    if (!sc || bulkOff(sc.e)) return;
    const safe = sc.shown.filter((p) => p.safe);
    if (!safe.length) return;
    const rest = sc.shown.filter((p) => !p.safe);
    const items = safe.map((p) => {
      if (p.verdict === 'COMMENT' || p.verdict === 'FLAG') return `Comment on ${esc((p.target && p.target.ref) || 'the existing issue')}: “${esc(p.title)}”`;
      const k = teamKey(p.owner_team);
      return `Create “${esc(p.title)}”${k ? ` in ${esc(k)}` : ''}, ${esc(p.owner ? `assigned to ${p.owner}` : 'unassigned')}`;
    });
    const n = safe.length;
    const h = BB.dialog({
      title: sc.filtered ? (n === 1 ? 'Approve the task shown?' : `Approve the ${n} tasks shown?`) : `Approve ${plural(n, 'task')}?`,
      html: `${titlesHtml(items)}${rest.length ? `<p class="tl-dialog-note">${esc(restNote(rest))}</p>` : ''}${hiddenNote(sc)}`,
      actions: [
        { label: `Approve ${n}`, busy: 'Approving…', onClick: () => wait(700) },
        { label: 'Cancel', cancel: true },
      ],
      trigger,
    });
    if (!(await h.result)) return;
    const done = [];
    const snaps = [];
    for (const s of safe) {
      const p = proposalOf(s.key);
      if (!p || p.status !== 'pending') continue;
      const plan = approvalPlan(p, false);
      const d = BB.decide(p.key, { action: plan.action, result: plan.result, ref: plan.ref, reason: null, edited: Boolean(p.edited), edit_summary: editSummary(p) });
      snaps.push(snapFor(p.key, d));
      done.push(plan.result === 'created' ? `created ${plan.ref}` : `commented on ${plan.ref}`);
    }
    if (!done.length) return;
    const left = pendingOf(BB.effectiveProposals(callId)).length;
    await refreshWith(nextFocus(callId, null, origin));
    reviewToast(`Approved ${done.length}: ${done.join(', ')}.${left ? ` ${left} still ${left === 1 ? 'waits' : 'wait'}.` : ''}`, snaps);
  }

  async function bulkSkip(callId, trigger, origin) {
    const sc = bulkScope(callId, origin);
    if (!sc || !sc.shown.length) return;
    const list = sc.shown;
    const n = list.length;
    let reason = null;
    const h = BB.dialog({
      title: sc.filtered ? (n === 1 ? 'Skip the proposal shown?' : `Skip the ${n} proposals shown?`) : `Skip ${plural(n, 'proposal')}?`,
      html: `${titlesHtml(list.map((p) => `${vchip(p.verdict)} ${esc(p.title)}`))}
        <p class="tl-dialog-note">Nothing is filed. A reason, if you give one, is kept as feedback.</p>${hiddenNote(sc)}
        <div class="form tl-skip-why"><div class="field"><label for="tl-skip-why">Why? (optional)</label>
        <select id="tl-skip-why" name="why"><option value="">No reason given</option>${REASONS.map((r) => `<option value="${esc(r.toLowerCase())}">${esc(r)}</option>`).join('')}</select></div></div>`,
      actions: [
        { label: `Skip ${n}`, onClick: (hd) => { const s = $('[name="why"]', hd.body); reason = s && s.value ? s.value : null; } },
        { label: 'Cancel', cancel: true },
      ],
      trigger,
    });
    if (!(await h.result)) return;
    const snaps = [];
    for (const s of list) {
      const p = proposalOf(s.key);
      if (!p || p.status !== 'pending') continue;
      const d = BB.decide(p.key, { action: 'skip', result: 'skipped', reason, edited: Boolean(p.edited), edit_summary: editSummary(p) });
      snaps.push(snapFor(p.key, d));
    }
    if (!snaps.length) return;
    await refreshWith(nextFocus(callId, null, origin));
    reviewToast(reason ? `Skipped ${snaps.length}. Reason saved as feedback.` : `Skipped ${snaps.length}.`, snaps);
  }

  // ---------------------------------------------------------------- "Create a new issue anyway?"
  function ownerOptions(selected) {
    const people = BB.effectivePeople().people;
    const opts = people.map((x) => [x.lastname, x.name || x.lastname]);
    if (selected && !people.some((x) => x.lastname === selected)) opts.push([selected, selected]);
    return opts.map(([v, label]) => `<option value="${esc(v)}"${v === selected ? ' selected' : ''}>${esc(label)}</option>`).join('');
  }

  /**
   * "Create anyway" (Already tracked) and "Create new instead" (FLAG) file a
   * second issue next to one that may cover the task: confirm it, with an owner.
   */
  async function confirmCreate(key, alt, trigger, origin) {
    let p = proposalOf(key);
    if (!p || p.status !== 'pending' || ui.busy.has(key)) return;
    if (!settings()) {
      await BB.load('settings').catch(() => null);
      p = proposalOf(key);
      if (!p || p.status !== 'pending') return;
    }
    const plan = approvalPlan(p, alt);
    const t = p.target || null;
    const i = (t && issueOf(t.ref)) || {};
    const status = issueStatus(p);
    const covers = p.verdict === 'DUPLICATE' ? 'already covers this' : 'may already cover this';
    const what = t
      ? `${esc(t.ref)} ${covers}: ${esc(i.title || t.title || '')}${status ? ` · ${esc(status)}` : ''}.`
      : 'The backlog check says this is already tracked.';
    const id = cardId(key);
    let owner = null;
    const h = BB.dialog({
      title: 'Create a new issue anyway?',
      html: `<div class="form tl-confirm">
        <p class="tl-confirm-what">${what}</p>
        <p class="tl-confirm-new">New issue${plan.ref ? ` <span class="mono">${esc(plan.ref)}</span>` : ''}: “${esc(p.title)}”</p>
        <div class="field"><label for="tl-c-owner">Owner</label>
          <select id="tl-c-owner" name="owner" required aria-required="true"><option value="">Choose an owner</option>${ownerOptions(p.owner)}</select>
          <p class="error" role="alert" id="tl-c-owner-err" hidden></p></div>
      </div>`,
      trigger,
      returnFocus: `#${id}-${alt ? 'alt' : 'anyway'}`,
      onOpen: (hd) => { const s = $('#tl-c-owner', hd.body); if (s) s.focus(); },
      actions: [
        {
          label: 'Create issue',
          onClick: (hd) => {
            const s = $('#tl-c-owner', hd.body);
            const err = $('#tl-c-owner-err', hd.body);
            if (!s.value) {
              s.setAttribute('aria-invalid', 'true');
              s.setAttribute('aria-describedby', 'tl-c-owner-err');
              err.textContent = 'Choose an owner. A new issue needs someone to pick it up.';
              err.hidden = false;
              s.focus();
              return false;
            }
            owner = s.value;
            return true;
          },
        },
        { label: 'Cancel', cancel: true },
      ],
    });
    if (!(await h.result) || !owner) return;
    const cur = proposalOf(key);
    if (!cur || cur.status !== 'pending') return;
    // The owner chosen here is an edit like any other (owner: none → Carter), and Undo puts it back.
    let edit = null;
    if ((cur.owner || null) !== owner) {
      const prev = BB.state.edits[key];
      edit = { prev: prev ? { ...prev } : null };
      BB.state.edits[key] = { ...(prev || {}), owner };
      BB.save();
      await refreshWith(`#${id}-${alt ? 'alt' : 'anyway'}`);
    }
    await approve(key, alt, origin, { act: alt ? 'alt' : 'anyway', edit });
  }

  // ---------------------------------------------------------------- Edit before filing
  function guessTeam(p) {
    const ref = (p.verdict === 'FLAG' && p.on_approve && p.on_approve.alt && p.on_approve.alt.ref) || (p.on_approve && p.on_approve.ref) || '';
    const prefix = String(ref).split('-')[0];
    const m = teamMap();
    const byRef = Object.keys(m).find((t) => m[t] === prefix);
    if (byRef) return byRef;
    const person = p.owner && BB.effectivePeople().people.find((x) => x.lastname === p.owner);
    return (person && person.team && m[person.team] ? person.team : null) || Object.keys(m)[0] || '';
  }

  function issueBodyHtml(p, e) {
    const b = p.issue_body && typeof p.issue_body === 'object' ? p.issue_body : null;
    const row = callRow(e.call_id);
    const at = p.ts ? ` <span class="ts">▶ ${esc(p.ts)}</span>` : '';
    const fallback = {
      context: `<p>From ${esc(e.topic)}, ${esc(BB.fmtDate(e.date, e.time))}${p.quote ? `: “${esc(p.quote)}”` : '.'}</p>`,
      task: `<p>${esc(p.title)}</p>`,
      result: '<p>Written when the issue is filed.</p>',
      extra: `<p><span class="mono">${esc((row && row.path) || e.tasks_path || '')}</span>${at}</p>`,
    };
    const blocks = BODY_HEADS.map(([k, head]) => {
      const html = b && b[k] ? (k === 'extra' ? BB.md(b[k]) : `<p>${BB.inline(b[k])}</p>`) : fallback[k];
      return `<h3>${esc(head)}</h3>${html}`;
    }).join('');
    return `<div class="field"><p class="field-label" id="tl-desc-l">Issue description</p>
      <div class="win tl-issue" role="group" aria-labelledby="tl-desc-l">
        <div class="win-bar"><span class="win-app">Linear</span><span class="win-path">Read-only · filed with the issue</span></div>
        <div class="win-body">${blocks}</div>
      </div></div>`;
  }

  /** "Edit before filing". opts.focus 'comment' starts on the comment (the card's "Will post … [Edit]"). */
  async function openEdit(key, trigger, opts = {}) {
    let p = proposalOf(key);
    if (!p || p.status !== 'pending' || ui.busy.has(key)) return;
    // The Linear teams come from settings, which a call page does not load by itself.
    if (!settings()) {
      await BB.load('settings').catch(() => null);
      p = proposalOf(key);
      if (!p || p.status !== 'pending') return;
    }
    const origin = trigger && trigger.closest && trigger.closest('[data-call-aside]') ? 'aside' : 'log';
    const e = BB.effectiveProposals(p.call_id);
    const fields = p.verdict !== 'COMMENT';
    const withComment = p.verdict === 'COMMENT' || (p.verdict === 'FLAG' && Boolean(p.target));
    const files = p.verdict === 'COMMENT' || (p.verdict === 'FLAG' && Boolean(p.target)) ? 'comment' : 'create';
    const base = p.original || { title: p.title, owner: p.owner, priority: p.priority, owner_team: p.owner_team };
    const baseTeam = base.owner_team || guessTeam({ ...p, owner: base.owner });
    const shownTeam = p.owner_team || baseTeam;
    const m = teamMap();
    const defComment = withComment ? defaultComment(p, e) : '';
    const curComment = typeof p.comment === 'string' ? p.comment : defComment;
    const id = cardId(key);
    const html = `<div class="form tl-edit">
      ${p.target && p.verdict === 'COMMENT' ? `<p class="tl-edit-on">Comment on ${BB.ref(p.target.ref)} · ${esc(p.target.title)}</p>` : ''}
      ${fields ? `<div class="field">
        <label for="tl-e-title">Title</label>
        <input type="text" id="tl-e-title" name="title" maxlength="250" required value="${esc(p.title)}" autocomplete="off">
        <p class="error" role="alert" id="tl-e-title-err" hidden></p>
      </div>
      <div class="tl-edit-grid">
        <div class="field"><label for="tl-e-owner">Owner</label><select id="tl-e-owner" name="owner"><option value="">No owner</option>${ownerOptions(p.owner)}</select></div>
        <div class="field"><label for="tl-e-prio">Priority</label><select id="tl-e-prio" name="priority">${PRIORITIES.map((x) => `<option value="${x}"${x === (p.priority || 'medium') ? ' selected' : ''}>${cap(x)}</option>`).join('')}</select></div>
        <div class="field"><label for="tl-e-team">Linear team</label><select id="tl-e-team" name="team">${Object.keys(m).map((t) => `<option value="${esc(t)}"${t === shownTeam ? ' selected' : ''}>${esc(`${m[t]} · ${t}`)}</option>`).join('')}</select></div>
      </div>` : ''}
      ${withComment ? `<div class="field">
        <label for="tl-e-comment">Comment</label>
        <textarea id="tl-e-comment" name="comment" rows="6" aria-describedby="tl-e-comment-help">${esc(curComment)}</textarea>
        <p class="help" id="tl-e-comment-help">${p.verdict === 'FLAG' ? `Posted on ${esc((p.target && p.target.ref) || 'the existing issue')} if you choose Comment on existing.` : `Posted on ${esc((p.target && p.target.ref) || 'the issue')} when you choose Add comment.`}</p>
      </div>` : ''}
      ${fields ? issueBodyHtml(p, e) : ''}
    </div>`;
    let values = null;
    const capture = (hd, mode) => {
      const get = (n) => { const el = $(`[name="${n}"]`, hd.body); return el ? el.value : null; };
      if (fields) {
        const t = $('[name="title"]', hd.body);
        const err = $('#tl-e-title-err', hd.body);
        const title = t.value.trim();
        const msg = !title ? 'Enter a title.' : title.length > 250 ? 'Keep the title to 250 characters or fewer.' : '';
        if (msg) {
          t.setAttribute('aria-invalid', 'true');
          t.setAttribute('aria-describedby', 'tl-e-title-err');
        } else {
          t.removeAttribute('aria-invalid');
          t.removeAttribute('aria-describedby');
        }
        err.textContent = msg;
        err.hidden = !msg;
        if (msg) { t.focus(); return false; }
      }
      values = { mode, title: fields ? get('title').trim() : null, owner: get('owner'), priority: get('priority'), team: get('team'), comment: get('comment') };
      return true;
    };
    const h = BB.dialog({
      title: 'Edit before filing',
      wide: fields,
      html,
      trigger,
      returnFocus: `#${id}-edit`,
      onOpen: (hd) => {
        const want = (opts.focus === 'comment' && $('#tl-e-comment', hd.body)) || $('#tl-e-title', hd.body) || $('#tl-e-comment', hd.body);
        if (want) want.focus();
      },
      actions: [
        { label: files === 'comment' ? 'Save and add comment' : 'Save and create issue', value: 'file', onClick: (hd) => capture(hd, 'file') },
        { label: 'Save changes', value: 'save', onClick: (hd) => capture(hd, 'save') },
        { label: 'Cancel', cancel: true },
      ],
    });
    const ok = await h.result;
    if (!ok || !values) return;
    const cur = proposalOf(key);
    if (!cur || cur.status !== 'pending') return;
    const ed = {};
    if (fields) {
      ed.title = values.title;
      ed.owner = values.owner || null;
      ed.priority = values.priority;
      if (values.team && values.team !== baseTeam) ed.team = values.team;
    }
    if (withComment && typeof values.comment === 'string' && values.comment.trim() !== defComment.trim()) ed.comment = values.comment;
    const changed = (fields && (ed.title !== base.title || (ed.owner || null) !== (base.owner || null) || ed.priority !== (base.priority || 'medium') || 'team' in ed)) || 'comment' in ed;
    const had = Boolean(BB.state.edits[key]);
    if (changed) BB.state.edits[key] = ed;
    else if (had) delete BB.state.edits[key];
    if (changed || had) BB.save();
    if (values.mode === 'file') {
      if (changed || had) await refreshWith(`#${id}-edit`);
      await approve(key, false, origin);
      return;
    }
    if (!changed && !had) return;
    await refreshWith(`#${id}-edit`);
    if (changed) toast('Proposal updated. Approve it to file it.', NOTE.linear);
  }

  // ---------------------------------------------------------------- Post reviews to Slack
  /** The time a post would carry now, on the workspace clock (the demo's frozen clock when it has one). */
  function nowClock() {
    const t = BB.clock(BB.now());
    if (t) return t;
    const d = new Date();
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  /** After posting: the group in Proposals, the proposals panel in call detail, else Overview's "Needs a review". */
  function afterSendFocus(callId) {
    const el = document.getElementById(`send-${callId}`) || document.getElementById(`group-${callId}`) || document.getElementById('proposals');
    if (el) return el;
    const h = document.getElementById('h-waiting');
    // BB.refresh() focuses the element as is; a heading needs tabindex to take focus.
    if (h && !h.hasAttribute('tabindex')) h.setAttribute('tabindex', '-1');
    return h;
  }

  /** "the summary, recording link and task log" */
  function includePhrase(inc) {
    const list = INCLUDE.filter(([k]) => inc[k]).map(([, label]) => label.toLowerCase());
    return list.length ? `the ${joinAnd(list)}` : '';
  }

  function openSendLog(callId, trigger) {
    if (!BB.isDemo) return;
    const e = BB.effectiveProposals(callId);
    if (!e) return;
    const thread = threadChannel(callId);
    const slack = BB.effectiveSlack();
    const channels = [...new Set([thread, slack.channel, ...(slack.channels_available || [])].filter(Boolean))];
    // The button shows only while the task log is off: the thread already has the summary, so what is
    // missing there is the task log with these reviews. More can be ticked.
    const opts = {
      to: 'thread',
      channel: thread,
      ask: true,
      include: { summary: false, transcript_link: false, recording_link: false, task_log: true },
    };
    const target = () => (opts.to === 'thread' ? thread : opts.channel);
    const html = `<div class="form tl-send">
      <fieldset class="tl-send-to"><legend>Post to</legend>
        <label class="check"><input type="radio" name="to" value="thread" checked> <span>Reply in the call's thread in <span class="mono">${esc(thread)}</span></span></label>
        <div class="tl-send-new">
          <label class="check"><input type="radio" name="to" value="new"> <span>New message in</span></label>
          <select name="channel" aria-label="Channel for the new message">${channels.map((c) => `<option value="${esc(c)}"${c === thread ? ' selected' : ''}>${esc(c)}</option>`).join('')}</select>
        </div>
      </fieldset>
      <fieldset class="tl-inc" aria-describedby="tl-inc-err"><legend>Include</legend>
        <div class="tl-inc-row">${INCLUDE.map(([k, label]) => `<label class="check"><input type="checkbox" name="inc" value="${k}"${opts.include[k] ? ' checked' : ''}> <span>${esc(label)}</span></label>`).join('')}</div>
        <label class="check tl-inc-sub"><input type="checkbox" name="ask" checked${opts.include.task_log ? '' : ' disabled'}> <span>With the task log, ask for corrections in the thread</span></label>
        <p class="error" role="alert" id="tl-inc-err" hidden></p>
      </fieldset>
      <div class="tl-send-preview" data-log-preview></div>
      <p class="tl-send-link"><a href="${esc(href('tasks', 'slack', callId))}" data-close-dialog>Change what's posted after every call</a></p>
      <p class="tl-send-foot">${feedbackHtml()}</p>
    </div>`;
    const h = BB.dialog({
      title: 'Post reviews to Slack',
      wide: true,
      html,
      trigger,
      returnFocus: () => afterSendFocus(callId),
      onOpen: (hd) => {
        const paint = () => {
          const box = $('[data-log-preview]', hd.body);
          if (box) box.innerHTML = sendPreviewHtml(callId, { ...opts, channel: target() });
          const b = hd.button(0);
          if (b && !hd.isBusy) b.textContent = `Post to ${target()}`;
        };
        hd.body.addEventListener('change', (ev) => {
          const t = ev.target;
          if (t.name === 'to') opts.to = t.value;
          if (t.name === 'channel') {
            opts.channel = t.value;
            opts.to = 'new';
            const r = $('input[name="to"][value="new"]', hd.body);
            if (r) r.checked = true;
          }
          if (t.name === 'inc') {
            opts.include[t.value] = t.checked;
            const ask = $('input[name="ask"]', hd.body);
            if (ask) ask.disabled = !opts.include.task_log;
            const err = $('#tl-inc-err', hd.body);
            if (err && Object.values(opts.include).some(Boolean)) { err.hidden = true; err.textContent = ''; }
          }
          if (t.name === 'ask') opts.ask = t.checked;
          paint();
        });
        const link = $('[data-close-dialog]', hd.body);
        if (link) link.addEventListener('click', () => hd.close(null));
        paint();
        if (!BB.cached(`call:${callId}`)) {
          BB.load(`call:${callId}`).then(() => { if (hd.el.isConnected) paint(); }).catch(() => {
            const box = $('[data-log-preview]', hd.body);
            if (box && hd.el.isConnected) box.innerHTML = BB.emptyState('<p>The call could not load, so the summary cannot be previewed.</p>');
          });
        }
      },
      actions: [
        {
          label: `Post to ${thread}`,
          onClick: async (hd) => {
            if (!Object.values(opts.include).some(Boolean)) {
              const err = $('#tl-inc-err', hd.body);
              err.textContent = 'Choose at least one thing to post.';
              err.hidden = false;
              const first = $('input[name="inc"]', hd.body);
              if (first) first.focus();
              return false;
            }
            hd.busy(`Posting to ${target()}…`);
            await wait(700);
            return true;
          },
        },
        { label: 'Cancel', cancel: true },
      ],
    });
    h.result.then(async (ok) => {
      if (!ok) return;
      const ch = target();
      const inc = { ...opts.include };
      BB.state.log_sent[callId] = { channel: ch, thread: opts.to === 'thread', ask_corrections: Boolean(opts.ask && inc.task_log), include: inc, at: BB.now() };
      BB.save();
      await refreshWith(() => afterSendFocus(callId));
      const what = includePhrase(inc);
      toast(opts.to === 'thread' ? `Posted ${what} to the thread in ${ch}.` : `Posted ${what} to ${ch}.`, NOTE.slack);
    });
  }

  // ================================================================ Open items (§3.5)
  /** Still owed: the build's `open` (post-call, not closed by a later call, not replaced by a later item). */
  function isOpen(a) {
    if (typeof a.open === 'boolean') return a.open;
    return a.status === 'post-call' && !a.closed_by && !a.superseded;
  }
  const itemTime = (a) => `${a.call_date || ''} ${a.ts || ''}`;

  /**
   * One row per issue. Items without an issue key are rows of their own. For
   * an issue, the latest item stands for it; when that item is the "done on
   * the call" line that closed an earlier commitment, the commitment shows
   * instead, as "Done · 19 Oct ▶ 15:20" (its title, owner and call stay).
   */
  function itemRows(items) {
    const rows = [];
    const byRef = new Map();
    for (const a of items) {
      if (!a.tracker_ref) { rows.push(a); continue; }
      if (!byRef.has(a.tracker_ref)) byRef.set(a.tracker_ref, []);
      byRef.get(a.tracker_ref).push(a);
    }
    const newest = (list) => [...list].sort((x, y) => itemTime(y).localeCompare(itemTime(x)))[0];
    for (const list of byRef.values()) {
      const latest = newest(list.filter((a) => !a.superseded)) || newest(list);
      const closed = latest.status === 'done-on-call'
        ? list.filter((a) => a.closed_by && a.closed_by.call_id === latest.call_id && (!a.closed_by.ts || a.closed_by.ts === latest.ts))
        : [];
      rows.push(closed.length ? newest(closed) : latest);
    }
    return rows.sort((x, y) => itemTime(y).localeCompare(itemTime(x)));
  }

  /**
   * The Status cell: "Open", "Monitoring", "Done · 19 Oct ▶ 15:20" linking to
   * the call that said so, or "Not filed · skipped: not a task" for a proposal
   * skipped here (no longer open; listed under All).
   */
  function itemState(a) {
    const done = a.closed_by || (a.status === 'done-on-call' ? { call_id: a.call_id, topic: a.call_topic, date: a.call_date, ts: a.ts } : null);
    if (done && done.call_id) {
      const said = a.closed_by && a.closed_by.title ? `<span class="sub">“${esc(a.closed_by.title)}”</span>` : '';
      return `<span class="tl-state tl-state-done">Done · <a href="${esc(href('call', done.call_id))}" aria-label="${esc(`Done, said on ${done.topic || 'a call'}, ${fmtDay(done.date)}`)}">${esc(fmtDay(done.date))}</a> ${BB.ts(done.call_id, done.ts)}</span>${said}`;
    }
    if (a.review && a.review.status === 'skipped') {
      return `<span class="tl-state tl-state-skipped">${esc(`Not filed · skipped${a.review.reason ? `: ${a.review.reason}` : ''}`)}</span>`;
    }
    if (a.status === 'monitoring') return '<span class="tl-state tl-state-monitoring">Monitoring</span>';
    return `<span class="tl-state">${isOpen(a) ? 'Open' : 'Replaced by a later item'}</span>`;
  }

  function openItemsView(parts, query) {
    firstRender();
    const items = BB.effectiveActionItems();
    const rows = itemRows(items);
    const owners = [...new Set(rows.map((a) => a.owner).filter(Boolean))].sort();
    const open = items.filter(isOpen).length;
    const st = ITEM_STATUS[query.status] ? query.status : 'open';
    const owner = query.owner || '';
    if (owner && owner !== 'none' && !owners.includes(owner)) owners.push(owner);
    page('open', `
      <form class="filters tl-items-filters" aria-label="Filter action items" data-items-filters>
        <label>Status <select name="status">${Object.entries(ITEM_STATUS).map(([k, [label]]) => `<option value="${k}"${k === st ? ' selected' : ''}>${label}</option>`).join('')}</select></label>
        <label>Owner <select name="owner"><option value="">Everyone</option>${owners.map((o) => `<option value="${esc(o)}"${o === owner ? ' selected' : ''}>${esc(o)}</option>`).join('')}<option value="none"${owner === 'none' ? ' selected' : ''}>No owner</option></select></label>
        <p class="tl-items-note">One row per issue. An item closes when a later call says it's done.</p>
      </form>
      <p class="sr-only" role="status" data-items-status></p>
      <div data-items-box></div>`, {
      eyebrow: esc(`${open} open · ${rows.length} in all`),
    });
    const form = $('[data-items-filters]', viewEl());
    const box = $('[data-items-box]', viewEl());
    const status = $('[data-items-status]', viewEl());
    const linear = (ref) => {
      const i = issueOf(ref);
      return i && i.status ? `<span class="sub">${esc(cap(String(i.status)))} in Linear</span>` : '';
    };
    const apply = (announce) => {
      const f = { status: form.elements.namedItem('status').value, owner: form.elements.namedItem('owner').value };
      const h = href('tasks', 'open', { status: f.status === 'open' ? '' : f.status, owner: f.owner });
      if (location.hash !== h) {
        history.replaceState(null, '', h);
        BB.current.hash = h;
        BB.current.query = f;
        ui.routed = h;
      }
      const want = (ITEM_STATUS[f.status] || ITEM_STATUS.open)[1];
      const list = rows.filter((a) => want(a) && (!f.owner || (f.owner === 'none' ? !a.owner : a.owner === f.owner)));
      if (!list.length) {
        box.innerHTML = BB.emptyState('<p>Nothing matches these filters.</p><p><button class="btn btn-small btn-ghost" type="button" data-items-clear>Clear filters</button></p>');
        $('[data-items-clear]', box).addEventListener('click', () => {
          form.elements.namedItem('status').value = 'open';
          form.elements.namedItem('owner').value = '';
          apply(true);
          form.elements.namedItem('status').focus();
        });
      } else {
        box.innerHTML = `<div class="table-wrap"><table class="items tl-open">
          <thead><tr><th scope="col">Action item</th><th scope="col">Owner</th><th scope="col">Status</th><th scope="col">Tracker</th><th scope="col">From call</th></tr></thead>
          <tbody>${list.map((a) => `<tr>
            <td data-label="Action item"><span class="tl-item-title">${esc(a.title)}</span> ${BB.prio(a.priority)}</td>
            <td data-label="Owner">${a.owner ? BB.person(a.owner) : '<span class="muted">No owner</span>'}${a.helpers && a.helpers.length ? `<span class="sub">with ${esc(joinAnd(a.helpers))}</span>` : ''}</td>
            <td data-label="Status">${itemState(a)}</td>
            <td data-label="Tracker">${a.tracker_ref ? `${BB.ref(a.tracker_ref)}${a.ref_added ? ' <span class="chip tl-you">New · you</span>' : ''}${linear(a.tracker_ref)}` : '<span class="muted">—</span>'}</td>
            <td data-label="From call"><a href="${esc(href('call', a.call_id))}">${esc(a.call_topic)}</a><span class="sub"><span class="mono">${esc(fmtDay(a.call_date))}</span> ${BB.ts(a.call_id, a.ts)}</span></td>
          </tr>`).join('')}</tbody></table></div>`;
      }
      if (announce) status.textContent = list.length ? `${plural(list.length, 'action item')} shown.` : 'Nothing matches these filters.';
    };
    form.addEventListener('input', () => apply(true));
    form.addEventListener('submit', (ev) => ev.preventDefault());
    apply(false);
  }

  // ================================================================ Slack post templates (§4)
  // Strings from the pipeline's English pack (ui_strings), with emoji written
  // out and <url|text> links shown as their text, plus the strings spec §6
  // adds and this round's wording: "Company memory", "Approve 2 tasks",
  // "Skip the rest", "65% similar", "Already tracked", "Not filed: kept as a
  // note", replies kept as feedback, and no "Mode:" line.
  const S = {
    'main.summary_header': '💬 *Summary*',
    'main.participants_line': '*Participants:* {names}',
    'main.decisions_header': '✅ *Decisions ({count})*',
    'main.agreements_header': '🤝 *Agreements ({count})*',
    'main.open_questions_header': '❓ *Open questions ({count})*',
    'main.insights_header': '💡 *Key insights ({count})*',
    'main.next_steps_header': '📋 *Next steps ({count})*',
    'main.monitoring_header': '👀 *Monitoring ({count})* — _ongoing observation_',
    'main.recording_line': 'Recording: {url}',
    'main.vault_link': '📁 Company memory: {filename}',
    'main.transcript_link': '📄 Transcript: {link}',
    'main.digest_footer': '_via Backbrief_',
    'tasks.waiting_in_workspace': '🛠 {count} task proposals are waiting: {link}',
    'tasks.waiting_in_workspace_one': '🛠 1 task proposal is waiting: {link}',
    'tasks.header': '🛠 Backbrief · tasks — {count} proposals',
    'tasks.header_one': '🛠 Backbrief · tasks — 1 proposal',
    'tasks.planning_banner': '⚠️ _Planning mode_ — on these calls the team usually walks through issues that ALREADY exist in the tracker. Review every **CREATE** button manually — chances are the task already exists and needs a COMMENT, not a CREATE. Bulk-approve is disabled.',
    'tasks.footer': '_Approve files it in the tracker. Skip only logs it._',
    'tasks.feedback_footer': '_Reply in this thread if a verdict, owner or priority is wrong; replies are kept as feedback._',
    'tasks.unassigned': '⚠️ _<UNASSIGNED — team lead pick>_',
    'tasks.quote_line': '_quote: «{quote}»{ts}_',
    'tasks.new_context_line': 'New context: «{title}»',
    'tasks.btn_create_issue': '✅ Create issue',
    'tasks.btn_add_comment': '💬 Add comment',
    'tasks.btn_comment_existing': '💬 Comment on existing',
    'tasks.btn_create_instead': '➕ Create new instead',
    'tasks.btn_skip': '⏸️ Skip',
    'tasks.btn_create_anyway': '➕ Create anyway',
    'tasks.btn_bulk_approve': '✅ Approve {count} tasks',
    'tasks.btn_bulk_approve_one': '✅ Approve 1 task',
    'tasks.btn_bulk_skip': '⏸️ Skip the rest',
    'tasks.created_confirm': '✅ Created {identifier}: «{title}»{assignee_suffix}',
    'tasks.assigned_to_suffix': ' · assigned to {mention}',
    'tasks.unassigned_suffix': ' · ⚠️ unassigned — team lead, please assign',
    'tasks.comment_added': '💬 Comment added to {identifier}',
    'tasks.skipped': '⏸️ Skipped: «{title}»',
    'tasks.skipped_reason': '⏸️ Skipped: «{title}» — {reason}',
    'tasks.file_only': '📄 Not filed: kept as a note — «{title}»',
  };
  const MARKER = { CREATE: '✏️ CREATE', COMMENT: '💬 COMMENT', FLAG: '⚠️ FLAG', DUPLICATE: '🔁 ALREADY TRACKED' };
  const fmtPriority = (p) => ({ urgent: '🔴 urgent', high: '🟠 high', medium: 'medium', low: '🟢 low' })[p] || p || 'medium';
  const DEMO_RECORDING = 'zoom.us/rec/share/…';

  /**
   * Slack mrkdwn → HTML. The template (ours) is escaped, then *bold*, _italic_
   * and `code` apply; {values} are HTML the caller built from escaped text and
   * go in last, so nothing in a value is read as markup.
   */
  function mk(tpl, vars = {}) {
    const vals = [];
    let s = String(tpl).replace(/\{(\w+)\}/g, (m, k) => {
      vals.push(vars[k] === undefined || vars[k] === null ? '' : String(vars[k]));
      return `\u0003${vals.length - 1}\u0003`;
    });
    s = esc(s);
    const codes = [];
    s = s.replace(/`([^`]+)`/g, (m, c) => { codes.push(c); return `\u0004${codes.length - 1}\u0004`; });
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[\s(«“])\*([^*]+?)\*(?=$|[\s).,;:!?»”])/g, '$1<strong>$2</strong>');
    s = s.replace(/(^|[\s(«“])_([^_]+?)_(?=$|[\s).,;:!?»”])/g, '$1<em>$2</em>');
    s = s.replace(/\u0004(\d+)\u0004/g, (m, i) => `<code>${codes[Number(i)]}</code>`);
    return s.replace(/\u0003(\d+)\u0003/g, (m, i) => vals[Number(i)]);
  }
  /** A link as Slack shows it: text in link colour; a real link only in the call's own thread (cx.live). */
  function lnk(text, url, cx) {
    const u = cx && cx.live && url ? BB.safeUrl(url) : null;
    return u ? `<a class="slk-link" href="${esc(u)}">${esc(text)}</a>` : `<span class="slk-link">${esc(text)}</span>`;
  }
  const mention = (name) => `<span class="mention">@${esc(name)}</span>`;
  /** ▶ links to the transcript line only when the transcript link is posted; otherwise plain (mm:ss). */
  const tsMode = (d) => (d && d.transcript_link ? 'tr' : 'plain');
  function TS(cx, mmss) {
    if (!mmss) return '';
    if (cx.mode !== 'tr') return `(${esc(mmss)})`;
    if (cx.live) return BB.ts(cx.callId, mmss);
    return `<span class="ts">▶ ${esc(mmss)}</span>`;
  }
  /** Digest text (markdown) as Slack shows it: **bold** → bold, `code`, (mm:ss) → the timestamp form. */
  function digestText(s, cx) {
    let h = esc(String(s || ''));
    h = h.replace(/`([^`]+)`/g, '<code>$1</code>');
    h = h.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    return h.replace(/\((\d{1,3}:\d{2})\)/g, (m, t) => TS(cx, t));
  }
  function addMinutes(hhmm, minutes) {
    const m = String(hhmm || '').match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return '';
    const t = ((Number(m[1]) * 60 + Number(m[2]) + minutes) % 1440 + 1440) % 1440;
    return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
  }
  const L = (html, cls, blk) => ({ html, cls, blk });

  /** One T5 row (09b's blocksForTask, with the tasks-file markers): lines, then buttons while it waits. */
  function t5Row(p, cx) {
    const lines = [];
    const pending = p.status === 'pending';
    const idx = `${p.n}`;
    const marker = MARKER[p.verdict] || p.verdict;
    const title = esc(p.title);
    const ref = p.target ? lnk(p.target.ref) : '';
    const asCreate = p.verdict === 'CREATE' || (p.verdict === 'FLAG' && !p.target);
    if (asCreate) {
      const team = p.owner_team ? `[${esc(cap(p.owner_team))}] ` : '';
      lines.push(L(mk(`*{idx}. {marker}* ${team ? '{team}' : ''}«{title}»`, { idx, marker, team, title }), 'row'));
      const owner = p.owner ? (pending ? mention(p.owner) : `<strong>${esc(p.owner)}</strong>`) : mk(S['tasks.unassigned']);
      lines.push(L(mk('→ {owner} · {prio}', { owner, prio: esc(fmtPriority(p.priority)) }), 'sub'));
    } else if (p.verdict === 'DUPLICATE') {
      const state = dupState(p);
      lines.push(L(mk(`*{idx}. {marker}* {ref}${state ? ' _{state}_' : ''} — «{title}»`, { idx, marker, ref, state: digestText(state, cx), title }), 'row'));
    } else {
      const sim = p.verdict === 'FLAG' && hasSim(p) ? ` (${pct(p.similarity)} similar)` : '';
      lines.push(L(mk('*{idx}. {marker}* {ref}{sim}', { idx, marker, ref, sim: esc(sim) }), 'row'));
      lines.push(L(mk(S['tasks.new_context_line'], { title: esc(contextOf(p)) }), 'sub'));
    }
    if (pending) {
      if (p.quote && p.verdict !== 'DUPLICATE') {
        const ts = asCreate && p.ts ? ` ${TS(cx, p.ts)}` : '';
        lines.push(L(mk(S['tasks.quote_line'], { quote: esc(p.quote), ts }), 'sub'));
      }
      let btns;
      if (p.verdict === 'COMMENT') btns = [[S['tasks.btn_add_comment'], true], [S['tasks.btn_skip']]];
      else if (p.verdict === 'FLAG' && p.target) btns = [[S['tasks.btn_comment_existing'], true], [S['tasks.btn_create_instead']], [S['tasks.btn_skip']]];
      else if (p.verdict === 'DUPLICATE') btns = [[S['tasks.btn_create_anyway']], [S['tasks.btn_skip']]];
      else btns = [[S['tasks.btn_create_issue'], true], [S['tasks.btn_skip']]];
      return { lines, btns };
    }
    const d = p.decision || {};
    let out;
    if (p.status === 'skipped') {
      out = d.reason ? mk(S['tasks.skipped_reason'], { title, reason: esc(d.reason) }) : mk(S['tasks.skipped'], { title });
    } else if (d.result === 'created') {
      const suffix = p.owner ? mk(S['tasks.assigned_to_suffix'], { mention: `<strong>${esc(p.owner)}</strong>` }) : mk(S['tasks.unassigned_suffix']);
      out = mk(S['tasks.created_confirm'], { identifier: lnk(d.ref || ''), title, assignee_suffix: suffix });
    } else if (d.result === 'commented') {
      out = mk(S['tasks.comment_added'], { identifier: lnk(d.ref || (p.target && p.target.ref) || '') });
    } else {
      out = mk(S['tasks.file_only'], { title });
    }
    lines.push(L(out, 'sub'));
    return { lines, btns: null };
  }

  /** T5: the task log message (header, planning banner, rows, bulk row, footers). */
  function t5Parts(e, cx, ask = true) {
    const parts = [];
    const n = e.proposals.length;
    parts.push(L(n === 1 ? mk(S['tasks.header_one']) : mk(S['tasks.header'], { count: n }), 'h'));
    const planning = isPlanning(e);
    if (planning) parts.push(L(mk(S['tasks.planning_banner']), 'ctx'));
    parts.push({ hr: true });
    for (const p of [...e.proposals].sort((a, b) => a.n - b.n)) {
      const r = t5Row(p, cx);
      parts.push(...r.lines);
      if (r.btns) parts.push({ btns: r.btns });
    }
    const pend = pendingOf(e);
    const tail = [];
    if (pend.length) {
      const btns = [];
      const safe = pend.filter((p) => p.safe).length;
      if (!planning && safe) btns.push([safe === 1 ? mk(S['tasks.btn_bulk_approve_one']) : mk(S['tasks.btn_bulk_approve'], { count: safe }), true, true]);
      btns.push([S['tasks.btn_bulk_skip']]);
      tail.push({ btns });
      tail.push(L(mk(S['tasks.footer']), 'ctx'));
    }
    if (ask) tail.push(L(mk(S['tasks.feedback_footer']), 'ctx'));
    if (tail.length) parts.push({ hr: true }, ...tail);
    return parts;
  }

  function partsHtml(parts) {
    return parts.map((x) => {
      if (x.hr) return '<hr class="slk-hr">';
      if (x.btns) {
        return `<div class="msg-actions slk-btns" aria-hidden="true">${x.btns.map(([label, main, html]) => `<span class="sbtn${main ? ' sbtn-main' : ''}">${html ? label : esc(label)}</span>`).join('')}</div>`;
      }
      return `<p class="slk-${x.cls || 'l'}"${x.blk ? ` data-blk="${x.blk}"` : ''}>${x.html}</p>`;
    }).join('');
  }

  function msgHtml(m) {
    const blk = m.blk ? ` data-blk="${m.blk}"` : '';
    const edited = m.edited ? ' <span class="slk-edited">(edited)</span>' : '';
    if (m.head) {
      return `<div class="msg slk-msg"${blk}><img class="msg-av" src="/assets/logo.svg" alt="" width="36" height="36"><div class="msg-main">
        <p class="msg-head"><strong>Backbrief</strong> <span class="app">App</span> <time>${esc(m.time)}</time>${edited}</p>${partsHtml(m.parts)}</div></div>`;
    }
    return `<div class="msg slk-msg slk-cont"${blk}><time class="slk-gutter">${esc(m.time)}</time><div class="msg-main">${partsHtml(m.parts)}${m.edited ? '<p class="slk-edited">(edited)</p>' : ''}</div></div>`;
  }

  const chName = (c) => String(c || 'Slack').replace(/^#/, '');
  const recordingUrl = (call) => (call && call.recording && call.recording.available && call.recording.url
    ? String(call.recording.url).replace(/^https?:\/\//, '') : DEMO_RECORDING);

  /** When the thread was posted: the root at slack.posted_at, replies around the tasks file's `generated`. */
  function threadTimes(call, e) {
    const rootAt = (call.slack && call.slack.posted_at) || addMinutes(call.time, (Number(call.duration_min) || 0) + 1) || '';
    // Replies follow the tasks file's `generated` time in the workspace timezone; without one
    // (/app reads no tenant settings yet), they keep their usual few minutes after the root post.
    const gen = e && e.generated && ws().workspace.timezone ? Date.parse(e.generated) : NaN;
    return {
      rootAt,
      tAt: Number.isNaN(gen) ? addMinutes(rootAt, 7) : BB.clock(new Date(gen - 60000).toISOString()),
      t5At: Number.isNaN(gen) ? addMinutes(rootAt, 8) : BB.clock(new Date(gen).toISOString()),
    };
  }

  /** R: the root post. The recording link only adds its "Recording:" line. */
  function rootHtml(call, d, at) {
    const names = (call.participants || []).join(', ');
    return `<div class="msg slk-msg slk-root" data-blk="root"><img class="msg-av" src="/assets/logo.svg" alt="" width="36" height="36"><div class="msg-main">
      <p class="msg-head"><strong>Backbrief</strong> <span class="app">App</span> <time>${esc(at)}</time></p>
      <p class="msg-title">${esc(call.topic)} <span class="muted">· ${joinDot([call.duration_min ? `${esc(call.duration_min)} min` : '', esc(names)])}</span></p>
      ${d.recording_link ? `<p class="slk-l" data-blk="recording_link">${mk(S['main.recording_line'], { url: lnk(recordingUrl(call)) })}</p>` : ''}
    </div></div>`;
  }

  /** T1 summary, T2 decisions and context, T3 next steps (task log off) and monitoring. */
  function summaryMsgs(call, cx, d, at) {
    const dg = call.digest || {};
    const out = [];
    const t1 = [L(mk(S['main.summary_header'])), L(mk(S['main.participants_line'], { names: (call.participants || []).map((n) => `<strong>${esc(n)}</strong>`).join(', ') }), 'q')];
    for (const th of dg.themes || []) {
      t1.push(L(mk('*{title}* {ts}', { title: digestText(th.title, cx), ts: TS(cx, th.ts) }), 'th'));
      for (const pt of th.points || []) t1.push(L(`• ${digestText(pt, cx)}`, 'li'));
    }
    out.push({ time: at, parts: t1, blk: 'summary' });

    const t2 = [];
    const section = (key, list, line) => {
      if (!list || !list.length) return;
      t2.push(L(mk(S[key], { count: list.length }), t2.length ? 'h2 slk-gap' : 'h2'));
      list.forEach((x, i) => t2.push(L(`${i + 1}. ${line(x)}`, 'li')));
    };
    const tat = (t) => (t ? ` ${TS(cx, t)}` : '');
    section('main.decisions_header', dg.decisions, (x) => mk(x.why ? '*{title}* — _{why}_ {ts}' : '*{title}* {ts}', { title: digestText(x.title, cx), why: digestText(x.why, cx), ts: TS(cx, x.ts) }));
    section('main.agreements_header', dg.agreements, (x) => `${x.parties && x.parties.length ? `${esc(x.parties.join(' ↔ '))}: ` : ''}${digestText(x.text, cx)}${tat(x.ts)}`);
    section('main.open_questions_header', dg.open_questions, (x) => `${digestText(x.title, cx)}${x.why ? ` — ${digestText(x.why, cx)}` : ''}${tat(x.ts)}`);
    section('main.insights_header', dg.key_insights, (x) => `${digestText(x.title, cx)}${x.implication ? ` — ${digestText(x.implication, cx)}` : ''}${tat(x.ts)}`);
    if (t2.length) out.push({ time: at, parts: t2, blk: 'context' });

    // The call's next steps as the digest posted them: an issue created later from a review is not one.
    const items = BB.effectiveActionItems(call.id).filter((a) => !a.added_here);
    const next = items.filter((a) => a.status === 'post-call');
    const mon = items.filter((a) => a.status === 'monitoring');
    const t3 = [];
    if (!d.task_log && next.length) {
      t3.push(L(mk(S['main.next_steps_header'], { count: next.length }), 'h2'));
      next.forEach((a, i) => t3.push(L(`${i + 1}. ${digestText(a.title, cx)}${a.owner ? ` — ${mention(a.owner)}` : ''}${a.helpers && a.helpers.length ? ` <em>(+${esc(a.helpers.join(', '))})</em>` : ''}${a.priority ? ` <em>[${esc(a.priority)}]</em>` : ''}${a.tracker_ref ? ` → <code>${esc(a.tracker_ref)}</code>` : ''}${tat(a.ts)}`, 'li')));
    }
    if (mon.length) {
      t3.push(L(mk(S['main.monitoring_header'], { count: mon.length }), t3.length ? 'h2 slk-gap' : 'h2'));
      mon.forEach((a, i) => t3.push(L(`${i + 1}. ${digestText(a.title, cx)}${a.owner ? ` — <strong>${esc(a.owner)}</strong>` : ''}${tat(a.ts)}`, 'li')));
    }
    if (t3.length) out.push({ time: at, parts: t3, blk: !d.task_log && next.length ? 'next_steps' : 'monitoring' });
    return out;
  }

  /** T4: the call's file, the transcript link, the waiting line and the footer (each optional). */
  function linksParts(call, e, d, cx, o = {}) {
    const parts = [];
    if (o.file !== false && call) {
      parts.push(L(mk(S['main.vault_link'], { filename: lnk(String(call.path || '').split('/').pop(), call.path ? href('memory', { node: call.path }) : null, cx) })));
    }
    if (d.transcript_link) {
      parts.push(L(mk(S['main.transcript_link'], { link: lnk('open the transcript', call ? href('call', call.id, 'transcript') : null, cx) }), 'l', 'transcript_link'));
    }
    if (o.recording) parts.push(L(mk(S['main.recording_line'], { url: lnk(recordingUrl(call)) }), 'l', 'recording_link'));
    const waiting = e ? e.pending : 0;
    if (o.waiting !== false && !d.task_log && waiting) {
      const link = lnk('review in Backbrief', e ? href('tasks', 'call', e.call_id) : null, cx);
      parts.push(L(waiting === 1 ? mk(S['tasks.waiting_in_workspace_one'], { link }) : mk(S['tasks.waiting_in_workspace'], { count: waiting, link }), 'l', 'waiting'));
    }
    if (o.footer !== false && parts.length) parts.push(L(mk(S['main.digest_footer'])));
    return parts;
  }

  /** The messages "Post reviews to Slack" sends, for the parts it includes. */
  function sendMsgs(call, e, o, live) {
    const inc = o.include || {};
    const cx = { mode: inc.transcript_link ? 'tr' : 'plain', live: Boolean(live), callId: e.call_id };
    const d = { transcript_link: Boolean(inc.transcript_link), recording_link: Boolean(inc.recording_link), task_log: Boolean(inc.task_log) };
    const msgs = [];
    if (inc.summary && call) msgs.push(...summaryMsgs(call, cx, d, o.at));
    const links = linksParts(call, e, d, cx, {
      file: Boolean(inc.summary), recording: Boolean(inc.recording_link && o.to === 'thread'), waiting: Boolean(inc.summary), footer: Boolean(inc.summary),
    });
    if (links.length) msgs.push({ time: o.at, parts: links, blk: 'links' });
    if (inc.task_log && e.proposals.length) msgs.push({ time: o.at, parts: t5Parts(e, cx, o.ask !== false), blk: 'task_log' });
    return msgs;
  }

  /**
   * The whole thread after a call (R, T1–T5) for a delivery combination,
   * reflecting the reviews made here. o.live: the call's own thread in call
   * detail, where ▶ times and links work and posts made from here follow.
   */
  function threadHtml(call, d, channel, o = {}) {
    const cx = { mode: tsMode(d), live: Boolean(o.live), callId: call.id };
    const e = BB.effectiveProposals(call.id);
    const { rootAt, tAt, t5At } = threadTimes(call, e);
    const replies = [...summaryMsgs(call, cx, d, tAt)];
    const links = linksParts(call, e, d, cx);
    if (links.length) replies.push({ time: tAt, parts: links, blk: 'links' });
    if (d.task_log && e && e.proposals.length) replies.push({ time: t5At, parts: t5Parts(e, cx, true), blk: 'task_log', edited: Boolean(o.live && e.decided_here) });
    if (o.live && e && e.log_sent && e.log_sent.thread !== false) {
      const sent = e.log_sent;
      const posted = sendMsgs(call, e, { include: sent.include || { task_log: true }, ask: sent.ask_corrections !== false, to: 'thread', at: BB.clock(sent.at) }, true);
      if (posted.length) { posted[0].head = true; replies.push(...posted); }
    }
    if (replies.length) replies[0].head = true;
    const caption = o.live
      ? `The Slack thread for ${esc(call.topic)} in ${esc(channel)}.`
      : `Preview of the Slack thread for ${esc(call.topic)}: ${esc(BB.deliveryPhrase(d))}.`;
    return `<figure class="thread slk${o.live ? ' slk-live' : ''}">
      <figcaption class="sr-only">${caption}</figcaption>
      <div class="thread-bar"><span><b># ${esc(chName(channel))}</b></span><span>${o.live ? 'Slack' : 'Preview · Slack'}</span></div>
      <div class="slk-scroll">
        ${rootHtml(call, d, rootAt)}
        ${replies.length ? `<p class="thread-sep">${esc(plural(replies.length, 'reply', 'replies'))}</p>` : ''}
        ${replies.map(msgHtml).join('')}
      </div>
    </figure>`;
  }

  /** The Send dialog's preview: what will be posted, as replies in the thread or as a new message. */
  function sendPreviewHtml(callId, o) {
    const e = BB.effectiveProposals(callId);
    const call = BB.cached(`call:${callId}`);
    if (!e) return '';
    if (!call) return BB.loading('call');
    const at = nowClock();
    const inThread = o.to === 'thread';
    const inc = o.include;
    const msgs = sendMsgs(call, e, { ...o, at }, false);
    const phrase = includePhrase(inc);
    let body;
    if (inThread) {
      if (!msgs.length) return BB.emptyState('<p>Nothing to post yet: choose what to include.</p>');
      msgs[0].head = true;
      body = msgs.map(msgHtml).join('');
    } else {
      if (!msgs.length && !inc.recording_link) return BB.emptyState('<p>Nothing to post yet: choose what to include.</p>');
      if (msgs.length) msgs[0].head = true;
      body = `${rootHtml(call, { recording_link: inc.recording_link }, at)}${msgs.length ? `<p class="thread-sep">${esc(plural(msgs.length, 'reply', 'replies'))}</p>${msgs.map(msgHtml).join('')}` : ''}`;
    }
    return `<figure class="thread slk slk-log">
      <figcaption class="sr-only">Preview of ${esc(phrase || 'the post')} for ${esc(e.topic)}, ${inThread ? `as replies in the call's thread in ${esc(o.channel)}` : `as a new message in ${esc(o.channel)}`}.</figcaption>
      <div class="thread-bar"><span><b># ${esc(chName(o.channel))}</b>${inThread ? ' · Thread' : ''}</span><span>Preview · Slack</span></div>
      <div class="slk-scroll">${body}</div>
    </figure>`;
  }

  // ================================================================ Slack delivery (§3.6)
  const DKEYS = ['transcript_link', 'recording_link', 'task_log'];
  function savedDraft() {
    const s = BB.effectiveSlack();
    const ch = { default: s.channel || '#call-digests' };
    for (const t of teamsList()) ch[t] = (s.per_team_channels && s.per_team_channels[t]) || '';
    return { delivery: { summary: true, ...Object.fromEntries(DKEYS.map((k) => [k, Boolean(s.delivery[k])])) }, channels: ch };
  }
  function isDirty() {
    if (!ui.draft) return false;
    const s = savedDraft();
    return DKEYS.some((k) => Boolean(ui.draft.delivery[k]) !== s.delivery[k])
      || Object.keys(s.channels).some((k) => (ui.draft.channels[k] || '') !== (s.channels[k] || ''));
  }
  const commaPhrase = (d) => ['summary', d.transcript_link && 'transcript link', d.recording_link && 'recording link', d.task_log && 'task log'].filter(Boolean).join(', ');
  function channelFor(call, chans) {
    const c = chans || (ui.draft && ui.draft.channels) || savedDraft().channels;
    return (call && call.team && c[call.team]) || c.default || '#call-digests';
  }

  // Where a delivery change shows in the preview: the added block, or where the removed one was.
  const CHANGE_AT = {
    transcript_link: (on) => (on ? ['[data-blk="transcript_link"]'] : ['[data-blk="links"]']),
    recording_link: (on) => (on ? ['[data-blk="recording_link"]'] : ['[data-blk="root"]']),
    task_log: (on) => (on ? ['[data-blk="task_log"]'] : ['[data-blk="next_steps"]', '[data-blk="waiting"]', '[data-blk="links"]']),
  };

  /** Mark what a change did in the preview: scroll to it, highlight it, caption it ("Added: 📄 Transcript link"). */
  function showChange(box, c) {
    let target = null;
    let text;
    if (c.key === 'channel') {
      target = $('.thread-bar', box);
      text = `Channel: ${c.channel}`;
    } else {
      for (const sel of (CHANGE_AT[c.key] || (() => []))(c.on)) { target = $(sel, box); if (target) break; }
      text = `${c.on ? 'Added' : 'Removed'}: ${PART[c.key] || c.key}`;
      if (c.key === 'task_log' && !c.on && target && target.matches('[data-blk="next_steps"]')) text += '. Next steps are listed instead';
    }
    if (!target) return text;
    target.classList.add('sd-hl');
    const capEl = document.createElement('p');
    capEl.className = 'sd-change';
    capEl.textContent = text;
    if (target.classList.contains('thread-bar')) {
      const sc = $('.slk-scroll', box);
      if (sc) sc.prepend(capEl);
    } else {
      target.before(capEl);
    }
    const sc = $('.slk-scroll', box);
    const inner = Boolean(sc) && sc.scrollHeight > sc.clientHeight + 1;
    if (inner) {
      const top = capEl.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop - 10;
      sc.scrollTo({ top: Math.max(0, top), behavior: reducedMotion() ? 'auto' : 'smooth' });
    }
    // On phones (and narrow windows) the preview sits below the settings: offer a way down to it.
    const pane = inner ? sc : target;
    const r = pane.getBoundingClientRect();
    const onScreen = inner ? r.top < window.innerHeight - 60 && r.bottom > 60 : r.top >= 0 && r.bottom <= window.innerHeight - CLEAR_BOTTOM;
    watchChange(onScreen ? null : target);
    return text;
  }

  /** The sticky "Preview changed ↓" button: shown while the changed block is off screen. */
  function watchChange(target) {
    ui.changeTarget = target || null;
    if (changeObserver) { changeObserver.disconnect(); changeObserver = null; }
    const wrap = $('[data-sd-changed]', viewEl());
    if (!wrap) return;
    wrap.hidden = !target;
    if (target && 'IntersectionObserver' in window) {
      changeObserver = new IntersectionObserver((list) => {
        if (list.some((x) => x.isIntersecting)) watchChange(null);
      }, { rootMargin: '0px 0px -30% 0px' });
      changeObserver.observe(target);
    }
  }

  function savedToast() {
    return 'Saved. Backbrief applies it before your next call.';
  }

  function paintPreview(announce, change) {
    const box = $('[data-sd-preview]', viewEl());
    if (!box) return;
    const id = ui.previewId;
    const call = id ? BB.cached(`call:${id}`) : null;
    const d = ui.draft ? ui.draft.delivery : BB.effectiveSlack().delivery;
    if (!call) {
      box.innerHTML = BB.loading('call');
      if (!id) return;
      BB.load(`call:${id}`).then(() => {
        if (ui.previewId === id && $('[data-sd-preview]', viewEl())) paintPreview(false);
      }).catch(() => {
        const b = $('[data-sd-preview]', viewEl());
        if (b && ui.previewId === id) b.innerHTML = BB.emptyState('<p>This call could not load. Pick another one.</p>');
      });
      return;
    }
    const channel = channelFor(call);
    box.innerHTML = threadHtml(call, d, channel);
    const said = change ? showChange(box, change) : '';
    if (!change) watchChange(null);
    const live = $('[data-sd-live]', viewEl());
    if (announce && live) live.textContent = `${said ? `${said}. ` : ''}Preview: ${commaPhrase(d)} · ${channel}`;
  }

  function syncDirty() {
    const dirty = isDirty();
    const v = viewEl();
    const chip = $('[data-sd-unsaved]', v);
    if (chip) chip.hidden = !dirty;
    for (const b of $$('[data-sd-save], [data-sd-discard]', v)) {
      if (dirty) b.removeAttribute('aria-disabled'); else b.setAttribute('aria-disabled', 'true');
    }
    BB.setLeaveGuard((to) => (isDirty() && !(to && to.startsWith('#/tasks/slack')) ? 'Your Slack delivery changes are not saved.' : null));
  }

  function previewPickerHtml(calls) {
    return `<label class="sd-pick">Preview with <select name="preview" data-sd-pick>${calls.map((c) => `<option value="${esc(c.id)}"${c.id === ui.previewId ? ' selected' : ''}>${esc(`${fmtDay(c.date)} · ${c.topic}`)}</option>`).join('')}</select></label>`;
  }

  function slackView(parts) {
    const first = firstRender();
    const calls = (ws() && ws().calls) || [];
    const slack = BB.effectiveSlack();
    const pid = parts[0];
    if (parts.length > 1 || (pid && !calls.some((c) => c.id === pid))) { BB.go('#/tasks/slack', { replace: true }); return; }
    const fallback = (slack.preview_call_id && calls.some((c) => c.id === slack.preview_call_id) ? slack.preview_call_id : null) || (calls[0] && calls[0].id) || null;
    ui.previewId = pid || (!first && ui.previewId) || fallback;
    const slackSrc = BB.effectiveSources().find((s) => s.id === 'slack');
    const eyebrow = esc(joinDot([slackSrc && slackSrc.account, slack.channel]));
    const editable = BB.isDemo && Boolean(settings());
    const previewPane = `<section class="sd-preview" id="slack-preview" tabindex="-1" aria-labelledby="h-sd-preview">
        <div class="sd-preview-head"><h2 id="h-sd-preview">Preview</h2>${calls.length ? previewPickerHtml(calls) : ''}</div>
        <div data-sd-preview></div>
        <p class="sr-only" role="status" data-sd-live></p>
      </section>`;
    if (!editable) {
      const teams = teamsList().filter((t) => slack.per_team_channels && slack.per_team_channels[t]);
      const chParts = teams.map((t) => `${esc(t)} → <span class="mono">${esc(slack.per_team_channels[t])}</span>`);
      if (slack.channel) chParts.push(`${teams.length ? 'everything else' : 'every call'} → <span class="mono">${esc(slack.channel)}</span>`);
      const chLine = chParts.length ? `Channels: ${chParts.join(', ')}.` : 'Channels: chosen with Backbrief when Slack was connected.';
      page('slack', `<div class="sd-layout">
          <section class="panel sd-settings" aria-labelledby="h-sd-post">
            <h2 id="h-sd-post">After each call, post</h2>
            <p class="sd-ro">${settings() ? `Posted after each call: ${esc(commaPhrase(slack.delivery))}.` : 'Posted after each call: the summary, plus the links and task log chosen when Slack was connected.'}</p>
            <p class="sd-ro">${chLine}</p>
            <p class="small muted">${BB.managed()}</p>
          </section>
          ${previewPane}
        </div>`, { eyebrow, lede: LEDE.slackReadOnly, focus: first && pid ? '#slack-preview' : null });
      ui.draft = null;
      wirePreviewPicker();
      paintPreview(false);
      return;
    }
    if (!ui.draft) ui.draft = savedDraft();
    const dr = ui.draft;
    const avail = [...new Set([...(slack.channels_available || []), dr.channels.default, ...teamsList().map((t) => dr.channels[t])].filter(Boolean))];
    const sw = SWITCHES.map(([k, label, help]) => {
      const locked = (slack.locked || ['summary']).includes(k);
      return `<div class="switch-row sd-switch">
        <div><label class="sd-label" for="sd-${k}">${esc(label)}</label><p class="sd-help" id="sd-${k}-help">${esc(help)}</p></div>
        <div>${locked ? '<span class="switch-note">Always on</span>' : ''}<input type="checkbox" role="switch" class="switch${locked ? ' switch-locked' : ''}" id="sd-${k}" name="${k}" aria-describedby="sd-${k}-help"${locked || dr.delivery[k] ? ' checked' : ''}${locked ? ' disabled' : ''}></div>
      </div>`;
    }).join('');
    const teamSel = teamsList().map((t) => `<div class="sd-team"><label for="sd-ch-${esc(t)}">${esc(t)}</label>
      <select id="sd-ch-${esc(t)}" name="ch-${esc(t)}" aria-describedby="sd-team-help"><option value="" data-default-option>Default (${esc(dr.channels.default)})</option>${avail.map((c) => `<option value="${esc(c)}"${c === dr.channels[t] ? ' selected' : ''}>${esc(c)}</option>`).join('')}</select></div>`).join('');
    const dirty = isDirty();
    page('slack', `<p class="sd-jump"><a href="#slack-preview">Jump to preview ↓</a></p>
      <div class="sd-layout">
        <section class="panel sd-settings" aria-labelledby="h-sd-post">
          <div class="form" data-sd-form>
            <div class="sd-head"><h2 id="h-sd-post">After each call, post</h2><span class="chip-mark" data-sd-unsaved${dirty ? '' : ' hidden'}>Unsaved changes</span></div>
            <div class="sd-switches">${sw}</div>
            <h2 class="sd-sub">Where</h2>
            <div class="field sd-default"><label for="sd-ch-default">Default channel</label>
              <select id="sd-ch-default" name="ch-default" aria-describedby="sd-default-help">${avail.map((c) => `<option value="${esc(c)}"${c === dr.channels.default ? ' selected' : ''}>${esc(c)}</option>`).join('')}</select>
              <p class="help" id="sd-default-help">For cross-team calls and teams without their own channel.</p></div>
            <fieldset class="sd-teams"><legend>Team channels</legend><div class="sd-team-grid">${teamSel}</div>
              <p class="help" id="sd-team-help">Invite @Backbrief to a channel before choosing it.</p></fieldset>
            <div class="sd-actions">
              <button class="btn btn-small" type="button" id="sd-save" data-sd-save${dirty ? '' : ' aria-disabled="true"'}>Save delivery settings</button>
              <button class="btn btn-small btn-ghost" type="button" id="sd-discard" data-sd-discard${dirty ? '' : ' aria-disabled="true"'}>Discard changes</button>
            </div>
          </div>
          <div class="sd-changed" data-sd-changed hidden><button class="btn btn-small sd-changed-btn" type="button" data-sd-changed-btn>Preview changed ↓</button></div>
        </section>
        ${previewPane}
      </div>`, { eyebrow, focus: first && pid ? '#slack-preview' : null });
    wireDelivery();
    wirePreviewPicker();
    syncDirty();
    paintPreview(false);
  }

  function wirePreviewPicker() {
    const pick = $('[data-sd-pick]', viewEl());
    if (!pick) return;
    pick.addEventListener('change', () => {
      ui.previewId = pick.value;
      const h = href('tasks', 'slack', pick.value);
      if (location.hash !== h) {
        history.replaceState(null, '', h);
        BB.current.hash = h;
        BB.current.parts = [pick.value];
        ui.routed = h;
      }
      paintPreview(true);
    });
  }

  function wireDelivery() {
    const v = viewEl();
    const form = $('[data-sd-form]', v);
    if (!form) return;
    form.addEventListener('change', (ev) => {
      const t = ev.target;
      if (!ui.draft || !t.name) return;
      const call = ui.previewId ? BB.cached(`call:${ui.previewId}`) : null;
      const before = channelFor(call);
      let change = null;
      if (t.type === 'checkbox') {
        if (!DKEYS.includes(t.name)) return;
        ui.draft.delivery[t.name] = t.checked;
        change = { key: t.name, on: t.checked };
      } else if (t.name === 'ch-default') {
        ui.draft.channels.default = t.value;
        for (const o of $$('[data-default-option]', form)) o.textContent = `Default (${t.value})`;
      } else if (t.name.startsWith('ch-')) {
        ui.draft.channels[t.name.slice(3)] = t.value;
      } else return;
      if (!change) {
        const after = channelFor(call);
        if (after !== before) change = { key: 'channel', channel: after };
      }
      syncDirty();
      paintPreview(true, change);
    });
    $('[data-sd-save]', form).addEventListener('click', async (ev) => {
      if (ev.currentTarget.getAttribute('aria-disabled') === 'true' || !ui.draft) return;
      const base = settings() && settings().slack;
      const d = ui.draft.delivery;
      const c = ui.draft.channels;
      const sameDelivery = base && DKEYS.every((k) => Boolean(d[k]) === Boolean(base.delivery[k]));
      const sameChannels = base && c.default === base.channel && teamsList().every((t) => (c[t] || '') === ((base.per_team_channels && base.per_team_channels[t]) || ''));
      BB.state.delivery = sameDelivery ? null : { summary: true, transcript_link: Boolean(d.transcript_link), recording_link: Boolean(d.recording_link), task_log: Boolean(d.task_log) };
      BB.state.channels = sameChannels ? null : { default: c.default, ...Object.fromEntries(teamsList().map((t) => [t, c[t] || null])) };
      BB.save();
      BB.setLeaveGuard(null);
      ui.draft = null;
      await refreshWith('#sd-save');
      toast(savedToast(), NOTE.browser);
    });
    $('[data-sd-discard]', form).addEventListener('click', (ev) => {
      if (ev.currentTarget.getAttribute('aria-disabled') === 'true') return;
      ui.draft = savedDraft();
      for (const [k] of SWITCHES) {
        const el = $(`#sd-${k}`, form);
        if (el && !el.disabled) el.checked = Boolean(ui.draft.delivery[k]);
      }
      const def = $('#sd-ch-default', form);
      if (def) def.value = ui.draft.channels.default;
      for (const o of $$('[data-default-option]', form)) o.textContent = `Default (${ui.draft.channels.default})`;
      for (const t of teamsList()) {
        const s = $(`[name="ch-${CSS.escape(t)}"]`, form);
        if (s) s.value = ui.draft.channels[t] || '';
      }
      syncDirty();
      BB.setLeaveGuard(null);
      paintPreview(true);
    });
    const jump = $('[data-sd-changed-btn]', v);
    if (jump) {
      jump.addEventListener('click', () => {
        const pane = $('#slack-preview', v);
        const t = ui.changeTarget && ui.changeTarget.isConnected ? ui.changeTarget : pane;
        if (t) t.scrollIntoView({ block: 'center', behavior: reducedMotion() ? 'auto' : 'smooth' });
        if (pane) pane.focus({ preventScroll: true });
        watchChange(null);
      });
    }
  }

  // ================================================================ call detail (§3.3)
  BB.hooks.callAside = (call, el) => {
    firstRender();
    const e = BB.effectiveProposals(call.id);
    if (!e || !e.proposals.length) {
      el.innerHTML = '';
      el.hidden = true;
      return;
    }
    el.setAttribute('aria-labelledby', 'h-proposals');
    // Team keys (Product → PRD) and issue facts come from settings; a call page may not have them yet.
    if (BB.isDemo && !settings()) {
      BB.load('settings').then(() => { if (el.isConnected && !el.contains(document.activeElement)) BB.hooks.callAside(call, el); }).catch(() => {});
    }
    const rows = [...e.proposals].sort((a, b) => a.n - b.n)
      .map((p) => `<li>${p.status === 'pending' ? cardHtml(p, { compact: true }) : outcomeHtml(p, { compact: true })}</li>`).join('');
    const send = sendButton(e);
    el.innerHTML = `<h2 id="h-proposals">Task proposals</h2>
      <p class="panel-note">Checked against the Linear backlog before anything was filed.</p>
      ${bulkHtml(e, null, { compact: true })}
      <ol class="tl-items tl-aside-items" aria-label="Task proposals">${rows}</ol>
      ${send ? `<p class="tl-aside-send">${send}</p>` : BB.threadNote(e, { cls: 'tl-aside-note' })}
      <p class="panel-foot"><a href="${esc(href('tasks', 'call', call.id))}">Open in Action items</a></p>`;
  };

  BB.hooks.sendLog = (callId, trigger) => openSendLog(callId, trigger);

  /**
   * The call's whole Slack thread, as Backbrief posted it with the saved
   * delivery settings and the reviews made here (call detail's Slack thread tab).
   */
  BB.hooks.slackThread = (call, el) => {
    if (!call || !el) return;
    const slack = BB.effectiveSlack();
    const d = { ...(slack.delivery || {}), summary: true };
    const channel = (call.slack && call.slack.channel) || (settings() ? channelFor(call, savedDraft().channels) : null);
    const where = channel ? `in <span class="mono">${esc(channel)}</span> ` : 'in Slack ';
    el.innerHTML = `<p class="tl-thread-cap">What Backbrief posted ${where}after this call</p>${threadHtml(call, d, channel || 'Slack', { live: true })}`;
    // Channels, delivery and issue facts come from settings; a call page may not have them yet.
    if (BB.isDemo && !settings()) {
      BB.load('settings').then(() => { if (el.isConnected && settings()) BB.hooks.slackThread(call, el); }).catch(() => {});
    }
  };

  // ================================================================ events
  document.addEventListener('click', (ev) => {
    const b = ev.target.closest && ev.target.closest('[data-act]');
    const v = viewEl();
    if (!b || !v || !v.contains(b)) return;
    ev.preventDefault();
    if (b.getAttribute('aria-disabled') === 'true') return;
    const key = b.dataset.p;
    const origin = b.closest('[data-call-aside]') ? 'aside' : 'log';
    const act = b.dataset.act;
    if (!BB.isDemo && act !== 'clear-filters' && act !== 'show-reviewed') return;
    if (act === 'approve') approve(key, false, origin);
    else if (act === 'alt') confirmCreate(key, true, b, origin);
    else if (act === 'anyway') confirmCreate(key, false, b, origin);
    else if (act === 'skip') skip(key, origin);
    else if (act === 'edit') openEdit(key, b);
    else if (act === 'edit-comment') openEdit(key, b, { focus: 'comment' });
    else if (act === 'why') pickReason(key, b.dataset.reason);
    else if (act === 'undo') {
      const f = ui.fresh.get(key);
      if (f) undoSnaps([f.snap]);
    } else if (act === 'bulk-approve') bulkApprove(b.dataset.call, b, origin);
    else if (act === 'bulk-skip') bulkSkip(b.dataset.call, b, origin);
    else if (act === 'send-log') openSendLog(b.dataset.call, b);
    else if (act === 'show-reviewed' || act === 'clear-filters') {
      const form = $('[data-tl-filters]', v);
      if (!form) return;
      const want = act === 'show-reviewed' ? 'reviewed' : 'all';
      const r = $(`input[name="status"][value="${want}"]`, form);
      if (!r) return;
      r.checked = true;
      if (act === 'clear-filters') {
        form.elements.namedItem('verdict').value = '';
        form.elements.namedItem('owner').value = '';
      }
      applyFilters(form, () => r.focus());
    }
  });

  // ================================================================ routes
  const NEEDS = ['workspace', 'settings?', 'people?'];
  BB.route('tasks', taskLogView, { nav: 'tasks', title: 'Action items', loading: 'proposals', needs: NEEDS });
  BB.route('tasks/open', openItemsView, { nav: 'tasks', title: 'Action items', needs: ['workspace', 'settings?', 'people?'] });
  // Review history folded into Proposals: its old address shows the reviewed ones.
  BB.route('tasks/history', () => { BB.go(href('tasks', { status: 'reviewed' }), { replace: true }); }, { nav: 'tasks', title: 'Action items', loading: 'proposals', needs: ['workspace'] });
  BB.route('tasks/slack', slackView, { nav: 'tasks', title: 'Action items', needs: NEEDS });
})();
