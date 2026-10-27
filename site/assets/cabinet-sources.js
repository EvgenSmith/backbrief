// SPDX-License-Identifier: MIT
/*
 * cabinet-sources.js — Sources (spec §3.10): a ruled ledger of what
 * Backbrief reads from and writes to (call recordings, chat, tracker, the
 * record repository, context repositories, imports, what comes next), and a
 * page per source: health, what it does (for Zoom, what gets processed and
 * who can read it, every digest channel included, then the processing rules
 * that are coming next, shown disabled), access with a reason for each
 * permission (Slack: what it can and never can do), settings, activity,
 * disconnect. In the demo, Connect
 * walks the steps of the setup call, with a stand-in for the tool's approval
 * screen, and Request offers a demo call; every change goes to the overlay
 * (sources, requests, imports). Styles live
 * in cabinet-people.css. API: the BB block at the top of cabinet.js.
 *
 * An imported file is read in the browser only to count its lines; its text
 * is never rendered or stored.
 */
(() => {
  'use strict';
  const BB = window.BB;
  if (!BB) return;
  const { esc, href, plural } = BB;

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const wait = (ms) => new Promise((r) => { setTimeout(r, ms); });
  const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const ws = () => BB.workspace();

  const NAMES = { zoom: 'Zoom', slack: 'Slack', linear: 'Linear', github: 'GitHub' };
  const CATEGORY = { zoom: 'Call recordings', slack: 'Chat', linear: 'Tracker', github: 'Repository' };
  const ORDER = ['zoom', 'slack', 'linear', 'github'];
  // Who approves the access in each tool, for the Connect dialog's managed first step.
  const ADMIN = { zoom: 'an account admin', slack: 'a workspace admin', linear: 'a workspace admin', github: 'an organization owner' };
  const back = '<a class="back-link" href="#/sources">← Sources</a>';
  /** Every view of this module renders inside .screen, so its phone rules (tap targets) stay scoped. */
  const show = (title, html, opts) => BB.render(title, `<div class="screen screen-sources">${html}</div>`, 'sources', opts);
  const reducedMotion = () => Boolean(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  /** The nav's own name for the Action items section, so links here follow a rename. */
  function tasksLabel() {
    const a = document.querySelector('.app-nav [data-nav="tasks"]');
    if (!a) return 'Action items';
    const copy = a.cloneNode(true);
    for (const x of copy.querySelectorAll('.nav-count, .sr-only')) x.remove();
    return copy.textContent.replace(/\s+/g, ' ').trim() || 'Action items';
  }

  function repoName() {
    const v = BB.cached('vault');
    if (v && v.repo) return v.repo;
    const gh = BB.effectiveSources().find((s) => s.id === 'github');
    if (gh && gh.account) return gh.account;
    const m = String((ws() && ws().workspace.vault_url) || '').match(/^https:\/\/github\.com\/([^/]+\/[^/?#]+)/);
    return m ? m[1] : 'your repository';
  }
  const callsTotal = () => (ws() ? ws().stats.calls_total || ws().calls.length : 0);

  // ------------------------------------------------------------ what each source does and may do

  const DOES = {
    zoom: () => 'When a cloud recording finishes, Zoom tells Backbrief, which fetches the transcript. No bot joins the call.',
    slack: () => "Posts each call's digest in a thread and, if the task log is on, the proposals with Approve and Skip.",
    linear: () => 'Checks proposals against your backlog and files the ones your team approves, with the label backbrief.',
    github: () => `Backbrief commits each call, tasks file and profile to ${repoName()}. This workspace reads it with a read-only key.`,
  };
  const DISCONNECT = {
    zoom: () => `New recordings stop being processed. The ${plural(callsTotal(), 'call')} already in ${repoName()} stay.`,
    slack: () => "Digests and proposals stop being posted to Slack. Proposals still wait in Action items, and every call is still saved.",
    linear: () => 'Approved proposals stop being filed, and new ones are no longer checked against your backlog. The tasks files keep every decision.',
    github: () => `New calls stop being saved and this workspace stops updating. Everything already in ${repoName()} stays yours.`,
  };

  const ZOOM_WHY = {
    'meeting:read:list_past_participants:admin': 'See who attended, to name participants',
    'cloud_recording:read:list_user_recordings:admin': 'List past recordings, for history import',
  };
  const ZOOM_EVENTS = { 'recording.completed': 'Recording finished', 'recording.transcript_completed': 'Transcript ready' };
  // Everything Slack's scopes allow, grouped under the "Can" line. channels:history reads the
  // whole history of every channel the app is invited to, so the line says so; nothing in this
  // list reads a direct message or a channel the app isn't in.
  const SLACK_GROUPS = [
    ['Post in the channels you choose', ['chat:write', 'chat:write.public']],
    ['See the channel list, so you can choose', ['channels:read', 'groups:read']],
    ["Message a call's owner if processing fails", ['im:write']],
    ["Read messages in channels it's invited to; it only uses replies in threads it started", ['channels:history', 'groups:history']],
    ['Match people by email', ['users:read', 'users:read.email']],
    ['Add and read reactions on its own posts', ['reactions:read', 'reactions:write']],
  ];
  const SLACK_CAN = "post in the channels you choose · read messages in channels it's invited to; it only uses replies in threads it started · match people by email · add reactions to its own posts.";
  const SLACK_NEVER = "read channels it isn't invited to · read direct messages.";
  const LINEAR_WHY = [
    ['read issues', 'Check each proposal against your backlog'],
    ['create issues', 'File the proposals your team approves'],
    ['comment', "Add a call's new context to an issue that already exists"],
    ['label backbrief', 'Add the label backbrief, so everything it files is easy to find'],
  ];

  /** [{why, scopes: [mono strings], required}] for one source: settings.json when it has them, else the product's own list. */
  function accessOf(s) {
    const id = s.id;
    if (id === 'zoom') {
      const scopes = s.scopes && s.scopes.length ? s.scopes : Object.keys(ZOOM_WHY).map((scope, i) => ({ scope, required: i === 0 }));
      return scopes.map((x) => {
        const scope = typeof x === 'string' ? x : x.scope;
        return { why: ZOOM_WHY[scope] || (x.for ? `For ${x.for}` : 'Read recordings'), scopes: [scope], required: Boolean(x.required) };
      });
    }
    if (id === 'slack') {
      const have = s.scopes && s.scopes.length ? s.scopes.map(String) : SLACK_GROUPS.flatMap(([, sc]) => sc);
      const rows = SLACK_GROUPS.map(([why, sc]) => ({ why, scopes: sc.filter((x) => have.includes(x)) })).filter((r) => r.scopes.length);
      const rest = have.filter((x) => !SLACK_GROUPS.some(([, sc]) => sc.includes(x)));
      if (rest.length) rows.push({ why: 'Other', scopes: rest });
      return rows;
    }
    if (id === 'linear') {
      const have = s.scopes && s.scopes.length ? s.scopes.map(String) : LINEAR_WHY.map(([k]) => k);
      return have.map((k) => ({ why: (LINEAR_WHY.find(([x]) => x === k) || [k, k])[1], scopes: [k] }));
    }
    const repo = repoName();
    return [
      { why: 'Commit each call, tasks file and profile', scopes: [`Backbrief: Contents read and write, ${repo} only`] },
      { why: 'Show this workspace; it never changes a file', scopes: ['Workspace: Contents read-only'] },
    ];
  }

  function accessHtml(s) {
    const rows = accessOf(s).map((r) => `<li>
        <span class="access-why">${esc(r.why)}${r.required ? ' <span class="chip">Required</span>' : ''}</span>
        <span class="access-scopes">${r.scopes.map((x) => `<code>${esc(x)}</code>`).join(' ')}</span>
      </li>`).join('');
    if (s.id === 'slack') {
      // Plain words first, then the scopes that make each "Can" true.
      return `<div class="access-cn">
          <p class="access-line"><span class="access-k">Can</span> <span>${esc(SLACK_CAN)}</span></p>
          <ul class="access access-under">${rows}</ul>
          <p class="access-line is-never"><span class="access-k">Never</span> <span>${esc(SLACK_NEVER)}</span></p>
          <p class="access-never-why">Slack lets it read only the channels it's invited to, though in those it can read every message, older ones included (<code>channels:history</code>). It has no <code>im:history</code> scope, so it can't read direct messages.</p>
        </div>`;
    }
    const events = s.id === 'zoom' ? ((s.events && s.events.length ? s.events : Object.keys(ZOOM_EVENTS)).map((e) => ZOOM_EVENTS[e] || e)) : [];
    return `<ul class="access">${rows}</ul>${events.length ? `<p class="access-events"><span class="access-k">Events</span> ${esc(events.join(' · '))}</p>` : ''}`;
  }

  // ------------------------------------------------------------ what a source means for your calls

  const KEEP_OFF = 'Keep 1:1, board and HR calls off the cloud recording.';

  /** Where digests are posted, as Slack delivery has it now: the default channel, then each team's own. */
  function digestChannels() {
    const sl = BB.effectiveSlack();
    return [...new Set([sl.channel, ...Object.values(sl.per_team_channels || {})].filter(Boolean))];
  }

  /**
   * The Zoom statement: what gets processed and who can read it, with every
   * channel a digest goes to. `advice: false` leaves out the closing advice
   * where the processing rules block says it.
   */
  function zoomStatement(s, { advice = true } = {}) {
    const set = s.settings || {};
    const min = Number(set.min_duration_min);
    const longer = set.min_duration_min !== undefined && set.min_duration_min !== null && Number.isFinite(min) && min > 0
      ? ` longer than ${plural(min, 'minute')}` : '';
    const slack = BB.effectiveSources().find((x) => x.id === 'slack');
    const chans = digestChannels();
    const readers = slack && slack.status === 'connected'
      ? `everyone in this workspace and ${chans.length ? `in ${BB.joinAnd(chans)}` : 'in the digest channel'} can read it`
      : 'everyone in this workspace can read it';
    return `${s.status === 'connected' ? 'Every' : 'Once connected, every'} cloud recording on ${s.account || 'your Zoom account'}${longer} is processed, and ${readers}.${advice ? ` ${KEEP_OFF}` : ''}`;
  }

  // ------------------------------------------------------------ processing rules (coming next)
  // What the product will offer to keep private calls out. Not live: every input is disabled,
  // the block says so, and the only action asks for early access.

  const RULES_KEY = 'processing-rules';
  const RULES = [
    { id: 'skip', kind: 'text', label: 'Skip calls whose title contains', value: '1:1, board, HR, interview' },
    { id: 'hosts', kind: 'text', label: 'Only process calls hosted by', value: '…' },
    { id: 'hold', kind: 'switch', label: "Hold the digest for review before it's posted" },
    { id: 'participants', kind: 'switch', label: 'Show a call only to its participants' },
  ];

  function rulesHtml() {
    const rows = RULES.map((r) => `<div class="source-rule">
        <label for="pr-${r.id}">${esc(r.label)}</label>
        ${r.kind === 'text'
    ? `<input id="pr-${r.id}" type="text" value="${esc(r.value)}" disabled aria-describedby="pr-note">`
    : `<input class="switch" id="pr-${r.id}" type="checkbox" role="switch" disabled aria-describedby="pr-note">`}
      </div>`).join('');
    const ask = !BB.isDemo
      ? `<p class="small muted">Want them first? Write to us at <a href="mailto:${esc(BB.contact)}">${esc(BB.contact)}</a>.</p>`
      : requested(RULES_KEY)
        ? `<p class="source-rules-do"><button class="btn btn-small btn-ghost source-req is-done" type="button" aria-disabled="true" data-key="req-${RULES_KEY}"><span aria-hidden="true">✓ </span>Early access requested</button></p>`
        : `<p class="source-rules-do"><button class="btn btn-small" type="button" data-request="${RULES_KEY}" data-label="Processing rules" data-key="req-${RULES_KEY}">Ask for early access</button></p>`;
    return `<p class="source-rules-lede">Rules that keep private calls out before anything is processed or posted.</p>
      <fieldset class="source-rules" disabled aria-describedby="pr-note">
        <legend class="sr-only">Processing rules, not live yet</legend>
        ${rows}
      </fieldset>
      <p class="source-rules-note" id="pr-note"><strong>Not live yet.</strong> Until then, ${KEEP_OFF.charAt(0).toLowerCase()}${KEEP_OFF.slice(1)}</p>
      ${ask}`;
  }

  // ------------------------------------------------------------ health

  const OFF = {
    zoom: "new recordings aren't processed",
    slack: "digests aren't posted to Slack",
    linear: "approved tasks aren't filed",
    github: "new calls aren't saved",
  };

  function addMinutes(hhmm, min) {
    const m = String(hhmm || '').match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return null;
    const t = Number(m[1]) * 60 + Number(m[2]) + Number(min || 0);
    return `${String(Math.floor(t / 60) % 24).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
  }

  /** The workspace's own date for an ISO time, as YYYY-MM-DD. */
  function localDay(iso) {
    try {
      const tz = (ws() && ws().workspace.timezone) || undefined;
      return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
    } catch {
      return String(iso).slice(0, 10);
    }
  }

  function latestCall() {
    const w = ws();
    if (!w || !w.calls.length) return null;
    return [...w.calls].sort((a, b) => `${b.date} ${b.time || ''}`.localeCompare(`${a.date} ${a.time || ''}`))[0];
  }

  /**
   * When a source last did something for Backbrief, {date, time}: settings' own
   * health.last_event when the data has it, else from the latest call: Zoom when
   * the recording ended, Slack when it posted (the proposals reply, if the task
   * log is on), Linear and GitHub when the proposals were checked and committed.
   */
  function lastEvent(s) {
    const h = s.health || {};
    if (h.last_event) return { date: localDay(h.last_event), time: BB.clock(h.last_event) };
    const c = latestCall();
    if (!c) return null;
    const ended = { date: c.date, time: c.time ? addMinutes(c.time, c.duration_min || 0) : null };
    const entry = ((ws() && ws().task_log) || []).find((e) => e.call_id === c.id && e.generated);
    const checked = entry ? { date: localDay(entry.generated), time: BB.clock(entry.generated) } : null;
    const detail = BB.cached(`call:${c.id}`);
    const posted = detail && detail.slack && detail.slack.posted_at ? { date: c.date, time: detail.slack.posted_at } : null;
    const later = (a, b) => (!a ? b : !b ? a : `${a.date} ${a.time}` >= `${b.date} ${b.time}` ? a : b);
    if (s.id === 'zoom') return ended;
    if (s.id === 'slack') return later(posted, BB.effectiveSlack().delivery.task_log ? checked : null) || ended;
    return checked || posted || ended;
  }

  /** "Healthy · last event 19 Oct, 10:44 · no failures in 30 days", or what stops while disconnected. */
  function health(s) {
    if (s.status !== 'connected') return { ok: false, text: `Not connected · ${OFF[s.id] || 'nothing new comes in'}` };
    if (!BB.isDemo && !s.health) return null; // /app has no health data yet: claim nothing
    const f = Number((s.health || {}).failures_30d) || 0;
    const ev = lastEvent(s);
    return {
      ok: f === 0,
      text: [f ? 'Needs a look' : 'Healthy', ev ? `last event ${BB.fmtDay(ev.date)}${ev.time ? `, ${ev.time}` : ''}` : '',
        f ? `${plural(f, 'failure')} in 30 days` : 'no failures in 30 days'].filter(Boolean).join(' · '),
    };
  }

  function healthHtml(s, cls = '') {
    const h = health(s);
    if (!h) return '';
    return `<p class="source-health${cls ? ` ${cls}` : ''}${h.ok ? '' : ' is-off'}"><span class="status-dot${h.ok ? '' : ' is-off'}" aria-hidden="true"></span>${esc(h.text)}</p>`;
  }

  // ------------------------------------------------------------ activity

  function myDecisions() {
    const mine = BB.effectiveProposals().flatMap((e) => e.proposals.filter((p) => p.by === 'you'));
    return {
      created: mine.filter((p) => p.decision && p.decision.result === 'created').length,
      commented: mine.filter((p) => p.decision && p.decision.result === 'commented').length,
      logs: BB.effectiveProposals().filter((e) => e.log_sent).length,
    };
  }

  /** Activity from settings.json, else (in /app) from the workspace itself; demo decisions add up. */
  function activityOf(s) {
    const w = ws();
    const a = s.activity || {};
    const last = (w && w.stats.last_call && w.stats.last_call.date) || (w && w.calls[0] && w.calls[0].date) || null;
    const mine = myDecisions();
    if (s.id === 'zoom') {
      const n = a.calls ?? (w ? w.calls.filter((c) => (c.platform || c.source) === 'zoom').length : 0);
      return { line: `${plural(n, 'call')} filed${a.last || last ? `, last ${BB.fmtDay(a.last || last)}` : ''}`, short: `${plural(n, 'call')}${a.last || last ? `, last ${BB.fmtDay(a.last || last)}` : ''}` };
    }
    if (s.id === 'slack') {
      const n = a.digests ?? (w ? w.calls.length : 0);
      return { line: `${plural(n, 'digest')} posted${a.last || last ? `, last ${BB.fmtDay(a.last || last)}` : ''}${mine.logs ? ` · ${plural(mine.logs, 'task log')} posted from this workspace` : ''}`, short: '' };
    }
    if (s.id === 'linear') {
      let created = a.issues_created;
      let comments = a.comments;
      let fileOnly = a.file_only;
      if (created === undefined && w) {
        const decided = w.task_log.flatMap((e) => e.proposals).filter((p) => p.status === 'approved');
        created = decided.filter((p) => p.decision.result === 'created').length;
        comments = decided.filter((p) => p.decision.result === 'commented').length;
        fileOnly = decided.filter((p) => p.decision.result === 'file-only').length;
      }
      created = (created || 0) + mine.created;
      comments = (comments || 0) + mine.commented;
      return {
        line: [plural(created, 'issue') + ' created', plural(comments, 'comment'), fileOnly ? `${fileOnly} kept in tasks files` : ''].filter(Boolean).join(' · '),
        short: `${plural(created, 'issue')} created, ${plural(comments, 'comment')}`,
      };
    }
    const n = a.calls_filed ?? (w ? w.stats.calls_total : 0);
    return { line: `${plural(n, 'call')} filed${a.last || last ? `, last ${BB.fmtDay(a.last || last)}` : ''}`, short: '' };
  }

  const historyOf = (s) => (BB.isDemo && s.changed_here && BB.state.sources[s.id] && Array.isArray(BB.state.sources[s.id].history) ? BB.state.sources[s.id].history : []);
  const HISTORY_WORD = { not_connected: 'Disconnected', connected: 'Connected again', settings: 'Settings saved' };

  // ------------------------------------------------------------ setup strip (an unfinished /app workspace)

  function setupStrip() {
    const w = ws();
    if (!w) return '';
    const steps = w.overview && Array.isArray(w.overview.setup) ? w.overview.setup : null;
    const done = steps ? Boolean((steps.find((x) => x.id === 'sources') || { done: true }).done)
      : ORDER.every((k) => (w.workspace.integrations || {})[k]);
    return done ? '' : '<p class="setup-strip"><span class="setup-strip-k">Setup · step 1 of 4</span> Connect your tools. About 10 minutes, or we do it with you on the setup call.</p>';
  }

  // ------------------------------------------------------------ the ledger

  function sourceDetailLine(s) {
    const on = s.status === 'connected';
    const parts = [];
    if (BB.isDemo && s.account) parts.push(`<span class="mono">${esc(s.account)}</span>`);
    if (!on) {
      const h = historyOf(s).filter((x) => x.status === 'not_connected').pop();
      parts.push(h ? `disconnected ${esc(BB.stamp(h.at, ' '))}` : 'not connected yet');
      return parts.join(' · ');
    }
    const a = activityOf(s);
    if (s.id === 'zoom') {
      if (s.connected_at) parts.push(`since ${esc(BB.fmtDay(s.connected_at))}`);
      parts.push(esc(a.short));
    } else if (s.id === 'slack') {
      const sl = BB.effectiveSlack();
      const chans = [sl.channel, ...Object.values(sl.per_team_channels || {})].filter(Boolean);
      if (chans.length) parts.push([...new Set(chans)].map((c) => `<span class="mono nowrap">${esc(c)}</span>`).join(', '));
      else parts.push(esc(a.line)); // /app: no channel list without the tenant's settings
    } else if (s.id === 'linear') {
      parts.push(esc(a.short));
    } else if (s.id === 'github') {
      const branch = (s.settings && s.settings.branch) || 'main';
      if (!BB.isDemo || !s.account) parts.push(`<span class="mono">${esc(repoName())}</span>`);
      parts.push(`<span class="mono">${esc(branch)}</span>`, 'Backbrief writes, workspace reads');
    }
    return parts.filter(Boolean).join(' · ');
  }

  function requested(key) { return Boolean(BB.isDemo && BB.state.requests && BB.state.requests[key]); }
  function requestButton(key, label) {
    if (!BB.isDemo) return '';
    const k = `req-${slug(key)}`;
    return requested(key)
      ? `<button class="btn btn-small btn-ghost source-req is-done" type="button" aria-disabled="true" data-key="${k}"><span aria-hidden="true">✓ </span>Requested<span class="sr-only">: ${esc(label)}</span></button>`
      : `<button class="btn btn-small btn-ghost source-req" type="button" data-request="${esc(key)}" data-label="${esc(label)}" data-key="${k}">Request<span class="sr-only">: ${esc(label)}</span></button>`;
  }

  function sourceRow(s) {
    const on = s.status === 'connected';
    const name = NAMES[s.id] || s.id;
    const action = !BB.isDemo
      ? `<a class="btn btn-small btn-ghost" href="${esc(href('sources', s.id))}">Details<span class="sr-only">: ${esc(name)}</span></a>`
      : on
        ? `<a class="btn btn-small btn-ghost" href="${esc(href('sources', s.id))}" data-key="source-${esc(s.id)}-action">Manage<span class="sr-only"> ${esc(name)}</span></a>`
        : `<button class="btn btn-small" type="button" data-connect="${esc(s.id)}" data-key="source-${esc(s.id)}-action">Connect ${esc(name)}</button>`;
    // The health line carries the status (with its dot); without health data (/app) the plain status stays.
    const healthLine = healthHtml(s);
    return `<li class="source-row${on ? '' : ' is-off'}">
      <p class="source-cat">${esc(CATEGORY[s.id] || '')}</p>
      <div class="source-what">
        <p class="source-title"><a href="${esc(href('sources', s.id))}">${esc(name)}</a></p>
        ${healthLine ? '' : `<p class="source-state${on ? '' : ' is-off'}"><span class="status-dot${on ? '' : ' is-off'}" aria-hidden="true"></span>${on ? 'Connected' : 'Not connected'}</p>`}
      </div>
      <div class="source-detail">
        <p class="source-facts">${sourceDetailLine(s)}</p>
        ${healthLine}
        ${s.id === 'zoom' && on ? `<p class="source-note">${esc(zoomStatement(s))}</p>` : ''}
      </div>
      <p class="source-do">${action}</p>
    </li>`;
  }

  function listView() {
    const sources = [...BB.effectiveSources()].sort((a, b) => ORDER.indexOf(a.id) - ORDER.indexOf(b.id));
    const st = BB.cached('settings');
    const imports = (st && st.imports) || ['Granola export', 'Fireflies export'];
    const coming = (st && st.coming_next) || ['Google Meet', 'Microsoft Teams', 'Jira', 'Asana', 'Single sign-on'];
    const mine = BB.isDemo ? BB.state.imports.length : 0;
    const rows = sources.map(sourceRow);
    const gh = rows.length ? sources.findIndex((s) => s.id === 'github') : -1;
    const context = `<li class="source-row is-soon">
      <p class="source-cat"><span class="sr-only">Repository</span></p>
      <div class="source-what">
        <p class="source-title">Context repositories</p>
        <p><span class="soon-tag">Coming next</span></p>
      </div>
      <p class="source-detail">Let Backbrief read other repositories, like product docs or code, so digests spell features and services the way your team does. Read-only.</p>
      <p class="source-do">${requestButton('context-repositories', 'Context repositories')}</p>
    </li>`;
    if (gh >= 0) rows.splice(gh + 1, 0, context); else rows.push(context);
    rows.push(`<li class="source-row">
      <p class="source-cat">Imports</p>
      <div class="source-what"><p class="source-title"><a href="${esc(href('sources', 'imports'))}">Transcripts</a></p></div>
      <p class="source-detail">${esc([...imports, '.vtt, .txt or .md'].join(' · '))}${mine ? ` · <a href="${esc(href('sources', 'imports'))}">${esc(plural(mine, 'file'))} imported in this browser</a>` : ''}</p>
      <p class="source-do">${BB.isDemo ? '<button class="btn btn-small btn-ghost" type="button" data-import data-key="source-import">Import a file</button>' : ''}</p>
    </li>`);
    rows.push(`<li class="source-row is-next">
      <p class="source-cat">Coming next</p>
      <div class="source-next">
        <p class="source-next-lede">Tell us what you run on. Requests decide what we connect next.</p>
        <ul class="tools tools-off source-soon" aria-label="Coming next">${coming.map((c) => `<li><span>${esc(c)}</span>${requestButton(c, c)}</li>`).join('')}</ul>
        ${BB.isDemo ? '' : `<p class="small muted">Need one of these? Write to us at <a href="mailto:${esc(BB.contact)}">${esc(BB.contact)}</a>.</p>`}
      </div>
    </li>`);
    const lede = `<p>What Backbrief reads from and writes to, and what it’s allowed to do there.</p>${BB.isDemo ? '<p class="sources-try">Try it: disconnect and reconnect any source. <span class="chip">Demo</span></p>' : ''}`;
    const on = sources.filter((s) => s.status === 'connected').length;
    show('Sources', `${setupStrip()}<ul class="ruled source-list" aria-label="Sources">${rows.join('')}</ul>${BB.isDemo ? '' : `<p class="small muted source-managed">${BB.managed()}</p>`}`, {
      eyebrow: esc(`${on} of ${sources.length} connected${BB.isDemo ? ` · records to ${repoName()}` : ''}`),
      lede,
    });
    wireCommon();
  }

  // ------------------------------------------------------------ a source

  /** The page's lede: the health line first, then the account and since when (or since when it's off). */
  function statusLine(s) {
    const on = s.status === 'connected';
    const bits = [];
    if (BB.isDemo && s.account) bits.push(`<span class="mono">${esc(s.account)}</span>`);
    if (on && s.connected_at) {
      const again = historyOf(s).filter((x) => x.status === 'connected').pop();
      bits.push(again ? `connected again ${esc(BB.stamp(again.at, ' '))}` : `connected since ${esc(BB.fmtDate(s.connected_at))}`);
    }
    if (!on) {
      const h = historyOf(s).filter((x) => x.status === 'not_connected').pop();
      if (h) bits.push(`disconnected ${esc(BB.stamp(h.at, ' '))}`);
    }
    const healthLine = healthHtml(s, 'is-lede');
    if (!healthLine) {
      return `<p class="source-status${on ? '' : ' is-off'}"><span class="status-dot${on ? '' : ' is-off'}" aria-hidden="true"></span>${[on ? 'Connected' : 'Not connected', ...bits].join(' · ')}</p>`;
    }
    return `${healthLine}${bits.length ? `<p class="source-sub">${bits.join(' · ')}</p>` : ''}`;
  }

  const pct = (x) => `${Math.round(Number(x) * 100)}%`;

  function teamLeads(s) {
    const set = (s.settings && s.settings.default_assignees) || null;
    if (set) return set;
    // Without the tenant's default assignees: the team's lead or head, by role.
    const out = {};
    for (const p of BB.effectivePeople().people) {
      if (p.team && !out[p.team] && /\b(lead|head)\b/i.test(p.role || '')) out[p.team] = p.lastname;
    }
    return out;
  }

  function settingsHtml(s) {
    const id = s.id;
    if (!BB.isDemo) return `<p class="muted">${BB.managed()}</p>`;
    const set = s.settings || {};
    if (id === 'zoom') {
      const days = set.history_import && set.history_import.enabled ? String(set.history_import.days || 30) : 'off';
      return `<form class="form source-form" data-settings="zoom" novalidate>
        <div class="field">
          <label for="zs-keep">Keep transcripts</label>
          <select id="zs-keep" name="raw_retention">
            <option value="none"${set.raw_retention === 'none' ? ' selected' : ''}>Don't keep</option>
            <option value="vtt"${set.raw_retention !== 'none' ? ' selected' : ''}>Keep the transcript in ${esc(repoName())}</option>
          </select>
        </div>
        <div class="field">
          <label for="zs-min">Skip calls shorter than</label>
          <p class="source-inline"><input id="zs-min" name="min_duration_min" type="number" inputmode="numeric" min="0" max="120" step="1" value="${esc(set.min_duration_min ?? 5)}" aria-describedby="zs-min-err"> <span>minutes</span></p>
          <p class="error" id="zs-min-err" role="alert" hidden></p>
        </div>
        <div class="field">
          <label for="zs-import">Import past recordings</label>
          <select id="zs-import" name="history">
            ${[['off', 'Off'], ['30', '30 days'], ['60', '60 days'], ['90', '90 days']].map(([v, l]) => `<option value="${v}"${days === v ? ' selected' : ''}>${l}</option>`).join('')}
          </select>
        </div>
        <p class="source-save"><button class="btn btn-small" type="submit" data-key="settings-save">Save</button> <span class="chip-mark" data-dirty hidden>Unsaved changes</span></p>
      </form>`;
    }
    if (id === 'slack') {
      // A read-only summary of the delivery defaults; they are set in the tasks section's Slack delivery.
      const sl = BB.effectiveSlack();
      const d = sl.delivery || {};
      const what = BB.joinAnd(['summary', d.transcript_link && 'transcript link', d.recording_link && 'recording link',
        d.task_log && 'task proposals with Approve and Skip'].filter(Boolean));
      const per = Object.entries(sl.per_team_channels || {}).filter(([, v]) => v);
      const where = `<span class="mono">${esc(sl.channel || '#call-digests')}</span>${per.length ? `; ${per.map(([t, c]) => `<span class="mono">${esc(c)}</span> for ${esc(t)}`).join(', ')}` : ''}`;
      return `<p class="source-defaults">After each call: ${esc(what)}, in ${where}.</p>
        <p class="source-link">Read-only here. <a href="#/tasks/slack">Change it in ${esc(tasksLabel())} › Slack delivery</a></p>`;
    }
    if (id === 'linear') {
      const map = set.team_mapping || {};
      const keys = [...new Set(Object.values(map))];
      const leads = teamLeads(s);
      const th = set.thresholds || {};
      return `<form class="form source-form" data-settings="linear" novalidate>
        <fieldset class="source-map">
          <legend>Team mapping</legend>
          ${Object.keys(map).map((team) => `<p class="source-map-row">
            <label for="ls-${esc(slug(team))}">${esc(team)}</label>
            <span aria-hidden="true">→</span>
            <select id="ls-${esc(slug(team))}" name="map-${esc(team)}">${keys.map((k) => `<option value="${esc(k)}"${map[team] === k ? ' selected' : ''}>${esc(k)}</option>`).join('')}</select>
            ${leads[team] ? `<span class="muted">(${esc(leads[team])})</span>` : ''}
          </p>`).join('')}
          <p class="help">Tasks with no owner go to the person in brackets.</p>
        </fieldset>
        <p>Approval: every task waits for a person.</p>
        <details class="source-details">
          <summary>Backlog check</summary>
          <p>A proposal ${esc(pct(th.comment ?? 0.75))} or more like an open issue becomes a comment; from ${esc(pct(th.flag_discovery ?? 0.55))} it's flagged for review (${esc(pct(th.flag_planning ?? 0.35))} on planning calls).</p>
        </details>
        <p class="source-save"><button class="btn btn-small" type="submit" data-key="settings-save">Save</button> <span class="chip-mark" data-dirty hidden>Unsaved changes</span></p>
      </form>`;
    }
    return `<p>Repository: <span class="mono">${esc(repoName())}</span></p><p>Branch: <span class="mono">${esc(set.branch || 'main')}</span></p>`;
  }

  function detailView(s) {
    const on = s.status === 'connected';
    const name = NAMES[s.id] || s.id;
    const hist = historyOf(s).map((h) => `<li>${esc(HISTORY_WORD[h.status] || h.status)} <span class="mono">${esc(BB.stamp(h.at))}</span></li>`).join('');
    const blocks = [
      // On Zoom's page the processing rules follow right away, with the advice the statement ends on elsewhere.
      ['What it does', `<p>${esc(DOES[s.id] ? DOES[s.id]() : '')}</p>${s.id === 'zoom' ? `<p class="source-statement">${esc(zoomStatement(s, { advice: false }))}</p>` : ''}`],
      ...(s.id === 'zoom' ? [['Processing rules', rulesHtml(), '<span class="soon-tag">Coming next</span>']] : []),
      ['Access', accessHtml(s)],
      ['Settings', settingsHtml(s)],
      ['Activity', `<p>${esc(activityOf(s).line)}</p>${hist ? `<ul class="source-history" aria-label="In this browser">${hist}</ul>` : ''}`],
    ];
    if (BB.isDemo) {
      blocks.push(['Connection', on
        ? `<p>${esc(DISCONNECT[s.id] ? DISCONNECT[s.id]() : '')}</p><p><button class="btn btn-small btn-ghost source-danger" type="button" data-disconnect="${esc(s.id)}" data-key="source-${esc(s.id)}-action">Disconnect ${esc(name)}</button></p>`
        : `<p>${esc(name)} is not connected, so nothing new comes in from it.</p><p><button class="btn btn-small" type="button" data-connect="${esc(s.id)}" data-key="source-${esc(s.id)}-action">Connect ${esc(name)}</button></p>`]);
    }
    const html = `<div class="source-sheet">${blocks.map(([k, body, tag]) => `<section class="source-block${tag ? ' is-soon' : ''}" aria-labelledby="sb-${slug(k)}">
        <h2 class="source-k" id="sb-${slug(k)}">${esc(k)}${tag ? ` ${tag}` : ''}</h2>
        <div class="source-body">${body}</div>
      </section>`).join('')}</div>`;
    show(name, html, {
      eyebrow: back,
      lede: statusLine(s),
      actions: BB.isDemo && !on ? `<button class="btn btn-small" type="button" data-connect="${esc(s.id)}" data-key="source-${esc(s.id)}-head">Connect ${esc(name)}</button>` : '',
    });
    wireCommon();
    wireSettings(s);
  }

  // ------------------------------------------------------------ settings, connect, disconnect

  function writeSource(id, patch, event) {
    const prev = BB.state.sources[id] && typeof BB.state.sources[id] === 'object' ? BB.state.sources[id] : {};
    const base = BB.effectiveSources().find((s) => s.id === id) || {};
    const at = BB.now();
    BB.state.sources[id] = {
      ...prev,
      status: patch.status || prev.status || base.status || 'connected',
      ...(patch.settings ? { settings: { ...(prev.settings || {}), ...patch.settings } } : {}),
      at,
      history: [...(Array.isArray(prev.history) ? prev.history : []), { status: event, at }].slice(-12),
    };
    BB.save();
  }

  function wireSettings(s) {
    const form = $(`[data-settings="${s.id}"]`);
    if (!form) return;
    const dirty = $('[data-dirty]', form);
    const initial = new FormData(form);
    const same = () => [...new FormData(form)].every(([k, v]) => initial.get(k) === v);
    form.addEventListener('input', () => { dirty.hidden = same(); });
    form.addEventListener('change', () => { dirty.hidden = same(); });
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const f = (n) => form.elements.namedItem(n);
      let settings;
      if (s.id === 'zoom') {
        const min = f('min_duration_min');
        const n = Number(min.value);
        const err = $('#zs-min-err');
        if (min.value.trim() === '' || !Number.isInteger(n) || n < 0 || n > 120) {
          err.textContent = 'Enter a whole number of minutes, from 0 to 120.';
          err.hidden = false;
          min.setAttribute('aria-invalid', 'true');
          min.focus();
          return;
        }
        err.hidden = true;
        min.removeAttribute('aria-invalid');
        const h = f('history').value;
        settings = { raw_retention: f('raw_retention').value, min_duration_min: n, history_import: { enabled: h !== 'off', days: h === 'off' ? ((s.settings.history_import || {}).days || 30) : Number(h) } };
      } else {
        const map = {};
        for (const team of Object.keys((s.settings && s.settings.team_mapping) || {})) map[team] = f(`map-${team}`).value;
        settings = { team_mapping: map };
      }
      writeSource(s.id, { settings }, 'settings');
      BB.refresh({ focus: '[data-key="settings-save"]' });
      // Managed service: the Backbrief team applies a change to the workspace before the next call.
      BB.toast('Saved. Backbrief applies it before your next call.', BB.DEMO_NOTE.browser);
    });
  }

  async function disconnect(id, trigger) {
    const name = NAMES[id];
    const ok = await BB.confirm({
      title: `Disconnect ${name}?`,
      text: DISCONNECT[id](),
      confirm: 'Disconnect',
      cancel: 'Cancel',
      danger: true,
      trigger,
    });
    if (!ok) return;
    writeSource(id, { status: 'not_connected' }, 'not_connected');
    await BB.refresh();
    BB.toast(`${name} disconnected.`, BB.DEMO_NOTE.browser);
  }

  function connectStep(s, step, values) {
    const name = NAMES[s.id];
    const steps = ['Access', `Approve in ${name}`, 'One setting'];
    const head = `<ol class="stepper source-steps" aria-label="Connect ${esc(name)}: step ${step} of 3">${steps.map((x, i) => `<li class="${i + 1 < step ? 'is-done' : i + 1 === step ? 'is-current' : ''}"${i + 1 === step ? ' aria-current="step"' : ''}><span class="dot">${i + 1}</span> <span class="step-label">${esc(x)}</span></li>`).join('')}</ol>`;
    if (step === 1) {
      // A managed service: connecting is a step of the setup call, not a self-serve sign-in.
      return `${head}<p class="source-step-h" tabindex="-1" data-step-h>In your workspace we connect this with you on the setup call. This is what ${esc(name)} asks ${esc(ADMIN[s.id] || 'an admin')} to approve:</p>${accessHtml(s)}`;
    }
    if (step === 2) {
      const reasons = accessOf(s).map((r) => `<li>${esc(r.why)}</li>`).join('');
      return `${head}<p class="source-step-h" tabindex="-1" data-step-h>In the demo, this stands in for ${esc(name)}'s approval screen.</p>
        <div class="win source-standin">
          <div class="win-bar"><span class="win-app">${esc(name)}</span><span class="win-path">Stand-in · approval screen</span></div>
          <div class="win-body">
            <p><strong>Backbrief</strong> would like to:</p>
            <ul class="plain-list">${reasons}</ul>
            ${s.account ? `<p class="small muted">Account: <span class="mono">${esc(s.account)}</span></p>` : ''}
          </div>
        </div>`;
    }
    let field = '';
    if (s.id === 'zoom') {
      field = `<div class="field"><label for="cs-min">Skip calls shorter than</label>
        <p class="source-inline"><input id="cs-min" name="min" type="number" inputmode="numeric" min="0" max="120" step="1" value="${esc(values.min)}" aria-describedby="cs-min-err"> <span>minutes</span></p>
        <p class="error" id="cs-min-err" role="alert" hidden></p></div>`;
    } else if (s.id === 'slack') {
      const st = BB.cached('settings');
      const chans = (st && st.slack && st.slack.channels_available) || [values.channel];
      field = `<div class="field"><label for="cs-chan">Default channel</label>
        <select id="cs-chan" name="channel">${chans.map((c) => `<option value="${esc(c)}"${values.channel === c ? ' selected' : ''}>${esc(c)}</option>`).join('')}</select>
        <p class="help">For cross-team calls and teams without their own channel. Invite @Backbrief to a channel before choosing it.</p></div>`;
    } else if (s.id === 'linear') {
      const map = values.map;
      const keys = [...new Set(Object.values(map))];
      field = `<fieldset class="source-map"><legend>Team mapping</legend>${Object.keys(map).map((team) => `<p class="source-map-row">
          <label for="cs-${esc(slug(team))}">${esc(team)}</label><span aria-hidden="true">→</span>
          <select id="cs-${esc(slug(team))}" name="map-${esc(team)}">${keys.map((k) => `<option value="${esc(k)}"${map[team] === k ? ' selected' : ''}>${esc(k)}</option>`).join('')}</select></p>`).join('')}</fieldset>`;
    } else {
      field = `<fieldset><legend>Choose the repository</legend>
        <label class="check"><input type="radio" name="repo" value="existing"${values.repo !== 'new' ? ' checked' : ''}> <span class="mono">${esc(repoName())}</span></label>
        <label class="check"><input type="radio" name="repo" value="new"${values.repo === 'new' ? ' checked' : ''}> Create a new private repository</label>
        <p class="help">In the demo, the record stays in ${esc(repoName())} either way.</p></fieldset>`;
    }
    return `${head}<p class="source-step-h" tabindex="-1" data-step-h>One setting to finish.</p><div class="form">${field}</div>`;
  }

  function connectDialog(id, trigger) {
    const s = BB.effectiveSources().find((x) => x.id === id);
    if (!s) return;
    const name = NAMES[id];
    const set = s.settings || {};
    const sl = BB.effectiveSlack();
    const values = {
      min: set.min_duration_min ?? 5,
      channel: sl.channel || '#call-digests',
      map: { ...(set.team_mapping || {}) },
      repo: 'existing',
    };
    let step = 1;
    const labels = ['', `Continue to ${name}`, 'Approve', 'Finish'];
    const read = (h) => {
      const f = (n) => h.body.querySelector(`[name="${n}"]`);
      if (step !== 3) return true;
      if (id === 'zoom') {
        const n = Number(f('min').value);
        const err = h.body.querySelector('#cs-min-err');
        if (f('min').value.trim() === '' || !Number.isInteger(n) || n < 0 || n > 120) {
          err.textContent = 'Enter a whole number of minutes, from 0 to 120.';
          err.hidden = false;
          f('min').setAttribute('aria-invalid', 'true');
          f('min').focus();
          return false;
        }
        values.min = n;
      } else if (id === 'slack') values.channel = f('channel').value;
      else if (id === 'linear') for (const team of Object.keys(values.map)) values.map[team] = f(`map-${team}`).value;
      else values.repo = (h.body.querySelector('[name="repo"]:checked') || {}).value || 'existing';
      return true;
    };
    const paint = (h) => {
      h.body.innerHTML = connectStep(s, step, values);
      h.button(0).textContent = labels[step];
      h.button(1).hidden = step === 1;
      const t = h.body.querySelector('[data-step-h]');
      if (t) t.focus();
    };
    const h = BB.dialog({
      title: `Connect ${name}`,
      html: connectStep(s, 1, values),
      trigger,
      returnFocus: () => $(`[data-key="source-${id}-action"]`),
      actions: [
        {
          label: labels[1],
          onClick: async (dlg) => {
            if (step < 3) { step++; paint(dlg); return false; }
            if (!read(dlg)) return false;
            dlg.busy(`Connecting to ${name}…`);
            await wait(reducedMotion() ? 200 : 900);
            return true;
          },
        },
        { label: 'Back', cancel: true, onClick: (dlg) => { if (step === 3) read(dlg); step = Math.max(1, step - 1); paint(dlg); return false; } },
        { label: 'Cancel', cancel: true },
      ],
      onOpen: (dlg) => { dlg.button(1).hidden = true; },
    });
    h.result.then(async (ok) => {
      if (ok !== true) return;
      const settings = {};
      if (id === 'zoom') settings.min_duration_min = values.min;
      if (id === 'linear') settings.team_mapping = values.map;
      if (id === 'slack' && values.channel !== sl.channel) {
        // The default channel is Slack delivery's setting too: keep the two in step.
        const teams = new Set([...Object.keys(sl.per_team_channels || {}), ...Object.keys((BB.effectiveSources().find((x) => x.id === 'linear') || { settings: {} }).settings.team_mapping || {})]);
        BB.state.channels = { default: values.channel, ...Object.fromEntries([...teams].map((t) => [t, (sl.per_team_channels || {})[t] || null])) };
      }
      writeSource(id, { status: 'connected', ...(Object.keys(settings).length ? { settings } : {}) }, 'connected');
      // From the page head the button goes away: focus the page title instead of a button far below.
      const fromHead = trigger && trigger.dataset && /-head$/.test(trigger.dataset.key || '');
      await BB.refresh({ focus: () => (fromHead ? $('[data-view-title]') : $(`[data-key="source-${id}-action"]`)) });
      BB.toast(`${name} connected${s.account ? `: ${s.account}` : ''}.`, BB.DEMO_NOTE.connection);
    });
  }

  // ------------------------------------------------------------ imports

  const FORMATS = /\.(vtt|txt|md)$/i;
  const MAX_BYTES = 10 * 1024 * 1024;
  const kb = (bytes) => (bytes / 1024).toLocaleString('en-GB', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

  function importFormHtml(prefix) {
    const st = BB.cached('settings');
    const kinds = [...((st && st.imports) || ['Granola export', 'Fireflies export']), 'Other: .vtt, .txt or .md'];
    return `<div class="form import-form" data-import-form="${prefix}">
      <fieldset>
        <legend>Source</legend>
        ${kinds.map((k, i) => `<label class="check"><input type="radio" name="${prefix}-source" value="${esc(k.startsWith('Other') ? 'Other' : k)}"${i === 0 ? ' checked' : ''}> ${esc(k)}</label>`).join('')}
      </fieldset>
      <div class="field">
        <label for="${prefix}-file">File</label>
        <input id="${prefix}-file" name="${prefix}-file" type="file" accept=".vtt,.txt,.md,text/vtt,text/plain,text/markdown" aria-describedby="${prefix}-file-help ${prefix}-file-err">
        <p class="help" id="${prefix}-file-help">Counted in your browser: nothing is uploaded, and the text is never shown.</p>
        <p class="import-picked" data-picked aria-live="polite"></p>
        <p class="error" id="${prefix}-file-err" role="alert" hidden></p>
      </div>
    </div>`;
  }

  /** Wire a file input: count lines and size in the browser. Returns () => {name, lines, size, source} or null. */
  function wireImport(root, prefix) {
    const input = $(`#${prefix}-file`, root);
    const out = $('[data-picked]', root);
    const err = $(`#${prefix}-file-err`, root);
    let picked = null;
    let seq = 0;
    const fail = (msg) => {
      picked = null;
      out.textContent = '';
      err.textContent = msg;
      err.hidden = !msg;
      if (msg) input.setAttribute('aria-invalid', 'true'); else input.removeAttribute('aria-invalid');
    };
    input.addEventListener('change', async () => {
      const my = ++seq;
      const file = input.files && input.files[0];
      fail('');
      if (!file) return;
      if (!FORMATS.test(file.name)) { fail('Use a .vtt, .txt or .md file.'); return; }
      if (file.size > MAX_BYTES) { fail('That file is over 10 MB.'); return; }
      out.textContent = `Reading ${file.name}…`;
      let lines = 0;
      try {
        // Read only to count lines; the text goes no further than this function.
        const text = await file.text();
        lines = text === '' ? 0 : text.split(/\r\n|\r|\n/).length - (/(\r\n|\r|\n)$/.test(text) ? 1 : 0);
      } catch {
        if (my === seq) fail("That file couldn't be read.");
        return;
      }
      if (my !== seq) return;
      picked = { name: file.name, lines, size: file.size };
      out.textContent = `${file.name} · ${plural(lines, 'line')} · ${kb(file.size)} KB`;
    });
    return () => {
      if (!picked) { fail(err.textContent || 'Choose a file to import.'); input.focus(); return null; }
      const src = $(`[name="${prefix}-source"]:checked`, root);
      return { ...picked, source: src ? src.value : 'Other' };
    };
  }

  function saveImport(x) {
    BB.state.imports = [...BB.state.imports, { name: x.name, source: x.source, lines: x.lines, size: x.size, at: BB.now() }];
    BB.save();
    BB.toast(`In your workspace, ${x.name} would be filed as a call with its digest.`, 'Demo · the file stayed in your browser.');
  }

  function importDialog(trigger) {
    let take = null;
    const h = BB.dialog({
      title: 'Import a transcript',
      html: `<p class="small muted">A call recorded before Backbrief, or another notetaker's export, becomes a call with its digest and task proposals.</p>${importFormHtml('imp')}`,
      trigger,
      actions: [
        {
          label: 'Import',
          onClick: async (dlg) => {
            const x = take && take();
            if (!x) return false;
            dlg.busy('Importing…');
            await wait(500);
            saveImport(x);
            return true;
          },
        },
        { label: 'Cancel', cancel: true },
      ],
      onOpen: (dlg) => { take = wireImport(dlg.body, 'imp'); },
    });
    h.result.then((ok) => { if (ok) BB.refresh(); });
  }

  function importsView() {
    const st = BB.cached('settings');
    const kinds = (st && st.imports) || ['Granola export', 'Fireflies export'];
    const mine = BB.isDemo ? [...BB.state.imports].reverse() : [];
    const list = mine.length
      ? `<ul class="source-imports">${mine.map((x) => `<li><span class="source-imports-name">${esc(x.name)}</span>
          <span class="mono small muted">${esc([x.source, plural(Number(x.lines) || 0, 'line'), `${kb(Number(x.size) || 0)} KB`, BB.stamp(x.at)].join(' · '))}</span></li>`).join('')}</ul>`
      : '';
    const blocks = [
      ['What it does', '<p>Brings in calls recorded before Backbrief, or exported from another notetaker. Each file becomes a call with its digest and task proposals, filed like a recorded one.</p>'],
      ['Formats', `<p>${esc([...kinds, '.vtt, .txt or .md'].join(' · '))}</p>`],
      ['Import', BB.isDemo
        ? `<form class="import-page" data-import-page novalidate>${importFormHtml('impp')}<p><button class="btn btn-small" type="submit" data-key="import-go">Import</button></p></form>`
        : `<p class="muted">${BB.managed()}</p>`],
    ];
    if (BB.isDemo && list) blocks.push(['Imported here', list]);
    show('Import a transcript', `<div class="source-sheet">${blocks.map(([k, body]) => `<section class="source-block" aria-labelledby="sb-${slug(k)}">
        <h2 class="source-k" id="sb-${slug(k)}">${esc(k)}</h2><div class="source-body">${body}</div></section>`).join('')}</div>`, {
      eyebrow: back,
      lede: 'Granola and Fireflies exports, or any transcript as .vtt, .txt or .md.',
    });
    const form = $('[data-import-page]');
    if (!form) return;
    const take = wireImport(form, 'impp');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = $('[data-key="import-go"]', form);
      if (btn.getAttribute('aria-disabled') === 'true') return;
      const x = take();
      if (!x) return;
      btn.setAttribute('aria-disabled', 'true');
      btn.textContent = 'Importing…';
      const at = location.hash;
      await wait(500);
      if (location.hash !== at) return;
      saveImport(x);
      BB.refresh({ focus: '[data-key="import-go"]' });
    });
  }

  // ------------------------------------------------------------ shared wiring

  function wireCommon() {
    const scope = document.querySelector('[data-view]');
    const head = document.querySelector('[data-view-actions]');
    for (const root of [scope, head]) {
      if (!root) continue;
      for (const b of $$('[data-connect]', root)) b.addEventListener('click', () => connectDialog(b.dataset.connect, b));
      for (const b of $$('[data-disconnect]', root)) b.addEventListener('click', () => disconnect(b.dataset.disconnect, b));
      for (const b of $$('[data-import]', root)) b.addEventListener('click', () => importDialog(b));
      for (const b of $$('[data-request]', root)) b.addEventListener('click', () => requestDialog(b.dataset.request, b.dataset.label, b));
    }
  }

  /** The header's own Book a demo link: the static bundles rewrite that href, so reuse it as it is. */
  function bookHref() {
    if (typeof BB.bookHref === 'function') return BB.bookHref();
    const a = document.querySelector('.app-actions a.btn[href]');
    const raw = a ? a.getAttribute('href') : null;
    return (raw && (BB.safeUrl(raw) || (/^mailto:/i.test(raw) ? raw : null))) || '/book';
  }

  // Requests whose dialog says more than "X is coming next".
  const REQUESTS = {
    [RULES_KEY]: {
      title: 'Ask for early access',
      text: "Processing rules are coming next: skip calls by title or host, hold a digest for review, and show a call only to its participants. They aren't live yet. Tell us on a 30-minute demo call which calls must stay out; requests decide what we build next.",
      done: 'Early access requested: processing rules.',
    },
  };

  /** Request a coming-next tool: the way in is a demo call; "Mark as requested" keeps the demo's record. */
  function requestDialog(key, label, trigger) {
    const verb = key === 'context-repositories' ? 'are' : 'is';
    const r = REQUESTS[key] || {};
    const h = BB.dialog({
      title: r.title || `Request ${label}`,
      html: `<p class="source-request-text">${esc(r.text || `${label} ${verb} coming next. Tell us on a 30-minute demo call; requests decide what we connect next.`)}</p>`,
      trigger,
      className: 'source-request',
      // Both buttons are secondary (type="button"): the primary action is the Book a demo link.
      actions: [
        {
          label: 'Mark as requested',
          cancel: true,
          value: true,
          onClick: () => {
            BB.state.requests = { ...BB.state.requests, [key]: BB.now() };
            BB.save();
            return true;
          },
        },
        { label: 'Close', cancel: true },
      ],
      onOpen: (dlg) => {
        dlg.button(0).insertAdjacentHTML('beforebegin', `<a class="btn btn-small" href="${esc(bookHref())}" data-book-demo>Book a demo</a>`);
        const link = $('[data-book-demo]', dlg.el);
        if (link) link.focus();
      },
    });
    h.result.then((ok) => {
      if (ok !== true) return;
      BB.refresh({ focus: `[data-key="req-${slug(key)}"]` });
      BB.toast(r.done || `${label} requested.`, BB.DEMO_NOTE.browser);
    });
  }

  BB.route('sources', async (parts, query, ctx) => {
    const [id] = parts;
    // The latest call's Slack timing feeds the health lines (demo); without it they fall back to the call's end.
    const last = BB.isDemo ? latestCall() : null;
    if (last && BB.cached(`call:${last.id}`) === undefined) {
      await BB.load(`call:${last.id}`).catch(() => null);
      if (ctx.stale()) return;
    }
    if (!id) { listView(); return; }
    if (id === 'imports') { importsView(); return; }
    const s = BB.effectiveSources().find((x) => x.id === id);
    if (!s) { BB.go('#/sources', { replace: true }); return; }
    detailView(s);
  }, { nav: 'sources', title: 'Sources', needs: ['workspace', 'settings', 'people?'] });
})();
