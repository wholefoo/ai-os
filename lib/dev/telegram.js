// lib/dev/telegram.js
// ============================================================
//  Two-way TELEGRAM gateway for dev-platform missions (P3, docs/dev-platform-design.md).
//
//  The operator drives Hermes-Dev from Telegram: start a mission, read its plan, APPROVE or reject it
//  with a button, ask for status/logs/budget, cancel, retry, revise. Hermes-Dev pushes back the
//  moments that need them: plan ready (with buttons), building, done (PR link), failed, budget alerts.
//
//  SAFETY — approving from Telegram reverses an earlier, deliberate "Telegram cannot approve" rule, so
//  the reversal is narrow and every part of it is enforced here (and again in server.js):
//    * only an ALLOWLISTED user in an ALLOWLISTED chat is heard at all; everyone else gets silence;
//    * buttons carry an unguessable, server-side, SINGLE-USE, EXPIRING nonce — never the approval id —
//      so a forged or replayed button does nothing (stronger than a stateless signature: a used nonce
//      is dead even inside its expiry); pressing one button of a pair kills its sibling;
//    * the only action type approvable from here is 'dev.mission-plan' (worst case: a PR on a fork);
//    * commands older than `staleMs` are not acted on (a backlog after downtime must not replay);
//    * the update offset is saved BEFORE an update is handled: a crash may LOSE a command, never
//      run it twice (a duplicated /new would start a second paid mission);
//    * the bot token never appears in a log line (makeTelegramApi strips it from every error).
//
//  Everything outside missions/board is INJECTED (the Telegram API, approvals, budget, logs, offset
//  storage), so the tests drive this exact code against a fake Telegram.
// ============================================================

const crypto = require('crypto');
const missions = require('./missions');

const MSG_MAX = 3900;                                    // Telegram's hard limit is 4096
const TELEGRAM_APPROVABLE = new Set(['dev.mission-plan']);
// Anything that looks like a credential is masked before log text leaves the box.
const SECRET_RE = /sk-ant-[A-Za-z0-9_-]{10,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|\bbot\d{6,}:[A-Za-z0-9_-]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g;
const redact = (s) => String(s || '').replace(SECRET_RE, '[redacted]');

const HELP = [
  'Hermes-Dev — coding missions',
  '',
  '/new [$N] <goal> — start a mission (plan, then your approval, then build)',
  '/research [$N] <goal> — same, with a web research step first',
  '/missions — recent missions',
  '/status <id> — where a mission is',
  '/plan <id> — read the plan (with Approve / Reject while it waits)',
  '/ship <id> — the ship package and deploy checklist',
  '/logs <id> — tail of the current run log',
  '/revise <id> <feedback> — reject the plan and re-plan with your feedback',
  '/cancel <id>   /retry <id>   /budget',
  '',
  'An <id> is the first few characters shown in messages, e.g. f0c949. Anything that is not a command is offered as a new mission (you confirm with a button).',
].join('\n');

const idSet = (v) => new Set(String(v || '').split(/[\s,]+/).map((s) => s.trim()).filter((s) => /^-?\d+$/.test(s)));
const short = (id) => String(id || '').replace(/^mis_/, '').slice(0, 8);
const money = (n) => `$${(Number(n) || 0).toFixed(2)}`;

function chunk(text, max = MSG_MAX) {
  const out = [];
  let rest = String(text || '');
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max);
    if (cut < max * 0.5) cut = max;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, '');
  }
  if (rest.length || !out.length) out.push(rest);
  return out;
}

// The PR link without the pre-filled body: short enough for a chat message (the full package is /ship).
function shortPrUrl(prUrl) {
  if (!prUrl) return '';
  try { const u = new URL(prUrl); u.searchParams.delete('body'); return u.toString(); } catch { return prUrl; }
}

// Real Bot API client. Every error message has the token stripped before it can reach a log.
function makeTelegramApi(token, fetchImpl = (...a) => fetch(...a)) {
  if (!token) throw new Error('makeTelegramApi: a bot token is required');
  const scrub = (s) => String(s || '').split(token).join('<token>');
  return async function api(method, params = {}, timeoutMs = 65000) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const r = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params), signal: ac.signal,
      });
      let j = {};
      try { j = await r.json(); } catch {}
      if (!j.ok) throw new Error(`telegram ${method} failed: ${j.description || `HTTP ${r.status}`}`);
      return j.result;
    } catch (e) {
      throw new Error(scrub(e && e.message));
    } finally { clearTimeout(t); }
  };
}

function createTelegramGateway({
  api, allowedUserIds, allowedChatIds,
  engine, boardRepo, approvals, getBudget = () => null, readRunLog = () => '',
  loadOffset = () => 0, saveOffset = () => {},
  defaultBudgetUsd = 10, staleMs = 15 * 60 * 1000, nonceTtlMs = 24 * 3600 * 1000,
  pollTimeoutSec = 50, budgetCheckMs = 5 * 60 * 1000,
  now = () => Date.now(), log = () => {},
}) {
  const users = idSet(allowedUserIds);
  const chats = idSet(allowedChatIds);
  const nonces = new Map();                 // nonce -> { kind, payload, exp, used, chatId, group }
  const seen = new Set();                   // update ids handled in this process
  const lastNotified = new Map();           // missionId -> { state, attempts }
  const budgetAlerted = new Set();          // `${period}:${day}:${level}`
  const ignoredLogged = new Set();
  let offset = 0;
  let running = false;
  let budgetTimer = null;

  const allowed = (userId, chatId) => users.has(String(userId)) && chats.has(String(chatId));

  async function send(chatId, text, replyMarkup) {
    const parts = chunk(text);
    let last = null;
    for (let i = 0; i < parts.length; i++) {
      const params = { chat_id: chatId, text: parts[i], disable_web_page_preview: true };
      if (replyMarkup && i === parts.length - 1) params.reply_markup = replyMarkup;
      last = await api('sendMessage', params);
    }
    return last;
  }
  async function broadcast(text, replyMarkup) {
    for (const c of chats) { try { await send(c, text, replyMarkup); } catch (e) { log(`[telegram] notify failed: ${redact(e.message)}`); } }
  }

  // ---------- single-use buttons ----------
  function prune() { const t = now(); for (const [k, v] of nonces) if (v.exp < t) nonces.delete(k); }
  function buttons(chatId, specs) {
    prune();
    const group = crypto.randomBytes(6).toString('hex');
    return { inline_keyboard: [specs.map(({ text, kind, payload }) => {
      const n = crypto.randomBytes(12).toString('base64url');           // 96 bits, 16 chars
      nonces.set(n, { kind, payload, exp: now() + nonceTtlMs, used: false, chatId: String(chatId), group });
      return { text, callback_data: `n:${n}` };
    })] };
  }
  const approvalButtons = (chatId, m) => buttons(chatId, [
    { text: '✅ Approve & build', kind: 'approve', payload: { approvalId: m.approval_id, missionId: m.id } },
    { text: '✖ Reject', kind: 'reject', payload: { approvalId: m.approval_id, missionId: m.id } },
  ]);

  // ---------- mission helpers ----------
  function resolve(ref) {
    const r = String(ref || '').trim().replace(/^#/, '').replace(/^mis_/, '').toLowerCase();
    if (r.length < 4) return { error: 'Give at least the first 4 characters of the mission id.' };
    const hits = missions.list({ limit: 500 }).filter((m) => m.id.replace(/^mis_/, '').toLowerCase().startsWith(r));
    if (!hits.length) return { error: `No mission starts with "${r}".` };
    if (hits.length > 1) return { error: `"${r}" matches ${hits.length} missions — give more characters.` };
    return { mission: hits[0] };
  }
  function statusText(m) {
    const t = m.current_task_id && boardRepo ? boardRepo.get(m.current_task_id) : null;
    const lines = [
      `${m.title}  (#${short(m.id)})`,
      `State: ${m.state}`,
      `Spent: ${money(missions.spend(m.id))} of ${money(m.budget_usd)}`,
    ];
    if (t) lines.push(`Current task: ${t.mode} — ${t.state}${t.result ? ` (${t.result})` : ''}`);
    if (m.build_attempts) lines.push(`Build attempts: ${m.build_attempts} of ${m.max_build_attempts}`);
    if (m.failure_reason) lines.push(`Why: ${m.failure_reason}`);
    if (m.state === 'done' && m.pr_url) lines.push(`PR: ${shortPrUrl(m.pr_url)}`);
    return lines.join('\n');
  }
  async function startMission(chatId, userId, { goal, budgetUsd, research, title }) {
    const m = missions.create({
      goal, title, research: Boolean(research), budgetUsd: budgetUsd === undefined ? defaultBudgetUsd : budgetUsd,
      createdBy: `telegram:${userId}`,
    });
    try { engine.tick(); } catch {}
    lastNotified.set(m.id, { state: m.state, attempts: 0 });
    await send(chatId, `🚀 Mission #${short(m.id)} started — ${m.title}\n${m.state === 'researching' ? 'Researching first, then planning' : 'Planning'} · budget ${money(m.budget_usd)}.\nI'll message you when the plan is ready for your approval.`);
    return m;
  }
  async function sendPlan(chatId, m) {
    if (!String(m.plan_md || '').trim()) return send(chatId, `No plan yet for #${short(m.id)} (state: ${m.state}).`);
    const a = m.approval_id && approvals ? approvals.get(m.approval_id) : null;
    const waiting = m.state === 'awaiting_approval' && a && a.status === 'pending';
    const head = `📋 Plan for #${short(m.id)} — ${m.title}\nSpent so far ${money(missions.spend(m.id))} of ${money(m.budget_usd)}.${waiting ? ' Nothing will be built until you approve.' : ` (state: ${m.state})`}\n\n`;
    return send(chatId, head + m.plan_md, waiting ? approvalButtons(chatId, m) : undefined);
  }

  // ---------- commands ----------
  const BUDGET_RE = /^\$(\d+(?:\.\d+)?)\s+([\s\S]+)$/;
  async function onCommand(chatId, userId, cmd, arg) {
    const need = async () => { if (!arg) { await send(chatId, `Usage: /${cmd} <id>`); return null; } const r = resolve(arg.split(/\s+/)[0]); if (r.error) { await send(chatId, r.error); return null; } return r.mission; };
    switch (cmd) {
      case 'start': case 'help': return send(chatId, HELP);
      case 'new': case 'research': {
        if (!arg) return send(chatId, `Usage: /${cmd} [$budget] <what you want built>`);
        const b = arg.match(BUDGET_RE);
        try { return await startMission(chatId, userId, { goal: b ? b[2] : arg, budgetUsd: b ? Number(b[1]) : undefined, research: cmd === 'research' }); }
        catch (e) { return send(chatId, `Could not start it: ${e.message}`); }
      }
      case 'missions': {
        const list = missions.list({ limit: 10 });
        return send(chatId, list.length ? list.map((m) => `#${short(m.id)}  ${m.state.padEnd(17)} ${m.title}`).join('\n') : 'No missions yet. /new <goal> starts one.');
      }
      case 'status': { const m = await need(); return m && send(chatId, statusText(m)); }
      case 'plan': { const m = await need(); return m && sendPlan(chatId, m); }
      case 'ship': {
        const m = await need(); if (!m) return null;
        return send(chatId, m.state === 'done' && m.ship_md ? `${m.ship_md}\n\nOpen the PR: ${shortPrUrl(m.pr_url)}` : `#${short(m.id)} has no ship package yet (state: ${m.state}).`);
      }
      case 'logs': {
        const m = await need(); if (!m) return null;
        if (!m.current_task_id) return send(chatId, `#${short(m.id)} has no run yet.`);
        const tailText = String(readRunLog(m.current_task_id) || '').slice(-3000);
        return send(chatId, tailText ? `Last part of the run log for #${short(m.id)}:\n\n${redact(tailText)}` : 'No run log yet (the task may still be queued).');
      }
      case 'budget': {
        const b = getBudget();
        if (!b) return send(chatId, 'Budget information is unavailable.');
        const row = (p) => `${p.padEnd(8)} ${money(b[p].cost)} of ${money(b[p].budget)}${b[p].budget ? ` (${Math.round((b[p].cost / b[p].budget) * 100)}%)` : ''}`;
        return send(chatId, [row('daily'), row('weekly'), row('monthly'), b.tripped ? `⛔ ${b.tripped} budget reached — new runs are paused.` : 'Within budget.'].join('\n'));
      }
      case 'cancel': {
        const m = await need(); if (!m) return null;
        try { engine.cancel(m.id, `telegram:${userId}`); return send(chatId, `⏹ Cancelled #${short(m.id)}.`); }
        catch (e) { return send(chatId, `Could not cancel: ${e.message}`); }
      }
      case 'retry': {
        const m = await need(); if (!m) return null;
        try { const out = engine.retry(m.id, `telegram:${userId}`); lastNotified.set(m.id, { state: out.state, attempts: out.build_attempts }); return send(chatId, `🔁 Retrying #${short(m.id)} — ${out.state === 'building' ? 'rebuilding on the approved plan' : 're-planning (you will be asked to approve again)'}.`); }
        catch (e) { return send(chatId, `Could not retry: ${e.message}`); }
      }
      case 'revise': {
        const m = await need(); if (!m) return null;
        const feedback = arg.split(/\s+/).slice(1).join(' ').trim();
        if (!feedback) return send(chatId, 'Usage: /revise <id> <what to change in the plan>');
        if (!String(m.plan_md || '').trim()) return send(chatId, `#${short(m.id)} has no plan to revise.`);
        if (m.state === 'awaiting_approval' && m.approval_id) {
          const a = approvals.get(m.approval_id);
          if (a && a.status === 'pending') approvals.reject(m.approval_id, `telegram:${userId}`, `revised from Telegram: ${feedback.slice(0, 200)}`);
        }
        const head = `${m.goal}\n\nOPERATOR FEEDBACK ON THE PREVIOUS PLAN — address this:\n${feedback}\n\nPREVIOUS PLAN (reference only; do not just repeat it):\n`;
        const goal = head + String(m.plan_md).slice(0, Math.max(0, 7900 - head.length));
        try { return await startMission(chatId, userId, { goal, budgetUsd: m.budget_usd, title: `${m.title} (revised)`.slice(0, 200) }); }
        catch (e) { return send(chatId, `Could not start the revision: ${e.message}`); }
      }
      default: return send(chatId, `Unknown command /${cmd}. /help lists them.`);
    }
  }

  async function onMessage(msg) {
    const userId = msg.from && msg.from.id;
    const chatId = msg.chat && msg.chat.id;
    if (!allowed(userId, chatId)) {
      const k = `${userId}:${chatId}`;
      if (!ignoredLogged.has(k)) { ignoredLogged.add(k); log(`[telegram] ignored a message from a non-allowlisted user/chat (user ${userId}, chat ${chatId})`); }
      return;                                            // silence: never confirm the bot to a stranger
    }
    const text = String(msg.text || '').trim();
    if (!text) return;
    if (msg.date && now() - msg.date * 1000 > staleMs) {
      return send(chatId, `Ignored "${text.slice(0, 60)}" — it was sent ${Math.round((now() - msg.date * 1000) / 60000)} min ago, while I was offline. Send it again if you still want it.`);
    }
    const cm = text.match(/^\/([a-z]+)(?:@\w+)?(?:\s+([\s\S]*))?$/i);
    if (cm) return onCommand(chatId, userId, cm[1].toLowerCase(), (cm[2] || '').trim());
    // Free text: offer it as a mission, created only on an explicit button press.
    return send(chatId, `Start a mission for this?\n\n${text.slice(0, 1500)}\n\n(budget ${money(defaultBudgetUsd)} — or use /new $N <goal>)`, buttons(chatId, [
      { text: '🚀 Start mission', kind: 'create', payload: { goal: text } },
      { text: 'Discard', kind: 'discard', payload: {} },
    ]));
  }

  async function onCallback(cq) {
    const userId = cq.from && cq.from.id;
    const chatId = cq.message && cq.message.chat && cq.message.chat.id;
    const answer = (text) => api('answerCallbackQuery', { callback_query_id: cq.id, text }).catch(() => {});
    if (!allowed(userId, chatId)) { log(`[telegram] refused a button press from non-allowlisted user ${userId}`); return answer('Not authorised.'); }
    const m = /^n:([A-Za-z0-9_-]{16})$/.exec(String(cq.data || ''));
    const entry = m ? nonces.get(m[1]) : null;
    if (!entry || entry.used || entry.exp < now() || entry.chatId !== String(chatId)) {
      return answer('This button has expired — send /plan <id> for fresh buttons.');
    }
    for (const v of nonces.values()) if (v.group === entry.group) v.used = true;     // single use, siblings too
    const clearButtons = () => api('editMessageReplyMarkup', { chat_id: chatId, message_id: cq.message.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => {});
    const actor = `telegram:${userId}`;

    if (entry.kind === 'approve' || entry.kind === 'reject') {
      const { approvalId, missionId } = entry.payload;
      const a = approvals.get(approvalId);
      if (!a) { await answer('That approval no longer exists.'); return clearButtons(); }
      if (!TELEGRAM_APPROVABLE.has(a.type)) { log(`[telegram] refused: ${a.type} is not approvable from Telegram`); return answer('This kind of approval cannot be decided from Telegram.'); }
      if (a.params && a.params.missionId && a.params.missionId !== missionId) return answer('This button does not match its approval — refused.');
      if (a.status !== 'pending') { await answer(`Already ${a.status}.`); return clearButtons(); }
      if (entry.kind === 'reject') {
        approvals.reject(approvalId, actor, 'rejected from Telegram');
        await answer('Rejected.'); await clearButtons();
        return send(chatId, `🚫 Plan rejected — #${short(missionId)}. Nothing will be built. /revise ${short(missionId)} <feedback> to re-plan.`);
      }
      const r = await approvals.approve(approvalId, actor);
      await clearButtons();
      if (!r || !r.ok) { await answer('Approval failed.'); return send(chatId, `Approval failed: ${(r && r.error) || 'unknown error'}`); }
      await answer('Approved — building.');
      lastNotified.set(missionId, { state: 'building', attempts: 1 });    // this reply IS the "building" notice
      return send(chatId, `✅ Approved — #${short(missionId)} is building. I'll message you when it is done.`);
    }
    if (entry.kind === 'create') {
      await answer('Starting…'); await clearButtons();
      try { return await startMission(chatId, userId, { goal: entry.payload.goal }); }
      catch (e) { return send(chatId, `Could not start it: ${e.message}`); }
    }
    await answer('Discarded.'); return clearButtons();
  }

  async function handleUpdate(u) {
    if (!u || typeof u.update_id !== 'number' || seen.has(u.update_id)) return;
    seen.add(u.update_id);
    if (seen.size > 5000) seen.delete(seen.values().next().value);
    offset = Math.max(offset, u.update_id + 1);
    saveOffset(offset);                                  // BEFORE acting: lose a command, never repeat one
    try {
      if (u.callback_query) await onCallback(u.callback_query);
      else if (u.message) await onMessage(u.message);
    } catch (e) { log(`[telegram] update ${u.update_id} failed: ${redact(e && e.message)}`); }
  }

  async function pollOnce() {
    const updates = await api('getUpdates', { offset, timeout: pollTimeoutSec, allowed_updates: ['message', 'callback_query'] }, (pollTimeoutSec + 15) * 1000);
    for (const u of updates || []) await handleUpdate(u);
    return (updates || []).length;
  }

  // ---------- push notifications ----------
  async function notifyMission(m) {
    if (!m || !m.id) return;
    const attempts = m.build_attempts || 0;
    // `building` with no attempt yet = approved, build task not filed: say nothing and RECORD nothing, so
    // the update that files attempt 1 is compared with what was actually announced.
    if (m.state === 'building' && !attempts) return;
    const prev = lastNotified.get(m.id);
    if (prev && prev.state === m.state && (m.state !== 'building' || prev.attempts === attempts)) return;
    lastNotified.set(m.id, { state: m.state, attempts });
    const tag = `#${short(m.id)} — ${m.title}`;
    switch (m.state) {
      case 'researching': return broadcast(`🔎 Researching ${tag}`);
      case 'planning': return prev ? undefined : broadcast(`📝 Planning ${tag}`);
      case 'awaiting_approval': { for (const c of chats) { try { await sendPlan(c, m); } catch (e) { log(`[telegram] plan send failed: ${redact(e.message)}`); } } return undefined; }
      case 'building':
        return broadcast(attempts > 1 ? `🔁 Tests failed — retrying the build (attempt ${attempts} of ${m.max_build_attempts}) ${tag}` : `🔨 Building ${tag}`);
      case 'done': return broadcast(`✅ Done ${tag}\nBranch: ${m.branch || '-'}\nSpent ${money(missions.spend(m.id))} of ${money(m.budget_usd)}\nOpen the PR: ${shortPrUrl(m.pr_url)}\n/ship ${short(m.id)} for the deploy checklist.`);
      case 'failed': return broadcast(`❌ Failed ${tag}\n${m.failure_reason || ''}\n/retry ${short(m.id)} to try again · /logs ${short(m.id)} for the run log`);
      case 'rejected': return broadcast(`🚫 Plan rejected ${tag}. Nothing was built.`);
      case 'cancelled': return broadcast(`⏹ Cancelled ${tag}`);
      default: return undefined;
    }
  }

  async function checkBudget() {
    const b = getBudget();
    if (!b) return;
    const day = new Date(now()).toISOString().slice(0, 10);
    for (const p of ['daily', 'weekly', 'monthly']) {
      const { cost, budget } = b[p] || {};
      if (!budget) continue;
      const pct = cost / budget;
      const level = pct >= 1 ? 100 : pct >= 0.75 ? 75 : 0;
      const key = `${p}:${day}:${level}`;
      if (!level || budgetAlerted.has(key)) continue;
      budgetAlerted.add(key);
      await broadcast(level === 100
        ? `⛔ ${p} budget reached: ${money(cost)} of ${money(budget)}. New coding runs and research are paused until it resets or is raised.`
        : `⚠️ ${p} budget at ${Math.round(pct * 100)}%: ${money(cost)} of ${money(budget)}.`);
    }
  }

  function start() {
    if (!users.size || !chats.size) throw new Error('refusing to start: HERMES_TELEGRAM_ALLOWED_USER_IDS and HERMES_TELEGRAM_ALLOWED_CHAT_IDS must both be set');
    if (running) return;
    running = true;
    offset = Number(loadOffset()) || 0;
    (async () => {
      let backoff = 1000;
      while (running) {
        try { await pollOnce(); backoff = 1000; }
        catch (e) {
          log(`[telegram] poll failed: ${redact(e && e.message)}`);
          await new Promise((r) => { const t = setTimeout(r, backoff); if (t.unref) t.unref(); });
          backoff = Math.min(backoff * 2, 60000);
        }
      }
    })();
    budgetTimer = setInterval(() => { checkBudget().catch(() => {}); }, budgetCheckMs);
    if (budgetTimer.unref) budgetTimer.unref();
  }
  function stop() { running = false; if (budgetTimer) { clearInterval(budgetTimer); budgetTimer = null; } }

  return { start, stop, pollOnce, handleUpdate, notifyMission, checkBudget, get active() { return running; } };
}

module.exports = { createTelegramGateway, makeTelegramApi };
