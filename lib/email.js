// lib/email.js — outbound email seam for the platform (sequences, and any future sender).
//
// Two transports behind one call, chosen by configuration — the operator brings whichever
// credential they have:
//   resend : HTTPS API (api.resend.com). No SMTP ports involved (some VPS hosts block 587/465).
//   smtp   : any SMTP server via nodemailer (Gmail app password, Mailgun, self-hosted postfix...).
// Config lives in settings.email (hydrated from EMAIL_* / RESEND_API_KEY / SMTP_* env in server.js).
// The unsubscribe footer + List-Unsubscribe header are appended HERE so no caller can forget
// them — every marketing email the platform ever sends is CAN-SPAM shaped by construction.

const crypto = require('crypto');
const nodemailer = require('nodemailer');

function pickProvider(cfg = {}) {
  if (cfg.provider === 'resend' || cfg.provider === 'smtp') return cfg.provider;
  if (cfg.resend_api_key) return 'resend';
  if (cfg.smtp_host) return 'smtp';
  return null;
}

function isConfigured(cfg = {}) {
  return !!(pickProvider(cfg) && cfg.from_email);
}

// Deterministic per-address unsubscribe token — HMAC over the normalized email with a
// server-held secret, so the public unsubscribe link can't be forged for other addresses.
function unsubscribeToken(email, secret) {
  return crypto.createHmac('sha256', String(secret)).update(String(email).trim().toLowerCase()).digest('hex').slice(0, 32);
}
function verifyUnsubscribeToken(email, token, secret) {
  const a = Buffer.from(unsubscribeToken(email, secret));
  const b = Buffer.from(String(token || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Minimal text→HTML: paragraphs on blank lines, <br> within, links left as text. Marketing
// emails from this platform are deliberately simple prose — no template gymnastics to break.
function textToHtml(text, { footerHtml = '' } = {}) {
  const body = String(text).trim().split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 14px;line-height:1.55;">${esc(p).replace(/\n/g, '<br>')}</p>`)
    .join('');
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#222;max-width:640px;margin:0 auto;padding:8px 4px;">${body}${footerHtml}</div>`;
}

function complianceFooter({ fromName, footerAddress, unsubscribeUrl }) {
  return `<hr style="border:none;border-top:1px solid #e5e5e5;margin:22px 0 12px;">` +
    `<p style="font-size:12px;color:#888;line-height:1.5;margin:0;">` +
    `You are receiving this because you contacted ${esc(fromName || 'us')} or requested information.` +
    (footerAddress ? ` ${esc(footerAddress)}.` : '') +
    (unsubscribeUrl ? ` <a href="${esc(unsubscribeUrl)}" style="color:#888;">Unsubscribe</a>.` : '') +
    `</p>`;
}

// send({cfg, to, subject, text, html?, unsubscribeUrl, attachments}) -> { ok, id?, error? }
// `text` is the whole authored body; HTML is derived from it unless a custom `html` body is
// passed (rich report emails) — the compliance footer is appended in BOTH paths, so no caller
// can produce a footer-less marketing email. attachments: [{ filename, content }] where content
// is a utf-8 string or Buffer. Never throws — callers branch on ok.
async function send({ cfg, to, subject, text, html: customHtml = null, unsubscribeUrl = null, attachments = [] }) {
  try {
    const provider = pickProvider(cfg);
    if (!provider || !cfg.from_email) return { ok: false, error: 'email not configured — set a Resend key or SMTP host + a From address in Settings → Email' };
    const from = cfg.from_name ? `${cfg.from_name} <${cfg.from_email}>` : cfg.from_email;
    const footerHtml = complianceFooter({ fromName: cfg.from_name, footerAddress: cfg.footer_address, unsubscribeUrl });
    const html = customHtml ? `${customHtml}${footerHtml}` : textToHtml(text, { footerHtml });
    const plain = `${text}\n\n--\n${unsubscribeUrl ? `Unsubscribe: ${unsubscribeUrl}` : ''}`.trim();
    const headers = unsubscribeUrl ? { 'List-Unsubscribe': `<${unsubscribeUrl}>` } : undefined;

    if (provider === 'resend') {
      const resendAttachments = attachments.map((a) => ({ filename: a.filename, content: Buffer.from(a.content).toString('base64') }));
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${cfg.resend_api_key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from, to: [to], subject, html, text: plain, headers, ...(resendAttachments.length ? { attachments: resendAttachments } : {}) }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) return { ok: false, error: j.message || j.error || `Resend HTTP ${r.status}` };
      return { ok: true, id: j.id || null, provider };
    }

    const transporter = nodemailer.createTransport({
      host: cfg.smtp_host,
      port: Number(cfg.smtp_port) || 587,
      secure: Number(cfg.smtp_port) === 465,
      auth: cfg.smtp_user ? { user: cfg.smtp_user, pass: cfg.smtp_pass } : undefined,
    });
    const info = await transporter.sendMail({ from, to, subject, html, text: plain, headers, ...(attachments.length ? { attachments } : {}) });
    return { ok: true, id: info.messageId || null, provider };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { send, pickProvider, isConfigured, unsubscribeToken, verifyUnsubscribeToken, textToHtml };
