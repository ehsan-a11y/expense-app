const APP_URL = 'https://expense-app-kappa-seven.vercel.app';

export function emailConfigured() {
  return Boolean(process.env.RESEND_API_KEY && process.env.REMINDER_EMAIL);
}

export async function sendReminderEmail({ subject, line, path }) {
  const to = process.env.REMINDER_EMAIL.split(',').map(s => s.trim()).filter(Boolean);
  const link = APP_URL + path;
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
      text: `${line}\n\nAdd one now: ${link}`,
      html: `<p>${line}</p><p><a href="${link}">Add an expense</a></p>`
    })
  });
  if (!r.ok) throw new Error(`Resend ${r.status}: ${await r.text()}`);
  return to.length;
}
