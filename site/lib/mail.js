// SPDX-License-Identifier: MIT
/*
 * mail.js — send the password email.
 *
 * MAIL_PROVIDER=resend  POST https://api.resend.com/emails with RESEND_API_KEY,
 *                       from MAIL_FROM (an address on the product domain).
 * MAIL_PROVIDER=log     print the message to the function log instead
 *                       (local preview and tests). This is the default, so a
 *                       deployment without a provider configured never
 *                       pretends to have sent anything.
 */

export async function sendPasswordEmail(env, { to, link, product = 'Backbrief' }) {
  const subject = `Set your ${product} password`;
  const text = [
    `Set a new password for ${product}:`,
    link,
    '',
    'The link works once and expires in 30 minutes.',
    "If you didn't ask for it, ignore this email; your password stays as it is.",
  ].join('\n');

  const provider = (env.MAIL_PROVIDER || 'log').toLowerCase();
  if (provider === 'log') {
    console.log(`[mail:log] to=${to} subject="${subject}" link=${link}`);
    return { ok: true, provider };
  }
  if (provider === 'resend') {
    if (!env.RESEND_API_KEY || !env.MAIL_FROM) throw new Error('RESEND_API_KEY and MAIL_FROM are required for MAIL_PROVIDER=resend');
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: env.MAIL_FROM, to: [to], subject, text }),
    });
    if (!res.ok) throw new Error(`resend: HTTP ${res.status}`);
    return { ok: true, provider };
  }
  throw new Error(`unknown MAIL_PROVIDER "${provider}"`);
}
