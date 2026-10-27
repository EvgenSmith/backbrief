// SPDX-License-Identifier: MIT
// Beta-access form: progressive enhancement over a plain POST to /api/waitlist.
// Without JavaScript the form still works (the function answers with a redirect).
(() => {
  const form = document.querySelector('[data-waitlist]');
  if (!form) return;
  const status = form.querySelector('[data-status]');
  const button = form.querySelector('button[type=submit]');

  const show = (text, kind) => {
    status.textContent = text;
    status.className = 'form-status ' + kind;
  };

  if (location.hash === '#beta-thanks') show("Thanks. We'll email you a few times for the demo.", 'ok');

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const data = new FormData(form);
    button.disabled = true;
    show('Sending…', '');
    try {
      const res = await fetch(form.action, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ email: data.get('email'), website: data.get('website') }),
      });
      if (res.ok) {
        form.reset();
        show("Thanks. We'll email you a few times for the demo.", 'ok');
      } else if (res.status === 400) {
        show('That email address doesn’t look right. Please check it and try again.', 'err');
      } else {
        throw new Error('HTTP ' + res.status);
      }
    } catch {
      const contact = document.querySelector('a[href^="mailto:"]');
      show('Something went wrong. Please try again, or email us' + (contact ? ' at ' + contact.textContent : '') + '.', 'err');
    } finally {
      button.disabled = false;
    }
  });
})();
