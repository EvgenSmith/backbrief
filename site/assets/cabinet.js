// SPDX-License-Identifier: MIT
/*
 * cabinet.js — the workspace shell and its core, exposed as window.BB.
 *
 * One shell, two data sources:
 *   /demo  static JSON built from site/demo-vault (a fictional team). Demo
 *          actions write to an overlay kept in this browser (BB.state).
 *   /app   /api/* for a signed-in workspace, read from its vault. Read-only:
 *          an action with no API behind it is not rendered at all.
 *
 * Modules plug in through BB. They load after this file as deferred scripts,
 * in this order, and register their routes while they load:
 *   cabinet-tasks.js    Action items (task log, open items, review history,
 *                       Slack delivery) and the proposal cards in call detail
 *   cabinet-people.js   People, profiles, Add person
 *   cabinet-memory.js   Company memory
 *   cabinet-sources.js  Sources
 * The first route runs on DOMContentLoaded, once every module is in.
 *
 * Escaping rules
 *   - Everything from the vault, the API or the overlay is untrusted text. It
 *     reaches the page only through esc() (plain text) or inline()/md()
 *     (escape first, then a small markdown subset). Build HTML strings from
 *     escaped values only; never put raw content into innerHTML.
 *   - URLs go through safeUrl(): http(s), a same-origin path or a #hash.
 *   - CSP is 'self': no inline scripts or on* attributes, no style attributes
 *     and no el.style writes (use classes and `hidden`), no other origin.
 *
 * ----------------------------------------------------------------- BB API
 * Full notes and examples: core-api.md. Functions that return markup return
 * HTML strings built from escaped values.
 *
 * Basics
 *   BB.mode 'demo'|'app'   BB.isDemo   BB.contact (email for /app notes)
 *   BB.API                 {me, workspace, people, vault, settings, call(id),
 *                          transcript(id)}; vault, settings and transcript are
 *                          null in /app (no endpoint yet)
 *   BB.esc(s)  BB.safeUrl(u)  BB.inline(text, {call})  BB.md(text, {call})
 *       inline/md: `code`, **bold**, _em_, _[high]_ → priority, [t](url), and
 *       (mm:ss) → BB.ts(call, mm:ss) when {call: id} is passed
 *   BB.fmtDate(d, t) '19 Oct 2026, 10:00'   BB.fmtDay(d) '19 Oct'
 *   BB.now() ISO time. The demo runs on its own clock: workspace.demo_now
 *     (Mon 19 Oct 2026, 11:05 Europe/London) plus the time since the page
 *     loaded, never past that day. BB.clock and BB.stamp follow it.
 *   BB.clock(iso = now) '10:44' in the workspace timezone   BB.today() '2026-10-19' (the demo's day)
 *   BB.stamp(iso, sep?) 'today, 14:07' (else '19 Oct, 14:07'), in the workspace timezone
 *   BB.plural(n, one, many?)   BB.joinAnd(list)   BB.initials(name)
 *   BB.href(...segments, query?)  '#/call/<id>/transcript/16:40', '#/calls?team=product'
 *   BB.verdict(v)  BB.prio(p)  BB.ref(r)  BB.teamChip(t)  BB.person(lastname)
 *     verdict: DUPLICATE reads "Already tracked" on a neutral chip
 *   BB.ts(callId, mmss)    '▶ 16:40' → #/call/<id>/transcript/16:40, labelled
 *                          "Transcript at 16:40"; plain '(16:40)' when nothing
 *                          can be opened
 *   BB.callRow(call, {compact, after})  BB.loading(what)  BB.emptyState(html)  BB.managed()
 *   BB.decisionRow(decision)  one workspace.decisions[] entry as a ledger row
 *   BB.isOpenItem(item)  still owed: `open` from the build (post-call, not closed
 *     by a later call, latest row for its issue); post-call on older data
 *   BB.bookHref()  the header's "Book a demo" href, as the page was built
 *   BB.deliveryPhrase(delivery)  'summary, transcript link and task log'
 *   BB.DEMO_NOTE.{linear, slack, github, browser, connection}  toast line 2
 *
 * Data
 *   BB.load(key) → Promise, cached per page load. Keys: 'workspace', 'people',
 *     'vault', 'settings', 'call:<id>', 'transcript:<id>'. Resolves null where
 *     /app has no endpoint; a call outside the workspace rejects (status 404).
 *   BB.cached(key) → the loaded value, or undefined   BB.workspace() = cached('workspace')
 *
 * Router  (hash routes: #/<a>/<b>?<query>)
 *   BB.route(prefix, handler, opts)  prefix 'calls', 'call', 'tasks', 'tasks/open'…
 *     ('' is Overview, where unknown routes go). Longest matching prefix
 *     wins; registering a prefix again replaces it.
 *     handler(parts, query, ctx): parts = decoded segments after the prefix,
 *       query = plain object, ctx = {stale(), render(...)} for async work.
 *     opts: {nav, title, loading, needs, notFound}. needs = keys (or
 *       (parts, query) => keys) loaded before the handler runs; 'people?'
 *       marks one optional (null on failure). Default ['workspace'].
 *   BB.render(title, html, navKey?, {eyebrow, lede, actions, focus})
 *     eyebrow/lede/actions are HTML; focus = selector, element or function.
 *     The first render after a route change moves focus to the h1 (or focus).
 *   BB.go(hash, {replace})   BB.current {prefix, parts, query, hash, nav}
 *   BB.setLeaveGuard(fn)     fn(toHash, fromHash) → truthy (or a sentence) to
 *     ask "Leave without saving?"; dropped when the route prefix changes.
 *
 * Demo state (spec §3.12): BB.state, kept in localStorage["backbrief.demo.v1"]
 *   {v, decisions, edits, log_sent, delivery, channels, people_added,
 *    zone_reviews, sources, requests, imports, prefs}; memory only if storage
 *   fails. prefs {viewing_as, tour_hidden} are view choices: Reset demo clears
 *   them, but they are not counted as changes.
 *   Mutate it, then BB.save(); then BB.refresh() to re-render.
 *   BB.save()  BB.reset()  BB.changeCount()  BB.storage 'local'|'memory'|'none'
 *   BB.decide(key, {action, result, ref, reason, edited, edit_summary})
 *   Selectors (read-only results; copy before sorting):
 *     BB.effectiveProposals()        task_log entries with the overlay applied
 *     BB.effectiveProposals(callId)  one entry, or null
 *     BB.effectiveActionItems(callId?)  workspace.action_items with the reviews
 *       made here: an approval moves the commitment at the proposal's minute to
 *       its edited title, owner and priority and gives it the issue key; a
 *       created issue with no commitment there adds an open item; a skip takes
 *       the item out of the open ones (review.status 'skipped')
 *     BB.openItemsFor(lastname)  one person's effective open items (null: no owner)
 *     BB.effectiveStats()  BB.effectivePeople()
 *     BB.effectiveSources()  BB.effectiveSlack()  BB.waitingCount()
 *     BB.taskLogOn()  Slack delivery's Task log switch (on by default): each
 *       review then updates the call's thread in place, so nothing is posted by hand
 *     BB.threadNote(entry, {cls, topic})  "Updated in the call's Slack thread ·
 *       today 11:06" after a review made here while the task log is on, else ''
 *     BB.effectiveMetrics()  overview.metrics recomputed with the reviews made
 *       here: {decisions, reviews, verdict_agreement, duplicates_prevented,
 *       time_to_decision, owner_coverage, processing}
 *     BB.viewingAs()  the lastname Overview is viewing as, or '' for everyone
 *   BB.refresh({focus}) re-renders the current view, the nav count and the
 *     header's "Reset demo · N changes".
 *
 * UI kit
 *   BB.toast(line1, line2, {action: {label, run}})  one at a time (a new toast
 *     replaces the current one), 4 s; with an action (e.g. Undo) the button
 *     shows and the toast stays 10 s. Pauses on hover and focus; a compact
 *     bottom bar on phones that keeps the focused element in view.
 *   BB.dialog({title, html, actions, wide, onOpen, onClose, trigger, returnFocus})
 *     → {el, body, result: Promise, close(value), busy(label|false)}; native
 *     <dialog>, Esc closes, focus returns to the trigger. actions: [{label,
 *     value, primary, cancel, busy: 'Posting…', onClick(handle) → false keeps
 *     it open}], or a link: {label, href, primary} renders <a class="btn">;
 *     following it closes the dialog (value: 'link') and opens the href
 *   BB.confirm({title, text|html, confirm, cancel, danger}) → Promise<boolean>
 *   BB.tabs(items, currentKey, {label})  items: [{key, href, label, count, mark}]
 *
 * Hooks and events
 *   BB.hooks.callAside(call, el)  render call detail's "Task proposals" into
 *     el (#proposals); runs after every render of the call view. Until a module
 *     sets it, the core lists the proposals with a link to Action items.
 *   BB.hooks.sendLog(callId, trigger)  open "Post reviews to Slack"; Overview's
 *     button calls it (without it, the button opens the task log). The button
 *     shows only while the task log is off (BB.taskLogOn())
 *   BB.hooks.slackThread(call, el)  render the call's Slack thread into el;
 *     call detail shows a "Slack thread" tab (#/call/<id>/slack) when it is set
 *   BB.on('state' | 'reset' | 'route', fn) → unsubscribe function
 */
(() => {
  'use strict';

  // ================================================================ basics
  const body = document.body;
  const mode = body.dataset.mode === 'app' ? 'app' : 'demo';
  const isDemo = mode === 'demo';
  const contact = body.dataset.contact || '';
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  const API = Object.freeze(isDemo
    ? {
      me: null,
      workspace: '/demo/workspace.json',
      people: '/demo/people.json',
      vault: '/demo/vault.json',
      settings: '/demo/settings.json',
      call: (id) => `/demo/calls/${encodeURIComponent(id)}.json`,
      transcript: (id) => `/demo/transcripts/${encodeURIComponent(id)}.json`,
    }
    : {
      me: '/api/me',
      workspace: '/api/workspace',
      people: '/api/people',
      vault: null,
      settings: null,
      call: (id) => `/api/call?id=${encodeURIComponent(id)}`,
      transcript: null,
    });

  const ui = {
    title: $('[data-view-title]'),
    eyebrow: $('[data-view-eyebrow]'),
    actions: $('[data-view-actions]'),
    lede: $('[data-view-lede]'),
    view: $('[data-view]'),
    navCount: $('[data-nav-count]'),
    nav: $('.app-nav'),
    navMenu: $('[data-nav-menu]'),
    navMenuCur: $('[data-nav-menu-cur]'),
    navMenuCount: $('[data-nav-menu-count]'),
    reset: $('[data-reset]'),
    banner: $('[data-demo-banner]'),
    wsName: $('[data-ws-name]'),
    user: $('[data-user]'),
    toasts: $('[data-toasts]'),
    menuBtn: $('[data-menu-btn]'),
    menu: $('[data-menu]'),
    menuReset: $('[data-menu-reset]'),
    menuTour: $('[data-menu-tour]'),
    menuUser: $('[data-menu-user]'),
  };
  for (const n of $$(isDemo ? '[data-app-only]' : '[data-demo-only]')) n.hidden = true;
  const loadedAt = Date.now();

  // ================================================================ helpers
  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
  const safeUrl = (u) => (typeof u === 'string' && /^(https?:\/\/|\/(?!\/)|#)/i.test(u) ? u : null);
  const dec = (s) => { try { return decodeURIComponent(s); } catch { return s; } };

  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const pad = (n) => String(n).padStart(2, '0');
  const ymd = (d) => { const m = String(d || '').match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? [+m[1], +m[2], +m[3]] : null; };
  const fmtDay = (d) => { const p = ymd(d); return p ? `${p[2]} ${MONTHS[p[1] - 1]}` : ''; };
  const fmtDate = (d, t) => {
    const p = ymd(d);
    if (!p) return '';
    const s = `${p[2]} ${MONTHS[p[1] - 1]} ${p[0]}`;
    return t ? `${s}, ${t}` : s;
  };
  const toSeconds = (mmss) => { const m = String(mmss || '').match(/^(\d{1,3}):(\d{2})$/); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };

  // ---------------------------------------------------------------- clock
  // The demo tells one Monday: it starts at workspace.demo_now (19 Oct 2026,
  // 11:05 Europe/London) and runs on from page load, but never past that day,
  // so nothing in it is ever dated by the visitor's real clock. /app uses the
  // real clock.
  let demoBase = null;
  function demoClock() {
    if (!isDemo) return null;
    const w = workspace();
    const iso = w && w.workspace && w.workspace.demo_now;
    const at = iso ? Date.parse(iso) : NaN;
    if (!Number.isFinite(at)) return null;
    if (!demoBase || demoBase.iso !== iso) {
      const hm = clock(iso).match(/^(\d{2}):(\d{2})$/);
      const left = hm ? (23 * 60 + 59 - (Number(hm[1]) * 60 + Number(hm[2]))) * 60000 : 0;
      demoBase = { iso, at, left: Math.max(0, left) };
    }
    return demoBase;
  }
  /** Now, in epoch ms: the demo's clock in the demo, else the real one. */
  function nowMs() {
    const c = demoClock();
    return c ? c.at + Math.min(Math.max(0, Date.now() - loadedAt), c.left) : Date.now();
  }
  const now = () => new Date(nowMs()).toISOString();

  /** Clock time of an ISO instant (default: now) in the workspace timezone ('10:44'). */
  function clock(iso = now(), tz = timezone()) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    try {
      return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: tz || undefined }).format(d);
    } catch {
      return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
    }
  }

  /** The calendar day of an instant ('2026-10-19') in the workspace timezone. */
  function dayOf(ms, tz = timezone()) {
    try {
      const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: tz || undefined })
        .formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
      return `${p.year}-${p.month}-${p.day}`;
    } catch {
      return new Date(ms).toISOString().slice(0, 10);
    }
  }

  /**
   * How demo actions are dated: 'today, 14:07' (else '19 Oct, 14:07'), in the
   * workspace timezone and on the demo's clock. Inside a sentence pass sep ' ':
   * 'Reviews posted to #x, today 14:07.'
   */
  function stamp(iso, sep = ', ') {
    const ms = Date.parse(iso);
    if (!Number.isFinite(ms)) return '';
    const day = dayOf(ms);
    return `${day === dayOf(nowMs()) ? 'today' : fmtDay(day)}${sep}${clock(new Date(ms).toISOString())}`;
  }

  /** Today as 'YYYY-MM-DD' in the workspace timezone: the demo's Monday in the demo. */
  const today = () => dayOf(nowMs());

  /** 'Mon 19 Oct': today on the demo's clock (the real one in /app). */
  function todayLabel() {
    try {
      return new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: timezone() || undefined }).format(new Date(nowMs()));
    } catch {
      return fmtDay(dayOf(nowMs()));
    }
  }

  /** '13 min', '2 h 5 min', '3.4 days'; '—' when unknown. */
  function fmtMinutes(min) {
    if (min === null || min === undefined || !Number.isFinite(Number(min))) return '—';
    const m = Math.max(0, Math.round(Number(min)));
    if (m < 60) return `${m} min`;
    if (m < 48 * 60) { const h = Math.floor(m / 60); const r = m % 60; return r ? `${h} h ${r} min` : `${h} h`; }
    return `${Math.round(m / 144) / 10} days`;
  }

  const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  const joinAnd = (xs) => {
    const a = (xs || []).filter(Boolean);
    return a.length < 2 ? (a[0] || '') : `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}`;
  };
  const initials = (name) => String(name || '').split(/[\s.-]+/).filter(Boolean).map((w) => w[0]).join('').slice(0, 2).toUpperCase();

  /** '#/' + path; args are segments (a/b allowed), an optional last object is the query. */
  function href(...args) {
    const last = args[args.length - 1];
    const query = last && typeof last === 'object' && !Array.isArray(last) ? args.pop() : null;
    const segs = args.flatMap((a) => String(a ?? '').split('/')).filter(Boolean)
      .map((s) => encodeURIComponent(s).replace(/%3A/gi, ':'));
    const q = query ? new URLSearchParams(Object.entries(query)
      .filter(([, v]) => v !== undefined && v !== null && v !== '' && v !== false)
      .map(([k, v]) => [k, String(v)])).toString() : '';
    return `#/${segs.join('/')}${q ? `?${q}` : ''}`;
  }

  // A caught duplicate is not an error: DUPLICATE reads "Already tracked" on a neutral chip
  // (.cabinet .v-duplicate). FLAG keeps its chip word; in prose it is a "possible duplicate".
  const VERDICT = { CREATE: 'Create', COMMENT: 'Comment', FLAG: 'Flag', DUPLICATE: 'Already tracked' };
  function verdict(v) {
    const k = String(v || '').toUpperCase();
    if (!VERDICT[k]) return '<span class="v v-other">Other</span>';
    return `<span class="v v-${k.toLowerCase()}${k === 'DUPLICATE' ? ' v-tracked' : ''}">${VERDICT[k]}</span>`;
  }
  const prio = (p) => (p ? `<span class="prio prio-${esc(String(p).toLowerCase())}">${esc(p)}</span>` : '');
  function ref(r) {
    if (!r) return '';
    const tpl = workspace() && workspace().workspace.tracker_url;
    const url = tpl ? safeUrl(String(tpl).replace('{ref}', encodeURIComponent(r))) : null;
    return url
      ? `<a class="chip chip-ref" href="${esc(url)}" rel="noopener">${esc(r)}</a>`
      : `<span class="chip chip-ref">${esc(r)}</span>`;
  }
  const teamChip = (t) => (t ? `<span class="chip">${esc(t)}</span>` : '');

  /** Can a ▶ for this call open its transcript here? (demo: yes when kept; /app: no endpoint yet) */
  function canOpenTranscript(callId) {
    if (!API.transcript || !callId) return false;
    const row = workspace() && workspace().calls.find((c) => c.id === callId);
    if (row) return Boolean(row.has_transcript);
    const d = cached(`call:${callId}`);
    return Boolean(d && d.transcript && d.transcript.available && d.transcript.url);
  }

  /** A call offset: '▶ 16:40' linking to the transcript cue, or plain '(16:40)'. */
  function ts(callId, mmss) {
    const t = String(mmss || '');
    if (!/^\d{1,3}:\d{2}$/.test(t)) return '';
    if (!canOpenTranscript(callId)) return `<span class="ts-plain">(${esc(t)})</span>`;
    return `<a class="ts" href="${esc(href('call', callId, 'transcript', t))}" aria-label="Transcript at ${esc(t)}">▶ ${esc(t)}</a>`;
  }

  /** Escape, then the markdown subset; ctx.call turns (mm:ss) into ▶ links. */
  function inline(text, ctx = {}) {
    let s = esc(String(text ?? '').replace(/\u0000/g, ''));
    const codes = [];
    s = s.replace(/`([^`]+)`/g, (m, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[\s(«“])_([^_]+)_(?=$|[\s).,;:!?»”])/g, '$1<em>$2</em>');
    s = s.replace(/<em>\[(urgent|high|medium|low)\]<\/em>/g, (m, p) => prio(p));
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, t, u) => {
      const url = safeUrl(u.replace(/&amp;/g, '&'));
      return url ? `<a href="${esc(url)}" rel="noopener">${t}</a>` : t;
    });
    s = s.replace(/\((\d{1,3}:\d{2})\)/g, (m, t) => ts(ctx.call, t));
    return s.replace(/\u0000(\d+)\u0000/g, (m, i) => `<code>${codes[Number(i)]}</code>`);
  }

  /** Block markdown: ### headings, - and 1. lists (with > quotes under items), > quotes, paragraphs. */
  function md(src, ctx = {}) {
    const out = [];
    let para = [];
    let list = null;
    const flushPara = () => { if (para.length) { out.push(`<p>${inline(para.join(' '), ctx)}</p>`); para = []; } };
    const closeList = () => {
      if (!list) return;
      const start = list.tag === 'ol' && list.start !== 1 ? ` start="${list.start}"` : '';
      out.push(`<${list.tag}${start}>${list.items.map((i) => `<li>${i}</li>`).join('')}</${list.tag}>`);
      list = null;
    };
    for (const raw of String(src || '').split('\n')) {
      const line = raw.replace(/\s+$/, '');
      let m;
      if (!line.trim()) { flushPara(); closeList(); continue; }
      if ((m = line.match(/^#{3,6}\s+(.*)$/))) { flushPara(); closeList(); out.push(`<h3>${inline(m[1], ctx)}</h3>`); continue; }
      if ((m = line.match(/^\s+>\s?(.*)$/)) && list) { list.items[list.items.length - 1] += `<blockquote>${inline(m[1], ctx)}</blockquote>`; continue; }
      if ((m = line.match(/^>\s?(.*)$/))) { flushPara(); closeList(); out.push(`<blockquote>${inline(m[1], ctx)}</blockquote>`); continue; }
      if ((m = line.match(/^[-*]\s+(.*)$/))) {
        flushPara();
        if (!list || list.tag !== 'ul') { closeList(); list = { tag: 'ul', items: [] }; }
        list.items.push(inline(m[1], ctx));
        continue;
      }
      if ((m = line.match(/^(\d+)\.\s+(.*)$/))) {
        flushPara();
        if (!list || list.tag !== 'ol') { closeList(); list = { tag: 'ol', start: Number(m[1]), items: [] }; }
        list.items.push(inline(m[2], ctx));
        continue;
      }
      if (list && /^\s+/.test(raw)) { list.items[list.items.length - 1] += ` ${inline(line.trim(), ctx)}`; continue; }
      closeList();
      para.push(line.trim());
    }
    flushPara();
    closeList();
    return out.join('\n');
  }

  const loading = (what) => `<p class="muted loading" role="status">Loading the ${esc(what)}…</p>`;
  const emptyState = (html) => `<div class="empty">${html}</div>`;
  const managed = () => `Managed by Backbrief. Ask us at <a href="mailto:${esc(contact)}">${esc(contact)}</a> to change it.`;
  /** The header's "Book a demo" href, as the page was built (a deployment may point it at a calendar). */
  function bookHref() {
    const a = $('.app-actions a[data-book]');
    const h = a ? a.getAttribute('href') : null;
    return (h && (safeUrl(h) || (/^mailto:/i.test(h) ? h : null))) || '/book';
  }
  /** Still owed: the build's `open` (post-call, not done on a later call, latest row for its issue). */
  const isOpenItem = (a) => Boolean(a) && (typeof a.open === 'boolean' ? a.open : a.status === 'post-call');
  /**
   * An action item and the proposal made from it share their call and minute
   * (the ▶ both show); without a minute, the title stands in.
   */
  const minuteKey = (callId, ts, title) => `${callId}|${ts || title || ''}`;
  const deliveryPhrase = (d = {}) => joinAnd(['summary', d.transcript_link && 'transcript link', d.recording_link && 'recording link', d.task_log && 'task log']);

  const DEMO_NOTE = Object.freeze({
    linear: 'Demo · nothing was sent to Linear.',
    slack: 'Demo · nothing was posted to Slack.',
    github: 'Demo · nothing was committed to GitHub.',
    browser: 'Demo · saved in this browser only.',
    connection: 'Demo · no connection was made.',
  });

  // ================================================================ data
  const cache = new Map();
  let dataVersion = 0;

  async function getJson(url) {
    const res = await fetch(url, { headers: { accept: 'application/json' }, credentials: 'same-origin' });
    if (!isDemo && (res.status === 401 || res.status === 403)) {
      location.href = '/login';
      throw Object.assign(new Error('Signed out.'), { status: res.status, signedOut: true });
    }
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      throw Object.assign(new Error(b.detail || b.error || `HTTP ${res.status}`), { status: res.status });
    }
    return res.json();
  }

  const notFound = () => Object.assign(new Error("This call isn't in the workspace."), { status: 404 });

  async function fetchCall(id) {
    if (!/^[\w-]{6,40}$/.test(id)) throw notFound();
    const w = await load('workspace');
    if (!w.calls.some((c) => c.id === id) && !(w.window && w.window.truncated)) throw notFound();
    try {
      return await getJson(API.call(id));
    } catch (e) {
      throw e.status === 404 ? notFound() : e;
    }
  }

  async function fetchTranscript(id) {
    if (!API.transcript) return null;
    const c = await load(`call:${id}`);
    const url = c && c.transcript && c.transcript.available ? c.transcript.url || API.transcript(id) : null;
    return url && /^\/(?!\/)/.test(url) ? getJson(url) : null;
  }

  function fetchKey(key) {
    const i = key.indexOf(':');
    const kind = i < 0 ? key : key.slice(0, i);
    const id = i < 0 ? '' : key.slice(i + 1);
    if (kind === 'workspace') return getJson(API.workspace);
    if (kind === 'people') {
      return getJson(API.people).then((p) => ({
        people: Array.isArray(p.people) ? p.people : [],
        unprofiled: Array.isArray(p.unprofiled) ? p.unprofiled : [],
        add_person: p.add_person || null,
      }));
    }
    if (kind === 'vault') return API.vault ? getJson(API.vault) : Promise.resolve(null);
    if (kind === 'settings') return API.settings ? getJson(API.settings) : Promise.resolve(null);
    if (kind === 'call' && id) return fetchCall(id);
    if (kind === 'transcript' && id) return fetchTranscript(id);
    return Promise.reject(new Error(`Unknown data key "${key}".`));
  }

  function load(key) {
    const k = String(key);
    const hit = cache.get(k);
    if (hit) return hit.promise;
    const entry = { done: false, value: undefined, promise: null };
    entry.promise = fetchKey(k).then(
      (v) => { entry.done = true; entry.value = v; dataVersion++; return v; },
      (e) => { if (cache.get(k) === entry) cache.delete(k); throw e; },
    );
    cache.set(k, entry);
    return entry.promise;
  }
  function cached(key) {
    const e = cache.get(String(key));
    return e && e.done ? e.value : undefined;
  }
  const workspace = () => cached('workspace');
  const timezone = () => (workspace() && workspace().workspace.timezone) || undefined;
  const company = () => {
    const w = workspace();
    return (w && w.workspace.company && w.workspace.company.name) || (w ? w.workspace.name : 'Workspace');
  };
  const displayName = () => (isDemo ? company() : (workspace() ? workspace().workspace.name : 'Workspace'));
  const titleName = () => (workspace() ? workspace().workspace.name : 'Workspace');
  const lastCallDate = () => {
    const w = workspace();
    return (w && w.stats.last_call && w.stats.last_call.date) || (w && w.calls[0] && w.calls[0].date) || '';
  };

  // ================================================================ demo state
  const STORE_KEY = 'backbrief.demo.v1';
  const blankState = () => ({
    v: 1, decisions: {}, edits: {}, log_sent: {}, delivery: null, channels: null,
    people_added: [], zone_reviews: {}, sources: {}, requests: {}, imports: [],
    // View choices, not demo changes: {viewing_as: '<Lastname>', tour_hidden: true}.
    prefs: {},
  });
  const state = blankState();
  let storage = isDemo ? 'local' : 'none';
  let stateVersion = 0;

  const isObj = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
  function adopt(saved) {
    const blank = blankState();
    for (const k of Object.keys(state)) delete state[k];
    for (const [k, def] of Object.entries(blank)) {
      const v = saved ? saved[k] : undefined;
      if (k === 'v') state.v = 1;
      else if (Array.isArray(def)) state[k] = Array.isArray(v) ? v : def;
      else if (def === null) state[k] = isObj(v) ? v : null;
      else state[k] = isObj(v) ? v : def;
    }
    stateVersion++;
  }

  function readStore() {
    if (!isDemo) return;
    let raw = null;
    try { raw = window.localStorage.getItem(STORE_KEY); storage = 'local'; } catch { storage = 'memory'; }
    let saved = null;
    try { saved = raw ? JSON.parse(raw) : null; } catch { saved = null; }
    adopt(saved && saved.v === 1 ? saved : null);
  }

  function save() {
    stateVersion++;
    if (isDemo) {
      try { window.localStorage.setItem(STORE_KEY, JSON.stringify(state)); storage = 'local'; } catch { storage = 'memory'; }
    }
    emit('state', state);
  }

  function reset() {
    adopt(null);
    if (isDemo) {
      try { window.localStorage.removeItem(STORE_KEY); } catch { storage = 'memory'; }
    }
    emit('reset', state);
    emit('state', state);
  }

  function changeCount() {
    const n = (o) => (isObj(o) ? Object.keys(o).length : 0);
    return n(state.decisions) + n(state.edits) + n(state.log_sent) + (state.delivery ? 1 : 0) + (state.channels ? 1 : 0)
      + state.people_added.length + n(state.zone_reviews) + n(state.sources) + n(state.requests) + state.imports.length;
  }

  /**
   * Stamps an older version of the demo wrote with the visitor's real clock
   * (later than the demo's Monday) move onto the demo clock, so no real-clock
   * date ever shows. Runs once the workspace (and so demo_now) has loaded.
   */
  function settleStamps() {
    const c = demoClock();
    if (!c) return;
    const limit = c.at + c.left + 60000;
    const at = now();
    let changed = false;
    const late = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v) && Date.parse(v) > limit;
    const walk = (o, depth) => {
      if (!o || typeof o !== 'object' || depth > 6) return;
      for (const [k, v] of Object.entries(o)) {
        if ((k === 'at' || k.endsWith('_at')) && late(v)) { o[k] = at; changed = true; } else walk(v, depth + 1);
      }
    };
    for (const k of Object.keys(state)) if (k !== 'requests' && k !== 'prefs') walk(state[k], 0);
    for (const [k, v] of Object.entries(state.requests)) if (late(v)) { state.requests[k] = at; changed = true; }
    if (changed) save();
  }

  /** Record a decision on proposal `key` ('<call_id>:<n>') and save. */
  function decide(key, d = {}) {
    state.decisions[key] = {
      action: 'approve', result: null, ref: null, reason: null, edited: false, edit_summary: null, ...d, at: d.at || now(),
    };
    save();
    return state.decisions[key];
  }

  // Selectors recompute when data loads or the state changes, not on every call.
  const memos = new Map();
  function memo(name, fn) {
    const v = `${dataVersion}.${stateVersion}`;
    const m = memos.get(name);
    if (m && m.v === v) return m.value;
    const value = fn();
    memos.set(name, { v, value });
    return value;
  }

  /** One task_log entry with the overlay's edits and decisions applied. */
  function overlayEntry(e) {
    const proposals = (e.proposals || []).map((p) => {
      const key = `${e.call_id}:${p.n}`;
      // A proposal reviewed in the vault keeps its own review: an owner changed before filing
      // (ENG-311: "owner: Okafor → Hughes") shows as edited. Only waiting ones take the overlay.
      const out = {
        ...p,
        key,
        call_id: e.call_id,
        edited: Boolean(p.edited),
        changed: Array.isArray(p.changed) ? [...p.changed] : [],
        original: isObj(p.original) ? { ...p.original } : null,
        by: null,
        at: null,
        edit_summary: p.edit_summary || null,
      };
      if (p.status !== 'pending') return out;
      out.edited = false;
      out.changed = [];
      out.original = null;
      out.edit_summary = null;
      const ed = state.edits[key];
      if (isObj(ed)) {
        out.original = { title: p.title, owner: p.owner, priority: p.priority, owner_team: p.owner_team };
        if (typeof ed.title === 'string' && ed.title.trim() && ed.title !== p.title) { out.title = ed.title; out.changed.push('title'); }
        if ('owner' in ed && (ed.owner || null) !== (p.owner || null)) { out.owner = ed.owner || null; out.changed.push('owner'); }
        if (ed.priority && ed.priority !== p.priority) { out.priority = ed.priority; out.changed.push('priority'); }
        if (ed.team && ed.team !== p.owner_team) { out.owner_team = ed.team; out.changed.push('team'); }
        if (typeof ed.comment === 'string') { out.comment = ed.comment; out.changed.push('comment'); }
        out.edited = out.changed.length > 0;
      }
      const d = state.decisions[key];
      if (isObj(d)) {
        out.status = d.action === 'skip' || d.result === 'skipped' ? 'skipped' : 'approved';
        out.decision = { result: d.result || (out.status === 'skipped' ? 'skipped' : null), ref: d.ref || null, reason: d.reason || null };
        out.by = 'you';
        out.at = d.at || null;
        out.edit_summary = d.edit_summary || null;
        if (d.edited) out.edited = true;
      }
      return out;
    });
    const pending = proposals.filter((p) => p.status === 'pending');
    const mine = proposals.filter((p) => p.by === 'you');
    const more = (r) => mine.filter((p) => p.decision.result === r).length;
    const base = e.counts || { extracted: proposals.length, created: 0, commented: 0, skipped: 0 };
    return {
      ...e,
      proposals,
      pending: pending.length,
      counts: { ...base, created: (base.created || 0) + more('created'), commented: (base.commented || 0) + more('commented'), skipped: (base.skipped || 0) + more('skipped') },
      bulk: {
        approve_safe: { allowed: e.bulk ? e.bulk.approve_safe.allowed !== false : true, count: pending.filter((p) => p.safe).length },
        skip_remaining: { count: pending.length },
      },
      decided_here: mine.length,
      log_sent: isObj(state.log_sent[e.call_id]) ? state.log_sent[e.call_id] : null,
    };
  }

  function effectiveProposals(callId) {
    const all = memo('proposals', () => {
      const w = workspace();
      return (w && Array.isArray(w.task_log) ? w.task_log : []).map(overlayEntry);
    });
    if (callId === undefined) return all;
    const hit = all.find((e) => e.call_id === callId);
    if (hit) return hit;
    const d = cached(`call:${callId}`);
    return d && d.task_log ? overlayEntry(d.task_log) : null;
  }

  const waitingCount = () => effectiveProposals().reduce((n, e) => n + e.pending, 0);

  /**
   * workspace.action_items with the reviews made here applied, so every open
   * count and list agrees with them. A review reaches the commitment its
   * proposal came from: the call's post-call item at the proposal's minute
   * (a done-on-call line is left as it is).
   *   - Approved: the item takes the edited title, owner and priority, and the
   *     issue key it was created as or commented on (ref_added when new).
   *   - Approved as a new issue with no commitment at that minute ("Create new
   *     instead", "Create anyway"): a new open item (added_here).
   *   - Skipped: the item is no longer open; nothing was filed.
   * Items a review touched carry review {status, result, ref, reason, at}.
   * Reviews kept in the vault are already in the build's items.
   */
  function effectiveActionItems(callId) {
    const all = memo('items', () => {
      const w = workspace();
      const out = [...((w && w.action_items) || [])];
      const taken = new Set();
      const added = [];
      for (const e of effectiveProposals()) {
        for (const p of e.proposals) {
          if (p.by !== 'you' || p.status === 'pending') continue;
          const d = p.decision || {};
          const was = p.original || p;
          const key = minuteKey(e.call_id, p.ts, was.title);
          let i = -1;
          out.forEach((a, j) => {
            if (taken.has(j) || a.call_id !== e.call_id || a.status !== 'post-call' || minuteKey(a.call_id, a.ts, a.title) !== key) return;
            if (i < 0 || a.title === was.title) i = j;
          });
          const filed = d.result === 'created' || d.result === 'commented' ? d.ref || null : null;
          const review = { status: p.status, result: d.result || null, ref: filed, reason: d.reason || null, at: p.at || null };
          if (i >= 0) {
            taken.add(i);
            const a = out[i];
            if (p.status === 'skipped') {
              out[i] = { ...a, open: false, review };
              continue;
            }
            const ch = p.changed || [];
            out[i] = {
              ...a,
              ...(ch.includes('title') ? { title: p.title } : {}),
              ...(ch.includes('owner') ? { owner: p.owner || null } : {}),
              ...(ch.includes('priority') ? { priority: p.priority || null } : {}),
              ...(filed && filed !== a.tracker_ref ? { tracker_ref: filed, ref_added: true } : {}),
              review,
            };
          } else if (p.status === 'approved' && d.result === 'created') {
            added.push({
              title: p.title, owner: p.owner || null, helpers: [], status: 'post-call', priority: p.priority || null, ts: p.ts || null,
              tracker_ref: filed, call_id: e.call_id, call_topic: e.topic, call_date: e.date,
              closed_by: null, superseded: false, open: true, ref_added: Boolean(filed), added_here: true, review,
            });
          }
        }
      }
      // A new item follows its call's other commitments (else its call's items, else its date).
      for (const a of added) {
        let at = -1;
        let last = -1;
        out.forEach((x, j) => {
          if (x.call_id !== a.call_id) return;
          last = j;
          if (x.status === 'post-call') at = j;
        });
        if (at < 0) at = last;
        if (at < 0) {
          at = out.findIndex((x) => String(x.call_date || '') < String(a.call_date || ''));
          out.splice(at < 0 ? out.length : at, 0, a);
        } else out.splice(at + 1, 0, a);
      }
      return out;
    });
    if (callId === undefined) return all;
    const mine = all.filter((a) => a.call_id === callId);
    if (mine.length || (workspace() && workspace().calls.some((c) => c.id === callId))) return mine;
    const d = cached(`call:${callId}`);
    return d ? (d.action_items || []).map((a) => ({ ...a, call_id: callId, call_topic: d.topic, call_date: d.date })) : [];
  }

  /** One person's open items, with the reviews made here ('Hughes'; null or '' for the items no one owns). */
  function openItemsFor(lastname) {
    const who = lastname || null;
    return effectiveActionItems().filter((a) => isOpenItem(a) && (a.owner || null) === who);
  }

  function effectivePeople() {
    return memo('people', () => {
      const loaded = cached('people');
      const base = loaded || { people: (workspace() && workspace().people) || [], unprofiled: [], add_person: null };
      const reviews = isObj(state.zone_reviews) ? state.zone_reviews : {};
      const added = state.people_added.filter((p) => isObj(p) && typeof p.lastname === 'string').map((p) => ({ ...p, added: true }));
      const names = new Set(added.map((p) => p.lastname));
      const reviewed = (p) => {
        const verdictFor = (z) => reviews[`${p.lastname}:${z}`];
        return {
          ...p,
          zones: (p.zones || []).filter((z) => verdictFor(z) !== 'removed'),
          zone_evidence: (p.zone_evidence || []).filter((z) => verdictFor(z.zone) !== 'removed')
            .map((z) => (verdictFor(z.zone) === 'confirmed' ? { ...z, review: 'confirmed' } : z)),
        };
      };
      return {
        people: [...base.people.filter((p) => !names.has(p.lastname)), ...added].map(reviewed).sort((a, b) => a.lastname.localeCompare(b.lastname)),
        unprofiled: base.unprofiled.filter((u) => !names.has(u.token)),
        add_person: base.add_person,
        loaded: Boolean(loaded),
      };
    });
  }

  function effectiveStats() {
    return memo('stats', () => {
      const w = workspace();
      if (!w) return null;
      const s = { ...w.stats };
      const all = effectiveProposals().flatMap((e) => e.proposals);
      const mine = all.filter((p) => p.by === 'you');
      s.pending = all.filter((p) => p.status === 'pending').length;
      s.safe_pending = all.filter((p) => p.status === 'pending' && p.safe).length;
      s.accepted = (w.stats.accepted || 0) + mine.filter((p) => p.status === 'approved').length;
      s.skipped = (w.stats.skipped || 0) + mine.filter((p) => p.status === 'skipped').length;
      s.decided_here = mine.length;
      s.linked_to_tracker = effectiveActionItems().filter((a) => a.tracker_ref).length;
      s.open_items = effectiveActionItems().filter(isOpenItem).length;
      s.people = (w.stats.people || 0) + state.people_added.length;
      s.unprofiled_teammates = cached('people') ? effectivePeople().unprofiled.filter((u) => u.kind === 'teammate').length : null;
      return s;
    });
  }

  const SOURCE_IDS = ['zoom', 'slack', 'linear', 'github'];
  function effectiveSources() {
    return memo('sources', () => {
      const st = cached('settings');
      if (!st) {
        const flags = (workspace() && workspace().workspace.integrations) || {};
        return SOURCE_IDS.map((id) => ({ id, status: flags[id] ? 'connected' : 'not_connected', account: null, connected_at: null, settings: {}, activity: null }));
      }
      return st.sources.map((s) => {
        const o = state.sources[s.id];
        if (!isObj(o)) return s;
        return { ...s, status: o.status || s.status, settings: { ...s.settings, ...(isObj(o.settings) ? o.settings : {}) }, changed_at: o.at || null, changed_here: true };
      });
    });
  }

  function effectiveSlack() {
    return memo('slack', () => {
      const st = cached('settings');
      const base = (st && st.slack) || { channel: null, per_team_channels: {}, delivery: { summary: true }, locked: ['summary'], channels_available: [], preview_call_id: null };
      const ch = isObj(state.channels) ? state.channels : null;
      return {
        ...base,
        channel: (ch && ch.default) || base.channel,
        per_team_channels: ch ? Object.fromEntries(Object.entries(ch).filter(([k, v]) => k !== 'default' && v)) : base.per_team_channels,
        delivery: { ...base.delivery, ...(isObj(state.delivery) ? state.delivery : {}), summary: true },
        base_delivery: base.delivery,
        changed: Boolean(state.delivery || state.channels),
      };
    });
  }

  // ---------------------------------------------------------------- review metrics
  // The rules lib/vault.js uses for overview.metrics, applied to the reviews made here.

  /** A skip reason as a kind: covered | done | not_a_task | wrong_owner | wrong_team | other | null. */
  function reasonKind(reason, v = null) {
    const r = String(reason || '').trim().toLowerCase();
    if (!r) return v === 'DUPLICATE' ? 'covered' : null;
    if (/wrong team|other team|belongs to/.test(r)) return 'wrong_team';
    if (/wrong owner|reassign/.test(r)) return 'wrong_owner';
    if (/not a task|no ticket|decides|discussion only/.test(r)) return 'not_a_task';
    if (/\bdone\b|shipped|\blive\b|finished|\b(?:is|are) (?:already )?in\b/.test(r)) return 'done';
    if (/covered|same ticket|already (?:tracked|exists|in the tracker)|duplicate|\b[a-z][a-z0-9]{1,9}-\d+\b/.test(r)) return 'covered';
    return 'other';
  }

  /** 'agreed' (reviewed as proposed), 'edited' (approved after a change), 'overridden', or null while waiting. */
  function agreementOf(p) {
    if (!p || p.status === 'pending') return null;
    const approved = p.status === 'approved';
    const result = p.decision && p.decision.result;
    if (p.verdict === 'DUPLICATE') return approved ? 'overridden' : 'agreed';
    if (p.verdict === 'FLAG' && approved && result !== 'commented') return 'overridden';
    if (p.verdict === 'FLAG' && !approved) return 'agreed';
    if (!approved) return 'overridden';
    return p.edited ? 'edited' : 'agreed';
  }

  /** The review kept a duplicate out of the tracker: a comment instead, or a skip as covered or done. */
  function preventsDuplicate(p) {
    if (!p || p.status === 'pending') return false;
    const d = p.decision || {};
    if (p.verdict === 'COMMENT') return p.status === 'approved';
    if (p.verdict === 'FLAG' && p.status === 'approved') return d.result === 'commented';
    if (p.verdict === 'FLAG' || p.verdict === 'DUPLICATE') {
      const kind = d.reason_kind !== undefined && p.by !== 'you' ? d.reason_kind : reasonKind(d.reason, p.verdict);
      return p.status === 'skipped' && (kind === 'covered' || kind === 'done');
    }
    return false;
  }

  function medianOf(values) {
    const v = values.filter(Number.isFinite).sort((a, b) => a - b);
    if (!v.length) return null;
    const mid = Math.floor(v.length / 2);
    return Math.round(v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2);
  }

  /** Decisions from calls in the last `days` days (today included), newest first. */
  function recentDecisions(days = 7) {
    const w = workspace();
    const since = dayOf(nowMs() - days * 864e5);
    return ((w && w.decisions) || []).filter((d) => String(d.date || '') > since);
  }

  /**
   * overview.metrics with the reviews made here (the build's base values plus
   * the overlay), and the counts the Overview tiles show.
   */
  function effectiveMetrics() {
    return memo('metrics', () => {
      const w = workspace();
      if (!w) return null;
      const m = (w.overview && w.overview.metrics) || {};
      const entries = effectiveProposals();
      const all = entries.flatMap((e) => e.proposals);
      const reviewed = all.filter((p) => p.status !== 'pending');
      const mine = reviewed.filter((p) => p.by === 'you');
      const base = reviewed.filter((p) => p.by !== 'you');
      const count = (list, kind) => list.filter((p) => agreementOf(p) === kind).length;

      const va = isObj(m.verdict_agreement) ? m.verdict_agreement : null;
      const agreement = {
        agreed: (va ? va.agreed : count(base, 'agreed')) + count(mine, 'agreed'),
        edited: (va ? va.edited : count(base, 'edited')) + count(mine, 'edited'),
        decided: (va ? va.decided : base.length) + mine.length,
      };
      agreement.rate = agreement.decided ? agreement.agreed / agreement.decided : null;

      const dp = isObj(m.duplicates_prevented) ? m.duplicates_prevented : null;
      const prevented = (dp ? dp.confirmed : base.filter(preventsDuplicate).length) + mine.filter(preventsDuplicate).length;

      // Time to review: per call with nothing waiting, call end → its last review (here or in the vault).
      const tt = isObj(m.time_to_decision) ? m.time_to_decision : null;
      const at = nowMs();
      let over48 = 0;
      const calls = (tt && Array.isArray(tt.calls) ? tt.calls : []).map((c) => {
        const e = entries.find((x) => x.call_id === c.call_id);
        const end = Date.parse(c.ended_at);
        if (!e || !Number.isFinite(end)) return c;
        const times = [];
        for (const p of e.proposals) {
          const t = p.status === 'pending' ? at : Date.parse((p.by === 'you' ? p.at : p.decided_at) || '');
          if (p.status !== 'pending' && Number.isFinite(t)) times.push(t);
          if (Number.isFinite(t) && t - end > 48 * 3600e3) over48++;
        }
        const last = e.pending === 0 && times.length ? Math.max(...times) : null;
        return { ...c, decided_at: last ? new Date(last).toISOString() : null, minutes: last ? Math.round((last - end) / 60000) : null, pending: e.pending };
      });

      // Owner coverage: a task filed here counts, unless an open action item already sat at its minute
      // (the build's items: the effective ones already hold what was filed here).
      let owners = isObj(m.owner_coverage) ? { ...m.owner_coverage } : null;
      if (owners) {
        const openAt = new Set((w.action_items || []).filter(isOpenItem).map((a) => minuteKey(a.call_id, a.ts, a.title)));
        for (const p of mine) {
          if (p.status !== 'approved' || p.decision.result !== 'created' || openAt.has(minuteKey(p.call_id, p.ts, (p.original || p).title))) continue;
          owners = { ...owners, total: owners.total + 1, with_owner: owners.with_owner + (p.owner ? 1 : 0) };
        }
      }

      return {
        decisions: { total: (w.decisions || []).length, last_7_days: recentDecisions(7).length },
        reviews: { reviewed: reviewed.length, total: all.length, waiting: all.length - reviewed.length, here: mine.length },
        verdict_agreement: agreement,
        duplicates_prevented: { confirmed: prevented },
        time_to_decision: {
          median_minutes: tt ? medianOf(calls.map((c) => c.minutes).filter((x) => x !== null && x !== undefined)) : null,
          over_48h: tt ? over48 : null,
          calls,
        },
        owner_coverage: owners,
        processing: isObj(m.processing) ? m.processing : null,
      };
    });
  }

  /** The teammate Overview is viewing as (a lastname), or '' for everyone. */
  const viewingAs = () => (isObj(state.prefs) && typeof state.prefs.viewing_as === 'string' ? state.prefs.viewing_as : '');

  /**
   * Slack delivery's Task log switch (on by default). While it is on, the
   * call's thread carries the task log and each review updates it in place,
   * so there is nothing to post by hand. Unknown (no settings) reads as on.
   */
  function taskLogOn() {
    if (!cached('settings') && !isObj(state.delivery)) return true;
    return Boolean(effectiveSlack().delivery.task_log);
  }

  /** When the last review made here updated the call's Slack thread (ISO), or null. */
  function threadUpdatedAt(e) {
    if (!isDemo || !e || !Array.isArray(e.proposals) || !taskLogOn()) return null;
    const slack = effectiveSources().find((s) => s.id === 'slack');
    if (slack && slack.status !== 'connected') return null;
    let last = NaN;
    for (const p of e.proposals) {
      const t = p.by === 'you' ? Date.parse(p.at) : NaN;
      if (Number.isFinite(t) && !(t <= last)) last = t;
    }
    return Number.isFinite(last) ? new Date(last).toISOString() : null;
  }

  /**
   * "Updated in the call's Slack thread · today 11:06": the quiet line after a
   * review made here while the task log is on (HTML; '' otherwise). The thread
   * links to the call's Slack thread tab. opts.topic leads with the call's
   * topic (several calls in one panel); opts.cls adds a class.
   */
  function threadNote(e, opts = {}) {
    const at = threadUpdatedAt(e);
    if (!at) return '';
    const where = typeof hooks.slackThread === 'function'
      ? `<a href="${esc(href('call', e.call_id, 'slack'))}">the call's Slack thread</a>`
      : "the call's Slack thread";
    const lead = opts.topic ? `${esc(e.topic)}: updated` : 'Updated';
    return `<p class="thread-note${opts.cls ? ` ${esc(opts.cls)}` : ''}">${lead} in ${where} · ${esc(stamp(at, ' '))}</p>`;
  }

  // ================================================================ events and hooks
  const listeners = {};
  function on(evt, fn) {
    (listeners[evt] = listeners[evt] || []).push(fn);
    return () => { listeners[evt] = listeners[evt].filter((f) => f !== fn); };
  }
  function emit(evt, arg) {
    for (const fn of listeners[evt] || []) {
      try { fn(arg); } catch (e) { console.error(e); }
    }
  }
  const hooks = { callAside: null, sendLog: null, slackThread: null };

  // ================================================================ UI kit
  const TOAST_MS = 4000;
  const TOAST_ACTION_MS = 10000;
  let shownToast = null;

  /**
   * One toast at a time, in the one polite live region: a new toast replaces
   * the current one. Line 2 is the demo note. With {action: {label, run}} (Undo)
   * the button shows and the toast stays 10 s, else 4 s; hover and focus pause it.
   */
  function toast(line1, line2 = '', opts = {}) {
    const box = ui.toasts;
    if (!box) return null;
    if (shownToast) shownToast.close();
    box.textContent = '';
    const action = opts && isObj(opts.action) && typeof opts.action.run === 'function' ? opts.action : null;
    const t = document.createElement('div');
    t.className = `toast${action ? ' has-action' : ''}`;
    t.innerHTML = `<div class="toast-text"><p class="toast-1">${esc(line1)}</p>${line2 ? `<p class="toast-2">${esc(line2)}</p>` : ''}</div>`
      + `<div class="toast-do">${action ? `<button class="toast-act" type="button">${esc(action.label || 'Undo')}</button>` : ''}`
      + '<button class="toast-x" type="button" aria-label="Dismiss"><span class="toast-x-word" aria-hidden="true">Dismiss</span><span class="toast-x-icon" aria-hidden="true">×</span></button></div>';
    let left = action ? TOAST_ACTION_MS : TOAST_MS;
    let started = 0;
    let timer = null;
    let running = false;
    let closed = false;
    let back = null;
    const handle = { el: t, close };
    function close() {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      const had = t.contains(document.activeElement);
      t.remove();
      if (shownToast === handle) shownToast = null;
      if (!box.children.length) body.classList.remove('has-toast');
      if (had) (back && back.isConnected ? back : ui.title).focus({ preventScroll: true });
    }
    const start = () => { if (closed) return; clearTimeout(timer); running = true; started = Date.now(); timer = setTimeout(close, left); };
    const pause = () => { if (!running) return; clearTimeout(timer); running = false; left = Math.max(1500, left - (Date.now() - started)); };
    t.addEventListener('mouseenter', pause);
    t.addEventListener('mouseleave', () => { if (!t.contains(document.activeElement)) start(); });
    t.addEventListener('focusin', (e) => { if (!t.contains(e.relatedTarget)) back = e.relatedTarget; pause(); });
    t.addEventListener('focusout', (e) => { if (!t.contains(e.relatedTarget)) start(); });
    t.querySelector('.toast-x').addEventListener('click', close);
    if (action) {
      t.querySelector('.toast-act').addEventListener('click', () => {
        close();
        try { action.run(); } catch (e) { console.error(e); }
      });
    }
    box.append(t);
    body.classList.add('has-toast');
    shownToast = handle;
    start();
    requestAnimationFrame(() => keepClear());
    return handle;
  }

  /** Keep the focused element clear of the toast: scroll it up when the toast would cover it. */
  function keepClear() {
    const t = shownToast && shownToast.el;
    const a = document.activeElement;
    if (!t || !t.isConnected || !a || a === body || a === ui.view || t.contains(a) || a.closest('dialog')) return;
    const r = a.getBoundingClientRect();
    const tr = t.getBoundingClientRect();
    if (!r.height || r.bottom <= tr.top - 8 || r.top >= window.innerHeight || r.left >= tr.right || r.right <= tr.left) return;
    const head = $('.app-header');
    const top = head && getComputedStyle(head).position === 'sticky' ? head.getBoundingClientRect().bottom : 0;
    const by = Math.min(r.bottom - tr.top + 12, r.top - top - 8);
    if (by > 0) window.scrollBy({ top: by, behavior: 'instant' });
  }

  function resolveFocus(x) {
    if (!x) return null;
    if (typeof x === 'function') { try { return resolveFocus(x()); } catch { return null; } }
    if (typeof x === 'string') return $(x, ui.view) || $(x);
    return x instanceof Element && x.isConnected ? x : null;
  }

  /** Focus an element and scroll it into view: centred, or from its top when it is tall (a task-log group). */
  function focusTarget(t, block) {
    if (!t) return;
    if (!t.hasAttribute('tabindex') && !/^(A|BUTTON|INPUT|SELECT|TEXTAREA|SUMMARY)$/.test(t.tagName)) t.setAttribute('tabindex', '-1');
    t.focus({ preventScroll: true });
    const tall = t.getBoundingClientRect().height > window.innerHeight * 0.4;
    t.scrollIntoView({ block: block || (tall ? 'start' : 'center'), behavior: 'instant' });
  }

  let dialogSeq = 0;
  function dialog(opts = {}) {
    const {
      title = '', html = '', wide = false, onOpen = null, onClose = null, className = '',
      actions = [{ label: 'Close', value: null, cancel: true }],
    } = opts;
    const trigger = opts.trigger || document.activeElement;
    const id = `dlg-${++dialogSeq}`;
    const d = document.createElement('dialog');
    d.className = ['sheet', wide ? 'sheet-wide' : '', className].filter(Boolean).join(' ');
    d.setAttribute('aria-labelledby', `${id}-title`);
    const primaryAt = actions.findIndex((a) => a.primary) >= 0 ? actions.findIndex((a) => a.primary) : actions.findIndex((a) => !a.cancel);
    // A link action ({label, href, primary}) is an <a class="btn">: following it closes the dialog.
    const linkOf = (a) => (a && typeof a.href === 'string' ? safeUrl(a.href) || (/^mailto:/i.test(a.href) ? a.href : null) : null);
    const actionHtml = (a, i) => {
      const cls = `btn btn-small${i === primaryAt ? '' : ' btn-ghost'}`;
      const attrs = `data-action="${i}"${a.autofocus ? ' autofocus' : ''}${a.disabled ? ' aria-disabled="true"' : ''}`;
      const url = linkOf(a);
      if (url) return `<a class="${cls}" href="${esc(url)}" ${attrs}>${esc(a.label)}</a>`;
      return `<button class="${cls}" type="${a.cancel ? 'button' : 'submit'}" ${attrs}>${esc(a.label)}</button>`;
    };
    d.innerHTML = `<form class="sheet-form" novalidate>
      <div class="sheet-head"><h2 id="${id}-title">${esc(title)}</h2></div>
      <div class="sheet-body">${html}</div>
      <div class="sheet-actions">${actions.map(actionHtml).join('')}</div>
    </form>`;
    document.body.append(d);
    const form = d.querySelector('form');
    const buttons = $$('[data-action]', d);
    let settled = false;
    let busyLabel = null;
    let resolve;
    const result = new Promise((r) => { resolve = r; });

    const handle = {
      el: d,
      body: d.querySelector('.sheet-body'),
      result,
      isBusy: false,
      button: (i) => buttons[i] || null,
      close(value = null) {
        if (settled) return;
        settled = true;
        if (d.open) d.close();
        finish(value);
      },
      busy(label, at = primaryAt) {
        if (label === false) {
          handle.isBusy = false;
          form.removeAttribute('aria-busy');
          for (const b of buttons) if (b.dataset.wasDisabled !== '1') b.removeAttribute('aria-disabled');
          if (busyLabel) { busyLabel.btn.textContent = busyLabel.text; busyLabel = null; }
          return;
        }
        handle.isBusy = true;
        form.setAttribute('aria-busy', 'true');
        for (const b of buttons) { b.dataset.wasDisabled = b.getAttribute('aria-disabled') === 'true' ? '1' : ''; b.setAttribute('aria-disabled', 'true'); }
        const btn = buttons[at];
        if (label && btn) { if (!busyLabel) busyLabel = { btn, text: btn.textContent }; btn.textContent = label; }
      },
    };

    function finish(value) {
      d.remove();
      try { if (onClose) onClose(value, handle); } catch (e) { console.error(e); }
      const back = trigger && trigger.isConnected && trigger !== document.body ? trigger : resolveFocus(opts.returnFocus) || ui.title;
      if (back && typeof back.focus === 'function') back.focus({ preventScroll: true });
      resolve(value);
    }

    async function act(i) {
      const a = actions[i];
      const btn = buttons[i];
      if (!a || handle.isBusy || settled || (btn && btn.getAttribute('aria-disabled') === 'true')) return;
      if (a.onClick) {
        let r;
        try {
          if (a.busy) handle.busy(a.busy, i);
          r = await a.onClick(handle);
        } catch (e) {
          console.error(e);
          r = false;
        }
        if (!settled) handle.busy(false);
        if (r === false || settled) return;
      }
      handle.close(a.value !== undefined ? a.value : !a.cancel);
    }

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const at = e.submitter && e.submitter.dataset.action;
      act(at !== undefined ? Number(at) : buttons.findIndex((b) => b.type === 'submit'));
    });
    for (const b of buttons) {
      if (b.tagName === 'A') {
        b.addEventListener('click', (e) => {
          // A new tab or window (modifier keys, middle click) leaves the dialog as it is.
          if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
          e.preventDefault();
          const a = actions[Number(b.dataset.action)];
          if (handle.isBusy || settled || b.getAttribute('aria-disabled') === 'true') return;
          try { if (a.onClick && a.onClick(handle) === false) return; } catch (err) { console.error(err); return; }
          const url = b.getAttribute('href');
          handle.close(a.value !== undefined ? a.value : 'link');
          if (url.startsWith('#')) go(url); else window.location.assign(url);
        });
      } else if (b.type === 'button') b.addEventListener('click', () => act(Number(b.dataset.action)));
    }
    d.addEventListener('cancel', (e) => { e.preventDefault(); if (!handle.isBusy) handle.close(null); });
    d.addEventListener('close', () => { if (!settled) { settled = true; finish(null); } });
    d.showModal();
    try { if (onOpen) onOpen(handle); } catch (e) { console.error(e); }
    return handle;
  }

  function confirm(opts = {}) {
    const h = dialog({
      title: opts.title || 'Are you sure?',
      html: opts.html || (opts.text ? `<p>${esc(opts.text)}</p>` : ''),
      actions: [
        { label: opts.confirm || 'OK', value: true, primary: true },
        { label: opts.cancel || 'Cancel', value: false, cancel: true, autofocus: Boolean(opts.danger) },
      ],
      trigger: opts.trigger,
      returnFocus: opts.returnFocus,
    });
    return h.result.then((v) => v === true);
  }

  function tabs(items, current, opts = {}) {
    return `<nav class="tabs" aria-label="${esc(opts.label || 'Views')}">${items.map((t) => {
      const n = t.count !== undefined && t.count !== null && t.count !== '' ? ` <span class="${t.mark && Number(t.count) > 0 ? 'chip-mark' : 'chip'}">${esc(t.count)}</span>` : '';
      return `<a href="${esc(t.href)}"${t.key === current ? ' aria-current="page"' : ''}>${esc(t.label)}${n}</a>`;
    }).join('')}</nav>`;
  }

  // ================================================================ router
  const routes = [];
  let current = null;
  let seq = 0;
  let booted = false;
  let pendingFocus = null;
  let leaveGuard = null;
  let guardPrefix = null;

  function route(prefix, handler, opts = {}) {
    const p = String(prefix || '').replace(/^#?\/*/, '').replace(/\/+$/, '');
    const r = { prefix: p, segs: p ? p.split('/') : [], handler, opts };
    const i = routes.findIndex((x) => x.prefix === p);
    if (i >= 0) routes[i] = r; else routes.push(r);
  }

  function parse(hash) {
    const raw = String(hash || '').replace(/^#\/?/, '');
    const qi = raw.indexOf('?');
    const path = qi >= 0 ? raw.slice(0, qi) : raw;
    const query = {};
    for (const [k, v] of new URLSearchParams(qi >= 0 ? raw.slice(qi + 1) : '')) query[k] = v;
    return { segs: path.split('/').filter(Boolean).map(dec), query, hash: `#/${raw}` };
  }

  function match(segs) {
    let best = null;
    for (const r of routes) {
      if (r.segs.length > segs.length || !r.segs.every((s, i) => s === segs[i])) continue;
      if (!best || r.segs.length > best.segs.length) best = r;
    }
    return best;
  }

  let navNow = 'overview';
  function setNav(key) {
    navNow = key || 'overview';
    for (const a of $$('[data-nav]')) {
      if (a.dataset.nav === key) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    }
  }

  /** The nav's sections as the nav lists them: {key, href, label, group} (the label without its count). */
  function navItems() {
    let group = 0;
    return [...(ui.nav ? ui.nav.children : [])].flatMap((el) => {
      if (el.matches('.nav-rule')) { group++; return []; }
      if (!el.matches('a[data-nav]')) return [];
      const label = [...el.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent).join('').trim();
      return [{ key: el.dataset.nav, href: el.getAttribute('href'), label, group }];
    });
  }

  /** The waiting count as the nav shows it: the number, read out as "N waiting". */
  const countHtml = (n) => (n ? `<span class="sr-only">, </span>${n}<span class="sr-only"> waiting</span>` : '');

  /** Phones: the Menu button names the current section and carries the waiting count. */
  function syncNavMenu(n) {
    if (!ui.navMenu) return;
    const items = navItems();
    const cur = items.find((x) => x.key === navNow) || items[0];
    if (ui.navMenuCur && cur && ui.navMenuCur.textContent !== cur.label) ui.navMenuCur.textContent = cur.label;
    if (ui.navMenuCount) {
      ui.navMenuCount.hidden = !n;
      const html = n ? `<span class="sr-only">, </span>${n}<span class="sr-only"> waiting in Action items</span>` : '';
      if (ui.navMenuCount.innerHTML !== html) ui.navMenuCount.innerHTML = html;
    }
  }

  /** Phones: the sheet behind the Menu button, with the six sections and the waiting count. */
  function openNavSheet() {
    const n = workspace() ? waitingCount() : 0;
    const items = navItems();
    const groups = [...new Set(items.map((x) => x.group))].map((g) => items.filter((x) => x.group === g));
    const li = (x) => `<li><a class="nav-sheet-item" href="${esc(x.href)}"${x.key === navNow ? ' aria-current="page"' : ''}><span>${esc(x.label)}</span>${x.key === 'tasks' && n ? `<span class="nav-count">${countHtml(n)}</span>` : ''}</a></li>`;
    let offHash = null;
    dialog({
      title: 'Menu',
      className: 'nav-sheet',
      html: `<nav aria-label="Workspace">${groups.map((g) => `<ul class="nav-sheet-list">${g.map(li).join('')}</ul>`).join('')}</nav>`,
      actions: [{ label: 'Close', cancel: true }],
      trigger: ui.navMenu,
      onOpen: (h) => {
        const cur = $('[aria-current="page"]', h.body) || $('a', h.body);
        if (cur) cur.focus();
        h.body.addEventListener('click', (e) => {
          const a = e.target.closest && e.target.closest('a[href^="#/"]');
          // A new tab or window (modifier keys, middle click) leaves the sheet as it is.
          if (!a || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
          e.preventDefault();
          const to = a.getAttribute('href');
          h.close('link');
          go(to);
        });
        // Back or forward while the sheet is open: the sheet closes with it.
        offHash = () => h.close(null);
        window.addEventListener('hashchange', offHash);
      },
      onClose: () => { if (offHash) window.removeEventListener('hashchange', offHash); },
    });
  }

  /** In a strip that scrolls sideways (a tab strip), bring the current item into view. */
  function revealCurrent(root) {
    for (const strip of $$('.tabs', root)) {
      const cur = $('[aria-current="page"]', strip);
      if (!cur || strip.scrollWidth <= strip.clientWidth) continue;
      const left = cur.getBoundingClientRect().left - strip.getBoundingClientRect().left + strip.scrollLeft;
      strip.scrollLeft = Math.max(0, left - (strip.clientWidth - cur.offsetWidth) / 2);
    }
  }

  function setSlot(node, html) {
    if (!node) return;
    node.innerHTML = html || '';
    node.hidden = !html;
  }

  function render(heading, html, navKey, opts = {}) {
    ui.title.textContent = heading;
    setSlot(ui.eyebrow, opts.eyebrow);
    setSlot(ui.actions, opts.actions);
    setSlot(ui.lede, opts.lede);
    ui.view.innerHTML = html;
    setNav(navKey || (current && current.nav) || 'overview');
    document.title = `${heading} | ${titleName()} | Backbrief`;
    syncChrome();
    if (typeof opts.before === 'function') opts.before(ui.view);
    revealCurrent(document);
    const p = pendingFocus;
    pendingFocus = null;
    if (!p) return;
    if (p.refresh) {
      const t = resolveFocus(opts.focus) || resolveFocus(p.focus) || resolveFocus(p.restore);
      if (t && !t.hasAttribute('tabindex') && !/^(A|BUTTON|INPUT|SELECT|TEXTAREA|SUMMARY)$/.test(t.tagName)) t.setAttribute('tabindex', '-1');
      if (t) t.focus({ preventScroll: true });
      else if (p.hadFocusInView) ui.title.focus({ preventScroll: true });
      return;
    }
    const t = resolveFocus(opts.focus) || resolveFocus(p.focus);
    if (t) focusTarget(t);
    else if (!p.initial) { ui.title.focus({ preventScroll: true }); window.scrollTo({ top: 0, behavior: 'instant' }); }
  }

  function renderLoading(r, needs) {
    const p = pendingFocus;
    pendingFocus = null;
    const kinds = needs.map((k) => k.replace(/\?$/, '').split(':')[0]);
    const noun = r.opts.loading || (kinds.includes('call') || kinds.includes('transcript') ? 'call'
      : kinds.includes('vault') ? 'repository map' : kinds.includes('people') ? 'profiles' : 'workspace');
    render(r.opts.title || 'Loading…', loading(noun), r.opts.nav);
    pendingFocus = p;
  }

  function renderError(r, parts, e) {
    if (e && e.status === 404 && typeof r.opts.notFound === 'function') {
      const x = r.opts.notFound(parts, e);
      render(x.title, x.html, r.opts.nav, { eyebrow: x.eyebrow, lede: x.lede });
      return;
    }
    render(e && e.status === 404 ? 'Not found' : 'Something went wrong', emptyState(`
      <p>${esc(e && e.status === 404 ? e.message : `This page could not load: ${e ? e.message : 'unknown error'}.`)}</p>
      <p><a href="#/">Back to Overview</a></p>`), r.opts.nav || 'overview');
  }

  function focusKey(a) {
    if (!a || a === document.body || !ui.view.contains(a)) return null;
    if (a.id) return `#${CSS.escape(a.id)}`;
    if (a.dataset && a.dataset.key) return `[data-key="${CSS.escape(a.dataset.key)}"]`;
    if (a.name) return `[name="${CSS.escape(a.name)}"]`;
    return null;
  }

  async function run(o = {}) {
    let loc = parse(location.hash);
    let r = match(loc.segs);
    if (!r || (r.prefix === '' && loc.segs.length)) {
      if (location.hash && location.hash !== '#/' && location.hash !== '#') history.replaceState(null, '', '#/');
      loc = parse('#/');
      r = match([]);
      if (!r) return;
    }
    const my = ++seq;
    const parts = loc.segs.slice(r.segs.length);
    current = { prefix: r.prefix, parts, query: loc.query, hash: loc.hash, nav: r.opts.nav || r.segs[0] || 'overview' };
    BB.current = current;
    if (guardPrefix !== null && guardPrefix !== r.prefix) { leaveGuard = null; guardPrefix = null; }
    const a = document.activeElement;
    pendingFocus = o.refresh
      ? { refresh: true, focus: o.focus, restore: focusKey(a), hadFocusInView: ui.view.contains(a) && a !== ui.view }
      : { refresh: false, focus: o.focus, initial: Boolean(o.initial) };
    const needs = (typeof r.opts.needs === 'function' ? r.opts.needs(parts, loc.query) : r.opts.needs) || ['workspace'];
    if (!o.refresh && needs.some((k) => cached(k.replace(/\?$/, '')) === undefined)) renderLoading(r, needs);
    let error = null;
    await Promise.all(needs.map((k) => (k.endsWith('?') ? load(k.slice(0, -1)).catch(() => null) : load(k)))).catch((e) => { error = e; });
    if (my !== seq) return;
    if (error) {
      if (!error.signedOut) renderError(r, parts, error);
      return;
    }
    const ctx = { stale: () => my !== seq, render: (...args) => { if (my === seq) render(...args); } };
    try {
      await r.handler(parts, loc.query, ctx);
    } catch (e) {
      console.error(e);
      if (my === seq) renderError(r, parts, e);
    }
    if (my === seq) emit('route', current);
  }

  function go(hash, opts = {}) {
    let h = String(hash || '#/');
    if (!h.startsWith('#')) h = `#${h.startsWith('/') ? '' : '/'}${h}`;
    if (opts.replace) { history.replaceState(null, '', h); run(); return; }
    if (location.hash === h) run();
    else location.hash = h;
  }

  function refresh(opts = {}) {
    stateVersion++;
    if (!booted) return Promise.resolve();
    return run({ ...opts, refresh: true });
  }

  function setLeaveGuard(fn) {
    leaveGuard = typeof fn === 'function' ? fn : null;
    guardPrefix = leaveGuard && current ? current.prefix : null;
  }

  async function onHashChange() {
    const h = location.hash;
    if (h && h !== '#' && !h.startsWith('#/')) {
      // An in-page anchor (#main, #proposals): focus it, keep the route.
      const target = document.getElementById(dec(h.slice(1)));
      history.replaceState(null, '', current ? current.hash : '#/');
      if (target) focusTarget(target, 'start');
      return;
    }
    if (current && leaveGuard) {
      const to = h || '#/';
      let ask = null;
      try { ask = leaveGuard(to, current.hash); } catch (e) { console.error(e); }
      if (ask) {
        history.replaceState(null, '', current.hash);
        const ok = await confirm({
          title: 'Leave without saving?',
          text: typeof ask === 'string' ? ask : 'Your changes on this page are not saved.',
          confirm: 'Leave', cancel: 'Stay', returnFocus: ui.title,
        });
        if (!ok) return;
        leaveGuard = null;
        guardPrefix = null;
        if (location.hash === to) run(); else location.hash = to;
        return;
      }
    }
    run();
  }

  function onDocClick(e) {
    const a = e.target.closest && e.target.closest('a[href^="#"]');
    if (a) {
      const h = a.getAttribute('href');
      if (h !== '#' && !h.startsWith('#/')) {
        const target = document.getElementById(dec(h.slice(1)));
        if (target) { e.preventDefault(); focusTarget(target, 'start'); }
      }
      return;
    }
    const j = e.target.closest && e.target.closest('[data-jump]');
    if (j) {
      const target = document.getElementById(j.dataset.jump);
      if (target) { e.preventDefault(); focusTarget(target, 'start'); }
    }
  }

  // ================================================================ shell
  /** The tour: a call's decisions, its tasks, who owns what, and the memory that answers why. */
  function tourSteps() {
    const w = workspace();
    const callId = (w.stats.last_call && w.stats.last_call.id) || (w.calls[0] && w.calls[0].id) || null;
    return [
      { label: 'What a call decided', href: callId ? href('call', callId) : '#/calls', on: (c) => c.prefix === 'call' && c.parts[0] === callId },
      { label: 'Review its tasks', href: '#/tasks', on: (c) => c.prefix === 'tasks' },
      { label: 'Who owns what', href: '#/tasks/open', on: (c) => c.prefix === 'tasks/open' },
      { label: 'Ask the memory why', href: '#/memory', on: (c) => c.prefix === 'memory' },
    ];
  }

  /** Builds the tour banner once the workspace has loaded; syncChrome keeps its current step. */
  function buildBanner() {
    if (!ui.banner || !isDemo || ui.banner.dataset.built) return;
    ui.banner.dataset.built = '1';
    ui.banner.setAttribute('role', 'region');
    ui.banner.setAttribute('aria-label', 'Demo tour');
    ui.banner.innerHTML = `<div class="banner-row">
        <div class="banner-text">
          <p class="banner-lead">Demo workspace for ${esc(company())}, a fictional team. Take the tour:</p>
          <ol class="tour">${tourSteps().map((s, i) => `<li><a href="${esc(s.href)}" data-tour-step="${i}"><span class="tour-n">${i + 1}</span> ${esc(s.label)}</a></li>`).join('')}</ol>
        </div>
        <button class="banner-x" type="button" data-tour-hide aria-label="Hide the tour"><span aria-hidden="true">×</span></button>
      </div>
      <p class="banner-sub">Everything runs in your browser.</p>`;
    $('[data-tour-hide]', ui.banner).addEventListener('click', () => {
      state.prefs.tour_hidden = true;
      save();
      syncChrome();
      ui.title.focus({ preventScroll: true });
    });
  }

  function syncBanner() {
    if (!ui.banner || !ui.banner.dataset.built) return;
    const hidden = Boolean(isObj(state.prefs) && state.prefs.tour_hidden);
    ui.banner.hidden = hidden;
    if (ui.menuTour) ui.menuTour.hidden = !hidden;
    const steps = tourSteps();
    for (const a of $$('[data-tour-step]', ui.banner)) {
      const s = steps[Number(a.dataset.tourStep)];
      if (s && current && s.on(current)) a.setAttribute('aria-current', 'step');
      else a.removeAttribute('aria-current');
    }
  }

  function syncChrome() {
    if (!workspace()) return;
    const n = waitingCount();
    if (ui.navCount) {
      ui.navCount.hidden = !n;
      const html = countHtml(n);
      if (ui.navCount.innerHTML !== html) ui.navCount.innerHTML = html;
    }
    syncNavMenu(n);
    if (!isDemo) return;
    const c = changeCount();
    const label = c ? `Reset demo · ${plural(c, 'change')}` : 'Reset demo';
    for (const b of [ui.reset, ui.menuReset]) if (b && b.textContent !== label) b.textContent = label;
    buildBanner();
    syncBanner();
  }

  /** The header's ⋯ menu (phones): Reset demo, the tour, and in /app the account. */
  function setMenu(open, focus) {
    if (!ui.menu || !ui.menuBtn) return;
    ui.menu.hidden = !open;
    ui.menuBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) {
      const first = $$('button, a', ui.menu).find((x) => !x.closest('[hidden]') && x.getClientRects().length);
      if (first) first.focus();
    } else if (focus) ui.menuBtn.focus();
  }

  function wireMenu() {
    if (!ui.menu || !ui.menuBtn) return;
    ui.menuBtn.addEventListener('click', () => setMenu(ui.menu.hidden));
    ui.menu.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setMenu(false, true); } });
    ui.menu.addEventListener('focusout', (e) => {
      if (e.relatedTarget && !ui.menu.contains(e.relatedTarget) && e.relatedTarget !== ui.menuBtn) setMenu(false);
    });
    document.addEventListener('click', (e) => {
      if (!ui.menu.hidden && !ui.menu.contains(e.target) && !ui.menuBtn.contains(e.target)) setMenu(false);
    });
    if (ui.menuReset) ui.menuReset.addEventListener('click', () => { setMenu(false); onReset(ui.menuBtn); });
    if (ui.menuTour) {
      ui.menuTour.addEventListener('click', () => {
        setMenu(false);
        state.prefs.tour_hidden = false;
        save();
        syncChrome();
        const first = $('[data-tour-step]', ui.banner);
        if (first) first.focus();
      });
    }
  }

  async function onReset(trigger) {
    const ok = await confirm({
      title: 'Reset the demo?',
      text: 'This clears your approvals, skips, edits, Slack settings, added people and connection changes in this browser.',
      confirm: 'Reset demo',
      cancel: 'Cancel',
      trigger: trigger && trigger.isConnected && trigger.getClientRects().length ? trigger : ui.title,
    });
    if (!ok) return;
    reset();
    await refresh();
    toast(`Demo reset to ${fmtDay(lastCallDate())}.`, DEMO_NOTE.browser);
  }

  // ================================================================ shared views
  const profiled = (lastname) => effectivePeople().people.some((p) => p.lastname === lastname);
  /** A teammate's name, linked to the profile when there is one. */
  function person(lastname) {
    if (!lastname) return '';
    return profiled(lastname) ? `<a href="${esc(href('people', lastname))}">${esc(lastname)}</a>` : esc(lastname);
  }

  /** One call in a ledger: the full row (Calls) or the compact one (Overview, profiles). */
  function callRow(c, opts = {}) {
    const e = effectiveProposals(c.id);
    const waiting = e ? e.pending : (c.proposals && c.proposals.pending) || 0;
    const mark = waiting ? `<span class="chip-mark">${waiting} waiting</span>` : '';
    const who = `${esc((c.participants || []).join(', '))}${c.duration_min ? ` · ${esc(c.duration_min)} min` : ''}`;
    if (opts.compact) {
      return `<li class="call-row">
        <span class="call-date">${esc(fmtDay(c.date))}</span>
        <div class="call-main">
          <p class="call-topic"><a class="call-link" href="${esc(href('call', c.id))}">${esc(c.topic)}</a> ${mark}</p>
          <p class="call-people">${c.team ? `${esc(c.team)} · ` : ''}${who}</p>
        </div>
      </li>`;
    }
    const total = (c.proposals && c.proposals.total) || 0;
    const counts = [
      plural(c.decisions_count || 0, 'decision'),
      plural(c.agreements_count || 0, 'agreement'),
      plural(c.action_items_count || 0, 'action item'),
      plural(total, 'proposal'),
    ].map(esc);
    if (c.has_transcript && canOpenTranscript(c.id)) counts.push(`<a href="${esc(href('call', c.id, 'transcript'))}">Transcript</a>`);
    const more = (c.decisions_count || 0) - 1;
    const decided = c.first_decision
      ? `<p class="call-decision"><span class="call-decision-k">Decided</span> ${esc(c.first_decision)}${more > 0 ? ` <span class="muted">+${esc(more)} more</span>` : ''}</p>`
      : '';
    return `<li class="call-row">
      <span class="call-date"><span>${esc(fmtDay(c.date))}</span>${c.time ? `<span>${esc(c.time)}</span>` : ''}</span>
      <div class="call-main">
        <p class="call-topic"><a class="call-link" href="${esc(href('call', c.id))}">${esc(c.topic)}</a>
          <span class="call-meta">${teamChip(c.team)}${c.call_type ? `<span>${esc(c.call_type)}</span>` : ''}${mark}</span></p>
        ${decided}
        <p class="call-people">${who}</p>
        <p class="call-counts">${counts.join(' · ')}</p>
        ${opts.after || ''}
      </div>
    </li>`;
  }

  /** "Follow-up: Hughes" (a link to the profile when there is one); "· done" once a later call records it. */
  function followUpChip(fu) {
    if (!fu || !fu.owner) return '';
    const done = Boolean(fu.closed_by) || fu.status === 'done-on-call';
    const label = `Follow-up: ${fu.owner}${done ? ' · done' : ''}`;
    return profiled(fu.owner)
      ? `<a class="chip dec-owner" href="${esc(href('people', fu.owner))}">${esc(label)}</a>`
      : `<span class="chip dec-owner">${esc(label)}</span>`;
  }

  /** One decision (workspace.decisions[]) as a ledger row: title, why, ▶, the call, the follow-up owner. */
  function decisionRow(d, opts = {}) {
    return `<li class="dec-row">
      <span class="dec-date">${esc(fmtDay(d.date))}</span>
      <div class="dec-main">
        <p class="dec-title">${esc(d.title)}</p>
        ${d.why ? `<p class="dec-why">Why: ${esc(d.why)}</p>` : ''}
        <p class="dec-meta">${ts(d.call_id, d.ts)} <a href="${esc(href('call', d.call_id))}">${esc(d.topic)}</a>${opts.compact || !d.team ? '' : ` ${teamChip(d.team)}`} ${followUpChip(d.follow_up)}</p>
      </div>
    </li>`;
  }

  // ================================================================ Overview (§3.1)
  const SOURCE_NAMES = { zoom: 'Zoom', slack: 'Slack', linear: 'Linear', github: 'GitHub' };

  function repoName() {
    const gh = effectiveSources().find((s) => s.id === 'github');
    if (gh && gh.account) return gh.account;
    const url = workspace() && workspace().workspace.vault_url;
    const m = String(url || '').match(/^https:\/\/github\.com\/([^/]+\/[^/]+)/);
    return m ? m[1] : null;
  }

  // What stops while a source is off (the alert row and the health line say it).
  const SOURCE_OFF = {
    zoom: "New recordings aren't processed.",
    slack: "Digests aren't posted to Slack.",
    linear: "Approved tasks aren't filed in Linear.",
    github: "New calls aren't saved to your repository.",
  };
  const sourceName = (id) => SOURCE_NAMES[id] || id;
  const failures = (s) => (s && isObj(s.health) && Number.isFinite(Number(s.health.failures_30d)) ? Number(s.health.failures_30d) : 0);

  /** Reviews made here since the reviews were last posted to the call's Slack thread. */
  function unposted(e) {
    const mine = e.proposals.filter((p) => p.by === 'you');
    const sent = e.log_sent ? Date.parse(e.log_sent.at) : NaN;
    return Number.isNaN(sent) ? mine.length : mine.filter((p) => !(Date.parse(p.at) <= sent)).length;
  }

  /**
   * What follows the reviews made here. With the task log on, the call's thread
   * already updated in place: the quiet "Updated in the call's Slack thread"
   * line. With it off: "Post reviews to Slack" while reviews are unposted, else
   * when they were posted.
   */
  function afterReviews(e, primary = false) {
    if (!isDemo) return '';
    if (taskLogOn()) return threadNote(e);
    if (unposted(e)) return `<button class="btn btn-small${primary ? '' : ' btn-ghost'}" type="button" data-send-log="${esc(e.call_id)}">Post reviews to Slack</button>`;
    if (e.log_sent) return `<p class="attn-done">Reviews posted to <span class="mono">${esc(e.log_sent.channel || '#call-digests')}</span>, ${esc(stamp(e.log_sent.at, ' '))}.</p>`;
    return '';
  }

  /** "All 4 proposals from 19 Oct are reviewed: 2 created, 1 commented, 1 skipped." */
  function reviewedLine(nd, e) {
    const mine = e.proposals.filter((p) => p.by === 'you');
    const n = (r) => mine.filter((p) => p.decision.result === r).length;
    const parts = [n('created') && `${n('created')} created`, n('commented') && `${n('commented')} commented`, n('skipped') && `${n('skipped')} skipped`].filter(Boolean);
    const what = nd.pending === 1 ? `The proposal from ${fmtDay(nd.date)} is reviewed` : `All ${nd.pending} proposals from ${fmtDay(nd.date)} are reviewed`;
    return `${what}${parts.length ? `: ${parts.join(', ')}` : ''}.`;
  }

  /** Calls that had proposals waiting, with what the overlay made of them: {nd, e, waiting}. */
  function waitingCalls() {
    const w = workspace();
    return ((w.overview && w.overview.needs_decision) || [])
      .map((nd) => ({ nd, e: effectiveProposals(nd.call_id) }))
      .filter((x) => x.e)
      .map((x) => ({ ...x, waiting: x.e.proposals.filter((p) => p.status === 'pending') }));
  }

  /** The demo's closing moment: every proposal that waited is reviewed, here. */
  function closingState() {
    if (!isDemo || waitingCount() > 0) return null;
    const done = waitingCalls().filter((x) => !x.waiting.length && x.e.decided_here > 0);
    return done.length ? done : null;
  }

  /** A source that is off, or failing: first in "Needs a review". */
  function sourceRows() {
    const rows = [];
    for (const s of effectiveSources()) {
      const name = sourceName(s.id);
      if (s.status !== 'connected') {
        const what = `${name} ${s.changed_here ? 'is disconnected' : "isn't connected"}. ${SOURCE_OFF[s.id] || ''}`.trim();
        const btn = isDemo
          ? `<a class="btn btn-small" href="${esc(href('sources', s.id))}">${s.changed_here ? 'Reconnect' : 'Connect'} ${esc(name)}</a>`
          : `<a class="btn btn-small btn-ghost" href="${esc(href('sources', s.id))}">${esc(name)} in Sources</a>`;
        rows.push(`<div class="attn-row is-inline is-alert">
          <p class="attn-what"><span class="status-dot is-off" aria-hidden="true"></span> <strong>${esc(what)}</strong></p>
          <div class="attn-do">${btn}</div>
        </div>`);
      } else if (failures(s)) {
        rows.push(`<div class="attn-row is-inline is-alert">
          <p class="attn-what"><span class="status-dot is-off" aria-hidden="true"></span> <strong>${esc(`${name} failed ${plural(failures(s), 'time')} in the last 30 days.`)}</strong></p>
          <div class="attn-do"><a class="btn btn-small btn-ghost" href="${esc(href('sources', s.id))}">See ${esc(name)}</a></div>
        </div>`);
      }
    }
    return rows;
  }

  /** Waiting proposals, calls reviewed here (when not closing), and the unprofiled teammate. */
  function waitingRows(closing) {
    const rows = [];
    for (const { nd, e, waiting } of waitingCalls()) {
      if (waiting.length) {
        // Approving several at once is off on planning and mixed calls, so no such chip there.
        const together = e.bulk.approve_safe.allowed ? waiting.filter((p) => p.safe).length : 0;
        const flagged = waiting.filter((p) => p.verdict === 'FLAG').length;
        const tracked = waiting.filter((p) => p.verdict === 'DUPLICATE').length;
        const chips = [
          together > 1 ? `<span class="chip">${together} can be approved together</span>` : '',
          flagged ? `<span class="v v-flag">${plural(flagged, 'possible duplicate')}</span>` : '',
          tracked ? `<span class="v v-duplicate v-tracked">${tracked} already tracked</span>` : '',
        ].join('');
        rows.push(`<div class="attn-row">
          <p class="attn-what"><strong>${plural(waiting.length, 'task proposal')}</strong> from <a href="${esc(href('call', nd.call_id))}">${esc(nd.topic)}</a> <span class="mono muted">· ${esc(fmtDay(nd.date))}</span></p>
          <div class="attn-do"><span class="attn-chips">${chips}</span><a class="btn btn-small" href="${esc(href('tasks', 'call', nd.call_id))}">Review ${plural(waiting.length, 'proposal')}</a></div>
          ${threadNote(e)}
        </div>`);
      } else if (!closing) {
        const post = afterReviews(e, true);
        rows.push(`<div class="attn-row is-inline">
          <p class="attn-what">${esc(reviewedLine(nd, e))}</p>
          ${post ? (post.startsWith('<p') ? post : `<div class="attn-do">${post}</div>`) : ''}
        </div>`);
      }
    }
    for (const u of effectivePeople().unprofiled.filter((x) => x.kind === 'teammate')) {
      rows.push(`<div class="attn-row is-inline">
        <p class="attn-what">${esc(u.token)} is named on ${plural(u.calls, 'call')} but has no profile.</p>
        ${isDemo ? `<div class="attn-do"><a class="btn btn-small btn-ghost" href="${esc(href('people', 'add', { last: u.token }))}">Add profile</a></div>` : ''}
      </div>`);
    }
    return rows;
  }

  function waitingPanel(rows, empty = true) {
    const w = workspace();
    if (!rows.length && !empty) return '';
    const body = rows.length ? rows.join('') : `<div class="attn-row"><p class="attn-what">${w.calls.length
      ? 'Nothing needs a review. Proposals from your next call show up here.'
      : "Nothing needs a review yet. Your first call's proposals show up here."}</p></div>`;
    return `<section class="panel${rows.length ? ' attn' : ''}" aria-labelledby="h-waiting"><h2 id="h-waiting">Needs a review</h2>${body}</section>`;
  }

  /** After the last waiting proposal is reviewed in the demo: the loop, and the way to see it on your stack. */
  function closingPanel(done) {
    const head = done.length === 1 ? reviewedLine(done[0].nd, done[0].e) : 'Every proposal that was waiting is reviewed.';
    const lines = done.length > 1 ? `<ul class="plain closing-calls">${done.map(({ nd, e }) => `<li>${esc(reviewedLine(nd, e))}</li>`).join('')}</ul>` : '';
    // The task log on: each call's thread already shows the reviews. Off: post them by hand.
    const notes = taskLogOn() ? done.map(({ e }) => threadNote(e, { topic: done.length > 1 })).join('') : '';
    const posts = taskLogOn() ? '' : done.map(({ e }) => afterReviews(e)).filter(Boolean).join('');
    return `<section class="panel closing" aria-labelledby="h-closing">
      <h2 id="h-closing">${esc(head)}</h2>
      ${lines}${notes}
      <p class="closing-lead">That's the loop after every call: decisions on record, tasks filed with owners, everything kept in your repository.</p>
      <div class="closing-do"><a class="btn" href="${esc(bookHref())}">Book a demo</a>${posts}</div>
    </section>`;
  }

  /**
   * One compact line instead of a panel: "All 4 sources healthy · last call
   * processed 19 Oct, 10:44 (digest 9 min after the call)". A source that is
   * off or failing turns it into a warning (its row also leads "Needs a review").
   */
  function healthLine() {
    const w = workspace();
    const srcs = effectiveSources();
    const off = srcs.filter((s) => s.status !== 'connected');
    const failing = srcs.filter((s) => s.status === 'connected' && failures(s));
    // Health data exists in the demo; /app knows only which sources are connected, so it claims no more.
    const known = srcs.some((s) => isObj(s.health));
    const clause = (s) => (s ? s.charAt(0).toLowerCase() + s.slice(1).replace(/\.$/, '') : 'nothing new comes in');
    let text;
    if (off.length) {
      const names = joinAnd(off.map((s) => sourceName(s.id)));
      text = off.length === 1
        ? `${names} ${off[0].changed_here ? 'is disconnected' : "isn't connected"}: ${clause(SOURCE_OFF[off[0].id])}`
        : `${names} are not connected`;
    } else if (failing.length) {
      text = `${joinAnd(failing.map((s) => sourceName(s.id)))} ${failing.length === 1 ? 'needs' : 'need'} a look: ${plural(failing.reduce((n, s) => n + failures(s), 0), 'failure')} in 30 days`;
    } else {
      text = known ? `All ${srcs.length} sources healthy` : `${srcs.length === 4 ? 'All 4' : srcs.length} sources connected`;
    }
    const ok = !off.length && !failing.length;
    const m = (w.overview && w.overview.metrics && w.overview.metrics.processing) || null;
    const last = m && isObj(m.last) ? m.last : null;
    let processed = '';
    if (last && Number.isFinite(Date.parse(last.at))) {
      const mins = Number.isFinite(last.minutes) ? ` (digest ${plural(last.minutes, 'min', 'min')} after the call)` : '';
      processed = ` · last call processed ${fmtDay(dayOf(Date.parse(last.at)))}, ${clock(last.at)}${mins}`;
    } else if (!w.calls.length) processed = ' · no calls processed yet';
    return `<p class="health${ok ? '' : ' is-problem'}"><span class="status-dot${ok ? '' : ' is-off'}" aria-hidden="true"></span>`
      + `<span><a href="#/sources">${esc(text)}</a>${esc(processed)}</span></p>`;
  }

  /** The five review tiles, recomputed with the reviews made here. */
  function statTiles() {
    const m = effectiveMetrics();
    const va = m.verdict_agreement;
    const tt = m.time_to_decision;
    const r = m.reviews;
    const tiles = [
      {
        k: 'Decisions on record', v: m.decisions.total, to: '#/calls/decisions',
        sub: m.decisions.last_7_days ? `${m.decisions.last_7_days} in the last 7 days` : 'none in the last 7 days',
      },
      { k: 'Proposals reviewed', v: r.reviewed, of: r.total, sub: r.waiting ? `${r.waiting} waiting` : 'none waiting', to: '#/tasks' },
      {
        k: 'Accepted as proposed', v: va.rate === null ? '—' : `${Math.round(va.rate * 100)}%`, to: href('tasks', { status: 'reviewed' }),
        sub: `${va.agreed} of ${plural(va.decided, 'review')}${va.edited ? ` · ${va.edited} edited` : ''}`,
      },
      { k: 'Duplicates prevented', v: m.duplicates_prevented.confirmed, sub: 'confirmed by your team' },
      {
        k: 'Time to review', v: fmtMinutes(tt.median_minutes),
        sub: `median, call end to last review${tt.over_48h ? ` · ${tt.over_48h} waiting over 48 h` : ''}`,
      },
    ];
    return `<ul class="stat-grid" aria-label="How proposals land">${tiles.map((t) => {
      const v = `${esc(t.v)}${t.of !== undefined ? ` <span class="stat-of">of ${esc(t.of)}</span>` : ''}`;
      const inner = `<span class="stat-k">${esc(t.k)}</span><span class="stat-v">${v}</span><span class="stat-sub">${esc(t.sub)}</span>`;
      return `<li class="stat">${t.to ? `<a class="stat-box" href="${esc(t.to)}">${inner}</a>` : `<div class="stat-box">${inner}</div>`}</li>`;
    }).join('')}</ul>`;
  }

  function recentCalls() {
    const w = workspace();
    return `<section class="panel" aria-labelledby="h-recent">
      <div class="panel-head"><h2 id="h-recent">Recent calls</h2><a href="#/calls">All calls</a></div>
      <ol class="call-list">${w.calls.slice(0, 5).map((c) => callRow(c, { compact: true })).join('')}</ol>
    </section>`;
  }

  /** Decisions from the last 7 days (on the demo's clock), newest first. */
  function decidedLastWeek() {
    const list = recentDecisions(7);
    return `<section class="panel" aria-labelledby="h-decided">
      <div class="panel-head"><h2 id="h-decided">Decided last week</h2><a href="#/calls/decisions">All decisions</a></div>
      ${list.length ? `<ol class="dec-list">${list.map((d) => decisionRow(d, { compact: true })).join('')}</ol>`
    : '<p class="panel-note">Nothing was decided on a call in the last 7 days.</p>'}
    </section>`;
  }

  /** Open items only (what Open items lists), per owner. */
  function openByOwner() {
    const items = effectiveActionItems().filter(isOpenItem);
    const by = new Map();
    for (const a of items) by.set(a.owner || '', (by.get(a.owner || '') || 0) + 1);
    const list = [...by].filter(([o]) => o).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .concat(by.has('') ? [['', by.get('')]] : []);
    const calls = new Set(items.map((a) => a.call_id)).size;
    const me = viewingAs();
    const rows = list.map(([owner, n]) => {
      const name = owner || 'No owner';
      return `<li><a class="owner-row${owner && owner === me ? ' is-me' : ''}" href="${esc(href('tasks', 'open', { owner: owner || 'none' }))}" aria-label="${esc(name)}, ${esc(plural(n, 'open item'))}">
      <span>${esc(name)}</span><span class="units" aria-hidden="true">${'<i></i>'.repeat(Math.min(n, 30))}</span><span class="owner-n">${esc(n)}</span></a></li>`;
    }).join('');
    return `<section class="panel" aria-labelledby="h-owners">
      <div class="panel-head"><h2 id="h-owners">Open items by owner</h2><a href="#/tasks/open">All open items</a></div>
      <p class="panel-note">${items.length ? `${esc(items.length)} open across ${esc(plural(calls, 'call'))}` : 'Nothing open.'}</p>
      ${rows ? `<ol class="owner-list">${rows}</ol>` : ''}
    </section>`;
  }

  /** People Overview can view as: profiles, plus anyone who owns an open item. */
  function viewers() {
    const names = new Map();
    for (const p of effectivePeople().people) names.set(p.lastname, p.name || p.lastname);
    for (const a of effectiveActionItems()) if (a.owner && isOpenItem(a) && !names.has(a.owner)) names.set(a.owner, a.owner);
    return [...names].sort((a, b) => a[0].localeCompare(b[0]));
  }

  function viewingSelect() {
    const list = viewers();
    if (!list.length) return '';
    const me = viewingAs();
    if (me && !list.some(([k]) => k === me)) list.push([me, me]);
    return `<label class="viewing"><span class="viewing-k">Viewing as</span> <select name="viewing_as" data-viewing>
      <option value="">Everyone</option>${list.map(([k, name]) => `<option value="${esc(k)}"${k === me ? ' selected' : ''}>${esc(name)}</option>`).join('')}
    </select></label>`;
  }

  /** "Yours: 2 open" and those items, for the teammate Overview is viewing as. */
  function minePanel() {
    const me = viewingAs();
    if (!me) return '';
    const items = openItemsFor(me);
    const rows = items.map((a) => `<li class="mine-row">
        <p class="mine-title">${esc(a.title)} ${prio(a.priority)}</p>
        <p class="mine-meta">${ts(a.call_id, a.ts)} <a href="${esc(href('call', a.call_id))}">${esc(a.call_topic || 'The call')}</a> <span class="mono">${esc(fmtDay(a.call_date))}</span> ${ref(a.tracker_ref)}</p>
      </li>`).join('');
    return `<section class="panel mine" aria-labelledby="h-mine">
      <div class="panel-head"><h2 id="h-mine">Yours: ${esc(items.length)} open</h2><a href="${esc(href('tasks', 'open', { owner: me }))}">${esc(`${me}'s open items`)}</a></div>
      ${rows ? `<ol class="mine-list">${rows}</ol>` : `<p class="panel-note">${esc(`Nothing is open for ${me}.`)}</p>`}
    </section>`;
  }

  /** "Saved to acme/vault on GitHub: 7 calls, 7 tasks files, 5 profiles. If you leave Backbrief, the files stay yours." */
  function savedLine() {
    const w = workspace();
    const repo = repoName();
    const files = [plural(w.stats.calls_total, 'call'), plural(w.task_log.filter((e) => e.tasks_path).length, 'tasks file'), plural(w.stats.people, 'profile')].join(', ');
    return `<p class="small muted saved-line">Saved to ${repo ? `<span class="mono">${esc(repo)}</span> on GitHub` : 'your git repository'}: ${esc(files)}. If you leave Backbrief, the files stay yours.</p>`;
  }

  function setupSteps() {
    const w = workspace();
    if (w.overview && Array.isArray(w.overview.setup) && w.overview.setup.length) return w.overview.setup;
    if (isDemo) return null;
    // /app knows only what the vault and the workspace flags say: no dates.
    const flags = w.workspace.integrations || {};
    const first = [...w.calls].sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`))[0];
    return [
      { id: 'sources', done: SOURCE_IDS.every((k) => flags[k]) },
      { id: 'people', done: w.stats.people > 0, count: w.stats.people },
      { id: 'slack', done: Boolean(flags.slack) },
      { id: 'first_call', done: Boolean(first), at: first ? first.date : null, call_id: first ? first.id : null },
    ];
  }

  function setupPanel() {
    const steps = setupSteps();
    if (!steps) return '';
    const w = workspace();
    const delivery = (cached('settings') && cached('settings').slack && cached('settings').slack.delivery) || null;
    const firstTopic = (id) => { const c = w.calls.find((x) => x.id === id); return c ? c.topic : ''; };
    const META = {
      // Step 00: the signed agreement comes before any setup; it has no page of its own.
      agreement: () => ({ title: 'Agreement signed', to: null, note: '', next: '' }),
      sources: () => ({ title: 'Tools connected', to: '#/sources', note: '', next: 'Connect your tools' }),
      people: (s) => ({ title: s.done ? `${plural(s.count || 0, 'profile')} confirmed` : "Check who's who", to: '#/people', note: '', next: 'Check profiles' }),
      slack: () => ({ title: 'Slack delivery chosen', to: '#/tasks/slack', note: delivery ? deliveryPhrase(delivery) : '', next: 'Choose what goes to Slack' }),
      first_call: (s) => ({ title: 'First call', to: s.call_id ? href('call', s.call_id) : '#/calls', note: s.call_id ? firstTopic(s.call_id) : '', next: 'See where calls arrive' }),
    };
    const nextAt = steps.findIndex((s) => !s.done);
    const from = steps[0] && steps[0].id === 'agreement' ? 0 : 1;
    const cells = steps.map((s, i) => {
      const m = (META[s.id] || (() => ({ title: s.id, to: '#/', note: '' })))(s);
      const n = pad(i + from);
      const when = [s.at ? fmtDay(s.at) : '', m.note].filter(Boolean).join(': ');
      const state = s.done ? '<span class="step-state">Done</span>' : i === nextAt ? '<span class="step-state is-next">Next</span>' : '<span class="step-state is-next">To do</span>';
      return `<li${s.done ? ' class="is-done"' : ''}>
        <p class="k"><span>${n}</span>${state}</p>
        <h3>${m.to ? `<a href="${esc(m.to)}">${esc(m.title)}</a>` : esc(m.title)}</h3>
        ${when ? `<p>${esc(when)}</p>` : ''}
        ${!isDemo && i === nextAt && m.to ? `<a class="btn btn-small" href="${esc(m.to)}">${esc(m.next)}</a>` : ''}
      </li>`;
    }).join('');
    return `<section class="setup" aria-labelledby="h-setup"><h2 id="h-setup">How this workspace was set up</h2><ol class="start setup-steps">${cells}</ol></section>`;
  }

  function overviewView() {
    const w = workspace();
    const has = w.calls.length > 0;
    const setup = setupPanel();
    const closing = closingState();
    const alerts = sourceRows();
    const rows = waitingRows(closing);
    // The closing panel takes the waiting panel's place; a source that is off still leads.
    const top = closing
      ? `${alerts.length ? waitingPanel([...alerts, ...rows], false) : ''}${closingPanel(closing)}${alerts.length ? '' : waitingPanel(rows, false)}`
      : waitingPanel([...alerts, ...rows]);
    const html = `
      ${!isDemo && !has ? setup : ''}
      ${top}
      ${minePanel()}
      ${statTiles()}
      ${has ? `<div class="two-col"><div class="col">${decidedLastWeek()}</div><div class="col">${openByOwner()}${recentCalls()}</div></div>` : ''}
      ${isDemo ? setup : ''}
      ${savedLine()}`;
    render('Overview', html, 'overview', {
      eyebrow: `${esc(displayName())} · ${esc(todayLabel())}`,
      lede: healthLine(),
      actions: viewingSelect(),
    });
    for (const b of $$('[data-send-log]', ui.view)) {
      b.addEventListener('click', () => {
        if (typeof hooks.sendLog === 'function') hooks.sendLog(b.dataset.sendLog, b);
        else go(href('tasks', 'call', b.dataset.sendLog));
      });
    }
    const sel = $('[data-viewing]', ui.actions);
    if (sel) {
      sel.addEventListener('change', () => {
        state.prefs.viewing_as = sel.value || null;
        save();
        refresh({ focus: '[data-viewing]' });
      });
    }
  }

  // ================================================================ Calls (§3.2)
  function weekOf(date) {
    const p = ymd(date);
    if (!p) return '';
    const d = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    return d.toISOString().slice(0, 10);
  }

  /** Calls · Decisions: the two views of the call record. */
  function callsTabs(key) {
    const w = workspace();
    return tabs([
      { key: 'calls', href: '#/calls', label: 'Calls', count: w.window && w.window.truncated ? w.window.total : w.calls.length },
      { key: 'decisions', href: '#/calls/decisions', label: 'Decisions', count: (w.decisions || []).length },
    ], key, { label: 'Calls and decisions' });
  }

  // What a search hit is, as its line says it.
  const HIT_KIND = {
    topic: 'Topic', people: 'People', tags: 'Tags', summary: 'Summary', decision: 'Decision', agreement: 'Agreement',
    action_item: 'Action item', open_question: 'Open question', key_insight: 'Key insight', quote: 'Quote', proposal: 'Task proposal',
  };

  /** The text with its first match of `needle` (lowercase) marked. */
  function markMatch(text, needle) {
    const s = String(text || '');
    const i = needle ? s.toLowerCase().indexOf(needle) : -1;
    return i < 0 ? esc(s) : `${esc(s.slice(0, i))}<mark>${esc(s.slice(i, i + needle.length))}</mark>${esc(s.slice(i + needle.length))}`;
  }

  /** A call's lines that match the search, each with its ▶ minute. */
  function hitsHtml(c, needle) {
    const lines = (c.search_lines || []).filter((l) => String(l.text || '').toLowerCase().includes(needle));
    if (!lines.length) return '';
    const shown = lines.slice(0, 4);
    return `<ul class="hits" aria-label="${esc(`Matches in ${c.topic}`)}">${shown.map((l) => `<li class="hit">
        <span class="hit-kind">${esc(HIT_KIND[l.kind] || 'Line')}</span>
        <span class="hit-text">${markMatch(l.text, needle)}</span>${l.ts ? ` ${ts(c.id, l.ts)}` : ''}
      </li>`).join('')}${lines.length > shown.length ? `<li class="hit hit-more">${esc(`and ${plural(lines.length - shown.length, 'more line')}`)}</li>` : ''}</ul>`;
  }

  /** What a call is searched by: what was said (digest, quotes, names), plus its topic, team, type and people. */
  const searchBlob = (c) => `${c.search || ''}\n${[c.topic, c.team, c.call_type, ...(c.participants || []), ...(c.external_participants || []), ...(c.tags || [])].join(' ')}`.toLowerCase();

  function callsView(parts, query) {
    if (parts[0] === 'decisions') { decisionsView(); return; }
    if (parts.length) { go('#/calls', { replace: true }); return; }
    const w = workspace();
    const teams = [...new Set(w.calls.map((c) => c.team).filter(Boolean))].sort();
    const dates = w.calls.map((c) => c.date).filter(Boolean).sort();
    const eyebrow = w.calls.length
      ? `${esc(plural(w.window && w.window.truncated ? w.window.total : w.calls.length, 'call'))}${dates.length ? ` · ${esc(fmtDay(dates[0]))} to ${esc(fmtDay(dates[dates.length - 1]))}` : ''}`
      : '';
    const filters = w.calls.length ? `
      <form class="filters" role="search" aria-label="Search and filter calls" data-calls-filters>
        <label class="grow">Search <input type="search" name="q" value="${esc(query.q || '')}" placeholder="Search decisions, quotes, names" autocomplete="off"></label>
        <label>Team <select name="team"><option value="">All teams</option>${teams.map((t) => `<option value="${esc(t)}"${t === query.team ? ' selected' : ''}>${esc(t)}</option>`).join('')}</select></label>
        <label class="check"><input type="checkbox" name="waiting" value="1"${query.waiting === '1' ? ' checked' : ''}> Only calls with proposals to review</label>
      </form>
      <p class="sr-only" role="status" data-calls-status></p>` : '';
    render('Calls', `${callsTabs('calls')}${filters}<div data-calls-list></div>`, 'calls', {
      eyebrow,
      lede: 'Every recorded call: what it decided and what it proposed.',
      actions: isDemo ? `<a class="btn btn-small btn-ghost" href="${esc(href('sources', 'imports'))}">Import a transcript</a>` : '',
    });
    const list = $('[data-calls-list]', ui.view);
    if (!w.calls.length) {
      list.innerHTML = emptyState('<p>No calls yet. Record your next call to the Zoom cloud; it shows up here about an hour after it ends, with its digest and proposals.</p>');
      return;
    }
    const form = $('[data-calls-filters]', ui.view);
    const status = $('[data-calls-status]', ui.view);
    const field = (n) => form.elements.namedItem(n);
    const apply = () => {
      const f = { team: field('team').value, waiting: field('waiting').checked ? '1' : '', q: field('q').value.trim() };
      const h = href('calls', f);
      if (location.hash !== h) { history.replaceState(null, '', h); current.hash = h; current.query = f; }
      const needle = f.q.toLowerCase();
      const rows = w.calls.filter((c) => (!f.team || c.team === f.team)
        && (!f.waiting || (effectiveProposals(c.id) || { pending: 0 }).pending > 0)
        && (!needle || searchBlob(c).includes(needle)));
      if (!rows.length) {
        list.innerHTML = emptyState(`<p>${needle ? `Nothing on a call matches “${esc(f.q)}”.` : 'No calls match these filters.'}</p><p><button class="btn btn-small btn-ghost" type="button" data-clear>Clear filters</button></p>`);
        $('[data-clear]', list).addEventListener('click', () => {
          field('team').value = '';
          field('waiting').checked = false;
          field('q').value = '';
          apply();
          field('q').focus();
        });
        status.textContent = needle ? `Nothing on a call matches “${f.q}”.` : 'No calls match these filters.';
        return;
      }
      const weeks = new Map();
      for (const c of rows) {
        const k = weekOf(c.date);
        if (!weeks.has(k)) weeks.set(k, []);
        weeks.get(k).push(c);
      }
      list.innerHTML = [...weeks].map(([wk, cs]) => `
        <section class="week" aria-labelledby="wk-${esc(wk)}">
          <h2 class="week-head" id="wk-${esc(wk)}"><span>Week of ${esc(fmtDay(wk))}</span><span class="week-n">${esc(plural(cs.length, 'call'))}</span></h2>
          <ol class="call-list">${cs.map((c) => callRow(c, { after: needle ? hitsHtml(c, needle) : '' })).join('')}</ol>
        </section>`).join('');
      status.textContent = needle ? `${plural(rows.length, 'call')} ${rows.length === 1 ? 'matches' : 'match'} “${f.q}”.`
        : rows.length === w.calls.length ? '' : `${plural(rows.length, 'call')} shown.`;
    };
    form.addEventListener('input', apply);
    form.addEventListener('submit', (e) => e.preventDefault());
    apply();
  }

  /** Every decision made on a call, newest first: what, why, when (▶), which call, who follows up. */
  function decisionsView() {
    const w = workspace();
    const list = w.decisions || [];
    const dates = list.map((d) => d.date).filter(Boolean).sort();
    render('Calls', `${callsTabs('decisions')}
      ${list.length ? `<ol class="dec-list dec-register">${list.map((d) => decisionRow(d)).join('')}</ol>`
    : emptyState('<p>No decisions yet. Each call\'s digest lists what it decided, with why and the minute it was said; they collect here.</p>')}`, 'calls', {
      eyebrow: list.length ? `${esc(plural(list.length, 'decision'))}${dates.length ? ` · ${esc(fmtDay(dates[0]))} to ${esc(fmtDay(dates[dates.length - 1]))}` : ''}` : '',
      lede: 'Every decision made on a call, newest first: why it was made, the minute it was said, and who follows up.',
    });
  }

  // ================================================================ Call detail (§3.3)
  const CITE_ORDER = ['Topic', 'Decision', 'Agreement', 'Action item', 'Task proposal', 'Open question', 'Key insight'];

  /**
   * Every minute the call record points to, and why. Each kind keeps what the
   * record says there: verbatim quotes, and the digest's own wording, so the
   * cue can mark just the words that became the record.
   */
  function citations(c) {
    const m = new Map();
    const add = (t, kind, quote, says) => {
      if (!t) return;
      const l = m.get(t) || [];
      let x = l.find((y) => y.kind === kind);
      if (!x) { x = { kind, quotes: [], says: [] }; l.push(x); }
      if (quote) x.quotes.push(quote);
      if (says) x.says.push(says);
      m.set(t, l);
    };
    const d = c.digest || {};
    for (const x of d.themes || []) add(x.ts, 'Topic');
    for (const x of d.decisions || []) add(x.ts, 'Decision', null, x.title);
    for (const x of d.agreements || []) add(x.ts, 'Agreement', null, x.text);
    for (const x of d.next_steps || []) add(x.ts, 'Action item', x.quote, x.title);
    for (const p of (c.task_log && c.task_log.proposals) || []) add(p.ts, 'Task proposal', p.quote, p.title);
    for (const x of d.open_questions || []) add(x.ts, 'Open question', null, x.title);
    for (const x of d.key_insights || []) add(x.ts, 'Key insight', null, x.title);
    for (const l of m.values()) l.sort((a, b) => CITE_ORDER.indexOf(a.kind) - CITE_ORDER.indexOf(b.kind));
    return m;
  }

  const STOP = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'are', 'was', 'its', 'our', 'can', 'will', 'from', 'into', 'than', 'then', 'they', 'them', 'have', 'has', 'all', 'one', 'out', 'who', 'what', 'when', 'just', 'we', 'it', 'is', 'on', 'to', 'of', 'in', 'a', 'an', 'so', 'be', 'by', 'or', 'as', 'at']);
  const words = (s) => (String(s).toLowerCase().match(/[a-z0-9$%][a-z0-9$%'-]*/g) || []).filter((w) => !STOP.has(w));

  /**
   * A cited cue with its record marked: the verbatim quote when the cue holds
   * it, else the sentence closest to what the digest says (the hero's
   * "Agreed. <mark>We ship…</mark>"). A cue cited only as a topic start is
   * not marked.
   */
  function markCue(text, cites) {
    const lower = text.toLowerCase();
    for (const q of cites.flatMap((x) => x.quotes)) {
      const i = q ? lower.indexOf(q.toLowerCase()) : -1;
      if (i >= 0) return `${esc(text.slice(0, i))}<mark>${esc(text.slice(i, i + q.length))}</mark>${esc(text.slice(i + q.length))}`;
    }
    const says = cites.flatMap((x) => x.says);
    if (!says.length) return esc(text);
    const sentences = text.match(/[^.!?]+(?:[.!?]+|$)\s*/g) || [text];
    if (sentences.length < 2) return `<mark>${esc(text)}</mark>`;
    const want = new Set(says.flatMap(words));
    let best = -1;
    let score = 0;
    sentences.forEach((sen, i) => {
      const n = words(sen).filter((w) => want.has(w)).length;
      if (n > score) { score = n; best = i; }
    });
    if (best < 0) return `<mark>${esc(text)}</mark>`;
    return sentences.map((sen, i) => {
      if (i !== best) return esc(sen);
      const body = sen.replace(/\s+$/, '');
      return `<mark>${esc(body)}</mark>${esc(sen.slice(body.length))}`;
    }).join('');
  }

  function speakerHtml(name, speakers) {
    const info = speakers.find((x) => x.lastname && x.lastname === name) || speakers.find((x) => x.label === name);
    if (info && info.lastname) return person(info.lastname);
    if (info && info.external) return `${esc(info.label)} <span class="guest">(guest)</span>`;
    return esc(name || 'Unknown speaker');
  }

  function transcriptHtml(c) {
    const t = cached(`transcript:${c.id}`);
    if (!t || !Array.isArray(t.segments) || !t.segments.length) {
      return emptyState('<p>No transcript kept for this call. Transcripts are kept when Sources › Zoom › Keep transcripts is on.</p>');
    }
    const cites = citations(c);
    const speakers = Array.isArray(t.speakers) ? t.speakers : [];
    const rec = c.recording && c.recording.available && /^https:\/\//.test(String(c.recording.url || '')) ? c.recording.url : null;
    const play = (mmss) => (rec ? ` <a class="play" href="${esc(`${rec}#t=${toSeconds(mmss)}`)}" target="_blank" rel="noopener">▶ Play from ${esc(mmss)}</a>` : '');
    const seen = new Map();
    const cues = t.segments.map((s) => {
      const base = `t-${String(s.ts_mmss).replace(':', '-')}`;
      const n = (seen.get(base) || 0) + 1;
      seen.set(base, n);
      const cs = cites.get(s.ts_mmss);
      const said = cs ? markCue(String(s.text || ''), cs) : esc(s.text);
      const tags = cs ? `<span class="cue-tags">${cs.map((x) => `<span class="cue-tag">${esc(x.kind)}</span>`).join('')}</span>` : '';
      return `<p class="cue${cs ? ' is-cited' : ''}" id="${esc(n > 1 ? `${base}-${n}` : base)}" tabindex="-1" data-ts="${esc(s.ts_mmss)}">`
        + `<a class="tc" href="${esc(href('call', c.id, 'transcript', s.ts_mmss))}" aria-label="Line at ${esc(s.ts_mmss)}">${esc(s.ts_mmss)}</a>`
        + `<span class="who">${speakerHtml(s.speaker, speakers)}</span><span class="said">${said}${tags}${play(s.ts_mmss)}</span></p>`;
    }).join('');
    return `
      <div class="transcript-tools">
        <label class="find"><span class="find-label">Find in transcript</span><input type="search" data-find placeholder="A word or a name" autocomplete="off"></label>
        <p class="find-status small muted" data-find-status role="status"></p>
      </div>
      ${isDemo ? '<p class="small muted transcript-note">Demo transcripts keep only the lines the digest points to. Yours keep the whole call.</p>' : ''}
      <div class="transcript transcript-doc">
        <p class="transcript-head"><span>Transcript</span><span>${c.duration_min ? `${esc(c.duration_min)} min · ` : ''}${esc(plural(t.segments.length, 'line'))}</span></p>
        ${cues}
      </div>`;
  }

  function cueFor(at) {
    const secs = toSeconds(at);
    if (secs === null) return null;
    let best = null;
    const cues = $$('.cue', ui.view);
    for (const p of cues) {
      const s = toSeconds(p.dataset.ts);
      if (s !== null && s <= secs) best = p;
    }
    return best || cues[0] || null;
  }

  function wireTranscript(at) {
    const input = $('[data-find]', ui.view);
    const status = $('[data-find-status]', ui.view);
    const cues = $$('.cue', ui.view);
    if (input) {
      const apply = () => {
        const q = input.value.trim().toLowerCase();
        let n = 0;
        for (const p of cues) {
          const hit = !q || p.textContent.toLowerCase().includes(q);
          p.hidden = !hit;
          if (hit) n++;
        }
        status.textContent = !q ? '' : n ? `${plural(n, 'line')} of ${cues.length} match.` : 'No line matches.';
      };
      input.addEventListener('input', apply);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && input.value) { e.preventDefault(); e.stopPropagation(); input.value = ''; apply(); }
      });
    }
    if (at) {
      const t = cueFor(at);
      if (t) {
        t.classList.add('is-target');
        setTimeout(() => t.classList.remove('is-target'), 1300);
      }
    }
  }

  const NONE_LINE = /^\s*(?:[-*]\s+|\d+\.\s+)?(?:none|n\/a|nothing)\.?\s*$/i;

  /** A digest section's markdown without "None." lines, and without ### blocks that hold only "None.". */
  function dropEmpty(src) {
    const lines = String(src || '').split('\n');
    const out = [];
    for (let i = 0; i < lines.length; i++) {
      if (/^#{3,6}\s/.test(lines[i])) {
        let j = i + 1;
        while (j < lines.length && !/^#{3,6}\s/.test(lines[j])) j++;
        if (lines.slice(i + 1, j).every((l) => !l.trim() || NONE_LINE.test(l))) { i = j - 1; continue; }
      }
      if (!NONE_LINE.test(lines[i])) out.push(lines[i]);
    }
    return out.join('\n').trim();
  }

  /** The digest, decisions and agreements first (what the call settled), then the rest; empty sections are left out. */
  function digestHtml(c) {
    const ctx = { call: c.id };
    const d = c.digest || {};
    const party = (p) => (profiled(p) ? `<a class="chip" href="${esc(href('people', p))}">${esc(p)}</a>` : `<span class="chip">${esc(p)}</span>`);
    const rank = (h) => (h === 'decisions' ? 0 : h === 'agreements' ? 1 : 2);
    const secs = (c.sections || []).map((s, i) => ({ s, i, h: String(s.heading).trim().toLowerCase() }))
      .sort((a, b) => rank(a.h) - rank(b.h) || a.i - b.i)
      .map(({ s, i, h }) => {
        let inner;
        if (h === 'decisions' && d.decisions && d.decisions.length) {
          inner = `<ol class="dg-decisions">${d.decisions.map((x) => `<li><p class="dg-dec"><strong>${inline(x.title, ctx)}</strong> ${ts(c.id, x.ts)}</p>${x.why ? `<p class="why">Why: ${inline(x.why, ctx)}</p>` : ''}</li>`).join('')}</ol>`;
        } else if (h === 'agreements' && d.agreements && d.agreements.length) {
          inner = `<ol>${d.agreements.map((x) => `<li>${x.parties && x.parties.length ? `<span class="parties">${x.parties.map(party).join(' ↔ ')}</span>` : ''}${inline(x.text, ctx)} ${ts(c.id, x.ts)}</li>`).join('')}</ol>`;
        } else {
          inner = md(dropEmpty(s.md), ctx);
        }
        if (!String(inner || '').trim()) return '';
        return `<section class="digest-section" aria-labelledby="dg-${i}"><h2 id="dg-${i}">${esc(s.heading)}</h2>${inner}</section>`;
      }).join('');
    return `<article class="digest" aria-label="Digest">${secs || '<p class="muted">This call has no digest yet.</p>'}</article>`;
  }

  function outcomeText(p) {
    const r = p.decision || {};
    if (p.status === 'skipped') return `Skipped${r.reason ? ` · ${r.reason}` : ''}`;
    if (r.result === 'created') return r.ref ? `Created ${r.ref}` : 'Created';
    if (r.result === 'commented') return r.ref ? `Commented on ${r.ref}` : 'Commented';
    if (r.result === 'file-only') return 'Kept in the tasks file';
    return 'Approved';
  }

  /** The core's "Task proposals" list, until cabinet-tasks.js sets BB.hooks.callAside. */
  function defaultProposals(c) {
    const e = effectiveProposals(c.id);
    if (!e || !e.proposals.length) return '';
    const rows = e.proposals.map((p) => {
      const st = p.status === 'pending'
        ? (isDemo ? '<span class="chip-mark">Waiting for review</span>' : "Waiting for review in the call's Slack thread.")
        : `<span class="prop-state-text">${esc(outcomeText(p))}</span>`;
      return `<li>${verdict(p.verdict)}<span>${esc(p.title)}</span><span class="prop-state${p.status === 'approved' ? ' is-done' : ''}">${st}</span></li>`;
    }).join('');
    return `<h2>Task proposals</h2>
      <p class="panel-note">Checked against the Linear backlog before anything was filed.</p>
      <ul class="prop-list">${rows}</ul>
      <p class="panel-foot"><a href="${esc(href('tasks', 'call', c.id))}">Open in Action items</a></p>`;
  }

  function fillProposals(c) {
    const box = $('[data-call-aside]', ui.view);
    if (!box) return;
    if (typeof hooks.callAside === 'function') {
      try {
        box.innerHTML = '';
        box.hidden = false;
        hooks.callAside(c, box);
        return;
      } catch (e) {
        console.error('BB.hooks.callAside failed; the core list is shown instead.', e);
      }
    }
    box.innerHTML = defaultProposals(c);
    box.hidden = !box.innerHTML.trim();
  }

  function asideHtml(c) {
    const items = effectiveActionItems(c.id);
    // A proposal skipped here filed nothing: its item says so (it is no longer an open item).
    const skipped = (a) => (a.review && a.review.status === 'skipped'
      ? `<span class="item-skipped">${esc(`Not filed · skipped${a.review.reason ? `: ${a.review.reason}` : ''}`)}</span>` : '');
    const groups = [['post-call', 'Post-call'], ['monitoring', 'Monitoring'], ['done-on-call', 'Done on call']].map(([st, label]) => {
      const list = items.filter((a) => a.status === st);
      return list.length ? `<h3>${label}</h3><ul class="item-list">${list.map((a) => `<li>${esc(a.title)}
        <span class="item-meta">${a.owner ? person(a.owner) : '<span>no owner</span>'}${a.ts ? ` ${ts(c.id, a.ts)}` : ''} ${prio(a.priority)} ${ref(a.tracker_ref)} ${skipped(a)}</span></li>`).join('')}</ul>` : '';
    }).join('');
    const refs = c.references || [];
    return `<aside class="call-aside" aria-label="Proposals, action items and earlier calls">
      <section class="panel" id="proposals" tabindex="-1" data-call-aside></section>
      ${groups ? `<section class="panel" aria-labelledby="h-items"><h2 id="h-items">Action items</h2>${groups}</section>` : ''}
      ${refs.length ? `<section class="panel" aria-labelledby="h-built"><h2 id="h-built">Built on</h2>
        <p class="panel-note">Earlier calls this digest was written with.</p>
        <ul class="link-list">${refs.map((r) => `<li><a href="${esc(href('call', r.id))}">${esc(r.topic)}</a> <span class="mono muted">${esc(fmtDay(String(r.id).slice(0, 10)))}</span></li>`).join('')}</ul></section>` : ''}
    </aside>`;
  }

  function recordingLine(c) {
    const rec = c.recording || {};
    if (!isDemo && rec.available && /^https:\/\//.test(String(rec.url || ''))) {
      return `<a href="${esc(rec.url)}" target="_blank" rel="noopener">▶ Recording</a>`;
    }
    return isDemo ? 'Recording: not in the demo' : 'Recording: not kept';
  }

  /** The Slack thread tab: the call's whole thread, as cabinet-tasks.js renders it (BB.hooks.slackThread). */
  function fillSlack(c) {
    const box = $('[data-slack-thread]', ui.view);
    if (!box) return;
    try {
      hooks.slackThread(c, box);
    } catch (e) {
      console.error('BB.hooks.slackThread failed.', e);
      box.innerHTML = emptyState('<p>The Slack thread could not be shown.</p>');
    }
  }

  function callView(parts, query = {}) {
    const [id, tab, at] = parts;
    if (!id) { go('#/calls', { replace: true }); return; }
    const c = cached(`call:${id}`);
    const withTranscriptTab = Boolean(API.transcript);
    // The thread tab needs the module that renders it, and a call that was posted (or the demo's settings).
    const withSlackTab = typeof hooks.slackThread === 'function' && (isDemo || Boolean(c.slack));
    const tabOk = !tab || (tab === 'transcript' && withTranscriptTab) || (tab === 'slack' && withSlackTab);
    if (!tabOk || (tab === 'slack' && at)) { go(href('call', id), { replace: true }); return; }
    const onTranscript = tab === 'transcript';
    const onSlack = tab === 'slack';
    const onDigest = !onTranscript && !onSlack;
    const e = effectiveProposals(id);
    const waiting = e ? e.pending : 0;
    // Phones keep the proposals (and the rest of the aside) on the Digest tab only; the other
    // tabs carry one link to them instead (#/call/<id>?show=proposals). Wider screens show the
    // aside beside every tab, so the link is a phone control, like the Digest's own jump.
    const toReview = `${plural(waiting, 'proposal')} to review ↓`;
    const jump = !waiting ? ''
      : onDigest ? ` <button class="chip-mark jump-proposals" type="button" data-jump="proposals">${esc(toReview)}</button>`
        : ` <a class="chip-mark jump-proposals" href="${esc(href('call', id, { show: 'proposals' }))}">${esc(toReview)}</a>`;
    const show = query.show === 'proposals';
    const guests = c.external_participants || [];
    const meta = [
      teamChip(c.team),
      `<span class="mono">${esc(fmtDate(c.date, c.time))}</span>`,
      c.duration_min ? `${esc(c.duration_min)} min` : '',
      c.call_type ? esc(c.call_type) : '',
      (c.participants || []).map(person).join(', '),
      guests.length ? `${guests.length > 1 ? 'guests' : 'guest'}: ${guests.map(esc).join(', ')}` : '',
    ].filter(Boolean).join(' · ');
    const info = [
      recordingLine(c),
      c.slack && c.slack.channel ? `Posted in <span class="mono">${esc(c.slack.channel)}</span>${c.slack.posted_at ? ` at <span class="mono">${esc(c.slack.posted_at)}</span>` : ''}` : '',
    ].filter(Boolean).join(' · ');
    const buttons = [
      // With the Slack thread tab, the thread is one tab away; the delivery preview is a setting.
      c.slack && !withSlackTab ? `<a class="btn btn-small btn-ghost" href="${esc(href('tasks', 'slack', id))}">Preview the Slack post</a>` : '',
      isDemo ? `<a class="btn btn-small btn-ghost" href="${esc(href('memory', { node: c.path }))}">Show the file</a>`
        : safeUrl(c.vault_file_url) ? `<a class="btn btn-small btn-ghost" href="${esc(c.vault_file_url)}" target="_blank" rel="noopener">Open in GitHub</a>` : '',
    ].filter(Boolean).join('');
    const strip = tabs([
      { key: 'digest', href: href('call', id), label: 'Digest' },
      ...(withTranscriptTab ? [{ key: 'transcript', href: href('call', id, 'transcript'), label: 'Transcript' }] : []),
      ...(withSlackTab ? [{ key: 'slack', href: href('call', id, 'slack'), label: 'Slack thread' }] : []),
    ], onTranscript ? 'transcript' : onSlack ? 'slack' : 'digest', { label: 'Call views' });
    const main = onTranscript ? transcriptHtml(c)
      : onSlack ? '<section class="slack-tab" aria-label="Slack thread" data-slack-thread></section>' : digestHtml(c);
    const html = `
      <div class="call-bar">${strip}<div class="call-links"><p class="call-info">${info}</p>${buttons ? `<p class="call-btns">${buttons}</p>` : ''}</div></div>
      <div class="call-layout${onDigest ? '' : ' is-side-tab'}">
        <div class="call-main">${main}</div>
        ${asideHtml(c)}
      </div>`;
    render(c.topic, html, 'calls', {
      eyebrow: '<a href="#/calls">← Calls</a>',
      lede: `${meta}${jump}`,
      focus: show && onDigest ? '#proposals' : onTranscript && at ? () => cueFor(at) : null,
      before: () => { if (onSlack) fillSlack(c); fillProposals(c); },
    });
    // ?show=proposals did its job (focus on the proposals): keep the call's plain address,
    // so a refresh after a review keeps focus where the review left it.
    if (show) {
      const clean = href('call', ...parts);
      history.replaceState(null, '', clean);
      current.hash = clean;
      current.query = {};
    }
    if (onTranscript) wireTranscript(at);
    else if (withTranscriptTab && c.transcript && c.transcript.available) load(`transcript:${id}`).catch(() => {});
  }

  const BB = {
    version: 1,
    mode,
    isDemo,
    contact,
    API,
    // helpers
    esc, safeUrl, inline, md, fmtDate, fmtDay, clock, stamp, now, today, plural, joinAnd, initials, href,
    verdict, prio, ref, teamChip, ts, person, callRow, decisionRow, isOpenItem, bookHref,
    loading, emptyState, managed, deliveryPhrase, DEMO_NOTE,
    // data
    load, cached, workspace,
    // router
    route, render, go, current: null, setLeaveGuard,
    // demo state
    state, save, reset, changeCount, decide, refresh,
    effectiveProposals, effectiveActionItems, openItemsFor, effectiveStats, effectivePeople, effectiveSources, effectiveSlack, waitingCount,
    effectiveMetrics, viewingAs, taskLogOn, threadNote,
    // UI kit
    toast, dialog, confirm, tabs,
    // hooks and events
    hooks, on,
  };
  Object.defineProperty(BB, 'storage', { get: () => storage, enumerable: true });
  window.BB = BB;

  // Core routes. Modules add 'tasks', 'people', 'memory' and 'sources'.
  route('', overviewView, { nav: 'overview', title: 'Overview', needs: () => (isDemo ? ['workspace', 'people?', 'settings?'] : ['workspace']) });
  route('calls', callsView, { nav: 'calls', title: 'Calls' });
  route('call', callView, {
    nav: 'calls',
    loading: 'call',
    needs: (parts) => (parts[0]
      ? ['workspace', 'people?', ...(isDemo ? ['settings?'] : []), `call:${parts[0]}`, ...(parts[1] === 'transcript' && API.transcript ? [`transcript:${parts[0]}?`] : [])]
      : ['workspace']),
    notFound: () => ({ title: 'Call not found', eyebrow: '<a href="#/calls">← Calls</a>', html: emptyState('<p>This call isn\'t in the workspace.</p><p><a href="#/calls">All calls</a></p>') }),
  });

  async function boot() {
    readStore();
    document.addEventListener('click', onDocClick);
    window.addEventListener('hashchange', onHashChange);
    window.addEventListener('beforeunload', (e) => {
      let ask = null;
      try { ask = leaveGuard && current ? leaveGuard(null, current.hash) : null; } catch { ask = null; }
      if (ask) { e.preventDefault(); e.returnValue = ''; }
    });
    window.addEventListener('storage', (e) => {
      if (e.key !== STORE_KEY && e.key !== null) return;
      readStore();
      refresh();
    });
    if (ui.reset) ui.reset.addEventListener('click', () => onReset(ui.reset));
    wireMenu();
    if (ui.navMenu) ui.navMenu.addEventListener('click', openNavSheet);
    window.addEventListener('hashchange', () => setMenu(false));
    // The toast never covers what has focus.
    document.addEventListener('focusin', () => { if (shownToast) keepClear(); });
    try {
      if (API.me) {
        const me = await getJson(API.me);
        if (ui.user) ui.user.textContent = me.email || '';
        if (ui.menuUser) ui.menuUser.textContent = me.email ? `Signed in as ${me.email}` : '';
      }
      await load('workspace');
    } catch (e) {
      if (!e.signedOut) {
        ui.title.textContent = 'Could not load the workspace';
        ui.view.innerHTML = `<p>${esc(e.message)}</p><p>Try again in a minute. If it keeps failing, write to us${contact ? ` at <a href="mailto:${esc(contact)}">${esc(contact)}</a>` : ''}.</p>`;
      }
      return;
    }
    if (ui.wsName) ui.wsName.textContent = displayName();
    settleStamps();
    booted = true;
    syncChrome();
    run({ initial: true });
  }

  // Deferred scripts run before DOMContentLoaded, so every module has
  // registered its routes by the time the first route runs. 'load' is the
  // fallback if this file ever runs after DOMContentLoaded.
  let started = false;
  const start = () => { if (!started) { started = true; boot(); } };
  if (document.readyState === 'complete') start();
  else {
    document.addEventListener('DOMContentLoaded', start, { once: true });
    window.addEventListener('load', start, { once: true });
  }
})();
