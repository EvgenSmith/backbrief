// SPDX-License-Identifier: MIT
/*
 * cabinet-sources.js — Sources (spec §3.10): a ruled ledger of what
 * Backbrief reads from and writes to (call recordings, chat, tracker, the
 * record repository, context repositories, imports, what comes next), and a
 * page per source: status, what it does, access with a reason for each
 * permission, settings, activity, disconnect. In the demo, Connect walks the
 * three steps a new customer sees, with a stand-in for the OAuth approval;
 * every change goes to the overlay (sources, requests, imports). Styles live
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
  const back = '<a href="#/sources">← Sources</a>';

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
  const SLACK_GROUPS = [
    ['Post messages and threads', ['chat:write', 'chat:write.public']],
    ['Message the owner if a call fails', ['im:write']],
    ['Match people by email', ['users:read', 'users:read.email']],
    ['Find channels', ['channels:read', 'groups:read']],
    ['Read thread replies for corrections', ['channels:history', 'groups:history']],
    ['Reactions', ['reactions:read', 'reactions:write']],
  ];
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
    const events = s.id === 'zoom' ? ((s.events && s.events.length ? s.events : Object.keys(ZOOM_EVENTS)).map((e) => ZOOM_EVENTS[e] || e)) : [];
    return `<ul class="access">${rows}</ul>${events.length ? `<p class="access-events"><span class="access-k">Events</span> ${esc(events.join(' · '))}</p>` : ''}`;
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
      if (chans.length) parts.push(`<span class="mono">${esc([...new Set(chans)].join(', '))}</span>`);
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
    return `<li class="source-row${on ? '' : ' is-off'}">
      <p class="source-cat">${esc(CATEGORY[s.id] || '')}</p>
      <div class="source-what">
        <p class="source-title"><a href="${esc(href('sources', s.id))}">${esc(name)}</a></p>
        <p class="source-state${on ? '' : ' is-off'}"><span class="status-dot${on ? '' : ' is-off'}" aria-hidden="true"></span>${on ? 'Connected' : 'Not connected'}</p>
      </div>
      <p class="source-detail">${sourceDetailLine(s)}</p>
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
    BB.render('Sources', `${setupStrip()}<ul class="ruled source-list" aria-label="Sources">${rows.join('')}</ul>${BB.isDemo ? '' : `<p class="small muted source-managed">${BB.managed()}</p>`}`, 'sources', {
      eyebrow: esc(`${on} of ${sources.length} connected${BB.isDemo ? ` · records to ${repoName()}` : ''}`),
      lede,
    });
    wireCommon();
  }

  // ------------------------------------------------------------ a source

  function statusLine(s) {
    const on = s.status === 'connected';
    const bits = [on ? 'Connected' : 'Not connected'];
    if (BB.isDemo && s.account) bits.push(`<span class="mono">${esc(s.account)}</span>`);
    if (on && s.connected_at) {
      const again = historyOf(s).filter((x) => x.status === 'connected').pop();
      bits.push(again ? `connected again ${esc(BB.stamp(again.at, ' '))}` : `since ${esc(BB.fmtDate(s.connected_at))}`);
    }
    if (!on) {
      const h = historyOf(s).filter((x) => x.status === 'not_connected').pop();
      if (h) bits.push(`disconnected ${esc(BB.stamp(h.at, ' '))}`);
    }
    return `<p class="source-status${on ? '' : ' is-off'}"><span class="status-dot${on ? '' : ' is-off'}" aria-hidden="true"></span>${bits.join(' · ')}</p>`;
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
      const sl = BB.effectiveSlack();
      const per = Object.entries(sl.per_team_channels || {}).filter(([, v]) => v);
      return `<p>After each call: ${esc(BB.deliveryPhrase(sl.delivery || {}))}.</p>
        <p>Posted in <span class="mono">${esc(sl.channel || '#call-digests')}</span>${per.length ? `; ${per.map(([t, c]) => `${esc(t)} calls in <span class="mono">${esc(c)}</span>`).join(', ')}` : ''}.</p>
        <p class="source-link">What gets posted and where: <a href="#/tasks/slack">Action items › Slack delivery</a></p>`;
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
      ['What it does', `<p>${esc(DOES[s.id] ? DOES[s.id]() : '')}</p>`],
      ['Access', accessHtml(s)],
      ['Settings', settingsHtml(s)],
      ['Activity', `<p>${esc(activityOf(s).line)}</p>${hist ? `<ul class="source-history" aria-label="In this browser">${hist}</ul>` : ''}`],
    ];
    if (BB.isDemo) {
      blocks.push(['Connection', on
        ? `<p>${esc(DISCONNECT[s.id] ? DISCONNECT[s.id]() : '')}</p><p><button class="btn btn-small btn-ghost source-danger" type="button" data-disconnect="${esc(s.id)}" data-key="source-${esc(s.id)}-action">Disconnect ${esc(name)}</button></p>`
        : `<p>${esc(name)} is not connected, so nothing new comes in from it.</p><p><button class="btn btn-small" type="button" data-connect="${esc(s.id)}" data-key="source-${esc(s.id)}-action">Connect ${esc(name)}</button></p>`]);
    }
    const html = `<div class="source-sheet">${blocks.map(([k, body]) => `<section class="source-block" aria-labelledby="sb-${slug(k)}">
        <h2 class="source-k" id="sb-${slug(k)}">${esc(k)}</h2>
        <div class="source-body">${body}</div>
      </section>`).join('')}</div>`;
    BB.render(name, html, 'sources', {
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
      BB.toast(`${NAMES[s.id]} settings saved. They apply from the next call.`, BB.DEMO_NOTE.browser);
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
      return `${head}<p class="source-step-h" tabindex="-1" data-step-h>Backbrief will ask ${esc(name)} for:</p>${accessHtml(s)}
        <p class="small muted">You approve this in ${esc(name)}${s.id === 'zoom' || s.id === 'slack' ? ' as an account admin' : ''}.</p>`;
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
            await wait(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 200 : 900);
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
      : '<p class="muted">Nothing imported in this browser yet.</p>';
    const blocks = [
      ['What it does', '<p>Brings in calls recorded before Backbrief, or exported from another notetaker. Each file becomes a call with its digest and task proposals, filed like a recorded one.</p>'],
      ['Formats', `<p>${esc([...kinds, '.vtt, .txt or .md'].join(' · '))}</p>`],
      ['Import', BB.isDemo
        ? `<form class="import-page" data-import-page novalidate>${importFormHtml('impp')}<p><button class="btn btn-small" type="submit" data-key="import-go">Import</button></p></form>`
        : `<p class="muted">${BB.managed()}</p>`],
    ];
    if (BB.isDemo) blocks.push(['Imported here', list]);
    BB.render('Import a transcript', `<div class="source-sheet">${blocks.map(([k, body]) => `<section class="source-block" aria-labelledby="sb-${slug(k)}">
        <h2 class="source-k" id="sb-${slug(k)}">${esc(k)}</h2><div class="source-body">${body}</div></section>`).join('')}</div>`, 'sources', {
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
      for (const b of $$('[data-request]', root)) {
        b.addEventListener('click', () => {
          const key = b.dataset.request;
          BB.state.requests = { ...BB.state.requests, [key]: BB.now() };
          BB.save();
          BB.refresh({ focus: `[data-key="req-${slug(key)}"]` });
          BB.toast(`${b.dataset.label} requested.`, BB.DEMO_NOTE.browser);
        });
      }
    }
  }

  BB.route('sources', (parts) => {
    const [id] = parts;
    if (!id) { listView(); return; }
    if (id === 'imports') { importsView(); return; }
    const s = BB.effectiveSources().find((x) => x.id === id);
    if (!s) { BB.go('#/sources', { replace: true }); return; }
    detailView(s);
  }, { nav: 'sources', title: 'Sources', needs: ['workspace', 'settings', 'people?'] });
})();
