// SPDX-License-Identifier: MIT
/*
 * cabinet-people.js — People (spec §3.7): one card per profile, the profile
 * page (zones with their evidence, the names people use, who they work
 * with, activity, the file itself), and the names heard on calls that have
 * no profile yet. Add person (spec §3.8): 1 Name → 2 What we found →
 * 3 Review and save; saving writes people_added to the demo overlay, so
 * People, Overview and the stats update together. Styles live in
 * cabinet-people.css (shared with cabinet-memory.js and cabinet-sources.js).
 * API: the BB block at the top of cabinet.js.
 *
 * The Add person draft lives in this module only (never in storage): steps 2
 * and 3 without a draft go back to step 1, and Reset demo drops it.
 */
(() => {
  'use strict';
  const BB = window.BB;
  if (!BB) return;
  const { esc, href, plural } = BB;

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const wait = (ms) => new Promise((r) => { setTimeout(r, ms); });
  const reducedMotion = () => Boolean(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const NUM = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
  const inWords = (n) => (n >= 0 && n <= 10 ? NUM[n] : String(n));
  const curly = (s) => `“${s}”`;
  const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
  const lc = (s) => String(s || '').toLowerCase();

  const ws = () => BB.workspace();
  const allCalls = () => (ws() ? ws().calls : []);
  const callOf = (id) => allCalls().find((c) => c.id === id) || null;
  const firstOf = (p) => (p.first_names && p.first_names[0]) || String(p.name || '').split(' ')[0] || p.lastname;
  const nameOf = (p) => p.name || [firstOf(p), p.lastname].filter(Boolean).join(' ');
  const findPerson = (last) => {
    const { people } = BB.effectivePeople();
    return people.find((p) => p.lastname === last) || people.find((p) => lc(p.lastname) === lc(last)) || null;
  };

  /** owner/repo of the record, from the vault map, the GitHub source or the workspace link. */
  function repoName() {
    const v = BB.cached('vault');
    if (v && v.repo) return v.repo;
    const gh = BB.effectiveSources().find((s) => s.id === 'github');
    if (gh && gh.account) return gh.account;
    const m = String((ws() && ws().workspace.vault_url) || '').match(/^https:\/\/github\.com\/([^/]+\/[^/?#]+)/);
    return m ? m[1] : null;
  }
  const repoText = () => repoName() || 'your repository';

  function todayYmd() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  // ------------------------------------------------------------ evidence

  /** The call a piece of evidence points to: by id, else the call that day (with the person in it). */
  function evidenceCall(ev, lastname) {
    if (!ev) return null;
    if (ev.call_id) return callOf(ev.call_id) || { id: ev.call_id, date: ev.date || null, topic: null };
    const same = allCalls().filter((c) => c.date === ev.date);
    return same.find((c) => (c.participants || []).includes(lastname)) || same[0] || null;
  }

  /** "Onboarding emails rework · 9 Oct · ▶ 08:20" (the topic links to the call). */
  function sourceLine(ev, lastname) {
    const c = evidenceCall(ev, lastname);
    const parts = [];
    if (c && c.topic) parts.push(`<a href="${esc(href('call', c.id))}">${esc(c.topic)}</a>`);
    const date = ev.date || (c && c.date);
    if (date) parts.push(esc(BB.fmtDay(date)));
    if (ev.ts) parts.push(BB.ts(c ? c.id : null, ev.ts));
    return parts.join(' · ');
  }

  const evidenceHtml = (ev, lastname) => (ev && ev.quote
    ? `<blockquote class="evidence"><p>${esc(curly(ev.quote))}</p><span class="evidence-src">${sourceLine(ev, lastname)}</span></blockquote>`
    : '');

  // ------------------------------------------------------------ activity

  /** Activity from the effective action items and calls; works in /app, where profiles carry none. */
  function activityOf(p) {
    const items = BB.effectiveActionItems();
    const owned = items.filter((a) => a.owner === p.lastname);
    const helping = items.filter((a) => (a.helpers || []).includes(p.lastname));
    const attended = allCalls().filter((c) => (c.participants || []).includes(p.lastname));
    const base = p.activity || {};
    const named = Array.isArray(base.call_ids) ? base.call_ids : [];
    const ids = [...new Set([...attended.map((c) => c.id), ...named])];
    const recent = ids.map(callOf).filter(Boolean).sort((a, b) => `${b.date} ${b.time}`.localeCompare(`${a.date} ${a.time}`));
    let partners = Array.isArray(base.partners) ? base.partners : null;
    if (!partners) {
      const n = {};
      for (const c of attended) for (const x of c.participants || []) if (x !== p.lastname) n[x] = (n[x] || 0) + 1;
      partners = Object.entries(n).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([lastname, calls]) => ({ lastname, calls }));
    }
    return {
      calls: Math.max(attended.length, Number(base.calls) || 0, ids.length),
      namedOnly: attended.length === 0 && ids.length > 0,
      open: owned.filter((a) => a.status === 'post-call'),
      monitoring: owned.filter((a) => a.status === 'monitoring'),
      done: owned.filter((a) => a.status === 'done-on-call'),
      helping,
      refs: [...new Set(owned.map((a) => a.tracker_ref).filter(Boolean))].sort(),
      recent,
      partners,
    };
  }

  // ------------------------------------------------------------ the file

  const yamlScalar = (v) => (/^[A-Za-z][A-Za-z0-9_-]*$/.test(String(v)) ? String(v) : JSON.stringify(String(v)));
  const yamlList = (a) => `[${(a || []).map(yamlScalar).join(', ')}]`;

  /** A profile's frontmatter in the team-profile template's own format (lines of text, not yet escaped). */
  function frontmatterLines(p) {
    const lines = ['---', 'type: member', 'schema_version: 1', `lastname: ${yamlScalar(p.lastname)}`];
    if (p.first_names && p.first_names.length) lines.push(`first_names: ${yamlList(p.first_names)}`);
    if (p.aliases && p.aliases.length) lines.push('aliases:', ...p.aliases.map((a) => `  - ${yamlScalar(a)}`));
    if (p.role) lines.push(`role: ${JSON.stringify(p.role)}`);
    if (p.team) lines.push(`team: ${yamlScalar(p.team)}`);
    if (p.zones && p.zones.length) lines.push(`zones: ${yamlList(p.zones)}`);
    if (p.typical_partners && p.typical_partners.length) lines.push(`typical_partners: ${yamlList(p.typical_partners)}`);
    if (p.languages && p.languages.length) lines.push(`languages: ${yamlList(p.languages)}`);
    if (p.email) lines.push(`email: ${JSON.stringify(p.email)}`);
    if (p.tracker_handle) lines.push(`tracker_handle: ${JSON.stringify(p.tracker_handle)}`);
    if (p.status) lines.push(`status: ${yamlScalar(p.status)}`);
    if (p.sources && p.sources.length) lines.push(`sources: ${yamlList(p.sources)}`);
    if (p.last_updated) lines.push(`last_updated: ${p.last_updated}`);
    lines.push('---');
    return lines;
  }

  const fileWin = (path, lines, app = 'GitHub') => `<div class="win">
      <div class="win-bar"><span class="win-app">${esc(app)}</span><span class="win-path">${esc(path)}</span></div>
      <div class="win-body"><pre class="code">${lines.map(esc).join('\n')}</pre></div>
    </div>`;

  // ------------------------------------------------------------ People list

  function statusChip(p, quiet) {
    const s = lc(p.status);
    if (s === 'draft') return '<span class="chip-mark">Draft</span>';
    if (s === 'stale') return '<span class="chip">Stale</span>';
    if (quiet) return '';
    return s === 'confirmed' ? '<span class="chip chip-pos">Confirmed</span>' : '';
  }

  function card(p) {
    const a = activityOf(p);
    const zones = (p.zone_evidence && p.zone_evidence.length ? p.zone_evidence.map((z) => z.zone) : p.zones || []);
    const tags = [statusChip(p, true), p.added ? '<span class="chip">New · you</span>' : ''].filter(Boolean).join(' ');
    return `<li class="person people-card">
      <span class="monogram" aria-hidden="true">${esc(BB.initials(nameOf(p)))}</span>
      <h3 class="people-name"><a class="people-link" href="${esc(href('people', p.lastname))}">${esc(nameOf(p))}</a></h3>
      <p class="role">${esc(p.role || 'Role not set')}${p.team ? `<span class="people-team"> · ${esc(p.team)}</span>` : ''}</p>
      ${tags ? `<p class="people-tags">${tags}</p>` : ''}
      ${zones.length ? `<p class="people-zones"><span class="people-k">Zones</span>${zones.map((z) => `<span class="chip">${esc(z)}</span>`).join(' ')}</p>` : ''}
      ${p.aliases && p.aliases.length ? `<p class="people-aliases"><span class="people-k">Also heard as</span> ${esc(p.aliases.join(', '))}</p>` : ''}
      <p class="people-activity">${esc(`${a.namedOnly ? 'Named on ' : ''}${plural(a.calls, 'call')} · ${plural(a.open.length, 'open item')}`)}</p>
    </li>`;
  }

  function unprofiledHtml(list) {
    if (!list.length) return '';
    const rows = list.map((u) => {
      const first = (u.mentioned_in || [])[0];
      if (u.kind === 'teammate') {
        return `<li class="people-name-row">
          <p class="people-token">${esc(u.token)}</p>
          <div class="people-name-main">
            <p class="people-name-what"><strong>Teammate</strong> · ${esc(plural(u.mentions, 'mention'))} on ${esc(plural(u.calls, 'call'))}</p>
            ${first ? evidenceHtml({ call_id: first.call_id, date: first.date, ts: first.ts, quote: first.line }, u.token) : ''}
          </div>
          ${BB.isDemo ? `<p class="people-name-do"><a class="btn btn-small" href="${esc(href('people', 'add', { last: u.token }))}">Add profile</a></p>` : ''}
        </li>`;
      }
      return `<li class="people-name-row is-guest">
        <p class="people-token">${esc(u.token)}</p>
        <div class="people-name-main">
          <p class="people-name-what"><strong>Guest</strong>${u.role_hint ? ` · ${esc(u.role_hint)}` : ''}${u.calls ? ` · ${esc(plural(u.calls, 'call'))}` : ''}</p>
          <p class="people-name-note">Guests don't need a profile: digests name them, and tasks only go to teammates.</p>
        </div>
        ${BB.isDemo ? `<p class="people-name-do"><a class="btn btn-small btn-ghost" href="${esc(href('people', 'add', { last: u.token }))}">Add profile anyway</a></p>` : ''}
      </li>`;
    }).join('');
    return `<section class="people-section" aria-labelledby="h-unprofiled">
      <h2 class="people-head" id="h-unprofiled">Named on calls, no profile yet</h2>
      <ul class="ruled people-names">${rows}</ul>
    </section>`;
  }

  /** "Aliases are why “Em”, “Emma C.” and “@emma” all resolve to Carter." from the busiest profile with aliases. */
  function aliasLine(people) {
    const p = people.filter((x) => (x.aliases || []).length >= 2)
      .sort((a, b) => activityOf(b).calls - activityOf(a).calls || a.lastname.localeCompare(b.lastname))[0];
    return p ? ` Aliases are why ${BB.joinAnd(p.aliases.slice(0, 3).map(curly))} all resolve to ${p.lastname}.` : '';
  }

  function listView() {
    const { people, unprofiled } = BB.effectivePeople();
    const teammates = unprofiled.filter((u) => u.kind === 'teammate').length;
    const eyebrow = people.length
      ? `${plural(people.length, 'profile')}${teammates ? ` · ${plural(teammates, 'teammate')} without one` : ''}`
      : '';
    const body = people.length
      ? `<ul class="people-grid" aria-label="Profiles">${people.map(card).join('')}</ul>`
      : BB.emptyState('<p>No profiles yet. Add the people who join your calls; Backbrief finds the rest of their details in your calls.</p>');
    const managed = BB.isDemo ? '' : `<p class="people-managed small muted">To add someone or change a profile: ${BB.managed()}</p>`;
    // An unfinished /app workspace: step 2 of the first-run sequence (spec §2).
    const strip = !BB.isDemo && !people.length
      ? '<p class="setup-strip"><span class="setup-strip-k">Setup · step 2 of 4</span> Check who\'s who. We draft a profile for each Slack member on your company domain, and you confirm them.</p>'
      : '';
    BB.render('People', `${strip}${body}${unprofiledHtml(unprofiled)}${managed}`, 'people', {
      eyebrow: esc(eyebrow),
      lede: esc(`One profile per teammate, so digests name owners instead of speakers.${aliasLine(people)}`),
      actions: BB.isDemo ? `<a class="btn btn-small" href="${esc(href('people', 'add'))}">Add person</a>` : '',
    });
  }

  // ------------------------------------------------------------ Profile

  let fileOpenFor = null;

  function zonesHtml(p) {
    const first = firstOf(p);
    const items = (p.zone_evidence || []).map((z) => {
      const zid = esc(z.zone);
      if (z.evidence) {
        return `<li class="zone"><p class="zone-head"><span class="chip zone-chip">${zid}</span></p>${evidenceHtml(z.evidence, p.lastname)}</li>`;
      }
      if (z.review === 'confirmed') {
        return `<li class="zone is-confirmed">
          <p class="zone-head"><span class="chip zone-chip">${zid}</span> <span class="zone-state is-pos">Confirmed by you</span></p>
          <p class="zone-note">Not heard on a call yet.${BB.isDemo ? ` <button class="btn-link" type="button" data-zone-act="undo" data-zone="${zid}" data-key="zone-undo-${zid}">Undo</button>` : ''}</p>
        </li>`;
      }
      if (z.manual || z.inferred === false) {
        return `<li class="zone"><p class="zone-head"><span class="chip zone-chip">${zid}</span></p><p class="zone-note">Added by you, not heard on a call yet.</p></li>`;
      }
      return `<li class="zone is-inferred">
        <p class="zone-head"><span class="chip zone-chip is-dashed">${zid}</span> <span class="zone-state">Inferred</span></p>
        <p class="zone-note">Inferred from ${esc(first)}'s role, not heard on a call yet.</p>
        ${BB.isDemo ? `<p class="zone-actions">
          <button class="btn btn-small" type="button" data-zone-act="confirm" data-zone="${zid}" data-key="zone-confirm-${zid}">Confirm</button>
          <button class="btn btn-small btn-ghost" type="button" data-zone-act="remove" data-zone="${zid}" data-key="zone-remove-${zid}">Remove</button>
        </p>` : ''}
      </li>`;
    }).join('');
    // Zones removed in this browser, so they can come back.
    let removed = [];
    if (BB.isDemo) {
      const base = (p.added ? BB.state.people_added : ((BB.cached('people') || {}).people || [])).find((x) => x.lastname === p.lastname);
      const now = new Set((p.zone_evidence || []).map((z) => z.zone));
      removed = ((base && base.zone_evidence) || []).map((z) => z.zone).filter((z) => !now.has(z));
    }
    const removedHtml = removed.length ? `<p class="zone-removed">Removed in this browser: ${removed.map((z) => `<span class="mono">${esc(z)}</span> <button class="btn-link" type="button" data-zone-act="restore" data-zone="${esc(z)}" data-key="zone-restore-${esc(z)}">Undo</button>`).join(' · ')}</p>` : '';
    return `<section class="panel" aria-labelledby="h-zones">
      <h2 id="h-zones">Responsibility zones</h2>
      <p class="panel-note">What digests route to ${esc(first)}, and the call that shows it.</p>
      ${items ? `<ul class="zones">${items}</ul>` : '<p class="muted">No zones yet. They are suggested once a call shows who owns what.</p>'}
      ${removedHtml}
    </section>`;
  }

  function itemLine(a) {
    const c = callOf(a.call_id);
    return `<li>${esc(a.title)}
      <span class="item-meta">${c ? `<a href="${esc(href('call', c.id))}">${esc(c.topic)}</a>` : ''}<span class="mono">${esc(BB.fmtDay(a.call_date || (c && c.date)))}</span>${a.ts ? ` ${BB.ts(a.call_id, a.ts)}` : ''} ${BB.prio(a.priority)} ${BB.ref(a.tracker_ref)}</span></li>`;
  }

  function profileView(p) {
    const first = firstOf(p);
    const a = activityOf(p);
    const counts = [
      `${a.namedOnly ? 'Named on ' : ''}${plural(a.calls, 'call')}`, `${a.open.length} open`, `${a.monitoring.length} monitoring`,
      `${a.done.length} done on call`, `${a.helping.length} helping`,
    ].join(' · ');
    const partners = (a.partners || []).slice(0, 4);
    const partnerRows = partners.map((x) => {
      const q = findPerson(x.lastname);
      return `<li><span class="monogram monogram-sm" aria-hidden="true">${esc(BB.initials(q ? nameOf(q) : x.lastname))}</span>
        <span class="partner-name">${BB.person(x.lastname)}${q && q.role ? ` <span class="muted">· ${esc(q.role)}</span>` : ''}</span>
        <span class="partner-n">${esc(a.namedOnly ? `on ${plural(x.calls, 'call')} that name ${first}` : `${plural(x.calls, 'call')} together`)}</span></li>`;
    }).join('');
    const typical = (p.typical_partners || []).filter((x) => !partners.some((y) => y.lastname === x));
    const aliases = p.aliases || [];
    const changedHere = BB.isDemo && (p.added || Object.keys(BB.state.zone_reviews || {}).some((k) => k.startsWith(`${p.lastname}:`)));
    const open = fileOpenFor === p.lastname;
    const fileHtml = `<section class="profile-file" id="profile-file" aria-label="${esc(p.path || `team/${p.lastname}.md`)}"${open ? '' : ' hidden'}>
        ${fileWin(p.path || `team/${p.lastname}.md`, frontmatterLines(p))}
        <p class="small muted profile-file-note">${p.added
    ? `Saved in this browser only: ${esc(repoText())} doesn't have this file.`
    : changedHere ? `With the zone changes made in this browser; ${esc(repoText())} still has the original.` : `The frontmatter, as it is in ${esc(repoText())}.`}</p>
      </section>`;

    const main = `
      ${p.about ? `<p class="profile-about">${esc(p.about)}</p>` : ''}
      ${zonesHtml(p)}
      <section class="panel" aria-labelledby="h-aliases">
        <h2 id="h-aliases">Also heard as</h2>
        ${aliases.length ? `<p class="profile-aliases">${aliases.map((x) => `<span class="chip">${esc(x)}</span>`).join(' ')}</p>
        <p class="panel-note">Said on a call or typed in Slack, each of these resolves to ${esc(p.lastname)} in digests and tasks.</p>`
    : `<p class="muted">No other names yet. ${esc(p.lastname)} still resolves.</p>`}
      </section>
      <section class="panel" aria-labelledby="h-partners">
        <h2 id="h-partners">Works most with</h2>
        ${partnerRows ? `<ul class="partners">${partnerRows}</ul>` : '<p class="muted">Nobody yet.</p>'}
        ${typical.length ? `<p class="panel-note">The profile also lists ${BB.joinAnd(typical.map(BB.person))}.</p>` : ''}
      </section>
      ${BB.isDemo ? '' : `<p class="small muted">To change this profile: ${BB.managed()}</p>`}`;

    const helpingList = a.helping.map((x) => `<li>${esc(x.title)}
      <span class="item-meta">${x.owner ? `for ${BB.person(x.owner)}` : ''}<span class="mono">${esc(BB.fmtDay(x.call_date))}</span>${x.ts ? ` ${BB.ts(x.call_id, x.ts)}` : ''}</span></li>`).join('');
    const aside = `<aside class="call-aside profile-aside" aria-label="Activity">
      <section class="panel" aria-labelledby="h-activity">
        <h2 id="h-activity">Activity</h2>
        <p class="profile-counts">${esc(counts)}</p>
        ${a.refs.length ? `<h3>In Linear</h3><p class="profile-refs">${a.refs.map(BB.ref).join(' ')}</p>` : ''}
        <h3>Open items</h3>
        ${a.open.length ? `<ul class="item-list">${a.open.map(itemLine).join('')}</ul>` : '<p class="panel-note">Nothing open.</p>'}
        ${helpingList ? `<h3>Helping</h3><ul class="item-list">${helpingList}</ul>` : ''}
        ${a.recent.length ? `<h3>${a.namedOnly ? `Calls that name ${esc(first)}` : 'Recent calls'}</h3><ol class="call-list">${a.recent.slice(0, 5).map((c) => BB.callRow(c, { compact: true })).join('')}</ol>` : ''}
      </section>
    </aside>`;

    const path = p.path || `team/${p.lastname}.md`;
    const lede = `<div class="profile-id">
        <span class="monogram monogram-lg" aria-hidden="true">${esc(BB.initials(nameOf(p)))}</span>
        <div class="profile-id-text">
          <p class="profile-role">${esc(p.role || 'Role not set')}${p.team ? ` · ${BB.teamChip(p.team)}` : ''} ${statusChip(p)}${p.added ? ' <span class="chip">New · you</span>' : ''}</p>
          <p class="profile-contact">${p.email ? `<span class="mono">${esc(p.email)}</span> · ` : ''}<span class="mono">${esc(path)}</span></p>
        </div>
      </div>`;
    BB.render(nameOf(p), `${fileHtml}<div class="call-layout profile-layout"><div class="profile-main">${main}</div>${aside}</div>`, 'people', {
      eyebrow: '<a href="#/people">← People</a>',
      lede,
      actions: `<button class="btn btn-small btn-ghost" type="button" data-view-file aria-expanded="${open ? 'true' : 'false'}" aria-controls="profile-file">View the file</button>`,
    });

    const btn = $('[data-view-actions] [data-view-file]');
    if (btn) {
      btn.addEventListener('click', () => {
        const box = $('#profile-file');
        const show = box.hidden;
        box.hidden = !show;
        btn.setAttribute('aria-expanded', String(show));
        fileOpenFor = show ? p.lastname : null;
        if (show) box.scrollIntoView({ block: 'nearest', behavior: 'instant' });
      });
    }
    for (const b of $$('[data-zone-act]', $('[data-view]'))) b.addEventListener('click', () => reviewZone(p, b.dataset.zoneAct, b.dataset.zone));
  }

  function reviewZone(p, act, zone) {
    if (!BB.isDemo) return;
    const key = `${p.lastname}:${zone}`;
    let line1;
    let focus;
    if (act === 'confirm') { BB.state.zone_reviews[key] = 'confirmed'; line1 = 'Zone confirmed.'; focus = `[data-key="zone-undo-${CSS.escape(zone)}"]`; }
    else if (act === 'remove') { BB.state.zone_reviews[key] = 'removed'; line1 = 'Zone removed.'; focus = `[data-key="zone-restore-${CSS.escape(zone)}"]`; }
    else { delete BB.state.zone_reviews[key]; line1 = act === 'restore' ? 'Zone restored.' : 'Zone back to inferred.'; focus = `[data-key="zone-confirm-${CSS.escape(zone)}"]`; }
    BB.save();
    BB.refresh({ focus: () => $(focus) || $('#h-zones') });
    BB.toast(line1, BB.DEMO_NOTE.github);
  }

  function notFoundView(last) {
    const u = BB.effectivePeople().unprofiled.find((x) => lc(x.token) === lc(last));
    const guest = u && u.kind === 'external';
    const add = u && BB.isDemo
      ? `<p><a class="btn btn-small${guest ? ' btn-ghost' : ''}" href="${esc(href('people', 'add', { last: u.token }))}">${guest ? 'Add profile anyway' : 'Add profile'}</a> <a class="btn btn-small btn-ghost" href="#/people">All people</a></p>`
      : '<p><a href="#/people">All people</a></p>';
    const html = u
      ? `<p>${esc(u.token)} ${guest ? `joined ${esc(plural(u.calls, 'call'))} as a guest. Guests don't need a profile: digests name them, and tasks only go to teammates.` : `is named on ${esc(plural(u.calls, 'call'))} but has no profile yet.`}</p>${add}`
      : `<p>There's no profile for ${esc(last)}.</p>${add}`;
    BB.render(u ? `No profile for ${u.token} yet` : 'No such profile', BB.emptyState(html), 'people', { eyebrow: '<a href="#/people">← People</a>' });
  }

  // ------------------------------------------------------------ Add person

  let draft = null;
  let searching = null;
  BB.on('reset', () => { draft = null; searching = null; fileOpenFor = null; });

  const LETTERS = /^[A-Za-z]+(?:['’-][A-Za-z]+)*$/;
  const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  function addPerson() { return BB.effectivePeople().add_person || null; }

  /** Every name already taken: profiles in the vault plus people added in this browser. */
  function takenNames() {
    const ap = addPerson();
    const out = (ap && ap.taken ? ap.taken : []).map((t) => ({ ...t }));
    for (const p of BB.effectivePeople().people) {
      const path = p.path || `team/${p.lastname}.md`;
      for (const n of [p.lastname, ...(p.aliases || [])]) if (!out.some((t) => lc(t.name) === lc(n))) out.push({ name: n, path });
    }
    return out;
  }
  const ownerOfPath = (path) => BB.effectivePeople().people.find((p) => (p.path || `team/${p.lastname}.md`) === path) || null;

  /** Aliases from the vault's rules: {first}, {first} {L}., @{email_local}. */
  function aliasesFrom(first, last, email) {
    const ap = addPerson();
    const rules = (ap && ap.alias_rules) || ['{first}', '{first} {L}.', '@{email_local}'];
    const local = email ? String(email).split('@')[0] : '';
    const out = [];
    for (const r of rules) {
      if ((r.includes('{first}') && !first) || (r.includes('{L}') && !last) || (r.includes('{email_local}') && !local)) continue;
      out.push(r.replace('{first}', first).replace('{L}', last.charAt(0).toUpperCase()).replace('{email_local}', local));
    }
    return [...new Set(out.filter(Boolean))];
  }

  function aliasClash(name, own) {
    const t = takenNames().find((x) => lc(x.name) === lc(name));
    if (t) {
      const o = ownerOfPath(t.path);
      return `${curly(name)} already belongs to ${o ? nameOf(o) : t.path}.`;
    }
    if (own && own.some((x) => lc(x) === lc(name))) return `${curly(name)} is already in the list.`;
    return null;
  }

  function stepper(n) {
    const steps = ['Name', 'What we found', 'Review and save'];
    return `<ol class="stepper addp-stepper" aria-label="Add person: step ${n} of 3">${steps.map((s, i) => {
      const cls = i + 1 < n ? 'is-done' : i + 1 === n ? 'is-current' : '';
      return `<li${cls ? ` class="${cls}"` : ''}${i + 1 === n ? ' aria-current="step"' : ''}><span class="dot">${i + 1}</span> <span class="step-label">${esc(s)}</span>${i + 1 < n ? '<span class="sr-only"> (done)</span>' : ''}</li>`;
    }).join('')}</ol>`;
  }

  function searchTerms(first, last, email) {
    return [last, ...aliasesFrom(first, last, email)];
  }

  /** The suggestion keyed by this last name, the unprofiled entry, and the calls they point to. */
  function findings(last) {
    const ap = addPerson() || {};
    const key = Object.keys(ap.suggestions || {}).find((k) => lc(k) === lc(last)) || null;
    const s = key ? ap.suggestions[key] : null;
    const u = BB.effectivePeople().unprofiled.find((x) => lc(x.token) === lc(last)) || null;
    return { key, s, u };
  }

  function makeDraft(first, lastIn, email) {
    const { key, s, u } = findings(lastIn);
    const last = key || (u && u.token) || lastIn;
    const rows = [];
    const aliases = aliasesFrom(first, last, email);
    if (aliases.length) {
      // A generated alias can already be someone else's ("Dan" is Kim's): say so before it can be accepted.
      const clash = aliases.map((a) => aliasClash(a)).find(Boolean) || null;
      rows.push({ key: 'aliases', kind: 'aliases', label: 'Also heard as', values: aliases, why: `From ${first}'s name${email ? ' and email' : ''}.`, state: 'pending', error: clash });
    }
    const ev = (e) => (e ? { call_id: e.call_id, ts: e.ts, quote: e.quote, date: (callOf(e.call_id) || {}).date || null } : null);
    if (s && s.role && s.role.value) {
      rows.push({ key: 'role', kind: 'role', label: 'Role', value: s.role.value, evidence: ev((s.role.evidence || [])[0]), state: 'pending' });
    } else if (u && u.role_hint) {
      const m = (u.mentioned_in || []).find((x) => x.line.includes(`(${u.role_hint})`)) || (u.mentioned_in || [])[0];
      rows.push({ key: 'role', kind: 'role', label: 'Role', value: cap(u.role_hint), evidence: m ? { call_id: m.call_id, ts: m.ts, quote: m.line, date: m.date } : null, state: 'pending' });
    }
    ((s && s.zones) || []).forEach((z, i) => {
      rows.push({ key: `zone-${i}`, kind: 'zone', label: 'Zone', value: z.value, evidence: ev((z.evidence || [])[0]), state: 'pending' });
    });
    if (s && s.typical_partners && s.typical_partners.length) {
      const helped = BB.effectiveActionItems().find((a) => (a.helpers || []).includes(last) && s.typical_partners.includes(a.owner));
      rows.push({
        key: 'partners', kind: 'partners', label: 'Works most with', values: [...s.typical_partners], state: 'pending',
        why: helped ? `Helper on ${helped.owner}'s task, ${BB.fmtDay(helped.call_date)}.` : `From the calls that name ${first}.`,
        evidence: helped ? { call_id: helped.call_id, ts: helped.ts, quote: helped.title, date: helped.call_date } : null,
      });
    }
    if (s && s.accounts && email && s.email && lc(email) === lc(s.email)) {
      rows.push({ key: 'accounts', kind: 'accounts', label: 'Accounts', value: `Slack ${s.accounts.slack} · Linear ${s.accounts.tracker}`, accounts: s.accounts, why: `Matched by ${email}.`, state: 'pending' });
    }
    const evidenceCalls = new Set([
      ...rows.map((r) => r.evidence && r.evidence.call_id).filter(Boolean),
      ...((u && u.mentioned_in) || []).map((m) => m.call_id),
    ]);
    const callIds = [...evidenceCalls];
    const mode = s ? 'found' : u ? 'mentions' : 'none';
    return {
      first, last, email, mode, rows,
      calls: u ? Math.max(u.calls, callIds.length) : callIds.length,
      callIds,
      mentions: (u && u.mentioned_in) || [],
      guest: Boolean(u && u.kind === 'external'),
      team: { answer: null, options: (addPerson() || {}).teams || [], error: false },
      manual: { role: '', team: '', zones: '' },
    };
  }

  // --- step 1

  function step1(query) {
    const ap = addPerson();
    const first = draft ? draft.first : '';
    const last = draft ? draft.last : (query.last && LETTERS.test(query.last) ? query.last : '');
    const email = draft ? draft.email : '';
    // The demo hint: the first suggested name that still has no profile.
    let hint = '';
    const sKey = ap && ap.suggestions ? Object.keys(ap.suggestions).find((k) => !findPerson(k)) : null;
    if (sKey && ap.suggestions[sKey].first_name) {
      const s = ap.suggestions[sKey];
      const u = BB.effectivePeople().unprofiled.find((x) => x.token === sKey);
      const full = `${s.first_name} ${sKey}`;
      hint = `<div class="auth-msg is-notice addp-hint">
        <p>Try ${esc(full)}${u ? `, who's named on ${esc(inWords(u.calls))} ${u.calls === 1 ? 'call' : 'calls'} but has no profile yet` : ''}.</p>
        <button class="btn btn-small btn-ghost" type="button" data-fill="${esc(sKey)}">Fill in ${esc(full)}</button>
      </div>`;
    }
    const field = (id, name, label, value, opts = {}) => `<div class="field">
        <label for="${id}">${esc(label)}${opts.required ? '<span aria-hidden="true">*</span>' : ''}</label>
        <input id="${id}" name="${name}" type="${opts.type || 'text'}" value="${esc(value)}" autocomplete="off" spellcheck="false"${opts.required ? ' required aria-required="true"' : ''} aria-describedby="${[opts.help ? `${id}-help` : '', `${id}-err`].filter(Boolean).join(' ')}"${opts.maxlength ? ` maxlength="${opts.maxlength}"` : ''}>
        ${opts.help ? `<p class="help" id="${id}-help">${opts.help}</p>` : ''}
        <p class="error" id="${id}-err" role="alert" hidden></p>
      </div>`;
    const fileName = last ? `team/${last}.md` : 'team/<Last name>.md';
    const html = `${stepper(1)}
      <div class="addp addp-start" data-addp>
        <div class="panel addp-card">
          ${hint}
          <form class="form addp-form" novalidate data-addp-form>
            ${field('addp-first', 'first', 'First name', first, { required: true, maxlength: 60 })}
            ${field('addp-last', 'last', 'Last name', last, { required: true, maxlength: 60, help: `Used for the file name, <span class="mono" data-file-name>${esc(fileName)}</span>, and as the owner name in tasks.` })}
            ${field('addp-email', 'email', 'Work email (optional)', email, { type: 'email', maxlength: 120, help: 'Used to find their Slack and Linear accounts. Never shown in digests.' })}
            <div class="addp-actions">
              <button class="btn" type="submit" data-key="addp-search">Search calls</button>
              <a class="btn btn-ghost" href="#/people">Cancel</a>
            </div>
            <div class="addp-search" data-search role="status" aria-live="polite"></div>
          </form>
        </div>
        <aside class="panel addp-aside" aria-labelledby="h-addp-aside">
          <h2 class="k" id="h-addp-aside">What Backbrief searches for</h2>
          <p class="addp-terms" data-terms>${termsHtml(first, last, email)}</p>
          <p class="k">Where</p>
          <ul class="plain-list addp-where">
            <li>${esc(plural(allCalls().length, 'call digest'))}</li>
            <li>${esc(plural(((ws() && ws().task_log) || []).filter((e) => e.tasks_path).length, 'tasks file'))}</li>
            <li>Slack and Linear accounts, by work email</li>
          </ul>
          <p class="small muted">Nothing is saved until you review the file in step 3.</p>
        </aside>
      </div>`;
    BB.render('Add a person', html, 'people', {
      eyebrow: '<a href="#/people">← People</a>',
      lede: 'Start with a name. Backbrief searches your calls for every way people say it and drafts the rest for you to check.',
    });
    wireStep1();
  }

  /** The names the search will try, as chips: last name, then the alias rules. */
  function termsHtml(first, last, email) {
    const l = LETTERS.test(last || '') ? last : '';
    const terms = l ? searchTerms(first, l, EMAIL.test(email || '') ? email : '') : [];
    return terms.length
      ? terms.map((t) => `<span class="chip">${esc(t)}</span>`).join(' ')
      : '<span class="muted">Type a name: the last name, the first name, the first name with an initial, and the email handle.</span>';
  }

  function setError(input, msg) {
    const err = $(`#${input.id}-err`);
    if (!err) return;
    if (msg) {
      err.innerHTML = msg;
      err.hidden = false;
      input.setAttribute('aria-invalid', 'true');
    } else {
      err.textContent = '';
      err.hidden = true;
      input.removeAttribute('aria-invalid');
    }
  }

  function lastNameError(v) {
    if (!v) return 'Enter a last name.';
    if (!LETTERS.test(v)) return 'Use letters only (a–z, hyphen or apostrophe).';
    const t = takenNames().find((x) => lc(x.name) === lc(v));
    if (!t) return null;
    const o = ownerOfPath(t.path);
    if (o && lc(o.lastname) === lc(v)) {
      return `${esc(`There's already a profile for ${o.lastname}: ${nameOf(o)} (${t.path}).`)} <a href="${esc(href('people', o.lastname))}">Open profile</a>`;
    }
    return esc(`${curly(v)} already belongs to ${o ? nameOf(o) : t.path}.`);
  }

  function wireStep1() {
    const form = $('[data-addp-form]');
    if (!form) return;
    const f = (n) => form.elements.namedItem(n);
    const fileName = $('[data-file-name]', form);
    f('last').addEventListener('input', () => {
      const v = f('last').value.trim();
      fileName.textContent = v && LETTERS.test(v) ? `team/${v}.md` : 'team/<Last name>.md';
    });
    const terms = $('[data-terms]');
    const paintTerms = () => { if (terms) terms.innerHTML = termsHtml(f('first').value.trim(), f('last').value.trim(), f('email').value.trim()); };
    for (const n of ['first', 'last', 'email']) f(n).addEventListener('input', () => { setError(f(n), null); paintTerms(); });
    f('last').addEventListener('blur', () => {
      const v = f('last').value.trim();
      if (v) setError(f('last'), lastNameError(v));
    });
    const fill = $('[data-fill]');
    if (fill) {
      fill.addEventListener('click', () => {
        const s = addPerson().suggestions[fill.dataset.fill];
        f('first').value = s.first_name || '';
        f('last').value = fill.dataset.fill;
        f('email').value = s.email || '';
        for (const n of ['first', 'last', 'email']) setError(f(n), null);
        f('last').dispatchEvent(new Event('input'));
        $('[data-key="addp-search"]', form).focus();
      });
    }
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      if (searching) return;
      const first = f('first').value.trim();
      const last = f('last').value.trim();
      const email = f('email').value.trim();
      const errs = [
        [f('first'), first ? null : 'Enter a first name.'],
        [f('last'), lastNameError(last)],
        [f('email'), !email || EMAIL.test(email) ? null : "That doesn't look like an email address."],
      ];
      for (const [input, msg] of errs) setError(input, msg ? (input === f('last') ? msg : esc(msg)) : null);
      const bad = errs.find(([, msg]) => msg);
      if (bad) { bad[0].focus(); return; }
      runSearch(form, first, last, email);
    });
  }

  async function runSearch(form, first, last, email) {
    const at = location.hash;
    const token = {};
    searching = token;
    const btn = $('[data-key="addp-search"]', form);
    btn.setAttribute('aria-disabled', 'true');
    for (const n of ['first', 'last', 'email']) form.elements.namedItem(n).readOnly = true;
    const box = $('[data-search]', form);
    const { key, u } = findings(last);
    const shownLast = key || (u && u.token) || last;
    const n = allCalls().length;
    const tasksFiles = ((ws() && ws().task_log) || []).filter((e) => e.tasks_path).length;
    const lines = [plural(n, 'call digest'), plural(tasksFiles, 'tasks file')];
    if (email) lines.push('Slack and Linear accounts by email');
    const terms = searchTerms(first, shownLast, email);
    box.innerHTML = `<p class="addp-searching">Searching ${esc(plural(n, 'call'))} for ${esc(BB.joinAnd(terms))}…</p>
      <ul class="addp-checks">${lines.map((l, i) => `<li data-check="${i}"><span class="addp-tick" aria-hidden="true"></span>${esc(l)}</li>`).join('')}</ul>`;
    const fast = reducedMotion();
    for (let i = 0; i < lines.length; i++) {
      if (!fast) await wait(330);
      if (searching !== token || location.hash !== at) return;
      const li = $(`[data-check="${i}"]`, box);
      if (li) { li.classList.add('is-done'); li.insertAdjacentHTML('beforeend', '<span class="sr-only">: searched</span>'); }
    }
    if (!fast) await wait(160);
    if (searching !== token || location.hash !== at) return;
    searching = null;
    draft = makeDraft(first, last, email);
    BB.go(href('people', 'add', 'found'));
  }

  // --- step 2

  const acceptedRow = (d, k) => d.rows.find((r) => r.key === k && r.state === 'accepted') || null;

  function rowValueHtml(r) {
    if (r.kind === 'aliases' || r.kind === 'partners') {
      return `<p class="suggest-value">${r.values.length ? r.values.map((v) => `<span class="chip">${r.edited ? `<mark>${esc(v)}</mark>` : esc(v)}</span>`).join(' ') : '<span class="muted">None</span>'}</p>`;
    }
    return `<p class="suggest-value">${r.edited ? `<mark>${esc(r.value)}</mark>` : esc(r.value)}</p>`;
  }

  function rowWhyHtml(r, d) {
    const parts = [];
    if (r.why && r.kind !== 'role' && r.kind !== 'zone') parts.push(`<p class="suggest-why">${esc(r.why)}</p>`);
    if (r.evidence) parts.push(evidenceHtml(r.evidence, d.last));
    return parts.join('');
  }

  function rowHtml(r, d) {
    const k = esc(r.key);
    if (r.state === 'dismissed') {
      return `<li class="suggest is-dismissed" data-row="${k}">
        <p class="suggest-k">${esc(r.label)}</p>
        <p class="suggest-collapsed"><span class="suggest-state">Dismissed</span> <span class="muted">${esc(r.values ? r.values.join(', ') : r.value)}</span> · <button class="btn-link" type="button" data-act="undo" data-key="${k}-undo">Undo</button></p>
      </li>`;
    }
    if (r.editing) {
      // What was typed survives a failed Done; otherwise the current value.
      const val = typeof r.typed === 'string' ? r.typed : r.values ? r.values.join(', ') : r.value;
      return `<li class="suggest is-editing" data-row="${k}">
        <label class="suggest-k" for="sg-${k}">${esc(r.label)}</label>
        <div class="suggest-main form">
          <input id="sg-${k}" type="text" value="${esc(val)}" data-edit-input aria-describedby="sg-${k}-err${r.values ? ` sg-${k}-help` : ''}" maxlength="200">
          ${r.values ? `<p class="help" id="sg-${k}-help">Separate them with commas.</p>` : ''}
          <p class="error" id="sg-${k}-err" role="alert"${r.error ? '' : ' hidden'}>${esc(r.error || '')}</p>
          ${rowWhyHtml(r, d)}
        </div>
        <div class="suggest-actions"><button class="btn btn-small" type="button" data-act="done" data-key="${k}-done">Done</button></div>
      </li>`;
    }
    const accepted = r.state === 'accepted';
    const addAlias = r.kind === 'aliases'
      ? (r.adding
        ? `<div class="suggest-add form">
            <label class="sr-only" for="sg-new-alias">New alias</label>
            <input id="sg-new-alias" type="text" data-alias-input placeholder="Another name, like a nickname" maxlength="60" aria-describedby="sg-new-alias-err">
            <button class="btn btn-small btn-ghost" type="button" data-act="alias-add" data-key="aliases-add-go">Add</button>
            <p class="error" id="sg-new-alias-err" role="alert"${r.addError ? '' : ' hidden'}>${esc(r.addError || '')}</p>
          </div>`
        : `<p class="suggest-more"><button class="btn-link" type="button" data-act="alias-open" data-key="aliases-add">Add alias</button></p>`)
      : '';
    const actions = accepted
      ? `<span class="suggest-state is-pos"><span aria-hidden="true">✓ </span>Accepted</span>
         <button class="btn btn-small btn-ghost" type="button" data-act="edit" data-key="${k}-edit">Edit</button>
         <button class="btn-link" type="button" data-act="undo" data-key="${k}-undo">Undo</button>`
      : `<button class="btn btn-small" type="button" data-act="accept" data-key="${k}-accept">Accept</button>
         <button class="btn btn-small btn-ghost" type="button" data-act="edit" data-key="${k}-edit">Edit</button>
         <button class="btn btn-small btn-ghost" type="button" data-act="dismiss" data-key="${k}-dismiss">Dismiss</button>`;
    const err = r.error ? `<p class="error" id="sg-${k}-err" role="alert">${esc(r.error)} Edit the list to go on.</p>` : '';
    return `<li class="suggest${accepted ? ' is-accepted' : ''}" data-row="${k}">
      <p class="suggest-k">${esc(r.label)}${r.edited ? ' <span class="chip-mark">Edited</span>' : ''}</p>
      <div class="suggest-main">${rowValueHtml(r)}${rowWhyHtml(r, d)}${err}${addAlias}</div>
      <div class="suggest-actions">${actions}</div>
    </li>`;
  }

  function teamAskHtml(d) {
    const opts = [...d.team.options.map((t) => [t, t]), ['none', 'No team: cross-team calls only']];
    return `<li class="suggest suggest-ask${d.team.answer ? ' is-answered' : ''}" data-row="team">
      <p class="suggest-k">${d.team.answer ? 'Team' : 'Needs your answer'}</p>
      <fieldset class="suggest-main" aria-describedby="sg-team-help sg-team-err">
        <legend class="suggest-q">Which team is ${esc(d.first)} on? We couldn't tell from the calls.</legend>
        <div class="ask-options">${opts.map(([v, label]) => `<label class="ask-option"><input type="radio" name="sg-team" value="${esc(v)}"${d.team.answer === v ? ' checked' : ''}> <span>${esc(label)}</span></label>`).join('')}</div>
        <p class="help" id="sg-team-help">Tasks ${esc(d.first)} owns go to this team in Linear.</p>
        <p class="error" id="sg-team-err" role="alert"${d.team.error ? '' : ' hidden'}>Answer this to review the profile.</p>
      </fieldset>
    </li>`;
  }

  function manualHtml(d) {
    const teams = d.team.options;
    const role = !d.rows.some((r) => r.kind === 'role') ? `<div class="field">
        <label for="mf-role">Role</label>
        <input id="mf-role" type="text" data-manual="role" value="${esc(d.manual.role)}" maxlength="80" placeholder="Like Customer Support Lead">
      </div>` : '';
    const team = d.mode === 'none' ? `<div class="field">
        <label for="mf-team">Team</label>
        <select id="mf-team" data-manual="team" aria-describedby="mf-team-help">
          <option value="">Not sure yet</option>
          ${teams.map((t) => `<option value="${esc(t)}"${d.manual.team === t ? ' selected' : ''}>${esc(t)}</option>`).join('')}
          <option value="none"${d.manual.team === 'none' ? ' selected' : ''}>No team: cross-team calls only</option>
        </select>
        <p class="help" id="mf-team-help">Tasks ${esc(d.first)} owns go to this team in Linear.</p>
      </div>` : '';
    const zones = `<div class="field">
        <label for="mf-zones">Zones</label>
        <input id="mf-zones" type="text" data-manual="zones" value="${esc(d.manual.zones)}" maxlength="200" placeholder="Like customer-comms, support-macros" aria-describedby="mf-zones-help">
        <p class="help" id="mf-zones-help">What ${esc(d.first)} owns, in a word or two each. Separate them with commas.</p>
      </div>`;
    return `<section class="panel addp-manual" aria-labelledby="h-manual">
      <h2 id="h-manual">${d.mode === 'none' || role ? 'What you know' : 'Zones'}</h2>
      <div class="form">${role}${team}${zones}</div>
    </section>`;
  }

  function mentionsHtml(d) {
    if (d.mode !== 'mentions' || !d.mentions.length) return '';
    return `<section class="panel addp-mentions" aria-labelledby="h-mentions">
      <h2 id="h-mentions">Where ${esc(d.last)} was named</h2>
      ${d.mentions.map((m) => evidenceHtml({ call_id: m.call_id, ts: m.ts, quote: m.line, date: m.date }, d.last)).join('')}
    </section>`;
  }

  function countText(d) {
    const acc = d.rows.filter((r) => r.state === 'accepted').length;
    const pend = d.rows.filter((r) => r.state === 'pending').length;
    const parts = [];
    if (d.rows.length) parts.push(`${acc} accepted`);
    if (pend) parts.push(`${pend} to check`);
    if (d.mode !== 'none' && !d.team.answer) parts.push('1 question left');
    return parts.join(' · ') || 'Fill in what you know, or review the file as it is.';
  }

  function step2() {
    const d = draft;
    const found = d.mode !== 'none';
    const title = found ? `Found ${d.first} ${d.last} on ${plural(d.calls, 'call')}` : `No mentions of ${d.last} yet`;
    const terms = searchTerms(d.first, d.last, '').slice(0, 3);
    const lede = found
      ? "Accept what's right, fix what's close, dismiss what's wrong. Nothing is saved until the last step."
      : `Nobody said ${BB.joinAnd(terms).replace(/ and ([^,]+)$/, ' or $1')} on the ${plural(allCalls().length, 'call')} so far. Fill in what you know; zones are suggested once ${d.first} shows up on a call.`;
    const html = `${stepper(2)}
      <div class="addp addp-found" data-addp>
        ${d.guest ? `<p class="addp-note small muted">${esc(d.last)} joined as a guest. Guests don't need a profile: digests name them, and tasks only go to teammates.</p>` : ''}
        <ul class="suggests" data-rows>${rowsHtml(d)}</ul>
        ${mentionsHtml(d)}
        ${d.mode !== 'found' ? manualHtml(d) : ''}
        <div class="addp-foot">
          <a class="btn btn-small btn-ghost" href="${esc(href('people', 'add'))}">Back</a>
          <p class="addp-count" data-count aria-live="polite">${esc(countText(d))}</p>
          <button class="btn btn-small" type="button" data-act="review" data-key="addp-review">Review profile</button>
        </div>
        ${d.rows.length ? '<p class="small muted addp-foot-note">Suggestions you leave unchecked stay out of the file.</p>' : ''}
      </div>`;
    BB.render(title, html, 'people', { eyebrow: '<a href="#/people">← People</a>', lede: esc(lede) });
    wireStep2();
  }

  function rowsHtml(d) {
    return `${d.rows.map((r) => rowHtml(r, d)).join('')}${d.mode !== 'none' ? teamAskHtml(d) : ''}`;
  }

  function repaint(focusSel) {
    const box = $('[data-rows]');
    if (!box || !draft) return;
    box.innerHTML = rowsHtml(draft);
    const count = $('[data-count]');
    if (count) count.textContent = countText(draft);
    const t = focusSel ? $(focusSel, box) || $(focusSel) : null;
    if (t) t.focus();
  }

  function commitEdit(r, box) {
    const input = $('[data-edit-input]', box);
    const raw = input ? input.value.trim() : '';
    r.typed = input ? input.value : null;
    if (r.values) {
      const vals = [...new Set(raw.split(',').map((x) => x.trim()).filter(Boolean))];
      for (const v of vals) {
        const clash = r.kind === 'aliases' ? aliasClash(v) : null;
        if (clash) { r.error = clash; return false; }
        if (r.kind === 'partners' && !findPerson(v)) { r.error = `There's no profile for ${v}.`; return false; }
      }
      r.edited = r.edited || vals.join('|') !== r.values.join('|');
      r.values = vals;
    } else {
      if (!raw) { r.error = `Enter a ${r.label.toLowerCase()}, or dismiss it.`; return false; }
      if (r.kind === 'zone' && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(raw)) { r.error = 'Use lowercase words joined by hyphens, like customer-comms.'; return false; }
      r.edited = r.edited || raw !== r.value;
      r.value = raw;
    }
    r.error = null;
    r.typed = null;
    r.editing = false;
    r.state = 'accepted';
    return true;
  }

  function wireStep2() {
    const root = $('[data-addp]');
    if (!root) return;
    root.addEventListener('click', (e) => {
      const b = e.target.closest('[data-act]');
      if (!b || !draft) return;
      const act = b.dataset.act;
      if (act === 'review') { review(); return; }
      const rowEl = b.closest('[data-row]');
      const r = rowEl ? draft.rows.find((x) => x.key === rowEl.dataset.row) : null;
      if (!r) return;
      const k = CSS.escape(r.key);
      if (act === 'accept') {
        const clash = r.kind === 'aliases' ? r.values.map((v) => aliasClash(v)).find(Boolean) : null;
        if (clash) { r.error = clash; repaint(`[data-key="${k}-edit"]`); return; }
        r.state = 'accepted';
        repaint(`[data-key="${k}-undo"]`);
      }
      else if (act === 'dismiss') { r.state = 'dismissed'; r.adding = false; repaint(`[data-key="${k}-undo"]`); }
      else if (act === 'undo') { r.state = 'pending'; repaint(`[data-key="${k}-accept"]`); }
      else if (act === 'edit') { r.editing = true; r.adding = false; r.typed = null; r.error = null; repaint('[data-edit-input]'); }
      else if (act === 'done') {
        if (commitEdit(r, rowEl)) repaint(`[data-key="${k}-edit"]`);
        else repaint('[data-edit-input]');
      } else if (act === 'alias-open') { r.adding = true; r.addError = null; repaint('[data-alias-input]'); }
      else if (act === 'alias-add') addAlias(r, rowEl);
    });
    root.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      if (e.target.matches('[data-edit-input]')) { e.preventDefault(); const done = e.target.closest('[data-row]').querySelector('[data-act="done"]'); if (done) done.click(); }
      if (e.target.matches('[data-alias-input]')) { e.preventDefault(); const add = e.target.closest('[data-row]').querySelector('[data-act="alias-add"]'); if (add) add.click(); }
      if (e.target.matches('[data-manual]')) e.preventDefault();
    });
    root.addEventListener('change', (e) => {
      if (e.target.name === 'sg-team') {
        draft.team.answer = e.target.value;
        draft.team.error = false;
        const li = e.target.closest('[data-row="team"]');
        li.classList.add('is-answered');
        $('.suggest-k', li).textContent = 'Team';
        const err = $('#sg-team-err');
        if (err) err.hidden = true;
        $('[data-count]').textContent = countText(draft);
      }
    });
    root.addEventListener('input', (e) => {
      const m = e.target.dataset && e.target.dataset.manual;
      if (m) draft.manual[m] = e.target.value;
    });
  }

  function addAlias(r, rowEl) {
    const input = $('[data-alias-input]', rowEl);
    const v = input ? input.value.trim() : '';
    if (!v) { r.addError = 'Type a name first.'; repaint('[data-alias-input]'); return; }
    const clash = aliasClash(v, r.values);
    if (clash) {
      r.addError = clash;
      repaint('[data-alias-input]');
      const again = $('[data-alias-input]');
      if (again) { again.value = v; again.setAttribute('aria-invalid', 'true'); }
      return;
    }
    r.values = [...r.values, v];
    r.edited = true;
    r.adding = false;
    r.addError = null;
    r.state = 'accepted';
    repaint('[data-key="aliases-add"]');
  }

  function review() {
    const d = draft;
    if (d.mode !== 'none' && !d.team.answer) {
      d.team.error = true;
      repaint('input[name="sg-team"]');
      return;
    }
    BB.go(href('people', 'add', 'review'));
  }

  // --- step 3

  /** The person the draft would save, in the people.json shape. */
  function personFromDraft(d) {
    const aliasesRow = acceptedRow(d, 'aliases');
    const roleRow = acceptedRow(d, 'role');
    const partnersRow = acceptedRow(d, 'partners');
    const accountsRow = acceptedRow(d, 'accounts');
    const hasRoleRow = d.rows.some((r) => r.kind === 'role');
    const role = hasRoleRow ? (roleRow ? roleRow.value : '') : d.manual.role.trim();
    const teamAns = d.mode === 'none' ? d.manual.team : d.team.answer;
    const team = teamAns && teamAns !== 'none' ? teamAns : null;
    const zones = d.rows.filter((r) => r.kind === 'zone' && r.state === 'accepted').map((r) => ({ zone: r.value, evidence: r.evidence }));
    const manualZones = d.manual.zones.split(',').map((x) => x.trim().toLowerCase().replace(/\s+/g, '-')).filter((z) => z && !zones.some((y) => y.zone === z));
    for (const z of [...new Set(manualZones)]) zones.push({ zone: z, evidence: null });
    const partners = partnersRow ? partnersRow.values : [];
    const lang = (allCalls()[0] && allCalls()[0].language) || 'en';
    const lastCall = d.callIds.map(callOf).filter(Boolean).map((c) => c.date).sort().pop() || null;
    const helping = BB.effectiveActionItems().filter((a) => (a.helpers || []).includes(d.last)).length;
    return {
      lastname: d.last,
      first_names: [d.first],
      name: `${d.first} ${d.last}`,
      role: role || null,
      team,
      aliases: aliasesRow ? aliasesRow.values : [],
      zones: zones.map((z) => z.zone),
      zone_evidence: zones.map((z) => (z.evidence
        ? { zone: z.zone, evidence: { call_id: z.evidence.call_id, date: z.evidence.date, ts: z.evidence.ts, quote: z.evidence.quote }, inferred: false }
        : { zone: z.zone, evidence: null, inferred: false, manual: true })),
      typical_partners: partners,
      email: d.email || null,
      ...(accountsRow ? { tracker_handle: accountsRow.accounts.tracker } : {}),
      languages: [lang],
      status: 'confirmed',
      sources: zones.some((z) => z.evidence) || roleRow ? ['web', 'transcripts'] : ['web'],
      last_updated: todayYmd(),
      path: `team/${d.last}.md`,
      about: null,
      activity: {
        calls: d.calls, last_call: lastCall, open: 0, monitoring: 0, done: 0, helps: helping, tracker_refs: [],
        partners: partners.map((x) => ({ lastname: x, calls: d.callIds.filter((id) => ((callOf(id) || {}).participants || []).includes(x)).length })),
        call_ids: d.callIds,
      },
    };
  }

  function fileLines(p) {
    const lines = frontmatterLines(p);
    const z = p.zone_evidence.map((x) => (x.evidence
      ? `- **${x.zone}** — evidence: ${JSON.stringify(x.evidence.quote)} (${x.evidence.date} call, ${x.evidence.ts})`
      : `- **${x.zone}** — added by hand, no call evidence yet`));
    lines.push('', `# ${p.name}${p.role ? ` — ${p.role}` : ''}`, '', '## Role', p.role ? `${p.role}.` : 'None.', '',
      '## Responsibility zones', ...(z.length ? z : ['None yet.']), '',
      '## Typical topics', ...(p.zones.length ? p.zones.map((x) => `- ${x.replace(/-/g, ' ')}`) : ['None yet.']), '',
      '## Typical partners', ...(p.typical_partners.length ? p.typical_partners.map((x) => `- **${x}**`) : ['None yet.']), '',
      '## Notes', 'None.');
    return lines;
  }

  function notAdded(d) {
    const out = [];
    for (const r of d.rows) {
      if (r.state === 'accepted') continue;
      if (r.kind === 'aliases') out.push(`the aliases ${r.values.join(', ')}`);
      else if (r.kind === 'role') out.push(`the role ${r.value}`);
      else if (r.kind === 'zone') out.push(`the zone ${r.value}`);
      else if (r.kind === 'partners') out.push(`works with ${r.values.join(', ')}`);
      else if (r.kind === 'accounts') out.push('the Slack and Linear accounts');
    }
    return out;
  }

  function step3() {
    const d = draft;
    const p = personFromDraft(d);
    const path = p.path;
    const settings = BB.cached('settings');
    const linear = settings && settings.sources ? settings.sources.find((s) => s.id === 'linear') : null;
    const key = p.team && linear && linear.settings && linear.settings.team_mapping ? linear.settings.team_mapping[p.team] : null;
    const accountsRow = acceptedRow(d, 'accounts');
    const changes = [];
    changes.push(p.aliases.length
      ? `From the next call, ${BB.joinAnd(p.aliases.map(curly))} ${p.aliases.length === 1 ? 'resolves' : 'resolve'} to ${p.lastname}.`
      : `From the next call, ${curly(p.lastname)} resolves to this profile.`);
    if (p.team) changes.push(`Tasks ${d.first} owns go to ${p.team}${key ? ` (${key})` : ''} in Linear${accountsRow ? `, assigned to ${accountsRow.accounts.tracker}` : ''}.`);
    else if ((d.mode === 'none' ? d.manual.team : d.team.answer) === 'none') changes.push(`${d.first} has no team: listed for cross-team calls only.`);
    if (d.calls) changes.push(d.calls === 1 ? `The call that names ${d.first} now links to this profile.` : `The ${d.calls} calls that name ${d.first} now link to this profile.`);
    const skipped = notAdded(d);
    if (skipped.length) changes.push(`Not added: ${BB.joinAnd(skipped)}.`);
    const html = `${stepper(3)}
      <div class="addp addp-review" data-addp>
        <div class="addp-file">${fileWin(path, fileLines(p))}</div>
        <section class="panel addp-changes" aria-labelledby="h-changes">
          <h2 id="h-changes">What changes</h2>
          <ul class="plain-list">${changes.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>
          <div class="addp-save">
            <button class="btn" type="button" data-save data-key="addp-save">Save profile</button>
            <a class="btn btn-ghost" href="${esc(href('people', 'add', 'found'))}">Back</a>
          </div>
          <p class="small muted addp-save-note" data-save-status role="status"></p>
        </section>
      </div>`;
    BB.render('Review and save', html, 'people', {
      eyebrow: '<a href="#/people">← People</a>',
      lede: esc(`This is the file Backbrief adds to ${repoText()}. You can edit it there any time.`),
    });
    const btn = $('[data-save]');
    btn.addEventListener('click', async () => {
      if (btn.getAttribute('aria-disabled') === 'true' || !draft) return;
      if (findPerson(p.lastname)) { BB.go(href('people', 'add')); return; }
      const at = location.hash;
      btn.setAttribute('aria-disabled', 'true');
      btn.textContent = `Saving ${path}…`;
      await wait(reducedMotion() ? 150 : 700);
      if (location.hash !== at || !draft) return;
      BB.state.people_added = [...BB.state.people_added.filter((x) => x.lastname !== p.lastname), { ...p, added_at: BB.now() }];
      BB.save();
      draft = null;
      BB.toast(`Saved ${path}. ${d.first} is now in People.`, BB.DEMO_NOTE.github);
      BB.go(href('people', p.lastname));
    });
  }

  // ------------------------------------------------------------ routes

  BB.route('people', (parts) => {
    const [last] = parts;
    if (!last) { listView(); return; }
    const p = findPerson(last);
    if (!p) { notFoundView(last); return; }
    if (fileOpenFor && fileOpenFor !== p.lastname) fileOpenFor = null;
    profileView(p);
  }, { nav: 'people', title: 'People', needs: ['workspace', 'people', 'settings?'], loading: 'profiles' });

  BB.route('people/add', (parts, query) => {
    if (!BB.isDemo) { BB.go('#/people', { replace: true }); return; }
    const [step] = parts;
    if ((step === 'found' || step === 'review') && !draft) {
      BB.go(href('people', 'add', query.last ? { last: query.last } : undefined), { replace: true });
      return;
    }
    if (draft && findPerson(draft.last) && step) { draft = null; BB.go(href('people', 'add'), { replace: true }); return; }
    if (step === 'found') step2();
    else if (step === 'review') step3();
    else {
      if (query.last && draft && lc(draft.last) !== lc(query.last)) draft = null;
      step1(query);
    }
  }, { nav: 'people', title: 'Add a person', needs: ['workspace', 'people', 'settings?'], loading: 'profiles' });
})();
