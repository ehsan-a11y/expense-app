import { neon } from '@neondatabase/serverless';

export const config = { api: { bodyParser: { sizeLimit: '1mb' } } };

async function getDB() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL not set');
  const sql = neon(process.env.DATABASE_URL);
  await sql`
    CREATE TABLE IF NOT EXISTS app_settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
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
    const sql = await getDB();

    if (req.method === 'GET') {
      const rows = await sql`SELECT key, value FROM app_settings`;
      const result = {};
      rows.forEach(r => { try { result[r.key] = JSON.parse(r.value); } catch { result[r.key] = r.value; } });
      return res.status(200).json(result);
    }

    if (req.method === 'POST') {
      const body = req.body;
      for (const [k, v] of Object.entries(body)) {
        if (k === 'categories' || k === 'accounts') {
          // Merge: union of existing DB list + incoming list (preserve all from both devices)
          const existing = await sql`SELECT value FROM app_settings WHERE key = ${k}`;
          let current = [];
          if (existing.length) { try { current = JSON.parse(existing[0].value); } catch {} }
          const merged = Array.from(new Set([...current, ...v]));
          const val = JSON.stringify(merged);
          await sql`
            INSERT INTO app_settings (key, value) VALUES (${k}, ${val})
            ON CONFLICT (key) DO UPDATE SET value = ${val}
          `;
        } else {
          const val = JSON.stringify(v);
          await sql`
            INSERT INTO app_settings (key, value) VALUES (${k}, ${val})
            ON CONFLICT (key) DO UPDATE SET value = ${val}
          `;
        }
      }
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
}
