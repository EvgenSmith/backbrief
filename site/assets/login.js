// SPDX-License-Identifier: MIT
// Log in, forgot password and set-password forms (/login and /reset).
// Progressive enhancement: without JavaScript the forms still post and the
// functions answer with a redirect to /login#<outcome>, which this script
// turns into a message when it is available.
(() => {
  const PRODUCT = 'Backbrief';

  const el = (tag, attrs = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    for (const k of kids) n.append(k);
    return n;
  };
  const strong = (t) => el('strong', {}, t);
  const demoLink = () => el('a', { class: 'btn btn-small', href: '/book' }, 'Book a demo');

  // Views on /login: "login" and "forgot", switched by the URL hash.
  const views = [...document.querySelectorAll('[data-view]')];
  const current = () => views.find((v) => !v.hidden) || views[0];
  const show = (name) => {
    const target = views.find((v) => v.dataset.view === name);
    if (!target) return current();
    for (const v of views) v.hidden = v !== target;
    return target;
  };
  const say = (kind, ...parts) => {
    const box = current().querySelector('[data-status]');
    if (!box) return;
    box.replaceChildren(...parts);
    box.className = `auth-msg is-${kind}`;
    box.hidden = parts.length === 0;
  };
  const quiet = () => say('info');

  const notRegistered = (who) => [
    el('p', {}, strong(`There's no ${PRODUCT} account for ${who}.`)),
    el('p', {}, `Accounts are set up when your team starts with ${PRODUCT}. Book a demo and we'll set yours up.`),
    demoLink(),
  ];

  const OUTCOMES = {
    'not-registered': () => ['notice', ...notRegistered('that email')],
    'google-not-registered': () => ['notice', ...notRegistered('that Google account')],
    'google-unavailable': () => ['error', el('p', {}, "Google sign-in isn't available right now. Log in with your email and password.")],
    'google-failed': () => ['error', el('p', {}, "Google sign-in didn't complete. Try again.")],
    'wrong-password': () => ['error', el('p', {}, "That password isn't right.")],
    'no-password': () => ['error', el('p', {}, "You haven't set a password yet. Use \"Forgot password?\" to get a link.")],
    'limited': () => ['error', el('p', {}, 'Too many attempts. Try again in an hour.')],
    'invalid': () => ['error', el('p', {}, 'Enter your work email and password.')],
    'reset-sent': () => ['ok', el('p', {}, 'Check your inbox for a link to set a new password.')],
    'reset-expired': () => ['error', el('p', {}, 'That link has expired or was already used. Request a new one.')],
    'send-failed': () => ['error', el('p', {}, "We couldn't send the email just now. Try again in a few minutes.")],
    'signed-out': () => ['ok', el('p', {}, "You're logged out.")],
  };

  const route = () => {
    const hash = location.hash.slice(1);
    show(hash === 'forgot' || hash === 'reset-expired' || hash === 'reset-sent' ? 'forgot' : (views.some((v) => v.dataset.view === 'login') ? 'login' : views[0]?.dataset.view));
    const outcome = OUTCOMES[hash];
    if (outcome) { const [kind, ...parts] = outcome(); say(kind, ...parts); } else quiet();
  };

  for (const link of document.querySelectorAll('[data-goto]')) {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      const email = document.querySelector('#login-email')?.value || document.querySelector('#forgot-email')?.value || '';
      history.replaceState(null, '', `#${link.dataset.goto}`);
      show(link.dataset.goto);
      quiet();
      const field = current().querySelector('input[type=email]');
      if (field && !field.value) field.value = email;
      field?.focus();
    });
  }

  for (const btn of document.querySelectorAll('[data-reveal]')) {
    btn.addEventListener('click', () => {
      const input = document.getElementById(btn.getAttribute('aria-controls'));
      const visible = input.type === 'text';
      input.type = visible ? 'password' : 'text';
      btn.textContent = visible ? 'Show' : 'Hide';
      btn.setAttribute('aria-pressed', String(!visible));
    });
  }

  const post = async (form, body) => {
    const res = await fetch(form.getAttribute('action'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
    });
    let data = {};
    try { data = await res.json(); } catch { /* empty body */ }
    return { status: res.status, data };
  };

  const busy = (form, on) => { const b = form.querySelector('button[type=submit]'); if (b) b.disabled = on; };
  const failed = () => say('error', el('p', {}, 'Something went wrong. Check your connection and try again.'));

  // Log in.
  const login = document.querySelector('[data-login]');
  login?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = login.email.value.trim();
    busy(login, true);
    try {
      const { status, data } = await post(login, { email, password: login.password.value });
      if (status === 200) { location.href = data.redirect || '/app'; return; }
      if (status === 404) say('notice', ...notRegistered(email));
      else if (status === 401) {
        const reset = el('a', { href: '#forgot', 'data-goto': 'forgot' }, 'Reset it');
        reset.addEventListener('click', (ev) => { ev.preventDefault(); history.replaceState(null, '', '#forgot'); show('forgot'); quiet(); document.querySelector('#forgot-email').value = email; });
        say('error', el('p', {}, "That password isn't right. ", reset, '.'));
      } else if (status === 409) say('error', ...OUTCOMES['no-password']().slice(1));
      else if (status === 429) say('error', ...OUTCOMES.limited().slice(1));
      else if (status === 400) say('error', ...OUTCOMES.invalid().slice(1));
      else failed();
    } catch { failed(); } finally { busy(login, false); }
  });

  // Forgot password.
  const forgot = document.querySelector('[data-forgot]');
  forgot?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = forgot.email.value.trim();
    busy(forgot, true);
    try {
      const { status, data } = await post(forgot, { email });
      if (status === 200) {
        const parts = [el('p', {}, strong('Check your inbox.'), ` We've sent a link to ${email}. It works once and expires in 30 minutes.`)];
        if (data.dev_link) parts.push(el('p', {}, el('a', { href: data.dev_link }, 'Local preview: open the link')));
        say('ok', ...parts);
      } else if (status === 404) say('notice', ...notRegistered(email));
      else if (status === 429) say('error', ...OUTCOMES.limited().slice(1));
      else if (status === 502) say('error', ...OUTCOMES['send-failed']().slice(1));
      else failed();
    } catch { failed(); } finally { busy(forgot, false); }
  });

  // Set a new password (/reset?token=…).
  const reset = document.querySelector('[data-reset]');
  if (reset) {
    const token = new URLSearchParams(location.search).get('token') || '';
    reset.querySelector('[data-token]').value = token;
    const expired = () => say('error', el('p', {}, 'That link has expired or was already used. ', el('a', { href: '/login#forgot' }, 'Request a new one'), '.'));
    if (!/^[0-9a-f]{64}$/.test(token)) expired();
    reset.addEventListener('submit', async (e) => {
      e.preventDefault();
      const password = reset.password.value;
      if (password.length < 10) { say('error', el('p', {}, 'Use at least 10 characters.')); return; }
      if (password !== document.querySelector('#reset-confirm').value) { say('error', el('p', {}, "The two passwords don't match.")); return; }
      busy(reset, true);
      try {
        const { status, data } = await post(reset, { token, password });
        if (status === 200) { location.href = data.redirect || '/app'; return; }
        if (status === 410) expired();
        else if (status === 400) say('error', el('p', {}, 'Use at least 10 characters.'));
        else failed();
      } catch { failed(); } finally { busy(reset, false); }
    });
  }

  if (views.length) {
    route();
    addEventListener('hashchange', route);
  }
})();
