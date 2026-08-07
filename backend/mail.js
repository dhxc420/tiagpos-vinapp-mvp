/**
 * Lightweight mailer: SMTP (nodemailer) or Resend API.
 * If neither is configured, returns sent:false so the UI can show the code/link.
 */

async function sendMail({ to, subject, text, html }) {
  if (!to) return { sent: false, reason: 'missing_to' };

  const from = process.env.MAIL_FROM || process.env.SMTP_FROM || 'WhatsMenú <noreply@whatsmenu.app>';

  if (process.env.RESEND_API_KEY) {
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ from, to: [to], subject, text, html: html || text })
      });
      if (!res.ok) {
        const body = await res.text();
        console.warn('Resend mail failed:', res.status, body);
        return { sent: false, reason: 'resend_error' };
      }
      return { sent: true, provider: 'resend' };
    } catch (e) {
      console.warn('Resend mail error:', e.message);
      return { sent: false, reason: e.message };
    }
  }

  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (host && user && pass) {
    try {
      const nodemailer = require('nodemailer');
      const transporter = nodemailer.createTransport({
        host,
        port: Number(process.env.SMTP_PORT || 587),
        secure: String(process.env.SMTP_SECURE || '').toLowerCase() === 'true',
        auth: { user, pass }
      });
      await transporter.sendMail({
        from,
        to,
        subject,
        text,
        html: html || text
      });
      return { sent: true, provider: 'smtp' };
    } catch (e) {
      console.warn('SMTP mail error:', e.message);
      return { sent: false, reason: e.message };
    }
  }

  console.log('[mail:dev]', { to, subject, text });
  return { sent: false, reason: 'mail_not_configured' };
}

function welcomeEmail({ name, username }) {
  const who = name || username || 'hola';
  const subject = '¡Registro exitoso en WhatsMenú!';
  const text =
    `Hola ${who},\n\n` +
    `Te registraste con éxito en WhatsMenú. Ya puedes iniciar sesión y empezar a usar tu menú digital y pedidos por WhatsApp.\n\n` +
    `Si no fuiste tú, ignora este mensaje.\n\n` +
    `— Equipo WhatsMenú`;
  return { subject, text };
}

function confirmEmail({ name, username, code, confirmUrl }) {
  const who = name || username || 'hola';
  const subject = 'Confirma tu cuenta en WhatsMenú';
  const text =
    `Hola ${who},\n\n` +
    `Gracias por registrarte en WhatsMenú. Para activar tu cuenta usa este código:\n\n` +
    `${code}\n\n` +
    `O abre este enlace:\n${confirmUrl}\n\n` +
    `El código vence en 24 horas.\n\n` +
    `— Equipo WhatsMenú`;
  const html =
    `<p>Hola <strong>${escapeHtml(who)}</strong>,</p>` +
    `<p>Gracias por registrarte en <strong>WhatsMenú</strong>. Confirma tu cuenta con este código:</p>` +
    `<p style="font-size:28px;letter-spacing:6px;font-weight:800">${escapeHtml(code)}</p>` +
    `<p>O <a href="${escapeHtml(confirmUrl)}">haz clic aquí para confirmar</a>.</p>` +
    `<p style="color:#666">El código vence en 24 horas.</p>`;
  return { subject, text, html };
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function mailConfig() {
  const resend = !!process.env.RESEND_API_KEY;
  const smtp = !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
  return {
    configured: resend || smtp,
    provider: resend ? 'resend' : (smtp ? 'smtp' : 'none'),
    from: !!(process.env.MAIL_FROM || process.env.SMTP_FROM),
    RESEND_API_KEY: resend,
    SMTP_HOST: !!process.env.SMTP_HOST,
    SMTP_USER: !!process.env.SMTP_USER,
    SMTP_PASS: !!process.env.SMTP_PASS
  };
}

module.exports = { sendMail, welcomeEmail, confirmEmail, mailConfig };
