import { neon } from '@neondatabase/serverless';

export const config = {
  api: { bodyParser: { sizeLimit: '10mb' } }
};

async function getDB() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL not set');
  const sql = neon(process.env.DATABASE_URL);
  await sql`
    CREATE TABLE IF NOT EXISTS expense_records (
      id        SERIAL PRIMARY KEY,
      time      TEXT    NOT NULL,
      type      TEXT    NOT NULL DEFAULT 'Expense',
      amount    NUMERIC NOT NULL,
      category  TEXT    NOT NULL,
      account   TEXT    NOT NULL DEFAULT '—',
      note      TEXT    NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;
  return sql;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const sql = await getDB();

    // GET — fetch all records
    if (req.method === 'GET') {
      const rows = await sql`
        SELECT id, time, type, amount::float AS amount, category, account, note
        FROM expense_records
        ORDER BY time DESC, id DESC
      `;
      return res.status(200).json(rows);
    }

    // POST — insert one or many records
    if (req.method === 'POST') {
      const body = req.body;
      const items = Array.isArray(body) ? body : [body];
      const inserted = [];
      for (const r of items) {
        const row = await sql`
          INSERT INTO expense_records (time, type, amount, category, account, note)
          VALUES (${r.time}, ${r.type || 'Expense'}, ${parseFloat(r.amount)},
                  ${r.category || 'Uncategorized'}, ${r.account || '—'}, ${r.note || ''})
          RETURNING id, time, type, amount::float AS amount, category, account, note
        `;
        inserted.push(row[0]);
      }
      return res.status(201).json(inserted);
    }

    // DELETE — delete by id (?id=X) or all (?all=1)
    if (req.method === 'DELETE') {
      if (req.query.all === '1') {
        await sql`DELETE FROM expense_records`;
        return res.status(200).json({ ok: true, deleted: 'all' });
      }
      const id = parseInt(req.query.id);
      if (!id) return res.status(400).json({ error: 'id required' });
      await sql`DELETE FROM expense_records WHERE id = ${id}`;
      return res.status(200).json({ ok: true, id });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
}
