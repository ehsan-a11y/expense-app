import { neon } from '@neondatabase/serverless';
import * as webpush from 'web-push';
import { UTC_OFFSET_HOURS, buildSummary, emailConfigured, getRecipients, sendReminderEmail } from './_email.js';

export async function processReminder(sql, query) {
  const slot = query.slot === 'evening' ? 'evening' : 'morning';
  const local = Date.now() + UTC_OFFSET_HOURS * 3600 * 1000;
  const today = new Date(local).toISOString().slice(0, 10);
  const yesterday = new Date(local - 86400000).toISOString().slice(0, 10);
  const target = slot === 'morning' ? yesterday : today;
  const force = query.force === '1';

  const found = await sql`
    SELECT 1 FROM expense_records
    WHERE type = 'Expense' AND LEFT(time, 10) = ${target}
    LIMIT 1
  `;
  const hasExpense = found.length > 0;
  const needsReminder = force || !hasExpense;
  // Morning (8 AM): email summary every day. Evening (9 PM): phone push, only when today has no expense yet.
  const sendEmail = slot === 'morning';
  const sendPush = slot === 'evening' && needsReminder;
  if (!sendEmail && !sendPush) return { status: 200, body: { ok: true, skipped: 'expense already added', slot, target } };

  const msg = slot === 'morning'
    ? { title: 'Don’t forget yesterday’s expenses', line: 'You didn’t add any expense yesterday.', body: 'You didn’t add any expense yesterday. Tap to add it now.', path: `/?add=1&date=${yesterday}` }
    : { title: 'Don’t forget your expenses', line: 'You haven’t added any expense today.', body: 'You haven’t added any expense today. Tap to add it now.', path: '/?add=1' };
  const mail = (slot === 'morning' && hasExpense && !force)
    ? { subject: 'Your daily expense summary', line: 'Here is your summary for yesterday.', path: '/' }
    : { subject: msg.title, line: msg.line, path: msg.path };

  const result = { ok: true, slot, target, hasExpense, push: { sent: 0, removed: 0 }, email: 'not configured' };

  const subs = sendPush ? await sql`SELECT endpoint, p256dh, auth FROM push_subscriptions` : [];
  if (subs.length) {
    webpush.setVapidDetails(process.env.VAPID_SUBJECT, process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
    const payload = JSON.stringify({ title: msg.title, body: msg.body, url: msg.path, tag: 'expense-reminder' });
    for (const s of subs) {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, { urgency: 'high', TTL: 4 * 3600 });
        result.push.sent++;
      } catch (err) {
        if (err.statusCode === 404 || err.statusCode === 410) {
          await sql`DELETE FROM push_subscriptions WHERE endpoint = ${s.endpoint}`;
          result.push.removed++;
        } else {
          console.error('push failed', err.statusCode, err.body);
        }
      }
    }
  }

  if (sendEmail && emailConfigured()) {
    try {
      const to = await getRecipients(sql);
      if (!to.length) {
        result.email = 'no email addresses added';
      } else {
        const summary = await buildSummary(sql);
        const r = await sendReminderEmail({ to, subject: mail.subject, line: mail.line, path: mail.path, summary });
        result.email = `sent ${r.sent}, failed ${r.failed}`;
      }
    } catch (err) {
      console.error('email failed', err.message);
      result.email = 'failed: ' + err.message;
    }
  }
  return { status: 200, body: result };
}

export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.authorization !== `Bearer ${secret}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  try {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL not set');
    const sql = neon(process.env.DATABASE_URL);
    await sql`
      CREATE TABLE IF NOT EXISTS push_subscriptions (
        endpoint   TEXT PRIMARY KEY,
        p256dh     TEXT NOT NULL,
        auth       TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `;
    const out = await processReminder(sql, req.query || {});
    return res.status(out.status).json(out.body);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
}
