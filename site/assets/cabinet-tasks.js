// SPDX-License-Identifier: MIT
/*
 * cabinet-tasks.js — Action items (spec §3.4 to §3.6, Slack post templates
 * in §4): the task log with its waiting proposal cards, open items, review
 * history, and Slack delivery with its live preview. It also fills
 * BB.hooks.callAside (the waiting cards and bulk bar in call detail) and
 * BB.hooks.sendLog (the "Send the task log to Slack" dialog).
 *
 * Every demo action writes the overlay through BB (BB.decide, state.edits,
 * state.log_sent, state.delivery, state.channels), saves, then re-renders
 * with BB.refresh(), so the nav count, Overview, call detail, the Calls
 * chips and the Slack preview all follow from one place. /app is read-only:
 * an action with no API behind it is not rendered at all (§3.11).
 *
 * The Slack preview (§4) is built from strings copied from the pipeline's
 * English language pack, with emoji shortcodes written out and links shown
 * as their text: nothing in the preview can be clicked.
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
  const joinDot = (parts) => parts.filter(Boolean).join(' · ');
  const NOTE = BB.DEMO_NOTE;

  // ================================================================ copy (spec §3.4–3.6)
  const LEDE = 'Every task Backbrief proposed, checked against your Linear backlog. Nothing is filed until someone approves it.';
  const LEDE_THREAD = "Decisions made in the call's Slack thread show up here too.";
  const WAITING_APP = "Waiting for a decision in the call's Slack thread.";
  const PLANNING = 'Planning call: teams usually walk through issues that already exist, so review each Create by hand; it often needs a Comment instead. Approve all is off for this call.';
  const REASONS = ['Already covered', 'Already done', 'Not a task', 'Wrong owner', 'Wrong team', 'Other'];
  const PRIORITIES = ['urgent', 'high', 'medium', 'low'];
  const VERDICTS = ['CREATE', 'COMMENT', 'FLAG', 'DUPLICATE'];
  const VNAME = { CREATE: 'Create', COMMENT: 'Comment', FLAG: 'Flag', DUPLICATE: 'Duplicate' };
  const STATUS = [['all', 'All'], ['waiting', 'Waiting'], ['approved', 'Approved'], ['skipped', 'Skipped']];
  const ITEM_STATUS = { open: ['post-call', 'Open'], monitoring: ['monitoring', 'Monitoring'], done: ['done-on-call', 'Done on call'], all: [null, 'All'] };
  const ITEM_LABEL = { 'post-call': 'Open', monitoring: 'Monitoring', 'done-on-call': 'Done on call' };
  const BODY_HEADS = [['context', '📌 Context'], ['task', '✅ Task'], ['result', '🎯 Expected result'], ['extra', '📎 Additional information']];
  const SWITCHES = [
    ['summary', 'Summary', "What was discussed and decided, who owns what next, and a link to the call's file."],
    ['transcript_link', 'Transcript link', 'A link to the transcript in this workspace. With the recording link off, every ▶ timestamp opens the transcript at that line.'],
    ['recording_link', 'Recording link', 'A link to the Zoom recording; every ▶ timestamp starts it at that minute.'],
    ['task_log', 'Task log', "The proposals and their verdicts, with Approve and Skip buttons, in the call's thread. Replies there are saved as training data. When off, proposals wait in Action items and the thread says how many."],
  ];

  // ================================================================ module state
  // Transient UI state lives here and is re-applied on every render: the
  // overlay (BB.state) holds only what a demo action changed.
  const ui = {
    busy: new Map(), // proposal key → {act, label} while an approval runs
    whyOpen: new Set(), // skipped here; the "Why?" chips show
    whySaved: new Set(), // a reason was just picked; "Saved as training data."
    draft: null, // Slack delivery draft {delivery, channels}
    previewId: null, // the call in the Slack delivery preview
    routed: null, // hash of the last rendered route (BB 'route' event)
    epoch: 0, // bumped by Reset demo, so a running approval is dropped
  };

  BB.on('route', (cur) => {
    ui.routed = cur.hash;
    if (cur.prefix !== 'tasks/slack') ui.draft = null;
  });
  BB.on('reset', () => {
    ui.epoch++;
    ui.busy.clear();
    ui.whyOpen.clear();
    ui.whySaved.clear();
    ui.draft = null;
    ui.previewId = null;
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
  function dupAdvice(p) {
    const s = dupState(p);
    if (/in progress/i.test(s)) return "Suggested: skip. It's already in progress.";
    if (/done/i.test(s)) return "Suggested: skip. It's already done.";
    return "Suggested: skip. It's already tracked.";
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
    // A FLAG with no matched issue (the discriminator's, not the matcher's) can only be created.
    if (p.verdict === 'FLAG' && (alt || !p.target)) {
      const ref = refInTeam((oa.alt && oa.alt.ref) || (!p.target && oa.ref) || null, moved);
      return { action: alt ? 'approve_alt' : 'approve', result: 'created', ref, busy: 'Creating in Linear…', toast: `Created ${ref || 'the issue'} in Linear, ${p.owner ? `assigned to ${p.owner}` : 'unassigned'}.` };
    }
    if (p.verdict === 'COMMENT' || p.verdict === 'FLAG') {
      const ref = oa.ref || (p.target && p.target.ref) || null;
      return { action: 'approve', result: 'commented', ref, busy: ref ? `Commenting on ${ref}…` : 'Commenting in Linear…', toast: ref ? `Comment added to ${ref}.` : 'Comment added.' };
    }
    const ref = refInTeam(oa.ref || null, moved);
    const toast = p.verdict === 'DUPLICATE'
      ? `Created ${ref || 'the issue'} in Linear.`
      : `Created ${ref || 'the issue'} in Linear, ${p.owner ? `assigned to ${p.owner}` : 'unassigned'}.`;
    return { action: 'approve', result: 'created', ref, busy: 'Creating in Linear…', toast };
  }

  /** 'owner: none → Carter', logged with an edited approval (training data). */
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
    const decided = BB.effectiveProposals().reduce((n, e) => n + e.proposals.filter((p) => p.status !== 'pending').length, 0);
    return BB.tabs([
      { key: 'log', href: '#/tasks', label: 'Task log', count: BB.waitingCount(), mark: true },
      { key: 'open', href: '#/tasks/open', label: 'Open items', count: BB.effectiveActionItems().filter((a) => a.status === 'post-call').length },
      { key: 'history', href: '#/tasks/history', label: 'Review history', count: decided },
      { key: 'slack', href: '#/tasks/slack', label: 'Slack delivery' },
    ], current, { label: 'Action items' });
  }

  /** The lede; with the task log on (always in /app, where decisions happen in Slack) it adds the thread sentence. */
  function lede() {
    const on = !BB.isDemo || Boolean(BB.effectiveSlack().delivery.task_log);
    return `${esc(LEDE)}${on ? ` ${esc(LEDE_THREAD)}` : ''}`;
  }

  function page(tab, html, opts = {}) {
    BB.render('Action items', strip(tab) + html, 'tasks', { eyebrow: opts.eyebrow || '', lede: lede(), focus: opts.focus || null });
  }

  /** Re-render after a demo action, then bring the focused element into view. */
  async function refreshWith(focus) {
    await BB.refresh({ focus });
    const v = viewEl();
    // BB.render() resolves focus before call detail runs BB.hooks.callAside, so a card
    // in the aside does not exist yet at that point: resolve the target again now.
    let want = null;
    try { want = typeof focus === 'function' ? focus() : typeof focus === 'string' ? document.querySelector(focus) : focus; } catch { want = null; }
    if (want && want.isConnected && v && v.contains(want) && want !== document.activeElement) want.focus({ preventScroll: true });
    const a = document.activeElement;
    if (a && v && v.contains(a) && typeof a.scrollIntoView === 'function') {
      const r = a.getBoundingClientRect();
      if (r.top < 64 || r.bottom > window.innerHeight) a.scrollIntoView({ block: r.height > window.innerHeight * 0.6 ? 'start' : 'nearest' });
    }
  }

  /** After a decision: the next waiting card in the call, else "Send log to Slack" (task log) or the panel (call detail). */
  function nextFocus(callId, afterKey, origin) {
    return () => {
      const pend = pendingOf(BB.effectiveProposals(callId));
      const n = afterKey ? Number(String(afterKey).split(':').pop()) : 0;
      for (const p of [...pend.filter((x) => x.n > n), ...pend.filter((x) => x.n <= n)]) {
        const el = document.getElementById(cardId(p.key));
        if (el) return el;
      }
      if (origin === 'aside') return document.getElementById('proposals');
      return document.getElementById(`send-${callId}`) || document.getElementById(`group-${callId}`);
    };
  }

  // ================================================================ cards and rows
  function actionsHtml(p, id) {
    if (!BB.isDemo) return `<p class="tl-wait">${esc(WAITING_APP)}</p>`;
    const busy = ui.busy.get(p.key);
    const btn = (act, label, primary) => `<button class="btn btn-small${primary ? '' : ' btn-ghost'}" type="button" id="${id}-${act}" data-act="${act}" data-p="${esc(p.key)}"${busy ? ' aria-disabled="true"' : ''}>${esc(busy && busy.act === act ? busy.label : label)}</button>`;
    let buttons;
    if (p.verdict === 'COMMENT') buttons = [btn('approve', 'Add comment', true), btn('edit', 'Edit'), btn('skip', 'Skip')];
    else if (p.verdict === 'FLAG' && p.target) buttons = [btn('approve', 'Comment on existing', true), btn('alt', 'Create new instead'), btn('edit', 'Edit'), btn('skip', 'Skip')];
    else if (p.verdict === 'DUPLICATE') buttons = [btn('skip', 'Skip', true), btn('approve', 'Create anyway')];
    else buttons = [btn('approve', 'Create issue', true), btn('edit', 'Edit'), btn('skip', 'Skip')];
    return `<div class="decision-actions">${buttons.join('')}</div>`;
  }

  /** A waiting proposal: the full §3.4 card (task log) or the compact one (call detail). */
  function cardHtml(p, o = {}) {
    const id = cardId(p.key);
    const busy = ui.busy.has(p.key);
    const ch = new Set(p.changed || []);
    const mark = (on, html) => (on && html ? `<mark>${html}</mark>` : html);
    const owner = mark(ch.has('owner'), p.owner ? BB.person(p.owner) : '<span class="tl-dim">no owner</span>');
    const key = teamKey(p.owner_team);
    const teamTo = p.owner_team ? `${esc(cap(p.owner_team))}${key ? ` → <span class="mono">${esc(key)}</span>` : ''}` : '';
    const team = mark(ch.has('team'), teamTo);
    const prio = mark(ch.has('priority'), p.priority ? esc(cap(p.priority)) : '');
    const at = p.ts ? BB.ts(p.call_id, p.ts) : '';
    const target = p.target ? `${BB.ref(p.target.ref)} · ${esc(p.target.title)}` : '';
    const lines = [];
    let note = '';
    if (p.verdict === 'COMMENT') {
      lines.push(`on ${target}`);
      if (!o.compact) lines.push(joinDot([owner, mark(ch.has('team'), p.owner_team ? esc(cap(p.owner_team)) : ''), prio, at]));
      if (!o.compact && p.evidence) note = `Why a comment: ${esc(p.evidence)}.`;
    } else if (p.verdict === 'FLAG') {
      const like = p.target ? `${p.similarity !== null && p.similarity !== undefined ? `${esc(pct(p.similarity))} like ` : 'Like '}${target}` : '';
      lines.push(joinDot([like, owner, team, prio, at]));
      note = p.target ? esc(seenBefore(p)) : (!o.compact && p.evidence ? `Why flagged: ${esc(p.evidence)}.` : '');
    } else if (p.verdict === 'DUPLICATE') {
      const state = dupState(p);
      lines.push(joinDot([p.target ? `Matches ${BB.ref(p.target.ref)}${o.compact ? '' : ` · ${esc(p.target.title)}`}` : '', state ? BB.inline(state, { call: p.call_id }) : '']));
      note = esc(dupAdvice(p));
    } else {
      lines.push(joinDot([owner, team, prio, at]));
      if (!o.compact && p.evidence) note = `Backlog check: ${esc(String(p.evidence).replace(/\s+in (the )?backlog$/i, ''))}.`;
    }
    const quote = !o.compact && p.quote ? `<blockquote class="evidence"><p>“${esc(p.quote)}”</p></blockquote>` : '';
    return `<article class="decision${o.compact ? ' tl-compact' : ''}${busy ? ' is-busy' : ''}" id="${id}" tabindex="-1" aria-labelledby="${id}-t" data-card="${esc(p.key)}"${busy ? ' aria-disabled="true"' : ''}>
      ${BB.verdict(p.verdict)}
      <h3 class="decision-title" id="${id}-t">${mark(ch.has('title'), esc(p.title))}${p.edited ? ' <span class="chip tl-edited">Edited</span>' : ''}</h3>
      ${lines.filter(Boolean).map((l) => `<p class="decision-meta">${l}</p>`).join('')}
      ${quote}
      ${note ? `<p class="decision-meta tl-note${p.verdict === 'FLAG' ? ' tl-seen' : ''}">${note}</p>` : ''}
      ${actionsHtml(p, id)}
    </article>`;
  }

  function resultHtml(p) {
    const d = p.decision || {};
    if (p.status === 'skipped') return `Skipped${d.reason ? ` · “${esc(d.reason)}”` : ''}`;
    if (d.result === 'created') return `Created${d.ref ? ` ${BB.ref(d.ref)}` : ''}`;
    if (d.result === 'commented') return `Commented${d.ref ? ` on ${BB.ref(d.ref)}` : ''}`;
    if (d.result === 'file-only') return 'Kept in the tasks file';
    return 'Approved';
  }

  function whyHtml(p, id) {
    if (!BB.isDemo || p.by !== 'you' || p.status !== 'skipped') return '';
    if (ui.whySaved.has(p.key)) return `<p class="tl-why tl-why-saved" id="${id}-why" tabindex="-1">Saved as training data.</p>`;
    if (!ui.whyOpen.has(p.key) || (p.decision && p.decision.reason)) return '';
    return `<div class="tl-why" id="${id}-why" tabindex="-1" role="group" aria-labelledby="${id}-whyk">
      <span class="tl-why-k" id="${id}-whyk">Why? <span class="tl-dim">Optional</span></span>
      <span class="tl-why-chips">${REASONS.map((r) => `<button class="tl-chip" type="button" data-act="why" data-p="${esc(p.key)}" data-reason="${esc(r.toLowerCase())}">${esc(r)}</button>`).join('')}</span>
    </div>`;
  }

  /** A decided proposal: one ruled line (§3.4), or the compact row in call detail. */
  function outcomeHtml(p, o = {}) {
    const id = cardId(p.key);
    const d = p.decision || {};
    const cls = p.status === 'skipped' ? 'is-skipped' : d.result === 'created' || d.result === 'commented' ? 'is-done' : 'is-kept';
    const who = p.owner ? esc(p.owner) : 'no owner';
    const ref = p.target ? BB.ref(p.target.ref) : '';
    let what;
    if (p.verdict === 'COMMENT') what = `on ${ref} <span class="tl-dim">· ${esc(contextOf(p))}</span>`;
    else if (p.verdict === 'FLAG') what = `${esc(p.title)} <span class="tl-dim">· ${joinDot([p.target ? `${p.similarity !== null && p.similarity !== undefined ? `${esc(pct(p.similarity))} like ` : 'like '}${ref}` : '', who])}</span>`;
    else if (p.verdict === 'DUPLICATE') what = `${esc(p.title)}${p.target ? ` <span class="tl-dim">· matches ${ref}</span>` : ''}`;
    else what = `${esc(p.title)} <span class="tl-dim">· ${who}</span>${p.ts && !o.compact ? ` ${BB.ts(p.call_id, p.ts)}` : ''}`;
    const by = p.by === 'you' ? `<span class="tl-by">You · ${esc(BB.stamp(p.at))}</span>` : '';
    return `<div class="outcome ${cls}${o.compact ? ' tl-compact' : ''}" id="${id}" tabindex="-1" data-card="${esc(p.key)}">
      ${BB.verdict(p.verdict)}
      <p class="tl-what">${what}${p.edited ? ' <span class="chip tl-edited">Edited</span>' : ''}</p>
      <p class="outcome-result">${resultHtml(p)}${by}</p>
      ${whyHtml(p, id)}
    </div>`;
  }

  function restNote(rest) {
    const f = rest.filter((p) => p.verdict === 'FLAG').length;
    const d = rest.filter((p) => p.verdict === 'DUPLICATE').length;
    const kinds = [f && 'flagged', d && 'duplicate', rest.length - f - d > 0 && 'other'].filter(Boolean);
    const one = rest.length === 1;
    return `The ${kinds.join(' and ')} ${one ? 'proposal stays' : 'proposals stay'} here to decide ${one ? 'on its own' : 'one by one'}.`;
  }

  /** "1 flagged and 1 duplicate: decide them one by one" */
  function othersPhrase(rest) {
    const f = rest.filter((p) => p.verdict === 'FLAG').length;
    const d = rest.filter((p) => p.verdict === 'DUPLICATE').length;
    const parts = [f && `${f} flagged`, d && plural(d, 'duplicate'), rest.length - f - d > 0 && `${rest.length - f - d} to review`].filter(Boolean);
    return `${joinAnd(parts)}: ${rest.length === 1 ? 'decide it on its own' : 'decide them one by one'}`;
  }

  /** Approve all safe (N) and Skip all remaining, or the planning-call banner where Approve all is off. */
  function bulkHtml(e, o = {}) {
    if (!BB.isDemo) return '';
    const pend = pendingOf(e);
    if (!pend.length) return '';
    const allowed = e.bulk && e.bulk.approve_safe ? e.bulk.approve_safe.allowed !== false : true;
    const safe = pend.filter((p) => p.safe).length;
    const rest = pend.filter((p) => !p.safe);
    const id = e.call_id;
    const btns = [];
    if (allowed && safe && pend.length > 1) btns.push(`<button class="btn btn-small" type="button" id="bulk-approve-${esc(id)}" data-act="bulk-approve" data-call="${esc(id)}">Approve all safe (${safe})</button>`);
    if (pend.length > 1) btns.push(`<button class="btn btn-small btn-ghost" type="button" id="bulk-skip-${esc(id)}" data-act="bulk-skip" data-call="${esc(id)}">Skip all remaining</button>`);
    let note = '';
    if (!allowed) note = `<p class="tl-planning">${esc(PLANNING)}</p>`;
    else if (rest.length && pend.length > 1) note = `<p class="tl-bulk-note">${esc(othersPhrase(rest))}</p>`;
    if (!btns.length && !note) return '';
    return `<div class="tl-bulk${o.compact ? ' tl-compact' : ''}">${btns.length ? `<div class="tl-bulk-btns">${btns.join('')}</div>` : ''}${note}</div>`;
  }

  // ================================================================ task log (§3.4)
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
    return (ignore === 'status' || f.status === 'all' || statusOf(p) === f.status)
      && (!f.verdict || p.verdict === f.verdict)
      && (!f.owner || (f.owner === 'none' ? !p.owner : p.owner === f.owner));
  }
  function statusCounts(all, f) {
    const n = { all: 0, waiting: 0, approved: 0, skipped: 0 };
    for (const e of all) {
      for (const p of e.proposals) {
        if (!matches(p, f, 'status')) continue;
        n.all++;
        n[statusOf(p)] = (n[statusOf(p)] || 0) + 1;
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

  function decidedPhrase(e) {
    const ps = e.proposals;
    const c = (r) => ps.filter((p) => p.status !== 'skipped' && p.decision && p.decision.result === r).length;
    const parts = [
      c('created') && `${c('created')} created`,
      c('commented') && `${c('commented')} commented`,
      c('file-only') && `${c('file-only')} kept in the tasks file`,
      ps.filter((p) => p.status === 'skipped').length && `${ps.filter((p) => p.status === 'skipped').length} skipped`,
    ].filter(Boolean);
    const lead = ps.length === 1 ? 'Decided' : `All ${ps.length} decided`;
    return `${lead}${parts.length ? `: ${parts.join(' · ')}` : ''}`;
  }

  function groupHtml(e, shown) {
    const id = e.call_id;
    const row = callRow(id);
    const pend = pendingOf(e);
    const planning = e.bulk && e.bulk.approve_safe && e.bulk.approve_safe.allowed === false;
    const meta = [BB.teamChip(e.team), row && row.call_type ? `<span>${esc(row.call_type)}</span>` : ''];
    if (pend.length) {
      meta.push(`<span class="chip-mark">${pend.length} waiting</span>`);
      const dec = e.proposals.length - pend.length;
      if (dec) meta.push(`<span class="tl-dim">${dec} decided</span>`);
    }
    const status = pend.length ? '' : `<p class="tl-status">${esc(decidedPhrase(e))}</p>${planning ? '<p class="tl-dim tl-small">Planning call · Approve all was off.</p>' : ''}`;
    const sent = e.log_sent ? `<p class="tl-sent">Log posted to <span class="mono">${esc(e.log_sent.channel || threadChannel(id))}</span> · ${esc(BB.stamp(e.log_sent.at, ' '))}</p>` : '';
    // The pipeline posted and updated each call's log; once a group is decided here, the posted log is behind.
    const primary = BB.isDemo && !pend.length && e.decided_here > 0 && !e.log_sent;
    const send = BB.isDemo ? `<button class="btn btn-small${primary ? '' : ' btn-ghost'}" type="button" id="send-${esc(id)}" data-act="send-log" data-call="${esc(id)}">${e.log_sent ? 'Send again' : 'Send log to Slack'}</button>` : '';
    const items = shown.map((p) => `<li>${p.status === 'pending' ? cardHtml(p) : outcomeHtml(p)}</li>`).join('');
    return `<section class="tl-group" id="group-${esc(id)}" tabindex="-1" aria-labelledby="gh-${esc(id)}">
      <header class="tl-head">
        <p class="tl-when"><span>${esc(fmtDay(e.date))}</span>${e.time ? `<span>${esc(e.time)}</span>` : ''}</p>
        <div class="tl-what-call">
          <h2 class="tl-topic" id="gh-${esc(id)}"><a href="${esc(href('call', id))}">${esc(e.topic)}</a></h2>
          <p class="tl-meta">${meta.filter(Boolean).join(' ')}</p>
          ${status}${sent}
        </div>
        ${send ? `<div class="tl-send-at">${send}</div>` : ''}
      </header>
      <div class="tl-body">
        ${bulkHtml(e)}
        <ol class="tl-items" aria-label="Proposals from ${esc(e.topic)}">${items}</ol>
      </div>
    </section>`;
  }

  function groupsHtml(all, f) {
    const out = [];
    for (const e of all) {
      const shown = e.proposals.filter((p) => matches(p, f)).sort((a, b) => a.n - b.n);
      if (shown.length) out.push(groupHtml(e, shown));
    }
    return out.join('') || BB.emptyState('<p>Nothing matches these filters.</p><p><button class="btn btn-small btn-ghost" type="button" data-act="clear-filters">Clear filters</button></p>');
  }

  function shownCount(all, f) {
    return all.reduce((n, e) => n + e.proposals.filter((p) => matches(p, f)).length, 0);
  }

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
    page('log', `${filtersHtml(all, f)}
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
    const box = $('[data-tl-groups]', viewEl());
    if (box) box.innerHTML = groupsHtml(all, f);
    const st = $('[data-tl-status]', viewEl());
    const count = shownCount(all, f);
    if (st) st.textContent = count ? `${plural(count, 'proposal')} shown.` : 'Nothing matches these filters.';
    if (focusAfter) focusAfter();
  }

  // ================================================================ interactions
  async function approve(key, alt, origin) {
    if (ui.busy.has(key)) return;
    const p = proposalOf(key);
    if (!p || p.status !== 'pending') return;
    const plan = approvalPlan(p, alt);
    const epoch = ui.epoch;
    ui.busy.set(key, { act: alt ? 'alt' : 'approve', label: plan.busy });
    paintBusy(key);
    await wait(700);
    if (epoch !== ui.epoch) return;
    const card = document.getElementById(cardId(key));
    if (card && !reducedMotion()) { card.classList.add('is-collapsing'); await wait(150); }
    ui.busy.delete(key);
    if (epoch !== ui.epoch) return;
    const now = proposalOf(key);
    if (!now || now.status !== 'pending') return;
    BB.decide(key, { action: plan.action, result: plan.result, ref: plan.ref, reason: null, edited: Boolean(now.edited), edit_summary: editSummary(now) });
    await refreshWith(nextFocus(callIdOf(key), key, origin));
    BB.toast(plan.toast, NOTE.linear);
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
    BB.decide(key, { action: 'skip', result: 'skipped', reason: null, edited: Boolean(p.edited), edit_summary: editSummary(p) });
    ui.whyOpen.add(key);
    const next = nextFocus(callIdOf(key), key, origin);
    await refreshWith(() => document.getElementById(`${cardId(key)}-why`) || next());
    BB.toast('Skipped. Logged as training data.', NOTE.linear);
  }

  async function pickReason(key, reason) {
    const d = BB.state.decisions[key];
    if (!d || !reason) return;
    d.reason = reason;
    BB.save();
    ui.whyOpen.delete(key);
    ui.whySaved.add(key);
    await refreshWith(`#${cardId(key)}-why`);
  }

  async function bulkApprove(callId, trigger, origin) {
    const e = BB.effectiveProposals(callId);
    if (!e || (e.bulk && e.bulk.approve_safe && e.bulk.approve_safe.allowed === false)) return;
    const safe = pendingOf(e).filter((p) => p.safe && !ui.busy.has(p.key));
    if (!safe.length) return;
    const rest = pendingOf(e).filter((p) => !p.safe);
    const items = safe.map((p) => {
      if (p.verdict === 'COMMENT') return `Comment on ${(p.target && p.target.ref) || 'the existing issue'}`;
      const k = teamKey(p.owner_team);
      return `Create “${p.title}”${k ? ` in ${k}` : ''}, ${p.owner ? `assigned to ${p.owner}` : 'unassigned'}`;
    });
    const h = BB.dialog({
      title: `Approve ${plural(safe.length, 'proposal')}?`,
      html: `<ul class="plain-list tl-dialog-list">${items.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>${rest.length ? `<p class="tl-dialog-note">${esc(restNote(rest))}</p>` : ''}`,
      actions: [
        { label: `Approve ${safe.length}`, busy: 'Approving…', onClick: () => wait(700) },
        { label: 'Cancel', cancel: true },
      ],
      trigger,
    });
    if (!(await h.result)) return;
    const done = [];
    for (const s of safe) {
      const p = proposalOf(s.key);
      if (!p || p.status !== 'pending') continue;
      const plan = approvalPlan(p, false);
      BB.decide(p.key, { action: plan.action, result: plan.result, ref: plan.ref, reason: null, edited: Boolean(p.edited), edit_summary: editSummary(p) });
      done.push(plan.result === 'created' ? `created ${plan.ref}` : `commented on ${plan.ref}`);
    }
    const left = pendingOf(BB.effectiveProposals(callId)).length;
    await refreshWith(nextFocus(callId, null, origin));
    BB.toast(`Approved ${done.length}: ${done.join(', ')}.${left ? ` ${left} still ${left === 1 ? 'waits' : 'wait'}.` : ''}`, NOTE.linear);
  }

  async function bulkSkip(callId, trigger, origin) {
    const pend = pendingOf(BB.effectiveProposals(callId)).filter((p) => !ui.busy.has(p.key));
    if (!pend.length) return;
    const n = pend.length;
    let reason = null;
    const h = BB.dialog({
      title: n === 1 ? 'Skip the remaining proposal?' : `Skip the ${n} remaining proposals?`,
      html: `<p>Nothing is filed. The skips are logged as training data.</p>
        <div class="form"><div class="field"><label for="tl-skip-why">Why? (optional)</label>
        <select id="tl-skip-why" name="why"><option value="">No reason given</option>${REASONS.map((r) => `<option value="${esc(r.toLowerCase())}">${esc(r)}</option>`).join('')}</select></div></div>`,
      actions: [
        { label: `Skip ${n}`, onClick: (hd) => { const s = $('[name="why"]', hd.body); reason = s && s.value ? s.value : null; } },
        { label: 'Cancel', cancel: true },
      ],
      trigger,
    });
    if (!(await h.result)) return;
    for (const s of pend) {
      const p = proposalOf(s.key);
      if (!p || p.status !== 'pending') continue;
      BB.decide(p.key, { action: 'skip', result: 'skipped', reason, edited: Boolean(p.edited), edit_summary: editSummary(p) });
    }
    await refreshWith(nextFocus(callId, null, origin));
    BB.toast(`Skipped ${n}. Logged as training data.`, NOTE.linear);
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

  function defaultComment(p, e) {
    const context = p.verdict === 'FLAG' ? p.title : (p.evidence || p.title);
    const when = [fmtDay(e.date), p.ts].filter(Boolean).join(', ');
    return `From ${e.topic} (${when}): ${context}.${p.quote ? ` “${p.quote}”` : ''}\n\n🤖 via Backbrief — automated comment from the call`;
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

  async function openEdit(key, trigger) {
    let p = proposalOf(key);
    if (!p || p.status !== 'pending' || ui.busy.has(key)) return;
    // The Linear teams come from settings, which a call page does not load by itself.
    if (!settings()) {
      await BB.load('settings').catch(() => null);
      p = proposalOf(key);
      if (!p || p.status !== 'pending') return;
    }
    const e = BB.effectiveProposals(p.call_id);
    const fields = p.verdict !== 'COMMENT';
    const withComment = p.verdict === 'COMMENT' || (p.verdict === 'FLAG' && Boolean(p.target));
    const base = p.original || { title: p.title, owner: p.owner, priority: p.priority, owner_team: p.owner_team };
    const baseTeam = base.owner_team || guessTeam({ ...p, owner: base.owner });
    const shownTeam = p.owner_team || baseTeam;
    const people = BB.effectivePeople().people;
    const m = teamMap();
    const defComment = withComment ? defaultComment(p, e) : '';
    const curComment = typeof p.comment === 'string' ? p.comment : defComment;
    const id = cardId(key);
    const ownerOpts = [...people.map((x) => [x.lastname, x.name || x.lastname])];
    if (p.owner && !people.some((x) => x.lastname === p.owner)) ownerOpts.push([p.owner, p.owner]);
    const html = `<div class="form tl-edit">
      ${p.target && p.verdict === 'COMMENT' ? `<p class="tl-edit-on">Comment on ${BB.ref(p.target.ref)} · ${esc(p.target.title)}</p>` : ''}
      ${fields ? `<div class="field">
        <label for="tl-e-title">Title</label>
        <input type="text" id="tl-e-title" name="title" maxlength="250" required value="${esc(p.title)}" autocomplete="off">
        <p class="error" role="alert" id="tl-e-title-err" hidden></p>
      </div>
      <div class="tl-edit-grid">
        <div class="field"><label for="tl-e-owner">Owner</label><select id="tl-e-owner" name="owner"><option value="">No owner</option>${ownerOpts.map(([v, label]) => `<option value="${esc(v)}"${v === p.owner ? ' selected' : ''}>${esc(label)}</option>`).join('')}</select></div>
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
    const h = BB.dialog({
      title: 'Edit before filing',
      wide: fields,
      html,
      trigger,
      returnFocus: `#${id}-edit`,
      actions: [
        {
          label: 'Save changes',
          onClick: (hd) => {
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
            values = { title: fields ? get('title').trim() : null, owner: get('owner'), priority: get('priority'), team: get('team'), comment: get('comment') };
            return true;
          },
        },
        { label: 'Cancel', cancel: true },
      ],
    });
    h.result.then(async (ok) => {
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
      if (!changed) {
        if (had) { delete BB.state.edits[key]; BB.save(); await refreshWith(`#${id}-edit`); }
        return;
      }
      BB.state.edits[key] = ed;
      BB.save();
      await refreshWith(`#${id}-edit`);
      BB.toast('Proposal updated. Approve it to file it.', NOTE.linear);
    });
  }

  // ---------------------------------------------------------------- Send log to Slack
  function nowClock() {
    const d = new Date();
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  /** After posting: the group's button in the task log, else Overview's "Waiting for you" heading. */
  function afterSendFocus(callId) {
    const btn = document.getElementById(`send-${callId}`);
    if (btn) return btn;
    const h = document.getElementById('h-waiting');
    // BB.refresh() focuses the element as is; a heading needs tabindex to take focus.
    if (h && !h.hasAttribute('tabindex')) h.setAttribute('tabindex', '-1');
    return h;
  }

  function openSendLog(callId, trigger) {
    if (!BB.isDemo) return;
    const e = BB.effectiveProposals(callId);
    if (!e) return;
    const thread = threadChannel(callId);
    const slack = BB.effectiveSlack();
    const channels = [...new Set([thread, slack.channel, ...(slack.channels_available || [])].filter(Boolean))];
    const opts = { to: 'thread', channel: thread, ask: true };
    const target = () => (opts.to === 'thread' ? thread : opts.channel);
    const html = `<div class="form tl-send">
      <fieldset class="tl-send-to"><legend>Post to</legend>
        <label class="check"><input type="radio" name="to" value="thread" checked> <span>Reply in the call's thread in <span class="mono">${esc(thread)}</span></span></label>
        <div class="tl-send-new">
          <label class="check"><input type="radio" name="to" value="new"> <span>New message in</span></label>
          <select name="channel" aria-label="Channel for the new message">${channels.map((c) => `<option value="${esc(c)}"${c === thread ? ' selected' : ''}>${esc(c)}</option>`).join('')}</select>
        </div>
      </fieldset>
      <label class="check"><input type="checkbox" name="ask" checked> <span>Ask for corrections: replies are saved as training data</span></label>
      <div class="tl-send-preview" data-log-preview></div>
      <p class="tl-send-link"><a href="${esc(href('tasks', 'slack', callId))}" data-close-dialog>Change what's posted after every call</a></p>
    </div>`;
    const h = BB.dialog({
      title: 'Send the task log to Slack',
      wide: true,
      html,
      trigger,
      returnFocus: () => afterSendFocus(callId),
      onOpen: (hd) => {
        const paint = () => {
          const box = $('[data-log-preview]', hd.body);
          if (box) box.innerHTML = logPreviewHtml(BB.effectiveProposals(callId), target(), opts.to === 'thread', opts.ask);
          const b = hd.button(0);
          if (b && !hd.isBusy) b.textContent = `Send to ${target()}`;
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
          if (t.name === 'ask') opts.ask = t.checked;
          paint();
        });
        const link = $('[data-close-dialog]', hd.body);
        if (link) link.addEventListener('click', () => hd.close(null));
        paint();
      },
      actions: [
        {
          label: `Send to ${thread}`,
          onClick: async (hd) => { hd.busy(`Posting to ${target()}…`); await wait(700); },
        },
        { label: 'Cancel', cancel: true },
      ],
    });
    h.result.then(async (ok) => {
      if (!ok) return;
      const ch = target();
      BB.state.log_sent[callId] = { channel: ch, thread: opts.to === 'thread', ask_corrections: opts.ask, at: BB.now() };
      BB.save();
      await refreshWith(() => afterSendFocus(callId));
      BB.toast(opts.to === 'thread' ? `Log posted to the thread in ${ch}.` : `Log posted to ${ch}.`, NOTE.slack);
    });
  }

  // ================================================================ open items (§3.5)
  function openItemsView(parts, query) {
    firstRender();
    const items = BB.effectiveActionItems();
    const owners = [...new Set(items.map((a) => a.owner).filter(Boolean))].sort();
    const fromCalls = new Set(items.map((a) => a.call_id)).size;
    const st = ITEM_STATUS[query.status] ? query.status : 'open';
    const owner = query.owner || '';
    if (owner && owner !== 'none' && !owners.includes(owner)) owners.push(owner);
    page('open', `
      <p class="tab-lede">Next steps from every call and who owes them. Approved proposals link to their tracker issues.</p>
      <form class="filters" aria-label="Filter action items" data-items-filters>
        <label>Status <select name="status">${Object.entries(ITEM_STATUS).map(([k, [, label]]) => `<option value="${k}"${k === st ? ' selected' : ''}>${label}</option>`).join('')}</select></label>
        <label>Owner <select name="owner"><option value="">Everyone</option>${owners.map((o) => `<option value="${esc(o)}"${o === owner ? ' selected' : ''}>${esc(o)}</option>`).join('')}<option value="none"${owner === 'none' ? ' selected' : ''}>No owner</option></select></label>
      </form>
      <p class="sr-only" role="status" data-items-status></p>
      <div data-items-box></div>`, {
      eyebrow: esc(`${plural(items.length, 'action item')} from ${plural(fromCalls, 'call')}`),
    });
    const form = $('[data-items-filters]', viewEl());
    const box = $('[data-items-box]', viewEl());
    const status = $('[data-items-status]', viewEl());
    const apply = (announce) => {
      const f = { status: form.elements.namedItem('status').value, owner: form.elements.namedItem('owner').value };
      const h = href('tasks', 'open', { status: f.status === 'open' ? '' : f.status, owner: f.owner });
      if (location.hash !== h) {
        history.replaceState(null, '', h);
        BB.current.hash = h;
        BB.current.query = f;
        ui.routed = h;
      }
      const want = ITEM_STATUS[f.status][0];
      const list = items.filter((a) => (!want || a.status === want) && (!f.owner || (f.owner === 'none' ? !a.owner : a.owner === f.owner)));
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
            <td data-label="Status"><span class="tl-state tl-state-${esc(a.status)}">${esc(ITEM_LABEL[a.status] || a.status)}</span></td>
            <td data-label="Tracker">${a.tracker_ref ? `${BB.ref(a.tracker_ref)}${a.ref_added ? ' <span class="chip tl-you">New · you</span>' : ''}` : '<span class="muted">—</span>'}</td>
            <td data-label="From call"><a href="${esc(href('call', a.call_id))}">${esc(a.call_topic)}</a><span class="sub"><span class="mono">${esc(fmtDay(a.call_date))}</span> ${BB.ts(a.call_id, a.ts)}</span></td>
          </tr>`).join('')}</tbody></table></div>`;
      }
      if (announce) status.textContent = list.length ? `${plural(list.length, 'action item')} shown.` : 'Nothing matches these filters.';
    };
    form.addEventListener('input', () => apply(true));
    form.addEventListener('submit', (ev) => ev.preventDefault());
    apply(false);
  }

  // ================================================================ review history (§3.5)
  function historySummary(decided) {
    const tr = ws().overview && ws().overview.training;
    const mine = decided.filter((p) => p.by === 'you');
    const base = tr
      ? { rows: tr.rows, accepted: tr.accepted, edited: tr.edited, skipped: tr.skipped }
      : { rows: decided.length - mine.length, accepted: decided.filter((p) => p.by !== 'you' && p.status === 'approved').length, edited: 0, skipped: decided.filter((p) => p.by !== 'you' && p.status === 'skipped').length };
    const total = base.rows + mine.length;
    const approved = base.accepted + mine.filter((p) => p.status === 'approved' && !p.edited).length;
    const edited = base.edited + mine.filter((p) => p.status === 'approved' && p.edited).length;
    const skipped = base.skipped + mine.filter((p) => p.status === 'skipped').length;
    const by = VERDICTS.map((v) => {
      const all = decided.filter((p) => p.verdict === v);
      if (!all.length) return null;
      const ok = all.filter((p) => p.status === 'approved').length;
      return { v, ok, n: all.length };
    }).filter(Boolean);
    const byLine = by.map((x, i) => `${VNAME[x.v]} ${x.ok} of ${x.n}${i === 0 ? ' approved' : ''}`).join(' · ');
    return { total, approved, edited, skipped, by, byLine };
  }

  /** "Skipped twice: proposals like GRW-102 Billing FAQ refresh (5 Oct, 7 Oct). Another one waits on 19 Oct." */
  function patternLines() {
    const out = [];
    for (const rf of (ws().overview && ws().overview.repeat_flags) || []) {
      const seen = [];
      for (const id of rf.calls || []) {
        const e = BB.effectiveProposals(id);
        const q = e && e.proposals.find((x) => x.verdict === 'FLAG' && x.target && x.target.ref === rf.ref);
        if (q) seen.push({ date: e.date, p: q });
      }
      seen.sort((a, b) => String(a.date).localeCompare(String(b.date)));
      const skipped = seen.filter((x) => x.p.status === 'skipped');
      if (skipped.length < 2) continue;
      const times = skipped.length === 2 ? 'twice' : `${skipped.length} times`;
      let html = `Skipped ${times}: proposals like ${BB.ref(rf.ref)} ${esc(rf.title)} (${esc(skipped.map((x) => fmtDay(x.date)).join(', '))}).`;
      const waiting = seen.filter((x) => x.p.status === 'pending');
      if (waiting.length === 1) html += ` Another one waits on ${esc(fmtDay(waiting[0].date))}.`;
      else if (waiting.length > 1) html += ` ${waiting.length} more wait, on ${esc(joinAnd(waiting.map((x) => fmtDay(x.date))))}.`;
      for (const x of seen.filter((y) => y.p.status === 'approved' && y.p.by === 'you')) {
        const d = x.p.decision;
        html += d.result === 'created'
          ? ` On ${esc(fmtDay(x.date))} it was filed as ${BB.ref(d.ref)} instead.`
          : ` On ${esc(fmtDay(x.date))} it became a comment on ${BB.ref(d.ref || rf.ref)}.`;
      }
      out.push(html);
    }
    return out;
  }

  function proposedText(p) {
    if (p.verdict === 'COMMENT') return `Comment on ${(p.target && p.target.ref) || 'an issue'}`;
    if (p.verdict === 'FLAG') return p.target ? `Review · ${p.similarity !== null && p.similarity !== undefined ? `${pct(p.similarity)} like ` : 'like '}${p.target.ref}` : 'Review';
    if (p.verdict === 'DUPLICATE') return p.target ? `Skip · matches ${p.target.ref}` : 'Skip';
    const k = teamKey(p.owner_team);
    return joinDot([`Create${k ? ` in ${k}` : ''}`, p.owner || 'no owner']);
  }

  /** The Decision column; the issue key sits in the Tracker column next to it. */
  function decisionText(p) {
    const d = p.decision || {};
    if (p.status === 'skipped') return d.reason ? `Skipped: ${d.reason}` : 'Skipped';
    if (d.result === 'created') return 'Created';
    if (d.result === 'commented') return 'Commented';
    if (d.result === 'file-only') return 'Kept in the tasks file';
    return 'Approved';
  }

  function historyView() {
    firstRender();
    const all = entries();
    const decided = all.flatMap((e) => e.proposals.filter((p) => p.status !== 'pending').map((p) => ({ ...p, call_date: e.date, call_topic: e.topic })));
    const repo = repoName();
    const intro = `<p class="tab-lede">Every approve, edit and skip, from Slack and from this workspace. Saved in ${repo ? `<span class="mono">${esc(repo)}</span>` : 'your repository'} under <span class="mono">.backbrief/training/</span> as your team's private training data for future proposals.</p>`;
    if (!decided.length) {
      page('history', `${intro}${BB.emptyState("<p>No decisions yet. Approve or skip a proposal and it's recorded here.</p>")}`, { eyebrow: repo ? esc(`${repo} · .backbrief/training/`) : '' });
      return;
    }
    const s = historySummary(decided);
    const patterns = patternLines();
    const order = [...decided].sort((a, b) => {
      if (a.by === 'you' || b.by === 'you') {
        if (a.by !== 'you') return 1;
        if (b.by !== 'you') return -1;
        return String(b.at || '').localeCompare(String(a.at || ''));
      }
      return String(b.call_date).localeCompare(String(a.call_date)) || a.n - b.n;
    });
    const rows = order.map((p) => {
      const d = p.decision || {};
      const cls = p.status === 'skipped' ? 'is-skipped' : d.result === 'created' || d.result === 'commented' ? 'is-done' : 'is-kept';
      const reasonSub = d.result === 'file-only' && d.reason ? `<span class="sub">${esc(d.reason)}</span>` : '';
      const editSub = p.edited && p.edit_summary ? `<span class="sub">Edited · ${esc(p.edit_summary)}</span>` : p.edited ? '<span class="sub">Edited</span>' : '';
      return `<tr${p.by === 'you' ? ' class="tl-row-you"' : ''}>
        <td data-label="Date"><span class="mono">${esc(p.by === 'you' ? BB.stamp(p.at) : fmtDay(p.call_date))}</span>${p.by === 'you' ? ' <span class="chip tl-you">New · you</span>' : ''}</td>
        <td data-label="Call"><a href="${esc(href('call', p.call_id))}">${esc(p.call_topic)}</a></td>
        <td data-label="Proposal"><span class="tl-prop">${BB.verdict(p.verdict)} <span>${esc(p.title)}</span></span></td>
        <td data-label="Proposed">${esc(proposedText(p))}</td>
        <td data-label="Decision"><span class="tl-dec ${cls}">${esc(decisionText(p))}</span>${reasonSub}${editSub}</td>
        <td data-label="Tracker">${d.ref ? BB.ref(d.ref) : '<span class="muted">—</span>'}</td>
      </tr>`;
    }).join('');
    page('history', `${intro}
      <section class="panel tl-sum" aria-labelledby="h-hist-sum">
        <h2 id="h-hist-sum" class="sr-only">Summary</h2>
        <p class="tl-sum-total"><strong>${esc(plural(s.total, 'decision'))}:</strong> ${esc(`${s.approved} approved, ${s.edited} edited, ${s.skipped} skipped.`)}</p>
        <p class="tl-sum-by">${esc(s.byLine)}.</p>
        <ul class="tl-sum-bars" aria-hidden="true">${s.by.map((x) => `<li><span class="tl-sum-k">${esc(VNAME[x.v])}</span><span class="units tl-units">${'<i></i>'.repeat(Math.min(x.ok, 40))}${'<i class="is-off"></i>'.repeat(Math.min(x.n - x.ok, 40))}</span><span class="tl-sum-n">${x.ok}/${x.n}</span></li>`).join('')}</ul>
        ${patterns.map((l) => `<p class="tl-pattern"><span class="k">Pattern</span>${l}</p>`).join('')}
      </section>
      <div class="table-wrap"><table class="items tl-hist">
        <caption class="sr-only">Decisions, newest first</caption>
        <thead><tr><th scope="col">Date</th><th scope="col">Call</th><th scope="col">Proposal</th><th scope="col">Proposed</th><th scope="col">Decision</th><th scope="col">Tracker</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>`, { eyebrow: repo ? esc(`${repo} · .backbrief/training/`) : '' });
  }

  // ================================================================ Slack post templates (§4)
  // Strings from pipeline/lang/en.pack.json (ui_strings), with emoji written
  // out and <url|text> links shown as their text; the strings spec §6 adds
  // (root title, agreements, open questions, next steps, transcript link,
  // waiting line, skipped with reason, file only, training footer) included.
  const S = {
    'main.summary_header': '💬 *Summary*',
    'main.participants_line': '> *Participants:* {names}',
    'main.decisions_header': '✅ *Decisions ({count})*',
    'main.agreements_header': '🤝 *Agreements ({count})*',
    'main.open_questions_header': '❓ *Open questions ({count})*',
    'main.insights_header': '💡 *Key insights ({count})*',
    'main.next_steps_header': '📋 *Next steps ({count})*',
    'main.monitoring_header': '👀 *Monitoring ({count})* — _ongoing observation_',
    'main.recording_line': 'Recording: {url}',
    'main.vault_link': '📁 Vault: {filename}',
    'main.transcript_link': '📄 Transcript: {link}',
    'main.digest_footer': '_via Backbrief_',
    'tasks.waiting_in_workspace': '🛠 {count} task proposals wait for a decision: {link}',
    'tasks.waiting_in_workspace_one': '🛠 1 task proposal waits for a decision: {link}',
    'tasks.header': '🛠 Backbrief · tasks — {count} proposals',
    'tasks.header_one': '🛠 Backbrief · tasks — 1 proposal',
    'tasks.meta_mode': 'Mode: `{mode}`',
    'tasks.planning_banner': '⚠️ _Planning mode_ — on these calls the team usually walks through issues that ALREADY exist in the tracker. Review every **CREATE** button manually — chances are the task already exists and needs a COMMENT, not a CREATE. Bulk-approve is disabled.',
    'tasks.footer': '_Approve files it in the tracker. Skip only logs it._',
    'tasks.training_footer': '_Reply in this thread if a verdict, owner or priority is wrong; replies are collected as training data._',
    'tasks.unassigned': '⚠️ _<UNASSIGNED — team lead pick>_',
    'tasks.quote_line': '_quote: «{quote}»{ts}_',
    'tasks.new_context_line': 'New context: «{title}»',
    'tasks.btn_create_issue': '✅ Create issue',
    'tasks.btn_add_comment': '💬 Add comment',
    'tasks.btn_comment_existing': '💬 Comment on existing',
    'tasks.btn_create_instead': '➕ Create new instead',
    'tasks.btn_skip': '⏸️ Skip',
    'tasks.btn_create_anyway': '➕ Create anyway',
    'tasks.btn_bulk_approve': '✅ Approve all safe ({count})',
    'tasks.btn_bulk_skip': '⏸️ Skip all remaining',
    'tasks.created_confirm': '✅ Created {identifier}: «{title}»{assignee_suffix}',
    'tasks.assigned_to_suffix': ' · assigned to {mention}',
    'tasks.unassigned_suffix': ' · ⚠️ unassigned — team lead, please assign',
    'tasks.comment_added': '💬 Comment added to {identifier}',
    'tasks.skipped': '⏸️ Skipped: «{title}»',
    'tasks.skipped_reason': '⏸️ Skipped: «{title}» — {reason}',
    'tasks.file_only': '📄 Kept in the tasks file only: «{title}»',
  };
  const MARKER = { CREATE: '✏️ CREATE', COMMENT: '💬 COMMENT', FLAG: '⚠️ FLAG', DUPLICATE: '🔁 DUPLICATE' };
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
  const link = (text) => `<span class="slk-link">${esc(text)}</span>`;
  const mention = (name) => `<span class="mention">@${esc(name)}</span>`;
  function tsMode(d) { return d && d.recording_link ? 'rec' : d && d.transcript_link ? 'tr' : 'plain'; }
  function TS(mode, mmss) {
    if (!mmss) return '';
    return mode === 'plain' ? `(${esc(mmss)})` : `<span class="ts">▶ ${esc(mmss)}</span>`;
  }
  /** Digest text (markdown) as Slack shows it: **bold** → bold, `code`, (mm:ss) → the timestamp form. */
  function digestText(s, mode) {
    let h = esc(String(s || ''));
    h = h.replace(/`([^`]+)`/g, '<code>$1</code>');
    h = h.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    return h.replace(/\((\d{1,3}:\d{2})\)/g, (m, t) => TS(mode, t));
  }
  function addMinutes(hhmm, minutes) {
    const m = String(hhmm || '').match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return '';
    const t = ((Number(m[1]) * 60 + Number(m[2]) + minutes) % 1440 + 1440) % 1440;
    return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
  }
  const L = (html, cls) => ({ html, cls });

  /** One T5 row (09b's blocksForTask, with the tasks-file markers): lines, then buttons while it waits. */
  function t5Row(p, mode) {
    const lines = [];
    const pending = p.status === 'pending';
    const idx = `${p.n}`;
    const marker = MARKER[p.verdict] || p.verdict;
    const title = esc(p.title);
    const ref = p.target ? link(p.target.ref) : '';
    const asCreate = p.verdict === 'CREATE' || (p.verdict === 'FLAG' && !p.target);
    if (asCreate) {
      const team = p.owner_team ? `[${esc(cap(p.owner_team))}] ` : '';
      lines.push(L(mk(`*{idx}. {marker}* ${team ? '{team}' : ''}«{title}»`, { idx, marker, team, title }), 'row'));
      const owner = p.owner ? (pending ? mention(p.owner) : `<strong>${esc(p.owner)}</strong>`) : mk(S['tasks.unassigned']);
      lines.push(L(mk('→ {owner} · {prio}', { owner, prio: esc(fmtPriority(p.priority)) }), 'sub'));
    } else if (p.verdict === 'DUPLICATE') {
      const state = dupState(p);
      lines.push(L(mk(`*{idx}. {marker}* {ref}${state ? ' _{state}_' : ''} — «{title}»`, { idx, marker, ref, state: digestText(state, mode), title }), 'row'));
    } else {
      const score = p.similarity !== null && p.similarity !== undefined ? ` (score ${Number(p.similarity).toFixed(2)})` : '';
      lines.push(L(mk('*{idx}. {marker}* {ref}{score}', { idx, marker, ref, score: esc(score) }), 'row'));
      lines.push(L(mk(S['tasks.new_context_line'], { title: esc(contextOf(p)) }), 'sub'));
    }
    if (pending) {
      if (p.quote && p.verdict !== 'DUPLICATE') {
        const ts = asCreate && p.ts ? ` ${TS(mode, p.ts)}` : '';
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
      out = mk(S['tasks.created_confirm'], { identifier: link(d.ref || ''), title, assignee_suffix: suffix });
    } else if (d.result === 'commented') {
      out = mk(S['tasks.comment_added'], { identifier: link(d.ref || (p.target && p.target.ref) || '') });
    } else {
      out = mk(S['tasks.file_only'], { title });
    }
    lines.push(L(out, 'sub'));
    return { lines, btns: null };
  }

  /** T5: the task log message (header, mode, planning banner, rows, bulk row, footers). */
  function t5Parts(e, mode, ask = true) {
    const parts = [];
    const n = e.proposals.length;
    parts.push(L(n === 1 ? mk(S['tasks.header_one']) : mk(S['tasks.header'], { count: n }), 'h'));
    parts.push(L(mk(S['tasks.meta_mode'], { mode: esc(e.call_mode || 'discovery') }), 'ctx'));
    const planning = e.call_mode === 'planning' || e.call_mode === 'mixed' || (e.bulk && e.bulk.approve_safe && e.bulk.approve_safe.allowed === false);
    if (planning) parts.push(L(mk(S['tasks.planning_banner']), 'ctx'));
    parts.push({ hr: true });
    for (const p of [...e.proposals].sort((a, b) => a.n - b.n)) {
      const r = t5Row(p, mode);
      parts.push(...r.lines);
      if (r.btns) parts.push({ btns: r.btns });
    }
    const pend = pendingOf(e);
    const tail = [];
    if (pend.length) {
      const btns = [];
      const safe = pend.filter((p) => p.safe).length;
      if (!planning && safe) btns.push([mk(S['tasks.btn_bulk_approve'], { count: safe }), true, true]);
      btns.push([S['tasks.btn_bulk_skip']]);
      tail.push({ btns });
      tail.push(L(mk(S['tasks.footer']), 'ctx'));
    }
    if (ask) tail.push(L(mk(S['tasks.training_footer']), 'ctx'));
    if (tail.length) parts.push({ hr: true }, ...tail);
    return parts;
  }

  function partsHtml(parts) {
    return parts.map((x) => {
      if (x.hr) return '<hr class="slk-hr">';
      if (x.btns) {
        return `<div class="msg-actions slk-btns" aria-hidden="true">${x.btns.map(([label, main, html]) => `<span class="sbtn${main ? ' sbtn-main' : ''}">${html ? label : esc(label)}</span>`).join('')}</div>`;
      }
      return `<p class="slk-${x.cls || 'l'}">${x.html}</p>`;
    }).join('');
  }

  function msgHtml(m) {
    if (m.head) {
      return `<div class="msg slk-msg"><img class="msg-av" src="/assets/logo.svg" alt="" width="36" height="36"><div class="msg-main">
        <p class="msg-head"><strong>Backbrief</strong> <span class="app">App</span> <time>${esc(m.time)}</time></p>${partsHtml(m.parts)}</div></div>`;
    }
    return `<div class="msg slk-msg slk-cont"><time class="slk-gutter">${esc(m.time)}</time><div class="msg-main">${partsHtml(m.parts)}</div></div>`;
  }

  const chName = (c) => String(c || 'Slack').replace(/^#/, '');

  /** The whole thread after a call (R, T1–T5) for a delivery combination, reflecting overlay decisions. */
  function threadHtml(call, d, channel) {
    const mode = tsMode(d);
    const dg = call.digest || {};
    const e = BB.effectiveProposals(call.id);
    const rootAt = (call.slack && call.slack.posted_at) || addMinutes(call.time, (Number(call.duration_min) || 0) + 1) || '';
    // Replies follow the tasks file's `generated` time in the workspace timezone; without one
    // (/app reads no tenant settings yet), they keep their usual few minutes after the root post.
    const gen = e && e.generated && ws().workspace.timezone ? Date.parse(e.generated) : NaN;
    const tAt = Number.isNaN(gen) ? addMinutes(rootAt, 7) : BB.clock(new Date(gen - 60000).toISOString());
    const t5At = Number.isNaN(gen) ? addMinutes(rootAt, 8) : BB.clock(new Date(gen).toISOString());
    const names = (call.participants || []).join(', ');

    // R: the root post.
    const recUrl = call.recording && call.recording.available && call.recording.url
      ? String(call.recording.url).replace(/^https?:\/\//, '') : DEMO_RECORDING;
    const root = `<div class="msg slk-msg slk-root"><img class="msg-av" src="/assets/logo.svg" alt="" width="36" height="36"><div class="msg-main">
      <p class="msg-head"><strong>Backbrief</strong> <span class="app">App</span> <time>${esc(rootAt)}</time></p>
      <p class="msg-title">${esc(call.topic)} <span class="muted">· ${joinDot([call.duration_min ? `${esc(call.duration_min)} min` : '', esc(names)])}</span></p>
      ${d.recording_link ? `<p class="slk-l">${mk(S['main.recording_line'], { url: link(recUrl) })}</p>` : ''}
    </div></div>`;

    const replies = [];
    // T1: summary.
    const t1 = [L(mk(S['main.summary_header'])), L(mk(S['main.participants_line'].replace(/^> /, ''), { names: (call.participants || []).map((n) => `<strong>${esc(n)}</strong>`).join(', ') }), 'q')];
    for (const th of dg.themes || []) {
      t1.push(L(mk('*{title}* {ts}', { title: digestText(th.title, mode), ts: TS(mode, th.ts) }), 'th'));
      for (const pt of th.points || []) t1.push(L(`• ${digestText(pt, mode)}`, 'li'));
    }
    replies.push({ time: tAt, parts: t1 });

    // T2: decisions and context.
    const t2 = [];
    const section = (key, list, line) => {
      if (!list || !list.length) return;
      t2.push(L(mk(S[key], { count: list.length }), t2.length ? 'h2 slk-gap' : 'h2'));
      list.forEach((x, i) => t2.push(L(`${i + 1}. ${line(x)}`, 'li')));
    };
    const at = (t) => (t ? ` ${TS(mode, t)}` : '');
    section('main.decisions_header', dg.decisions, (x) => mk(x.why ? '*{title}* — _{why}_ {ts}' : '*{title}* {ts}', { title: digestText(x.title, mode), why: digestText(x.why, mode), ts: TS(mode, x.ts) }));
    section('main.agreements_header', dg.agreements, (x) => `${x.parties && x.parties.length ? `${esc(x.parties.join(' ↔ '))}: ` : ''}${digestText(x.text, mode)}${at(x.ts)}`);
    section('main.open_questions_header', dg.open_questions, (x) => `${digestText(x.title, mode)}${x.why ? ` — ${digestText(x.why, mode)}` : ''}${at(x.ts)}`);
    section('main.insights_header', dg.key_insights, (x) => `${digestText(x.title, mode)}${x.implication ? ` — ${digestText(x.implication, mode)}` : ''}${at(x.ts)}`);
    if (t2.length) replies.push({ time: tAt, parts: t2 });

    // T3: next steps (task log off) and monitoring (always).
    const items = BB.effectiveActionItems(call.id);
    const next = items.filter((a) => a.status === 'post-call');
    const mon = items.filter((a) => a.status === 'monitoring');
    const t3 = [];
    if (!d.task_log && next.length) {
      t3.push(L(mk(S['main.next_steps_header'], { count: next.length }), 'h2'));
      next.forEach((a, i) => t3.push(L(`${i + 1}. ${digestText(a.title, mode)}${a.owner ? ` — ${mention(a.owner)}` : ''}${a.helpers && a.helpers.length ? ` <em>(+${esc(a.helpers.join(', '))})</em>` : ''}${a.priority ? ` <em>[${esc(a.priority)}]</em>` : ''}${a.tracker_ref ? ` → <code>${esc(a.tracker_ref)}</code>` : ''}${at(a.ts)}`, 'li')));
    }
    if (mon.length) {
      t3.push(L(mk(S['main.monitoring_header'], { count: mon.length }), t3.length ? 'h2 slk-gap' : 'h2'));
      mon.forEach((a, i) => t3.push(L(`${i + 1}. ${digestText(a.title, mode)}${a.owner ? ` — <strong>${esc(a.owner)}</strong>` : ''}${at(a.ts)}`, 'li')));
    }
    if (t3.length) replies.push({ time: tAt, parts: t3 });

    // T4: file and links.
    const file = String(call.path || '').split('/').pop();
    const t4 = [L(mk(S['main.vault_link'], { filename: link(file) }))];
    if (d.transcript_link) t4.push(L(mk(S['main.transcript_link'], { link: link('open the transcript') })));
    const waiting = e ? e.pending : 0;
    if (!d.task_log && waiting) {
      t4.push(L(waiting === 1 ? mk(S['tasks.waiting_in_workspace_one'], { link: link('review in Backbrief') }) : mk(S['tasks.waiting_in_workspace'], { count: waiting, link: link('review in Backbrief') })));
    }
    t4.push(L(mk(S['main.digest_footer'])));
    replies.push({ time: tAt, parts: t4 });

    // T5: the task log.
    if (d.task_log && e && e.proposals.length) replies.push({ time: t5At, parts: t5Parts(e, mode, true) });

    replies[0].head = true;
    return `<figure class="thread slk">
      <figcaption class="sr-only">Preview of the Slack thread for ${esc(call.topic)}: ${esc(BB.deliveryPhrase(d))}.</figcaption>
      <div class="thread-bar"><span><b># ${esc(chName(channel))}</b></span><span>Preview · Slack</span></div>
      <div class="slk-scroll">
        ${root}
        <p class="thread-sep">${esc(plural(replies.length, 'reply', 'replies'))}</p>
        ${replies.map(msgHtml).join('')}
      </div>
    </figure>`;
  }

  /** The "Send log to Slack" preview: T5 as it would post now. */
  function logPreviewHtml(e, channel, inThread, ask) {
    const mode = tsMode(BB.effectiveSlack().delivery);
    return `<figure class="thread slk slk-log">
      <figcaption class="sr-only">Preview of the task log for ${esc(e.topic)}, ${inThread ? `as a reply in the call's thread in ${esc(channel)}` : `as a new message in ${esc(channel)}`}.</figcaption>
      <div class="thread-bar"><span><b># ${esc(chName(channel))}</b>${inThread ? ' · Thread' : ''}</span><span>Preview · Slack</span></div>
      <div class="slk-scroll">${msgHtml({ time: nowClock(), head: true, parts: t5Parts(e, mode, ask) })}</div>
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

  function savedToast(d, chans) {
    const over = teamsList().filter((t) => chans[t]).map((t) => `${chans[t]} for ${t}`);
    const where = over.length ? `in ${joinAnd([...over, `${chans.default} for the rest`])}` : `in ${chans.default}`;
    return `Saved. From the next call: ${BB.deliveryPhrase(d)}, ${where}.`;
  }

  function paintPreview(announce) {
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
    const live = $('[data-sd-live]', viewEl());
    if (announce && live) live.textContent = `Preview: ${commaPhrase(d)} · ${channel}`;
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
      page('slack', `<p class="tab-lede">What is posted after every call, and where.</p>
        <div class="sd-layout">
          <section class="panel sd-settings" aria-labelledby="h-sd-post">
            <h2 id="h-sd-post">After each call, post</h2>
            <p class="sd-ro">${settings() ? `Posted after each call: ${esc(commaPhrase(slack.delivery))}.` : 'Posted after each call: the summary, plus the links and task log chosen when Slack was connected.'}</p>
            <p class="sd-ro">${chLine}</p>
            <p class="small muted">${BB.managed()}</p>
          </section>
          ${previewPane}
        </div>`, { eyebrow, focus: first && pid ? '#slack-preview' : null });
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
    page('slack', `<p class="tab-lede">Choose what is posted after every call, and where, while seeing the exact post.</p>
      <p class="sd-jump"><a href="#slack-preview">Jump to preview ↓</a></p>
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
    const form = $('[data-sd-form]', viewEl());
    if (!form) return;
    form.addEventListener('change', (ev) => {
      const t = ev.target;
      if (!ui.draft || !t.name) return;
      if (t.type === 'checkbox') {
        if (!DKEYS.includes(t.name)) return;
        ui.draft.delivery[t.name] = t.checked;
      } else if (t.name === 'ch-default') {
        ui.draft.channels.default = t.value;
        for (const o of $$('[data-default-option]', form)) o.textContent = `Default (${t.value})`;
      } else if (t.name.startsWith('ch-')) {
        ui.draft.channels[t.name.slice(3)] = t.value;
      } else return;
      syncDirty();
      paintPreview(true);
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
      const msg = savedToast(d, c);
      BB.save();
      BB.setLeaveGuard(null);
      ui.draft = null;
      await refreshWith('#sd-save');
      BB.toast(msg, NOTE.browser);
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
  }

  // ================================================================ call detail aside (§3.3)
  BB.hooks.callAside = (call, el) => {
    firstRender();
    const e = BB.effectiveProposals(call.id);
    if (!e || !e.proposals.length) {
      el.innerHTML = '';
      el.hidden = true;
      return;
    }
    el.setAttribute('aria-labelledby', 'h-proposals');
    // Team keys (Product → PRD) come from settings; a call page does not load them, so fill them in once they arrive.
    if (BB.isDemo && !settings()) {
      BB.load('settings').then(() => { if (el.isConnected && !el.contains(document.activeElement)) BB.hooks.callAside(call, el); }).catch(() => {});
    }
    const rows = [...e.proposals].sort((a, b) => a.n - b.n)
      .map((p) => `<li>${p.status === 'pending' ? cardHtml(p, { compact: true }) : outcomeHtml(p, { compact: true })}</li>`).join('');
    el.innerHTML = `<h2 id="h-proposals">Task proposals</h2>
      <p class="panel-note">Checked against the Linear backlog before anything was filed.</p>
      ${bulkHtml(e, { compact: true })}
      <ol class="tl-items tl-aside-items" aria-label="Task proposals">${rows}</ol>
      <p class="panel-foot"><a href="${esc(href('tasks', 'call', call.id))}">Open in Action items</a></p>`;
  };

  BB.hooks.sendLog = (callId, trigger) => openSendLog(callId, trigger);

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
    if (!BB.isDemo && act !== 'clear-filters') return;
    if (act === 'approve') approve(key, false, origin);
    else if (act === 'alt') approve(key, true, origin);
    else if (act === 'skip') skip(key, origin);
    else if (act === 'edit') openEdit(key, b);
    else if (act === 'why') pickReason(key, b.dataset.reason);
    else if (act === 'bulk-approve') bulkApprove(b.dataset.call, b, origin);
    else if (act === 'bulk-skip') bulkSkip(b.dataset.call, b, origin);
    else if (act === 'send-log') openSendLog(b.dataset.call, b);
    else if (act === 'clear-filters') {
      const form = $('[data-tl-filters]', v);
      if (!form) return;
      $('input[name="status"][value="all"]', form).checked = true;
      form.elements.namedItem('verdict').value = '';
      form.elements.namedItem('owner').value = '';
      applyFilters(form, () => { const r = $('input[name="status"][value="all"]', form); if (r) r.focus(); });
    }
  });

  // ================================================================ routes
  const NEEDS = ['workspace', 'settings?', 'people?'];
  BB.route('tasks', taskLogView, { nav: 'tasks', title: 'Action items', loading: 'proposals', needs: NEEDS });
  BB.route('tasks/open', openItemsView, { nav: 'tasks', title: 'Action items', needs: ['workspace', 'people?'] });
  BB.route('tasks/history', historyView, { nav: 'tasks', title: 'Action items', loading: 'proposals', needs: NEEDS });
  BB.route('tasks/slack', slackView, { nav: 'tasks', title: 'Action items', needs: NEEDS });
})();
