// SPDX-License-Identifier: MIT
// Sign-in form: progressive enhancement over a plain POST to /api/auth/request.
(() => {
  const form = document.querySelector('[data-login]');
  if (!form) return;
  const status = form.querySelector('[data-status]');
  const button = form.querySelector('button[type=submit]');
  const show = (text, kind) => { status.textContent = text; status.className = 'form-status ' + (kind || ''); };
  const SENT = 'If that email belongs to a beta workspace, a sign-in link is on its way. It works once, for 15 minutes.';
  const MESSAGES = {
    email: ['That email address doesn’t look right.', 'err'],
    expired: ['That sign-in link has expired or was already used. Request a new one.', 'err'],
    limit: ['Too many attempts. Try again in an hour.', 'err'],
    send: ['We couldn’t send the email just now. Try again in a few minutes.', 'err'],
  };

  const params = new URLSearchParams(location.search);
  if (params.get('sent')) show(SENT, 'ok');
  if (params.get('signed_out')) show('You are signed out.', 'ok');
  if (MESSAGES[params.get('error')]) show(...MESSAGES[params.get('error')]);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    button.disabled = true;
    show('Sending…');
    try {
      const res = await fetch(form.action, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ email: new FormData(form).get('email') }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok) {
        show(SENT, 'ok');
        if (body.dev_link) {
          // Local preview only (DEV_RETURN_LINK=1): no mail is sent, so show the link.
          const a = document.createElement('a');
          a.href = body.dev_link;
          a.textContent = ' Open the sign-in link (dev)';
          status.append(a);
        }
      } else if (res.status === 400) show(...MESSAGES.email);
      else if (res.status === 429) show(...MESSAGES.limit);
      else show(...MESSAGES.send);
    } catch {
      show(...MESSAGES.send);
    } finally {
      button.disabled = false;
    }
  });
})();
