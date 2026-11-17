import nodemailer from 'nodemailer';

const APP_URL = 'https://expense-app-kappa-seven.vercel.app';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function smtpReady() {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

function resendReady() {
  return Boolean(process.env.RESEND_API_KEY);
}

export function emailConfigured() {
  return smtpReady() || resendReady();
}

export async function getRecipients(sql) {
  let list = [];
  try {
    const rows = await sql`SELECT value FROM app_settings WHERE key = 'reminderEmails'`;
    if (rows.length) {
      const v = JSON.parse(rows[0].value);
      if (Array.isArray(v)) list = v;
    }
  } catch (_) {}
  if (process.env.REMINDER_EMAIL) list = list.concat(process.env.REMINDER_EMAIL.split(','));
  const seen = new Set();
  return list
    .map(s => String(s).trim().toLowerCase())
    .filter(s => EMAIL_RE.test(s) && !seen.has(s) && seen.add(s))
    .slice(0, 10);
}

let transporter;
function smtp() {
  if (!transporter) {
    const port = parseInt(process.env.SMTP_PORT || '587', 10);
    const secure = process.env.SMTP_SECURE ? process.env.SMTP_SECURE === 'true' : port === 465;
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port,
      secure,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 15000
    });
  }
  return transporter;
}

async function sendOne(to, { subject, text, html }) {
  if (smtpReady()) {
    await smtp().sendMail({ from: process.env.SMTP_FROM || process.env.SMTP_USER, to, subject, text, html });
    return;
  }
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: process.env.REMINDER_FROM || 'ExpenseApp <onboarding@resend.dev>',
      to: [to],
      subject,
      text,
      html
    })
  });
  if (!r.ok) throw new Error(`Resend ${r.status}: ${await r.text()}`);
}

export const UTC_OFFSET_HOURS = 4; // UAE / Gulf Standard Time

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function getFormatter(sql) {
  let cfg = {};
  try {
    const rows = await sql`SELECT key, value FROM app_settings WHERE key IN ('currency', 'numFmt', 'symPos')`;
    rows.forEach(r => { try { cfg[r.key] = JSON.parse(r.value); } catch (_) { cfg[r.key] = r.value; } });
  } catch (_) {}
  const cur = cfg.currency || '$';
  const dec = cfg.numFmt === '0' ? 0 : 2;
  const after = cfg.symPos === 'after';
  return v => {
    const s = (parseFloat(v) || 0).toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec });
    return after ? `${s} ${cur}` : `${cur} ${s}`;
  };
}

export async function buildSummary(sql) {
  const local = new Date(Date.now() + UTC_OFFSET_HOURS * 3600 * 1000);
  const today = local.toISOString().slice(0, 10);
  const yesterday = new Date(local.getTime() - 86400000).toISOString().slice(0, 10);
  const monthStart = today.slice(0, 8) + '01';
  const fmt = await getFormatter(sql);

  const month = await sql`
    SELECT type, amount::float AS amount, category FROM expense_records
    WHERE LEFT(time, 10) >= ${monthStart} AND LEFT(time, 10) <= ${today}
  `;
  const ydayRows = await sql`
    SELECT id, type, amount::float AS amount, category, account, note FROM expense_records
    WHERE LEFT(time, 10) = ${yesterday}
    ORDER BY id
  `;

  const total = month.reduce((s, r) => s + r.amount, 0);
  const income = month.filter(r => r.type === 'Income').reduce((s, r) => s + r.amount, 0);
  const expense = month.filter(r => r.type === 'Expense').reduce((s, r) => s + r.amount, 0);
  const balance = income - expense;
  const cats = new Set(month.map(r => r.category)).size;
  const yExpense = ydayRows.filter(r => r.type === 'Expense').reduce((s, r) => s + r.amount, 0);
  const yCount = ydayRows.filter(r => r.type === 'Expense').length;

  const dayLabel = d => new Date(d + 'T00:00:00Z').toLocaleDateString('en-US', { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' });
  const monthLabel = new Date(today + 'T00:00:00Z').toLocaleDateString('en-US', { timeZone: 'UTC', month: 'long', year: 'numeric' });

  const card = (label, value, color, sub) =>
    `<td width="50%" style="padding:4px;vertical-align:top"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td bgcolor="${color}" style="background:${color};border-radius:10px;padding:12px 14px;color:#ffffff">` +
    `<div style="font-size:11px;letter-spacing:.06em;text-transform:uppercase;font-weight:700;color:#ffffff;opacity:.9">${label}</div>` +
    `<div style="font-size:18px;font-weight:700;margin-top:4px;color:#ffffff">${esc(value)}</div>` +
    `<div style="font-size:11px;margin-top:2px;color:#ffffff;opacity:.85">${esc(sub)}</div></td></tr></table></td>`;

  const cards = [
    [card('Total', fmt(total), '#2980b9', `${month.length} records`), card('Income', fmt(income), '#27ae60', 'Earnings')],
    [card('Expenses', fmt(expense), '#e74c3c', 'Spending'), card('Balance', fmt(balance), balance >= 0 ? '#8e44ad' : '#c0392b', 'Net')],
    [card('Categories', String(cats), '#16a085', 'Unique'), card('Yesterday’s expenses', fmt(yExpense), '#e67e22', `${dayLabel(yesterday)} · ${yCount} record${yCount === 1 ? '' : 's'}`)]
  ].map(r => `<tr>${r.join('')}</tr>`).join('');

  const shown = ydayRows.slice(0, 30);
  const th = 'padding:7px 8px;font-size:11px;text-align:left;color:#5a6a82;border-bottom:1px solid #dde3ec;text-transform:uppercase';
  const rowsHtml = shown.map((r, i) => {
    const bg = i % 2 ? '#f4f6fa' : '#ffffff';
    const badge = r.type === 'Income' ? 'background:#e8f5e9;color:#27ae60' : 'background:#fde8e8;color:#c0392b';
    return `<tr style="background:${bg}"><td style="padding:7px 8px;font-size:12px"><span style="${badge};padding:2px 8px;border-radius:12px;font-size:11px;font-weight:700">${esc(r.type)}</span></td>` +
      `<td style="padding:7px 8px;font-size:12px;font-weight:700">${esc(fmt(r.amount))}</td>` +
      `<td style="padding:7px 8px;font-size:12px">${esc(r.category)}</td>` +
      `<td style="padding:7px 8px;font-size:12px">${esc(r.account)}</td>` +
      `<td style="padding:7px 8px;font-size:12px;color:#5a6a82">${esc(r.note)}</td></tr>`;
  }).join('');
  const more = ydayRows.length > shown.length ? `<p style="font-size:12px;color:#5a6a82">…and ${ydayRows.length - shown.length} more records.</p>` : '';
  const table = ydayRows.length
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #dde3ec;border-radius:8px;border-collapse:separate;overflow:hidden"><tr><th style="${th}">Type</th><th style="${th}">Amount</th><th style="${th}">Category</th><th style="${th}">Account</th><th style="${th}">Note</th></tr>${rowsHtml}</table>${more}`
    : `<p style="font-size:13px;color:#5a6a82;margin:0">No records were added for yesterday.</p>`;

  const html =
    `<h3 style="font-size:14px;margin:0 0 6px">${esc(monthLabel)} so far</h3>` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 -4px 18px">${cards}</table>` +
    `<h3 style="font-size:14px;margin:0 0 8px">Yesterday’s records (${esc(dayLabel(yesterday))})</h3>${table}`;

  const textRows = shown.map(r => `  - ${r.type}: ${fmt(r.amount)} | ${r.category} | ${r.account}${r.note ? ' | ' + r.note : ''}`).join('\n');
  const text =
    `${monthLabel} so far\n  Total: ${fmt(total)} (${month.length} records)\n  Income: ${fmt(income)}\n  Expenses: ${fmt(expense)}\n  Balance: ${fmt(balance)}\n  Categories: ${cats}\n\n` +
    `Yesterday (${dayLabel(yesterday)}): expenses ${fmt(yExpense)} in ${yCount} record${yCount === 1 ? '' : 's'}\n` + (textRows || '  No records were added for yesterday.');

  return { html, text };
}

export async function sendReminderEmail({ to, subject, line, path, summary }) {
  const link = APP_URL + path;
  const msg = {
    subject,
    text: `${line}\n\nAdd one now: ${link}` + (summary ? `\n\n${summary.text}` : ''),
    html: `<div style="font-family:Arial,Helvetica,sans-serif;max-width:620px;margin:0 auto;color:#1a2332">
<p style="font-size:16px;margin:0 0 12px">${esc(line)}</p>
<p style="margin:0 0 18px"><a href="${link}" style="background:#2980b9;color:#ffffff;text-decoration:none;padding:10px 18px;border-radius:6px;font-weight:700;display:inline-block">Add an expense</a></p>
${summary ? summary.html : ''}
</div>`
  };
  let sent = 0, failed = 0, lastError = '';
  for (const addr of to) {
    try {
      await sendOne(addr, msg);
      sent++;
    } catch (err) {
      failed++;
      lastError = err.message;
      console.error('email failed for one recipient:', err.message);
    }
  }
  if (!sent && failed) throw new Error(lastError || 'email failed');
  return { sent, failed };
}
