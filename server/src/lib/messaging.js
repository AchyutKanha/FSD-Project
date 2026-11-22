const nodemailer = require('nodemailer');
const config = require('../config');

let transporter = null;
function getTransporter() {
  if (transporter) return transporter;
  transporter = config.smtp.host
    ? nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.secure,
      auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
    })
    // No SMTP configured: render the message as JSON and log it instead of sending.
    : nodemailer.createTransport({ jsonTransport: true });
  return transporter;
}

async function sendEmail({ to, subject, html, text, attachments }) {
  const info = await getTransporter().sendMail({ from: config.smtp.from, to, subject, html, text, attachments });
  if (!config.smtp.host && !config.isTest) console.log(`[mail:dev] to=${to} subject="${subject}"`);
  return info;
}

/** Post a plain-text message to a Google Chat incoming webhook. */
async function sendGoogleChat(webhookUrl, text) {
  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=UTF-8' },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) throw new Error(`Google Chat webhook responded ${res.status}`);
}

const escapeHtml = (v) => String(v ?? '').replace(/[&<>"']/g, (ch) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[ch]));

module.exports = { sendEmail, sendGoogleChat, escapeHtml };
