import { neon } from '@neondatabase/serverless';
import * as webpush from 'web-push';
import { emailConfigured, sendReminderEmail } from './_email.js';

const UTC_OFFSET_HOURS = 4; // Gulf Standard Time

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

    const slot = req.query.slot === 'morning' ? 'morning' : 'evening';
    const local = Date.now() + UTC_OFFSET_HOURS * 3600 * 1000;
    const today = new Date(local).toISOString().slice(0, 10);
    const yesterday = new Date(local - 86400000).toISOString().slice(0, 10);
    const target = slot === 'morning' ? yesterday : today;
    const force = req.query.force === '1';

    if (!force) {
      const found = await sql`
        SELECT 1 FROM expense_records
        WHERE type = 'Expense' AND LEFT(time, 10) = ${target}
        LIMIT 1
      `;
      if (found.length) return res.status(200).json({ ok: true, skipped: 'expense already added', slot, target });
    }

    const msg = slot === 'morning'
      ? { title: 'Add yesterday’s expenses', body: 'You didn’t add any expense yesterday. Tap to add them.', path: `/?add=1&date=${yesterday}` }
      : { title: 'Add today’s expenses', body: 'You haven’t added any expense today. Tap to add one.', path: '/?add=1' };

    const result = { ok: true, slot, target, push: { sent: 0, removed: 0 }, email: 'not configured' };

    const subs = await sql`SELECT endpoint, p256dh, auth FROM push_subscriptions`;
    if (subs.length) {
      webpush.setVapidDetails(process.env.VAPID_SUBJECT, process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
      const payload = JSON.stringify({ title: msg.title, body: msg.body, url: msg.path, tag: 'expense-reminder' });
      for (const s of subs) {
        try {
          await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload);
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

    if (emailConfigured()) {
      try {
        result.email = `sent to ${await sendReminderEmail({ subject: msg.title, line: msg.body.replace(' Tap to add one.', '').replace(' Tap to add them.', ''), path: msg.path })} recipient(s)`;
      } catch (err) {
        console.error('email failed', err.message);
        result.email = 'failed: ' + err.message;
      }
    }
    return res.status(200).json(result);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
}
