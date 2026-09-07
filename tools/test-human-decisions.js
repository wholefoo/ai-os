// Human-in-the-loop decisions are HUMAN-only: the API token may not approve, retry, batch-approve,
// approve a pipeline gate, or change the automation mode. SOC 2 gap item 21 (CC8.1-h).
//
// Before this: the service token resolved to an admin session, so any automation holding it (an
// n8n workflow built from the shipped templates, Hermes, a leaked token) could queue a gated action
// and approve it itself — or switch the instance to `auto` and have nothing queued at all. The
// approval gate was a gate with the key taped to the door.
//
// Shape pinned here as text (repo convention). Behaviour proven end to end on a throwaway-token
// instance in the commit that lands this: token → 403 on every decision route, before any lookup;
// signed-in admin → allowed, with the from → to audit line.
const { assert, done, serverSource } = require('./test-util');

const src = serverSource();
const between = (a, b) => src.slice(src.indexOf(a), src.indexOf(b, src.indexOf(a)));

const mw = between('function requireHuman(', '\n}\n');
assert(mw.length > 50, 'requireHuman located');
assert(/req\.session\.service/.test(mw) && /status\(403\)/.test(mw), 'requireHuman refuses a service (API-token) session with 403');
assert(/logActivity\('approval', 'Refused: API token attempted a human-only decision'/.test(mw), 'the refusal is written to the activity log with the route');

// Every decision route stacks requireHuman AFTER requireAdmin (admin first, so an anonymous caller
// still gets 401, and a non-admin human 403 for the usual reason).
for (const route of ['/api/approvals/:id/approve', '/api/approvals/batch', '/api/approvals/:id/retry', '/api/approvals/:id/reconcile', '/api/pipelines/runs/:id/approve']) {
  const re = new RegExp(`app\\.post\\('${route.replace(/[/:]/g, (c) => '\\' + c)}', requireAdmin, requireHuman`);
  assert(re.test(src), `${route} is requireAdmin, requireHuman`);
}
// Rejecting is not a bypass and remediation only records minutes — deliberately left open to automation.
assert(/app\.post\('\/api\/approvals\/:id\/reject', requireAdmin, \(req/.test(src), 'reject stays admin-only without requireHuman (declining is not a bypass)');

// Mode changes: human-only, audited from → to, notified on a switch TO auto, pending approvals untouched.
const put = between("app.put('/api/settings/:section'", 'async function testJsonService');
assert(/const modeChange = section === 'automation' && req\.body && 'mode' in req\.body/.test(put), 'a mode change is detected by key, not by section alone (other automation keys stay open)');
assert(/if \(modeChange && req\.session && req\.session\.service\) return requireHuman\(/.test(put), 'the API token cannot change the mode');
assert(put.indexOf('previousMode') < put.indexOf('for (const [key, value] of Object.entries(updates))'), 'the previous mode is captured BEFORE the write loop, so the audit line cannot read the new value as the old one');
assert(/Automation mode changed: \$\{previousMode\} → \$\{to\}/.test(put) && /actor: reqActor\(req\), ip: req\.ip/.test(put), 'a real change writes its own audit line with from, to, actor, ip');
assert(/previousMode !== req\.body\.mode/.test(put), 'setting the mode to what it already is does not write a change line');
assert(/if \(to === 'auto'\)[\s\S]*sendNotification\('Automation mode set to AUTO'/.test(put), 'a switch TO auto sends a high-priority notification');
assert(/Pending approvals are NOT flushed/.test(put), 'the no-flush rule is stated where the mode changes');

// gateAction reads the mode at decision time (so a switch cannot retroactively release what was queued).
const gate = between('async function gateAction(', '\n}\n');
assert(/const mode = \(settings\.automation && settings\.automation\.mode\) \|\| 'supervised'/.test(gate), 'gateAction reads the live mode per decision, defaulting to supervised');

done();
