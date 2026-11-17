import { neon } from '@neondatabase/serverless';
import * as webpush from 'web-push';

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
      return res.status(200).json({ publicKey: process.env.VAPID_PUBLIC_KEY });
    }

    if (req.method === 'POST') {
      const sql = await getDB();
      const body = req.body || {};

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
          JSON.stringify({ title: 'ExpenseApp reminder', body: 'Test notification — reminders are working.', url: '/?add=1' })
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
