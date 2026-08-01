// lib/notify/slack.js — deciding whether a Slack webhook is actually usable, and what to send.
//
// Written after the production log showed `[SLACK] Send failed: Failed to parse URL from
// your-slack-webhook-url-here` — the literal placeholder from .env.example, shipped as if it were
// configuration. Every send attempted a real HTTP request against a string that was never a URL,
// failed, and logged an error. Meanwhile the activity log recorded "Slack notification sent".
//
// Three distinct defects lived in `if (webhookUrl)`:
//
//   1. A placeholder is TRUTHY. "Set to something" was being read as "configured", so an instance
//      that had never been connected to Slack behaved like a broken one rather than an unconfigured
//      one. Those need different messages: nothing is wrong with an instance that doesn't use Slack.
//
//   2. The failure was invisible where it mattered. It appeared once per attempt in stderr, which
//      nobody reads, while the dashboard's own activity feed claimed delivery. An alert channel
//      that has never delivered anything, reporting success, is worse than no channel at all.
//
//   3. The URL is operator-configurable and was fetched raw — the same SSRF shape as the plugin
//      test-fire. Sending goes through safeRequest at the call site; this module's job is to
//      refuse anything that isn't a plausible webhook before it gets that far.
//
// The check is deliberately NOT a list of known placeholder spellings ("your-", "xxx", "changeme",
// "TODO"). Enumerating the strings people write means missing the next one. A webhook has to be an
// https URL to work at all, so that IS the test — it admits every real webhook and rejects every
// placeholder, including ones nobody has thought of yet.

'use strict';

/**
 * Resolve a configured value into a usable webhook URL.
 *
 * @returns {{ok: true, url: string} | {ok: false, state: 'unset'|'invalid', reason: string}}
 *   `unset` means nobody has configured Slack — normal, silent, not a problem.
 *   `invalid` means somebody put something there that cannot work — worth saying out loud once.
 */
function resolveWebhook(raw) {
  const value = String(raw == null ? '' : raw).trim();
  if (!value) return { ok: false, state: 'unset', reason: 'no Slack webhook configured' };

  let u;
  try { u = new URL(value); } catch {
    // The placeholder path. Note it lands here rather than in a placeholder branch: a value that
    // is not a URL cannot be a webhook, whatever the author meant by it.
    return { ok: false, state: 'invalid', reason: `not a URL (${value.slice(0, 40)})` };
  }

  // Slack incoming webhooks are always https. Allowing http would also mean allowing a plaintext
  // POST of whatever the notification contains, which can include proposal titles and system state.
  if (u.protocol !== 'https:') return { ok: false, state: 'invalid', reason: `must be https, got ${u.protocol.replace(':', '')}` };

  return { ok: true, url: u.href };
}

/** True when Slack is genuinely usable. The one predicate every send site should ask. */
function isConfigured(raw) {
  return resolveWebhook(raw).ok === true;
}

/**
 * A one-line explanation for a value that was SET but cannot work, or null when there is nothing
 * to say. Called at boot so a misconfiguration is stated once, loudly, instead of once per
 * notification in a stream nobody tails.
 */
function configWarning(raw) {
  const r = resolveWebhook(raw);
  if (r.ok || r.state === 'unset') return null;
  return `SLACK_WEBHOOK_URL is set but unusable — ${r.reason}. Slack notifications are DISABLED. `
    + 'Create an Incoming Webhook at https://api.slack.com/messaging/webhooks and set the https URL it gives you.';
}

/** The message body for a plain notification. */
function notificationPayload({ title, message, priority }) {
  const color = priority === 'critical' ? '#ef4444' : priority === 'normal' ? '#3b82f6' : '#6b7280';
  return {
    attachments: [{
      color,
      title: String(title || ''),
      text: String(message || ''),
      footer: 'AI OS Orchestration Lab',
      ts: Math.floor(Date.now() / 1000),
    }],
  };
}

/** The message body for an approval proposal. */
function approvalPayload(proposal) {
  const p = proposal || {};
  const riskEmoji = p.risk === 'high' ? '🔴' : p.risk === 'medium' ? '🟡' : '🟢';
  const text = `${p.icon || ''} *Platform Update Proposal*\n\n`
    + `*${p.title || 'Untitled'}*\n`
    + `Type: ${p.typeLabel || 'unknown'} | Risk: ${riskEmoji} ${p.risk || 'unknown'}\n`
    + (p.description ? `${p.description}\n` : '')
    + '\nApprove/reject in the dashboard → Platform view';
  return { text };
}

module.exports = { resolveWebhook, isConfigured, configWarning, notificationPayload, approvalPayload };
