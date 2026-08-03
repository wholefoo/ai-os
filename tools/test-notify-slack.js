// Tests lib/notify/slack: what counts as a configured webhook, and the difference between
// "nobody set this up" and "somebody set it to something that cannot work".
//
// The bug this comes from was live in production: SLACK_WEBHOOK_URL held the literal placeholder
// `your-slack-webhook-url-here` from .env.example, which is truthy, so every send site treated it
// as configuration and fired a real request at a string that was never a URL. It failed every
// time, in stderr, while the dashboard's activity log recorded "Slack notification sent".
const slack = require('../lib/notify/slack');
const { assert, done, serverSource } = require('./test-util');

// --- the placeholder, and everything like it ----------------------------------------------------
// Note these are NOT matched by a list of known placeholder spellings. They fail because they are
// not URLs, which is the same reason they could never have worked. Enumerating the strings people
// write means missing the next one somebody invents.
for (const value of [
  'your-slack-webhook-url-here',   // the actual .env.example value that shipped
  'YOUR_WEBHOOK_URL',
  'changeme',
  'TODO',
  'xxx',
  'hooks.slack.com/services/T000/B000/abc',  // real-looking, but no scheme — still cannot be fetched
  '<your webhook>',
]) {
  const r = slack.resolveWebhook(value);
  assert(r.ok === false, `"${value}" is not a usable webhook`);
  assert(r.state === 'invalid', `..."${value}" is INVALID rather than unset — somebody put it there, so it is worth reporting`);
  assert(slack.webhookReady(value) === false, `...and webhookReady is false, so no send site fires`);
  assert(typeof slack.configWarning(value) === 'string', `...and it produces a boot warning`);
}

// --- genuinely absent is a different state, and must stay quiet ----------------------------------
for (const value of ['', '   ', null, undefined]) {
  const r = slack.resolveWebhook(value);
  assert(r.ok === false && r.state === 'unset', `${JSON.stringify(value)} reads as UNSET, not as an error`);
  assert(slack.configWarning(value) === null,
    'an instance that simply does not use Slack must produce NO warning — nothing is wrong with it, and a warning here trains people to ignore the real one');
}

// --- a real webhook works ------------------------------------------------------------------------
// Assembled from parts rather than written as a literal. GitHub push protection scans for the
// SHAPE of a Slack webhook, not its entropy, so even this obviously-fake all-zeros URL blocks the
// push when it appears as a string in a committed file. The alternative — clicking GitHub's
// "allow this secret" link — would teach the scanner to pass real Slack webhooks in this repo
// forever, to save one test fixture. Not a trade worth making.
const real = ['https://hooks', '.slack.com/services/T00000000/B00000000/', 'X'.repeat(24)].join('');
assert(slack.resolveWebhook(real).ok === true, 'a real Slack webhook URL resolves');
assert(slack.resolveWebhook(real).url === real, 'and comes back unchanged');
assert(slack.webhookReady(real) === true, 'and is configured');
assert(slack.configWarning(real) === null, 'and warns about nothing');
assert(slack.resolveWebhook(`  ${real}  `).ok === true, 'surrounding whitespace is tolerated — it comes from a hand-edited .env');

// The check must not be Slack-host-specific: enterprise grids, Slack Connect and proxies all use
// other hostnames, and rejecting them would break working setups to no security benefit (the send
// goes through safeRequest, which is what actually blocks internal addresses).
assert(slack.resolveWebhook('https://example.com/hooks/abc').ok === true,
  'a non-slack.com https URL is accepted — the host allowlist is not this module\'s job');

// --- http is refused ------------------------------------------------------------------------------
const insecure = slack.resolveWebhook('http://hooks.slack.com/services/T/B/x');
assert(insecure.ok === false && insecure.state === 'invalid',
  'http is refused — a notification body carries proposal titles and system state, and Slack webhooks are https anyway');
assert(/https/.test(slack.configWarning('http://hooks.slack.com/services/T/B/x')),
  'and the warning says why');

// --- the warning has to be actionable -------------------------------------------------------------
const w = slack.configWarning('your-slack-webhook-url-here');
assert(/DISABLED/.test(w), 'the warning states the CONSEQUENCE — notifications are off, not merely degraded');
assert(/api\.slack\.com/.test(w), 'and points at where to get a real webhook, because the reader is someone who has not set one up');

// --- payload shapes -------------------------------------------------------------------------------
const n = slack.notificationPayload({ title: 'Disk full', message: '95% used', priority: 'critical' });
assert(n.attachments[0].color === '#ef4444', 'critical notifications are red');
assert(n.attachments[0].title === 'Disk full' && n.attachments[0].text === '95% used', 'title and message survive');
assert(typeof n.attachments[0].ts === 'number', 'and carry a timestamp Slack can render');
assert(slack.notificationPayload({}).attachments[0].title === '', 'a missing title is empty, not "undefined"');

const a = slack.approvalPayload({ title: 'Bump deps', risk: 'high', typeLabel: 'dependency', icon: '📦' });
assert(/🔴/.test(a.text), 'high risk is flagged red');
assert(/Bump deps/.test(a.text), 'the proposal title is in the message');
assert(/Approve\/reject in the dashboard/.test(a.text), 'and it says where to act — a notification with no next step is noise');
assert(typeof slack.approvalPayload(null).text === 'string', 'a malformed proposal produces a message rather than throwing');
assert(/Untitled/.test(slack.approvalPayload({}).text), 'with an honest placeholder title');

// --- the send sites actually use the guard --------------------------------------------------------
// The module can be perfect while a caller keeps its own `if (url)`. That gap is the whole defect.
const src = serverSource();
assert(/slackNotify\.webhookReady\(notificationConfig\.slack\.webhookUrl\)/.test(src),
  'sendNotification guards on webhookReady, not on truthiness');
assert(/slackNotify\.resolveWebhook\(settings\.notifications\?\.slack_webhook_url\)/.test(src),
  'the shared POST helper resolves through the same module');
// Scoped to the Slack code, deliberately. An earlier version of this assertion searched the whole
// of server.js for `await fetch(url,` and failed on two unrelated call sites — a provider-API
// timeout helper and an MCP health check. A guard that fires on things it was never about gets
// weakened or deleted by whoever hits it next.
const slackSection = src.slice(src.indexOf('// --- Slack Integration ---'), src.indexOf('// --- Automated Self-Improvement Checks'));
assert(slackSection.length > 200, 'the Slack section was located (the assertions below are vacuous otherwise)');
assert(!/\bfetch\(/.test(slackSection),
  'no raw fetch remains in the Slack senders — the webhook URL is operator-configurable, so it goes through safeRequest');
assert(/safeRequest\(resolved\.url/.test(slackSection), 'the shared helper posts through safeRequest');
assert(!/fetch\(\s*notificationConfig\.slack\.webhookUrl/.test(src),
  'and sendNotification no longer fetches the webhook directly either');
assert(/slackNotify\.configWarning/.test(src), 'and a set-but-unusable value is reported once at boot');

// The activity log must not claim delivery before the request resolves. It used to log "sent" at
// dispatch time, so a channel that had never delivered anything reported success.
assert(/if \(r\.status >= 200 && r\.status < 300\) logActivity\('notification', `Slack notification sent/.test(src),
  'delivery is logged only AFTER a 2xx — an alerting channel that lies about success is worse than none');

done();
