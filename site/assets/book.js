// SPDX-License-Identifier: MIT
// Book-a-demo form, two steps: contact details, then call booking.
// Step 1 posts the email to /api/book. Step 2 shows the booking calendar
// (links.book_demo, prefilled with the name and email) when one is configured,
// otherwise a note that we'll email times. Without JavaScript the form still
// posts, and the function redirects back to #booked.
(() => {
  const form = document.querySelector('[data-book]');
  if (!form) return;
  const card = form.closest('.book-card');
  const next = card.querySelector('[data-book-next]');
  const steps = card.querySelectorAll('[data-step-label]');
  const status = form.querySelector('[data-status]');
  const button = form.querySelector('button[type=submit]');
  const calendar = form.dataset.calendar || '';

  const show = (text, kind) => {
    status.textContent = text;
    status.className = 'form-status ' + kind;
  };

  const stepTwo = (name, email) => {
    form.hidden = true;
    next.hidden = false;
    steps[0].classList.replace('is-current', 'is-done');
    steps[1].classList.add('is-current');
    if (name) next.querySelector('[data-book-name]').textContent = ', ' + name;
    if (email) next.querySelector('[data-book-email]').textContent = email;
    if (calendar) {
      const url = new URL(calendar);
      if (name) url.searchParams.set('name', name);
      if (email) url.searchParams.set('email', email);
      const frame = document.createElement('iframe');
      frame.src = url.toString();
      frame.title = 'Pick a time for the demo';
      frame.className = 'book-calendar';
      next.querySelector('[data-calendar-slot]').append(frame);
      next.querySelector('[data-book-done]').hidden = true;
    }
    next.focus();
  };

  if (location.hash === '#booked') stepTwo('', '');

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const data = new FormData(form);
    const name = String(data.get('name') || '').trim();
    const email = String(data.get('email') || '').trim();
    button.disabled = true;
    show('Sending…', '');
    try {
      // Only the email is stored; the name just prefills the calendar.
      const res = await fetch(form.getAttribute('action'), {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ email, website: data.get('website') }),
      });
      if (res.ok) {
        show('', '');
        stepTwo(name, email);
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
