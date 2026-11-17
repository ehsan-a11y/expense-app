import nodemailer from 'nodemailer';

const APP_URL = 'https://expense-app-kappa-seven.vercel.app';

function smtpConfigured() {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS && process.env.REMINDER_EMAIL);
}

function resendConfigured() {
  return Boolean(process.env.RESEND_API_KEY && process.env.REMINDER_EMAIL);
}

export function emailConfigured() {
  return smtpConfigured() || resendConfigured();
}

function recipients() {
  return process.env.REMINDER_EMAIL.split(',').map(s => s.trim()).filter(Boolean);
}

async function sendViaSmtp({ subject, text, html }) {
  const port = parseInt(process.env.SMTP_PORT || '587', 10);
  const secure = process.env.SMTP_SECURE ? process.env.SMTP_SECURE === 'true' : port === 465;
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000
  });
  const to = recipients();
  await transporter.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to,
    subject,
    text,
    html
  });
  return to.length;
}

async function sendViaResend({ subject, text, html }) {
  const to = recipients();
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: process.env.REMINDER_FROM || 'ExpenseApp <onboarding@resend.dev>',
      to,
      subject,
      text,
      html
    })
  });
  if (!r.ok) throw new Error(`Resend ${r.status}: ${await r.text()}`);
  return to.length;
}

export async function sendReminderEmail({ subject, line, path }) {
  const link = APP_URL + path;
  const msg = {
    subject,
    text: `${line}\n\nAdd one now: ${link}`,
    html: `<p>${line}</p><p><a href="${link}">Add an expense</a></p>`
  };
  return smtpConfigured() ? sendViaSmtp(msg) : sendViaResend(msg);
}
