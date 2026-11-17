import { neon } from '@neondatabase/serverless';
import * as webpush from 'web-push';
import { buildSummary, emailConfigured, getRecipients, sendReminderEmail } from './_email.js';

let lastTestEmail = 0;

async function getDB() {
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
  return sql;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    if (req.method === 'GET') {
      if (!process.env.VAPID_PUBLIC_KEY) return res.status(500).json({ error: 'VAPID_PUBLIC_KEY not set' });
      return res.status(200).json({ publicKey: process.env.VAPID_PUBLIC_KEY, emailEnabled: emailConfigured() });
    }

    if (req.method === 'POST') {
      const body = req.body || {};

      if (body.action === 'test-email') {
        if (!emailConfigured()) return res.status(400).json({ error: 'email sending is not set up on the server yet' });
        if (Date.now() - lastTestEmail < 30000) return res.status(429).json({ error: 'wait a moment before sending another test' });
        const sql = await getDB();
        const to = await getRecipients(sql);
        if (!to.length) return res.status(400).json({ error: 'add an email address first' });
        lastTestEmail = Date.now();
        try {
          const summary = await buildSummary(sql);
          const r = await sendReminderEmail({
            to,
            summary,
            subject: 'Reminder email is on',
            line: 'This is a test. You will get an email like this every day at 8 AM with a summary of yesterday.',
            path: '/?add=1'
          });
          return res.status(200).json({ ok: true, sent: r.sent, failed: r.failed });
        } catch (err) {
          console.error('test email failed', err.message);
          return res.status(502).json({ error: err.message });
        }
      }

      const sql = await getDB();

      if (body.action === 'subscribe') {
        const s = body.subscription;
        if (!s || !s.endpoint || !s.keys || !s.keys.p256dh || !s.keys.auth) {
          return res.status(400).json({ error: 'invalid subscription' });
        }
        await sql`
          INSERT INTO push_subscriptions (endpoint, p256dh, auth)
          VALUES (${s.endpoint}, ${s.keys.p256dh}, ${s.keys.auth})
          ON CONFLICT (endpoint) DO UPDATE SET p256dh = ${s.keys.p256dh}, auth = ${s.keys.auth}
        `;
        return res.status(200).json({ ok: true });
      }

      if (body.action === 'unsubscribe') {
        if (!body.endpoint) return res.status(400).json({ error: 'endpoint required' });
        await sql`DELETE FROM push_subscriptions WHERE endpoint = ${body.endpoint}`;
        return res.status(200).json({ ok: true });
      }

      if (body.action === 'test') {
        if (!body.endpoint) return res.status(400).json({ error: 'endpoint required' });
        const rows = await sql`SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE endpoint = ${body.endpoint}`;
        if (!rows.length) return res.status(404).json({ error: 'not subscribed' });
        webpush.setVapidDetails(process.env.VAPID_SUBJECT, process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
        const r = rows[0];
        await webpush.sendNotification(
          { endpoint: r.endpoint, keys: { p256dh: r.p256dh, auth: r.auth } },
          JSON.stringify({
            title: 'Reminder is on',
            body: 'This is a test. If you forget to add today’s expenses, you will get a reminder like this at 9 PM.',
            url: '/?add=1'
          })
        );
        return res.status(200).json({ ok: true });
      }

      return res.status(400).json({ error: 'unknown action' });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
}
