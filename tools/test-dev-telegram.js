// Dev-platform P3: the two-way TELEGRAM gateway (lib/dev/telegram.js), driven against a fake Bot API
// and the REAL missions + engine + board.sqlite. The safety properties are the point of this suite:
// allowlist silence, single-use unguessable buttons, approve-only-mission-plans, stale-command refusal,
// offset-before-action, token never logged. Each is proven by making it fire.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { assert, cleanupAndFinish, requireFinish } = require('./test-util');
requireFinish();   // a gateway test that hangs on a never-settling promise must FAIL, not exit 0 mid-suite

const board = require('../lib/board');
const repo = board.repo;
const missions = require('../lib/dev/missions');
const { createMissionEngine } = require('../lib/dev/engine');
const { createTelegramGateway, makeTelegramApi } = require('../lib/dev/telegram');
const rawDb = () => require('../lib/board/db').getDb();

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-'));
const reset = () => rawDb().exec('DELETE FROM missions; DELETE FROM tasks;');
const ME = 111, CHAT = 111, STRANGER = 999, GROUP = -5005;

// ---- fake Telegram ------------------------------------------------------------------------------
let calls = [];
let msgSeq = 1000;
const queued = [];
const api = async (method, params) => {
  calls.push({ method, params });
  if (method === 'getUpdates') return queued.splice(0, queued.length);
  if (method === 'sendMessage') return { message_id: ++msgSeq, chat: { id: params.chat_id } };
  return true;
};
const sent = () => calls.filter((c) => c.method === 'sendMessage');
const lastText = () => { const s = sent(); return s.length ? s[s.length - 1].params.text : ''; };
const lastMarkup = () => { const s = sent().filter((c) => c.params.reply_markup); return s.length ? s[s.length - 1].params.reply_markup : null; };
const answers = () => calls.filter((c) => c.method === 'answerCallbackQuery').map((c) => c.params.text);
let updSeq = 1;
let clock = Date.parse('2026-10-10T12:00:00Z');
const msg = (text, { user = ME, chat = CHAT, ageSec = 0 } = {}) => ({ update_id: updSeq++, message: { message_id: ++msgSeq, from: { id: user }, chat: { id: chat }, date: Math.floor(clock / 1000) - ageSec, text } });
const press = (data, { user = ME, chat = CHAT } = {}) => ({ update_id: updSeq++, callback_query: { id: `cq${updSeq}`, from: { id: user }, data, message: { message_id: 77, chat: { id: chat } } } });
const buttonsOf = (markup) => (markup ? markup.inline_keyboard[0].map((b) => b.callback_data) : []);

// ---- fake approval queue + a real engine ---------------------------------------------------------
const approvalsStore = new Map();
let apSeq = 0;
let engine;
const approvals = {
  get: (id) => approvalsStore.get(id) || null,
  approve: async (id, actor) => {
    const a = approvalsStore.get(id);
    if (!a || a.status !== 'pending') return { ok: false, error: 'not pending' };
    a.status = 'approved'; a.approvedBy = actor;
    engine.approvePlan(a.params.missionId);
    return { ok: true };
  },
  reject: (id, actor, reason) => { const a = approvalsStore.get(id); if (a) { a.status = 'rejected'; a.rejectedBy = actor; a.rejectReason = reason; } },
};
engine = createMissionEngine({
  research: async () => ({ ok: true, content: 'brief', cost: 0.1 }),
  requestApproval: async (m) => { const id = `ap_${++apSeq}`; approvalsStore.set(id, { id, type: 'dev.mission-plan', status: 'pending', params: { missionId: m.id } }); return id; },
  approvalStatus: (id) => (approvalsStore.get(id) || {}).status,
  withdrawApproval: (id) => { const a = approvalsStore.get(id); if (a) a.status = 'rejected'; },
});
const logs = [];
const offsets = [];
let budget = { daily: { cost: 10, budget: 50 }, weekly: { cost: 10, budget: 250 }, monthly: { cost: 10, budget: 1000 }, tripped: '' };
const runLogs = new Map();
const gw = createTelegramGateway({
  api, allowedUserIds: `${ME}`, allowedChatIds: `${CHAT}, ${GROUP}`,
  engine, boardRepo: repo, approvals,
  getBudget: () => budget, readRunLog: (id) => runLogs.get(id) || '',
  saveOffset: (n) => offsets.push(n), defaultBudgetUsd: 7,
  now: () => clock, log: (m) => logs.push(m),
});
const H = (u) => gw.handleUpdate(u);
const flush = () => new Promise((r) => setImmediate(r));
// Drive a mission to awaiting_approval through the real engine (plan task finished by hand).
async function toAwaiting(goal = 'Add a /healthz route') {
  const m = missions.create({ goal, budgetUsd: 10 });
  await engine.tick();
  const t = missions.get(m.id).current_task_id;
  repo.setState(t, 'running');
  repo.finish(t, { status: 'planned', costUsd: '0.4', planMd: '## Goal\nAdd it.\n## Approach\nRoute + test.' });
  await engine.tick();
  return missions.get(m.id);
}

(async () => {
  board.openDb(path.join(dir, 'board.sqlite'));

  // ---------- allowlist: strangers get SILENCE --------------------------------------------------
  reset(); calls = [];
  await H(msg('/new build me a thing', { user: STRANGER, chat: STRANGER }));
  assert(sent().length === 0 && missions.list().length === 0, 'a non-allowlisted user gets no reply and starts nothing');
  await H(msg('/missions', { user: ME, chat: 4242 }));
  assert(sent().length === 0, 'an allowlisted user in a NON-allowlisted chat is ignored too (both must match)');
  await H(msg('/missions', { user: STRANGER, chat: GROUP }));
  assert(sent().length === 0, 'a stranger in an allowlisted GROUP chat is ignored');
  assert(logs.filter((l) => /non-allowlisted/.test(l)).length === 3, 'each ignored sender is logged once (by id), for the operator');
  await H(msg('/missions', { user: STRANGER, chat: STRANGER }));
  assert(logs.filter((l) => /non-allowlisted/.test(l)).length === 3, '...and a repeat from the same stranger is not logged again (no log flood)');
  let refused = false; try { createTelegramGateway({ api, allowedUserIds: '', allowedChatIds: '1', engine, approvals }).start(); } catch { refused = true; }
  assert(refused, 'the gateway refuses to start with an empty allowlist');

  // ---------- commands ------------------------------------------------------------------------
  calls = [];
  await H(msg('/help'));
  assert(/\/new/.test(lastText()) && /\/revise/.test(lastText()), '/help lists the commands');
  await H(msg('/start@HermesDevBot'));
  assert(/\/new/.test(lastText()), 'a command addressed with @botname (group chats) is understood');
  await H(msg('/new Add a /healthz route'));
  let all = missions.list();
  assert(all.length === 1 && all[0].budget_usd === 7 && all[0].created_by === `telegram:${ME}` && all[0].state === 'planning', '/new starts a mission with the default budget, attributed to the Telegram user');
  assert(/Mission #[0-9a-f]{8} started/.test(lastText()), '/new replies with the mission short id');
  await H(msg('/research $3.5 Adopt the new API'));
  all = missions.list();
  const rm = all.find((m) => m.goal === 'Adopt the new API');
  // The engine is kicked on create and the fake research resolves at once, so the mission may already
  // be past `researching` — assert what was recorded at creation, not a moment-in-time state.
  assert(rm && rm.budget_usd === 3.5 && missions.events(rm.id)[0].data.research === true, '/research $N <goal> sets the budget and the research step');
  await H(msg('/new'));
  assert(/Usage: \/new/.test(lastText()), '/new with no goal shows usage');
  await H(msg('/new $500 too expensive'));
  assert(/Could not start it/.test(lastText()) && !missions.list().some((m) => m.goal === 'too expensive'), 'a mission over the budget ceiling is refused with the reason');
  await H(msg('/missions'));
  assert(lastText().split('\n').length === 2 && all.every((x) => lastText().includes(`#${x.id.slice(4, 12)}`)), '/missions lists recent missions, by short id');
  const sid = all[0].id.replace(/^mis_/, '');
  await H(msg(`/status ${sid.slice(0, 6)}`));
  assert(/State: /.test(lastText()) && /Spent: \$/.test(lastText()), '/status by id prefix');
  await H(msg('/status zz'));
  assert(/at least the first 4/.test(lastText()), '/status refuses a too-short id');
  await H(msg('/status ffffffff'));
  assert(/No mission starts with/.test(lastText()), '/status: unknown id');
  await H(msg('/frobnicate'));
  assert(/Unknown command/.test(lastText()), 'unknown commands are answered with /help');

  // ---------- the plan + APPROVE button (the gate) ----------------------------------------------
  reset(); calls = []; approvalsStore.clear();
  let m = await toAwaiting();
  await H(msg(`/plan ${m.id.slice(4, 12)}`));
  assert(/Route \+ test/.test(lastText()) && /Nothing will be built until you approve/.test(lastText()), '/plan shows the plan of a mission awaiting approval');
  const [approveBtn, rejectBtn] = buttonsOf(lastMarkup());
  assert(/^n:[A-Za-z0-9_-]{16}$/.test(approveBtn) && /^n:[A-Za-z0-9_-]{16}$/.test(rejectBtn), 'buttons carry an opaque 16-char nonce...');
  assert(!approveBtn.includes(m.approval_id) && !approveBtn.includes(m.id), '...never the approval or mission id');
  assert(approveBtn.length <= 64, 'callback data fits Telegram\'s 64-byte limit');
  await H(press('n:AAAAAAAAAAAAAAAA'));
  assert(/expired/.test(answers().pop()) && approvalsStore.get(m.approval_id).status === 'pending', 'a forged button does nothing');
  await H(press(approveBtn, { user: STRANGER, chat: CHAT }));
  assert(/Not authorised/.test(answers().pop()) && approvalsStore.get(m.approval_id).status === 'pending', 'a non-allowlisted user pressing a real button is refused');
  await H(press(approveBtn, { user: ME, chat: GROUP }));
  assert(/expired/.test(answers().pop()) && approvalsStore.get(m.approval_id).status === 'pending', 'a button pressed in a different chat than it was sent to is refused');
  await H(press(approveBtn));
  await flush(); await engine.tick();
  assert(approvalsStore.get(m.approval_id).status === 'approved' && approvalsStore.get(m.approval_id).approvedBy === `telegram:${ME}`, 'Approve approves through the approval queue, attributed to the Telegram user');
  assert(missions.get(m.id).state === 'building' && missions.get(m.id).build_attempts === 1, '...and the mission builds');
  assert(calls.some((c) => c.method === 'editMessageReplyMarkup'), '...and the buttons are removed from the message');
  const apCalls = sent().length;
  await H(press(approveBtn));
  assert(/expired/.test(answers().pop()), 'the same button pressed again is dead (single use)');
  await H(press(rejectBtn));
  assert(/expired/.test(answers().pop()) && approvalsStore.get(m.approval_id).status === 'approved', 'its sibling (Reject) died with it — no approve-then-reject');
  assert(sent().length === apCalls, 'dead buttons send nothing');

  // reject
  reset(); calls = [];
  m = await toAwaiting('Reject me');
  await H(msg(`/plan ${m.id.slice(4, 12)}`));
  const [, rej] = buttonsOf(lastMarkup());
  await H(press(rej));
  await engine.tick();
  assert(approvalsStore.get(m.approval_id).status === 'rejected' && missions.get(m.id).state === 'rejected', 'Reject rejects the approval and the mission ends rejected — nothing is built');
  assert(missions.tasks(m.id).every((t) => t.mode === 'plan'), '...no build task exists');

  // only mission plans are approvable from Telegram
  reset(); calls = [];
  m = await toAwaiting('Other type');
  await H(msg(`/plan ${m.id.slice(4, 12)}`));
  const [otherApprove] = buttonsOf(lastMarkup());
  approvalsStore.get(m.approval_id).type = 'infra.destructive-op';
  await H(press(otherApprove));
  assert(/cannot be decided from Telegram/.test(answers().pop()) && approvalsStore.get(m.approval_id).status === 'pending', 'an approval of any other type is NEVER decided from Telegram');
  approvalsStore.get(m.approval_id).type = 'dev.mission-plan';
  // a button is bound to the mission it was issued for: if its approval now names another mission, refuse
  await H(msg(`/plan ${m.id.slice(4, 12)}`));
  const [boundBtn] = buttonsOf(lastMarkup());
  approvalsStore.get(m.approval_id).params.missionId = 'mis_somethingelse0000000';
  await H(press(boundBtn));
  assert(/does not match its approval/.test(answers().pop()) && approvalsStore.get(m.approval_id).status === 'pending', 'a button whose approval no longer belongs to its mission is refused');
  approvalsStore.get(m.approval_id).params.missionId = m.id;
  // a button whose approval was decided elsewhere (dashboard) reports that, does nothing
  await H(msg(`/plan ${m.id.slice(4, 12)}`));
  const [lateBtn] = buttonsOf(lastMarkup());
  approvalsStore.get(m.approval_id).status = 'approved';
  await H(press(lateBtn));
  assert(/Already approved/.test(answers().pop()), 'a button for an approval already decided in the dashboard says so and does nothing');
  // buttons expire
  reset(); calls = [];
  m = await toAwaiting('Expire');
  await H(msg(`/plan ${m.id.slice(4, 12)}`));
  const [oldBtn] = buttonsOf(lastMarkup());
  clock += 25 * 3600 * 1000;
  await H(press(oldBtn));
  assert(/expired/.test(answers().pop()) && approvalsStore.get(m.approval_id).status === 'pending', 'a button older than its TTL is dead');

  // ---------- free text -> confirm -> mission ---------------------------------------------------
  reset(); calls = [];
  await H(msg('Please add dark mode to the board view'));
  assert(missions.list().length === 0 && /Start a mission for this\?/.test(lastText()), 'free text does NOT start a mission by itself — it asks');
  const [createBtn, discardBtn] = buttonsOf(lastMarkup());
  await H(press(discardBtn));
  assert(missions.list().length === 0, 'Discard starts nothing');
  await H(press(createBtn));
  assert(/expired/.test(answers().pop()) && missions.list().length === 0, 'after Discard, Start is dead too');
  await H(msg('Add a CSV export to the board'));
  const [create2] = buttonsOf(lastMarkup());
  await H(press(create2));
  assert(missions.list().length === 1 && missions.list()[0].goal === 'Add a CSV export to the board', 'Start mission creates exactly that mission');

  // ---------- stale commands, offset, duplicates ------------------------------------------------
  reset(); calls = []; offsets.length = 0;
  const stale = msg('/new from the backlog', { ageSec: 20 * 60 });
  await H(stale);
  assert(missions.list().length === 0 && /while I was offline/.test(lastText()), 'a command older than the stale window is NOT acted on (no backlog replay after downtime)');
  assert(offsets[offsets.length - 1] === stale.update_id + 1, 'the offset is advanced past every handled update');
  const fresh = msg('/new twice?');
  await H(fresh); await H(fresh);
  assert(missions.list().length === 1, 'the same update delivered twice is handled once');
  // offset is saved BEFORE acting: a handler that throws still advanced it
  const before = offsets.length;
  const boom = createTelegramGateway({ api: async (mth) => { if (mth === 'sendMessage') throw new Error('network down'); return true; }, allowedUserIds: `${ME}`, allowedChatIds: `${CHAT}`, engine, boardRepo: repo, approvals, saveOffset: (n) => offsets.push(n), now: () => clock, log: (l) => logs.push(l) });
  const bu = msg('/help');
  await boom.handleUpdate(bu);
  assert(offsets.length === before + 1 && offsets[offsets.length - 1] === bu.update_id + 1, 'the offset is saved even when handling fails (lose a command, never repeat one)');
  assert(logs.some((l) => /network down/.test(l)), '...and the failure is logged');
  // pollOnce sends the saved offset
  const resumed = createTelegramGateway({ api, allowedUserIds: `${ME}`, allowedChatIds: `${CHAT}`, engine, boardRepo: repo, approvals, loadOffset: () => 4242, now: () => clock });
  calls = [];
  // start() would loop forever; exercise one poll by hand after loading the offset the way start() does
  resumed.start(); resumed.stop();
  await flush();
  const gu = calls.find((c) => c.method === 'getUpdates');
  assert(gu && gu.params.offset === 4242 && gu.params.timeout === 50, 'polling resumes from the persisted offset (long-poll 50s)');

  // ---------- cancel / retry / revise / logs / budget / ship -------------------------------------
  reset(); calls = [];
  m = await toAwaiting('Cancel me');
  await H(msg(`/cancel ${m.id.slice(4, 12)}`));
  assert(missions.get(m.id).state === 'cancelled' && approvalsStore.get(m.approval_id).status === 'rejected', '/cancel cancels the mission and withdraws its pending approval');
  m = missions.create({ goal: 'f', budgetUsd: 5 });
  missions.setState(m.id, 'failed', { failure_reason: 'x' });
  await H(msg(`/retry ${m.id.slice(4, 12)}`));
  assert(missions.get(m.id).state === 'planning' && /re-planning/.test(lastText()), '/retry restarts a failed mission');
  await H(msg(`/retry ${m.id.slice(4, 12)}`));
  assert(/Could not retry: only a failed mission/.test(lastText()), '/retry on a live mission is refused with the reason');
  reset(); calls = [];
  m = await toAwaiting('Original goal');
  await H(msg(`/revise ${m.id.slice(4, 12)} use the existing health module instead`));
  const rev = missions.list().find((x) => x.id !== m.id);
  assert(approvalsStore.get(m.approval_id).status === 'rejected', '/revise rejects the plan waiting for approval');
  assert(rev && /Original goal/.test(rev.goal) && /use the existing health module instead/.test(rev.goal) && /PREVIOUS PLAN/.test(rev.goal) && /\(revised\)$/.test(rev.title), '/revise starts a new mission carrying the goal, the feedback and the previous plan');
  assert(rev.goal.length <= 8000 && rev.budget_usd === m.budget_usd, '...within the goal limit, same budget');
  const bigPlan = missions.create({ goal: 'g', budgetUsd: 5 });
  missions.update(bigPlan.id, { plan_md: 'P'.repeat(20000) });
  await H(msg(`/revise ${bigPlan.id.slice(4, 12)} smaller please`));
  assert(missions.list().some((x) => /smaller please/.test(x.goal) && x.goal.length <= 8000), '/revise trims a huge previous plan to fit (it does not fail on it)');
  // logs are redacted
  reset(); calls = [];
  m = missions.create({ goal: 'g', budgetUsd: 5 });
  await engine.tick();
  const tid = missions.get(m.id).current_task_id;
  runLogs.set(tid, 'step 1\nkey sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUV leaked\ngh ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123\n-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----\nRESULT: tests_failed');
  await H(msg(`/logs ${m.id.slice(4, 12)}`));
  assert(/RESULT: tests_failed/.test(lastText()) && !/sk-ant-api03-ABC/.test(lastText()) && !/ghp_ABC/.test(lastText()) && !/AAAA/.test(lastText()), '/logs sends the run log tail with credentials redacted');
  await H(msg('/budget'));
  assert(/daily\s+\$10\.00 of \$50\.00 \(20%\)/.test(lastText()) && /Within budget/.test(lastText()), '/budget shows each period');
  m = missions.create({ goal: 'g', budgetUsd: 5 });
  missions.setState(m.id, 'failed', { failure_reason: 'x' });
  await H(msg(`/ship ${m.id.slice(4, 12)}`));
  assert(/no ship package yet/.test(lastText()), '/ship before done says so');

  // ---------- push notifications ---------------------------------------------------------------
  reset(); calls = [];
  m = await toAwaiting('Notify me');
  await gw.notifyMission(missions.get(m.id));
  const planMsgs = sent().filter((c) => /Plan for #/.test(c.params.text));
  assert(planMsgs.length === 2 && planMsgs.every((c) => c.params.reply_markup), 'awaiting approval -> the plan WITH buttons goes to every allowlisted chat');
  assert(new Set(planMsgs.map((c) => c.params.reply_markup.inline_keyboard[0][0].callback_data)).size === 2, '...each chat gets its own nonces');
  const n0 = sent().length;
  await gw.notifyMission(missions.get(m.id));
  assert(sent().length === n0, 'the same state is not announced twice');
  engine.approvePlan(m.id);
  await gw.notifyMission(missions.get(m.id));
  assert(sent().length === n0, 'approved but no build task yet: nothing is announced');
  await flush(); await engine.tick();
  await gw.notifyMission(missions.get(m.id));
  assert(/🔨 Building/.test(lastText()), 'the build starting is announced');
  const t1 = missions.get(m.id).current_task_id;
  repo.setState(t1, 'running'); repo.finish(t1, { status: 'tests_failed', costUsd: '0.5' });
  await engine.tick();
  await gw.notifyMission(missions.get(m.id));
  assert(/retrying the build \(attempt 2 of 2\)/.test(lastText()), 'an automatic retry is announced');
  const t2 = missions.get(m.id).current_task_id;
  repo.setState(t2, 'running');
  repo.finish(t2, { status: 'pushed', costUsd: '0.6', branch: 'hermes/x', prUrl: 'https://github.com/o/r/compare/master...f:r:hermes/x?expand=1' });
  await engine.tick();
  await gw.notifyMission(missions.get(m.id));
  assert(/✅ Done/.test(lastText()) && /Open the PR: https:\/\/github\.com/.test(lastText()) && !/body=/.test(lastText()), 'done -> PR link, without the long pre-filled body');
  // a Telegram approval is not announced twice
  reset(); calls = [];
  m = await toAwaiting('Approve via TG');
  await H(msg(`/plan ${m.id.slice(4, 12)}`));
  await H(press(buttonsOf(lastMarkup())[0]));
  await flush(); await engine.tick();
  const nBuild = sent().filter((c) => /Building|is building/.test(c.params.text)).length;
  await gw.notifyMission(missions.get(m.id));
  assert(sent().filter((c) => /Building|is building/.test(c.params.text)).length === nBuild && nBuild === 1, 'approving from Telegram gives ONE "building" message, not two');
  // failure notice
  m = missions.create({ goal: 'g', budgetUsd: 5 });
  await gw.notifyMission(missions.setState(m.id, 'failed', { failure_reason: 'build failed: unsafe' }));
  assert(/❌ Failed/.test(lastText()) && /unsafe/.test(lastText()) && /\/retry/.test(lastText()), 'a failure is announced with its reason and the retry command');

  // ---------- budget alerts ---------------------------------------------------------------------
  calls = [];
  budget = { daily: { cost: 40, budget: 50 }, weekly: { cost: 10, budget: 250 }, monthly: { cost: 10, budget: 1000 }, tripped: '' };
  await gw.checkBudget(); await gw.checkBudget();
  assert(sent().filter((c) => /daily budget at 80%/.test(c.params.text)).length === 2, '75%+ -> one alert per chat (2 chats), not repeated on the next check');
  budget.daily.cost = 51; budget.tripped = 'daily';
  await gw.checkBudget();
  assert(sent().filter((c) => /daily budget reached/.test(c.params.text)).length === 2, '100% -> a "paused" alert');
  clock += 24 * 3600 * 1000;
  await gw.checkBudget();
  assert(sent().filter((c) => /daily budget reached/.test(c.params.text)).length === 4, 'a new day can alert again');

  // ---------- long messages + the real API client ----------------------------------------------
  reset(); calls = [];
  m = await toAwaiting('Long');
  missions.update(m.id, { plan_md: `${'line of plan\n'.repeat(900)}` });
  await H(msg(`/plan ${m.id.slice(4, 12)}`));
  const parts = sent().filter((c) => c.params.chat_id === CHAT);
  assert(parts.length >= 3 && parts.every((c) => c.params.text.length <= 4096), 'a long plan is split under Telegram\'s 4096 limit');
  assert(parts.filter((c) => c.params.reply_markup).length === 1 && parts[parts.length - 1].params.reply_markup, '...with the buttons on the LAST part only');
  const TOKEN = '123456789:AAFakeTokenValueForTestsOnly_abcdefgh';
  const realApi = makeTelegramApi(TOKEN, async (url) => { throw new Error(`connect ECONNREFUSED for ${url}`); });
  let msgOut = '';
  try { await realApi('getMe'); } catch (e) { msgOut = e.message; }
  assert(/ECONNREFUSED/.test(msgOut) && !msgOut.includes(TOKEN) && msgOut.includes('<token>'), 'the API client strips the bot token from every error');
  const okApi = makeTelegramApi(TOKEN, async (url, init) => ({ status: 200, json: async () => ({ ok: true, result: { url, body: JSON.parse(init.body) } }) }));
  const r = await okApi('sendMessage', { chat_id: 1, text: 'hi' });
  assert(r.url === `https://api.telegram.org/bot${TOKEN}/sendMessage` && r.body.text === 'hi', 'the API client POSTs JSON to the Bot API method');
  const badApi = makeTelegramApi(TOKEN, async () => ({ status: 409, json: async () => ({ ok: false, description: 'Conflict: terminated by other getUpdates request' }) }));
  let conflict = ''; try { await badApi('getUpdates'); } catch (e) { conflict = e.message; }
  assert(/Conflict: terminated by other getUpdates request/.test(conflict), 'a Bot API refusal (e.g. two pollers on one bot) surfaces its reason');

  // ---------- server.js wiring ------------------------------------------------------------------
  const { serverSource } = require('./test-util');
  const src = serverSource();
  assert(/String\(process\.env\.HERMES_TELEGRAM_GATEWAY \|\| ''\) === '1'/.test(src), 'wiring: the gateway only starts where HERMES_TELEGRAM_GATEWAY=1');
  assert(/if \(a\.type !== 'dev\.mission-plan'\) return \{ ok: false, error: `Telegram may only approve coding-mission plans/.test(src), 'wiring: the server-side approve adapter ALSO refuses anything but mission plans');
  assert(/approve: async \(id, actor\) => \{[\s\S]{0,300}return executeApprovedAction\(a, \{\}, actor\);/.test(src), 'wiring: approval goes through executeApprovedAction (the same path as the dashboard)');
  assert(/function rejectPendingApproval\(/.test(src) && /rejectPendingApproval\(a, reqActor\(req\)/.test(src), 'wiring: one shared reject path for the dashboard, cancel-withdraw and Telegram');
  assert(/const telegramOwnsIt = \(\(\) => \{ try \{ return type === 'dev\.mission-plan' && Boolean\(devTelegram\); \}/.test(src),
    'wiring: the "approval required" ping is skipped ONLY for dev.mission-plan, and only while the gateway runs');
  assert(/if \(!telegramOwnsIt\) \{\s*sendNotification\(/.test(src), 'wiring: ...every other high/critical approval still reaches Telegram/Slack via sendNotification');

  gw.stop(); engine.stop();
  try { rawDb().close(); } catch {}
  cleanupAndFinish(dir);
})().catch((e) => { console.error('FAIL: telegram suite threw:', e && e.stack || e); process.exitCode = 1; try { rawDb().close(); } catch {} cleanupAndFinish(dir); });
