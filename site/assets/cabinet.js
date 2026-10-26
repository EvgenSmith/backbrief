// SPDX-License-Identifier: MIT
/*
 * cabinet.js — the workspace UI. One shell, two data sources:
 *   /demo  static JSON built from site/demo-vault (public, fictional team)
 *   /app   /api/* for the signed-in beta workspace (data read from its vault)
 * Everything from the vault is untrusted text: it is escaped first, then a
 * small markdown subset is applied. No innerHTML of raw content anywhere.
 */
(() => {
  const mode = document.body.dataset.mode === 'app' ? 'app' : 'demo';
  const $ = (sel) => document.querySelector(sel);
  const view = $('[data-view]');
  const title = $('[data-view-title]');

  const API = mode === 'app'
    ? { me: '/api/me', workspace: '/api/workspace', call: (id) => `/api/call?id=${encodeURIComponent(id)}`, people: '/api/people' }
    : { me: null, workspace: '/demo/workspace.json', call: (id) => `/demo/calls/${encodeURIComponent(id)}.json`, people: '/demo/people.json' };

  for (const el of document.querySelectorAll(mode === 'app' ? '[data-demo-only]' : '[data-app-only]')) el.hidden = true;

  // ------------------------------------------------------------ helpers
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const safeUrl = (u) => /^(https?:\/\/|\/|#)/.test(u) ? u : null;

  function inline(text) {
    let s = esc(text);
    s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[\s(«“"])_([^_]+)_(?=$|[\s).,;:!?»”"])/g, '$1<em>$2</em>');
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, t, u) => {
      const url = safeUrl(u.replace(/&amp;/g, '&'));
      return url ? `<a href="${esc(url)}" rel="noopener">${t}</a>` : t;
    });
    s = s.replace(/\((\d{1,3}:\d{2})\)/g, '<span class="ts">$1</span>');
    return s;
  }

  function md(src) {
    const out = [];
    let para = [];
    let list = null;
    const flushPara = () => { if (para.length) { out.push(`<p>${inline(para.join(' '))}</p>`); para = []; } };
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
      if ((m = line.match(/^#{3,6}\s+(.*)$/))) { flushPara(); closeList(); out.push(`<h3>${inline(m[1])}</h3>`); continue; }
      if ((m = line.match(/^\s+>\s?(.*)$/)) && list) { list.items[list.items.length - 1] += `<blockquote>${inline(m[1])}</blockquote>`; continue; }
      if ((m = line.match(/^>\s?(.*)$/))) { flushPara(); closeList(); out.push(`<blockquote>${inline(m[1])}</blockquote>`); continue; }
      if ((m = line.match(/^[-*]\s+(.*)$/))) {
        flushPara();
        if (!list || list.tag !== 'ul') { closeList(); list = { tag: 'ul', items: [] }; }
        list.items.push(inline(m[1]));
        continue;
      }
      if ((m = line.match(/^(\d+)\.\s+(.*)$/))) {
        flushPara();
        if (!list || list.tag !== 'ol') { closeList(); list = { tag: 'ol', start: Number(m[1]), items: [] }; }
        list.items.push(inline(m[2]));
        continue;
      }
      if (list && /^\s+/.test(raw)) { list.items[list.items.length - 1] += ' ' + inline(line.trim()); continue; }
      closeList();
      para.push(line.trim());
    }
    flushPara();
    closeList();
    return out.join('\n');
  }

  const fmtDate = (d, t) => {
    if (!d) return '';
    const date = new Date(`${d}T00:00:00Z`);
    const s = date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
    return t ? `${s}, ${t}` : s;
  };
  const daysAgo = (d) => {
    if (!d) return '';
    const n = Math.round((Date.now() - new Date(`${d}T12:00:00Z`).getTime()) / 864e5);
    return n <= 0 ? 'today' : n === 1 ? 'yesterday' : `${n} days ago`;
  };
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const STATUS = { 'post-call': 'Post-call', monitoring: 'Monitoring', 'done-on-call': 'Done on call' };
  const VERDICT = { CREATE: 'Create', COMMENT: 'Comment', FLAG: 'Flag', DUPLICATE: 'Duplicate', OTHER: 'Other' };

  let ws = null;
  let people = null;

  const ref = (r) => {
    if (!r) return '';
    const tpl = ws && ws.workspace.tracker_url;
    return tpl
      ? `<a class="chip chip-ref" href="${esc(tpl.replace('{ref}', encodeURIComponent(r)))}" rel="noopener">${esc(r)}</a>`
      : `<span class="chip chip-ref">${esc(r)}</span>`;
  };
  const prio = (p) => (p ? `<span class="prio prio-${esc(p)}">${esc(p)}</span>` : '');
  const teamChip = (t) => (t ? `<span class="chip">${esc(t)}</span>` : '');

  async function getJson(url) {
    const res = await fetch(url, { headers: { accept: 'application/json' }, credentials: 'same-origin' });
    if (res.status === 401 || res.status === 403) {
      location.href = '/login';
      throw new Error('signed out');
    }
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.detail || body.error || `HTTP ${res.status}`);
    }
    return res.json();
  }

  function setNav(name) {
    for (const a of document.querySelectorAll('[data-nav]')) {
      if (a.dataset.nav === name) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    }
  }

  function render(heading, htmlBody, nav) {
    title.textContent = heading;
    view.innerHTML = htmlBody;
    setNav(nav);
    document.title = `${heading} | ${ws ? ws.workspace.name : 'Workspace'} | Backbrief`;
  }

  // ------------------------------------------------------------ views
  function overview() {
    const s = ws.stats;
    const last = s.last_call;
    const integ = ws.workspace.integrations || {};
    const names = { zoom: 'Zoom recordings', slack: 'Slack digests', linear: 'Linear tasks', github: 'Git vault' };
    const cards = [
      ['Calls processed', s.calls_total, `${s.calls_last_30d} in the last 30 days`],
      ['Action items', s.action_items, `${s.linked_to_tracker} linked to the tracker`],
      ['Task proposals', s.proposals, `${s.accepted} accepted · ${s.skipped} skipped`],
      ['Duplicates caught', s.duplicates_caught, 'became comments, not new tickets'],
      ['People', s.people, 'profiles the digests resolve names with'],
    ];
    const recent = ws.calls.slice(0, 5).map(callRow).join('');
    const open = ws.action_items.filter((a) => a.status === 'post-call').slice(0, 8).map((a) => `
      <li><a href="#/call/${esc(a.call_id)}">${esc(a.title)}</a>
        <span class="muted small">${a.owner ? esc(a.owner) + ' · ' : ''}${esc(fmtDate(a.call_date))}</span> ${prio(a.priority)} ${ref(a.tracker_ref)}</li>`).join('');
    const note = ws.window.truncated
      ? `<p class="small muted">Details below cover the latest ${ws.window.calls} of ${ws.window.total} calls.</p>` : '';
    return `
      <div class="stat-grid">${cards.map(([k, v, sub]) => `
        <div class="stat"><div class="stat-k">${esc(k)}</div><div class="stat-v">${esc(v)}</div><div class="stat-sub">${esc(sub)}</div></div>`).join('')}
      </div>
      ${note}
      <div class="two-col">
        <section class="panel"><h2>Recent calls</h2><div class="call-list">${recent || '<p class="muted">No calls yet.</p>'}</div>
          <p><a href="#/calls">All calls</a></p></section>
        <section class="panel"><h2>Open next steps</h2>${open ? `<ul class="plain">${open}</ul>` : '<p class="muted">Nothing open.</p>'}
          <p><a href="#/tasks">All action items</a></p></section>
      </div>
      <section class="panel"><h2>Pipeline</h2>
        <p>${last ? `Last call filed: <a href="#/call/${esc(last.id)}">${esc(last.topic)}</a>, ${esc(fmtDate(last.date, last.time))}${mode === 'app' ? ` (${esc(daysAgo(last.date))})` : ''}.` : 'No calls filed yet.'}</p>
        <ul class="integrations">${Object.keys(names).map((k) => `<li class="${integ[k] ? 'on' : 'off'}">${integ[k] ? '✓' : '–'} ${esc(names[k])}</li>`).join('')}</ul>
        <p class="small muted">Everything here is read from the vault at <a href="${esc(ws.workspace.vault_url)}" rel="noopener">${esc(ws.workspace.vault_url.replace(/^https:\/\//, ''))}</a>. Delete ${'Backbrief'} tomorrow and those files stay yours.</p>
      </section>`;
  }

  function callRow(c) {
    return `
      <a class="call-row" href="#/call/${esc(c.id)}">
        <span class="call-date">${esc(fmtDate(c.date, c.time))}</span>
        <span class="call-topic">${esc(c.topic)}</span>
        <span class="call-meta">${teamChip(c.team)} ${c.language && c.language !== 'en' ? `<span class="chip">${esc(c.language)}</span>` : ''}
          <span class="muted small">${esc(c.participants.join(', '))}${c.duration_min ? ` · ${esc(c.duration_min)} min` : ''} · ${esc(plural(c.action_items_count, 'action item', 'action items'))}</span></span>
      </a>`;
  }

  function calls() {
    const teams = [...new Set(ws.calls.map((c) => c.team).filter(Boolean))].sort();
    const body = `
      <div class="filters">
        <label>Team <select data-f-team><option value="">All</option>${teams.map((t) => `<option>${esc(t)}</option>`).join('')}</select></label>
        <label class="grow">Search <input type="search" data-f-q placeholder="Topic or participant"></label>
      </div>
      <div class="call-list" data-list></div>`;
    render('Calls', body, 'calls');
    const list = $('[data-list]');
    const team = $('[data-f-team]');
    const q = $('[data-f-q]');
    const apply = () => {
      const needle = q.value.trim().toLowerCase();
      const rows = ws.calls.filter((c) => (!team.value || c.team === team.value)
        && (!needle || `${c.topic} ${c.participants.join(' ')}`.toLowerCase().includes(needle)));
      list.innerHTML = rows.map(callRow).join('') || '<p class="muted">No calls match.</p>';
    };
    team.addEventListener('change', apply);
    q.addEventListener('input', apply);
    apply();
  }

  async function call(id) {
    render('Loading…', '<p class="muted">Loading the call…</p>', 'calls');
    let c;
    try { c = await getJson(API.call(id)); } catch (e) { render('Call not found', `<p>${esc(e.message)}</p><p><a href="#/calls">Back to calls</a></p>`, 'calls'); return; }
    const meta = [fmtDate(c.date, c.time), c.duration_min ? `${c.duration_min} min` : null, c.call_type, c.language && c.language !== 'en' ? `language: ${c.language}` : null].filter(Boolean);
    const grouped = ['post-call', 'monitoring', 'done-on-call'].map((st) => {
      const items = c.action_items.filter((a) => a.status === st);
      return items.length ? `<h3>${esc(STATUS[st])}</h3><ul class="plain">${items.map((a) => `
        <li>${esc(a.title)}<br><span class="muted small">${a.owner ? esc(a.owner) : 'no owner'}${a.ts ? ` · <span class="ts">${esc(a.ts)}</span>` : ''}</span> ${prio(a.priority)} ${ref(a.tracker_ref)}</li>`).join('')}</ul>` : '';
    }).join('');
    const proposals = c.tasks ? c.tasks.drafts.map((d) => `
      <li><span class="verdict v-${esc(d.verdict.toLowerCase())}">${esc(VERDICT[d.verdict] || d.verdict)}</span> ${esc(d.title)}
        ${d.refs.filter((r) => !d.title.includes(r)).map(ref).join(' ')}<br><span class="muted small">${d.decision === 'accepted' ? 'Accepted' : d.decision === 'skipped' ? 'Skipped' : 'Waiting for a decision'}${d.note ? ` · ${inline(d.note)}` : ''}</span></li>`).join('') : '';
    const refs = c.references.length ? `<ul class="plain">${c.references.map((r) => `<li><a href="#/call/${esc(r.id)}">${esc(r.topic)}</a></li>`).join('')}</ul>` : '';
    const body = `
      <p><a href="#/calls">← All calls</a></p>
      <p class="call-head-meta">${teamChip(c.team)} ${esc(meta.join(' · '))}</p>
      <p class="muted">${esc(c.participants.join(', '))}${c.external_participants.length ? ` · guests: ${esc(c.external_participants.join(', '))}` : ''}</p>
      <div class="call-layout">
        <article class="digest">${c.sections.map((s) => `<section><h2>${esc(s.heading)}</h2>${md(s.md)}</section>`).join('')}</article>
        <aside class="call-aside">
          <section class="panel"><h2>Action items</h2>${grouped || '<p class="muted">None.</p>'}</section>
          ${proposals ? `<section class="panel"><h2>Task proposals</h2><p class="small muted">Checked against the backlog before anything was created.</p><ul class="plain proposals">${proposals}</ul></section>` : ''}
          ${refs ? `<section class="panel"><h2>Built on</h2><p class="small muted">Earlier calls this digest was written with.</p>${refs}</section>` : ''}
          ${c.vault_file_url ? `<p><a class="btn btn-ghost btn-small" href="${esc(c.vault_file_url)}" rel="noopener">Open the file in the vault</a></p>` : ''}
        </aside>
      </div>`;
    render(c.topic, body, 'calls');
  }

  function tasks() {
    const owners = [...new Set(ws.action_items.map((a) => a.owner).filter(Boolean))].sort();
    const body = `
      <div class="filters">
        <label>Owner <select data-f-owner><option value="">Everyone</option>${owners.map((o) => `<option>${esc(o)}</option>`).join('')}</select></label>
        <label>Status <select data-f-status><option value="">All</option>${Object.entries(STATUS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></label>
      </div>
      <div class="table-wrap"><table class="items"><thead><tr><th>Action item</th><th>Owner</th><th>Status</th><th>Tracker</th><th>From call</th></tr></thead><tbody data-rows></tbody></table></div>`;
    render('Action items', body, 'tasks');
    const owner = $('[data-f-owner]');
    const status = $('[data-f-status]');
    const rows = $('[data-rows]');
    const apply = () => {
      const list = ws.action_items.filter((a) => (!owner.value || a.owner === owner.value) && (!status.value || a.status === status.value));
      rows.innerHTML = list.map((a) => `
        <tr><td>${esc(a.title)} ${prio(a.priority)}</td><td>${esc(a.owner || '—')}</td><td>${esc(STATUS[a.status] || a.status)}</td>
          <td>${ref(a.tracker_ref) || '<span class="muted">—</span>'}</td>
          <td><a href="#/call/${esc(a.call_id)}">${esc(a.call_topic)}</a><br><span class="muted small">${esc(fmtDate(a.call_date))}${a.ts ? ` · ${esc(a.ts)}` : ''}</span></td></tr>`).join('')
        || '<tr><td colspan="5" class="muted">No action items match.</td></tr>';
    };
    owner.addEventListener('change', apply);
    status.addEventListener('change', apply);
    apply();
  }

  async function peopleView() {
    render('People', '<p class="muted">Loading profiles…</p>', 'people');
    try {
      if (!people) people = (await getJson(API.people)).people;
    } catch (e) {
      render('People', `<p>${esc(e.message)}</p>`, 'people');
      return;
    }
    const cards = people.map((p) => `
      <article class="person">
        <h2>${esc([...(p.first_names || []), p.lastname].join(' '))}</h2>
        <p class="role">${esc(p.role || '')}${p.team ? ` · ${esc(p.team)}` : ''}</p>
        ${p.zones.length ? `<p>${p.zones.map((z) => `<span class="chip">${esc(z)}</span>`).join(' ')}</p>` : ''}
        ${p.aliases.length ? `<p class="small muted">Also heard as: ${esc(p.aliases.join(', '))}</p>` : ''}
      </article>`).join('');
    render('People', `<p class="muted">One profile per teammate. Aliases are why "Masha", "Маша" and "@maria" resolve to one owner.</p><div class="team">${cards || '<p class="muted">No profiles yet.</p>'}</div>`, 'people');
  }

  function route() {
    if (!ws) return;
    const h = location.hash.replace(/^#\/?/, '');
    const [name, arg] = h.split('/');
    if (name === 'calls') return calls();
    if (name === 'call' && arg) return call(decodeURIComponent(arg));
    if (name === 'tasks') return tasks();
    if (name === 'people') return peopleView();
    return render('Overview', overview(), 'overview');
  }

  async function start() {
    try {
      if (API.me) {
        const me = await getJson(API.me);
        const user = $('[data-user]');
        if (user) user.textContent = me.email;
      }
      ws = await getJson(API.workspace);
    } catch (e) {
      if (e.message !== 'signed out') {
        title.textContent = 'Could not load the workspace';
        view.innerHTML = `<p>${esc(e.message)}</p><p>Try again in a minute. If it keeps failing, write to us.</p>`;
      }
      return;
    }
    const name = $('[data-ws-name]');
    if (name) name.textContent = ws.workspace.name;
    window.addEventListener('hashchange', route);
    route();
  }

  start();
})();
