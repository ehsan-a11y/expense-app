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

export async function sendReminderEmail({ to, subject, line, path }) {
  const link = APP_URL + path;
  const msg = {
    subject,
    text: `${line}\n\nAdd one now: ${link}`,
    html: `<p>${line}</p><p><a href="${link}">Add an expense</a></p>`
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
