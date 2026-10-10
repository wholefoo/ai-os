// lib/dev/missions.js
// ============================================================
//  Mission data access + the mission STATE MACHINE (dev-platform P1, docs/dev-platform-design.md).
//
//  A mission is the operator-facing unit of work: "research this, plan it, let me approve the plan,
//  then build it and hand me a PR". It owns board tasks (tasks.mission_id) and never runs anything
//  itself — engine.js advances it by reading what its tasks did. This file owns every legal mission
//  transition, so a bad one throws instead of corrupting the record (same rule as lib/board/repo.js).
//
//     researching ─► planning ─► awaiting_approval ─► building ─► shipping ─► done
//          │             │               │                │           │
//          └─────────────┴──► failed ◄───┴────────────────┴───────────┘
//                              │  └─ retry ─► planning (plan never approved) | building (plan approved)
//     any active state ─► cancelled            awaiting_approval ─► rejected (a human said no)
//     done / rejected / cancelled are terminal.
// ============================================================

// fallow-ignore-file duplicate-export
// create/get/list/events/setState mirror lib/board/repo.js on purpose: each SQLite-backed domain has
// its own repo module with the same verbs, required on its own handle (missions.get vs repo.get) and
// never merged into one barrel — the same established store pattern lib/board/db.js documents.
const { getDb } = require('../board/db');
const { now, uid, normalizeRunParams } = require('../board/repo');

const TRANSITIONS = {
  researching:       ['planning', 'failed', 'cancelled'],
  planning:          ['awaiting_approval', 'failed', 'cancelled'],
  awaiting_approval: ['building', 'rejected', 'failed', 'cancelled'],
  building:          ['shipping', 'failed', 'cancelled'],
  shipping:          ['done', 'failed'],
  failed:            ['planning', 'building', 'cancelled'],
  done: [], rejected: [], cancelled: [],
};
const STATES = Object.keys(TRANSITIONS);
const ACTIVE = new Set(['researching', 'planning', 'awaiting_approval', 'building', 'shipping']);
const TERMINAL = new Set(['done', 'rejected', 'cancelled']);

const MAX_GOAL_CHARS = 8000;
const MAX_URLS = 3;
const MAX_MISSION_BUDGET_USD = 100;

function parse(row) {
  if (!row) return null;
  let urls = [];
  try { urls = JSON.parse(row.research_urls || '[]'); } catch {}
  return { ...row, research_urls: urls, plan_approved: row.plan_approved === 1 };
}

function _event(missionId, type, data = {}, author = 'system') {
  getDb().prepare('INSERT INTO mission_events (id, mission_id, type, data, author, created_at) VALUES (?,?,?,?,?,?)')
    .run(uid('mev'), missionId, type, JSON.stringify(data || {}), author, now());
}

function get(id) { return parse(getDb().prepare('SELECT * FROM missions WHERE id = ?').get(id)); }

function list({ state, limit = 200 } = {}) {
  const db = getDb();
  const rows = state
    ? db.prepare('SELECT * FROM missions WHERE state = ? ORDER BY updated_at DESC LIMIT ?').all(state, limit)
    : db.prepare('SELECT * FROM missions ORDER BY updated_at DESC LIMIT ?').all(limit);
  return rows.map(parse);
}

function active() {
  return getDb().prepare(`SELECT * FROM missions WHERE state IN (${[...ACTIVE].map(() => '?').join(',')}) ORDER BY created_at ASC`)
    .all(...ACTIVE).map(parse);
}

function events(id, limit = 300) {
  return getDb().prepare('SELECT * FROM mission_events WHERE mission_id = ? ORDER BY created_at ASC LIMIT ?').all(id, limit)
    .map((e) => { let d = {}; try { d = JSON.parse(e.data || '{}'); } catch {} return { ...e, data: d }; });
}

// Only http(s) URLs, at most MAX_URLS; anything else is refused with the reason rather than dropped.
function normalizeUrls(urls) {
  if (urls === undefined || urls === null || urls === '') return [];
  const arr = Array.isArray(urls) ? urls : [urls];
  if (arr.length > MAX_URLS) throw new Error(`mission: at most ${MAX_URLS} research URLs`);
  return arr.map((u) => {
    let p; try { p = new URL(String(u)); } catch { throw new Error(`mission: invalid research URL "${String(u).slice(0, 80)}"`); }
    if (p.protocol !== 'http:' && p.protocol !== 'https:') throw new Error('mission: research URLs must be http(s)');
    return p.href;
  });
}

// Create a mission. It starts `researching` when research was asked for (a query or URLs, or
// research:true), else straight at `planning`; the engine creates the first task on its next tick.
function create({ title = '', goal, research = false, researchQuery = '', researchUrls = [], budgetUsd, model = '', maxBuildAttempts = 2, createdBy = '' } = {}) {
  const g = String(goal || '').trim();
  if (!g) throw new Error('mission: goal is required');
  if (g.length > MAX_GOAL_CHARS) throw new Error(`mission: goal is longer than ${MAX_GOAL_CHARS} characters`);
  const b = Number(budgetUsd);
  if (!Number.isFinite(b) || b <= 0 || b > MAX_MISSION_BUDGET_USD) throw new Error(`mission: budgetUsd must be > 0 and <= ${MAX_MISSION_BUDGET_USD}`);
  const mba = Number(maxBuildAttempts);
  if (!Number.isInteger(mba) || mba < 1 || mba > 5) throw new Error('mission: maxBuildAttempts must be an integer 1..5');
  // The model is handed to every task this mission creates — validate it with the board's own rule
  // now, so a bad name is a 400 at submit time rather than an engine failure minutes later.
  normalizeRunParams({ model });
  const urls = normalizeUrls(researchUrls);
  const q = String(researchQuery || '').trim().slice(0, 2000);
  const wantsResearch = Boolean(research) || Boolean(q) || urls.length > 0;
  const t = String(title || '').trim() || g.split('\n')[0].slice(0, 80);
  const id = uid('mis');
  const ts = now();
  const state = wantsResearch ? 'researching' : 'planning';
  getDb().prepare(`INSERT INTO missions (id, title, goal, state, model, budget_usd, research_query, research_urls, max_build_attempts, created_by, created_at, updated_at)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, t.slice(0, 200), g, state, String(model || ''), b, q, JSON.stringify(urls), mba, String(createdBy || ''), ts, ts);
  _event(id, 'created', { title: t, state, budgetUsd: b, research: wantsResearch, urls: urls.length }, createdBy || 'system');
  return get(id);
}

// Validated transition + optional column patch. Throws on an illegal edge.
const SETTABLE = ['research_md', 'research_cost', 'plan_md', 'plan_approved', 'approval_id', 'current_task_id',
  'build_attempts', 'branch', 'pr_url', 'ship_md', 'failure_reason'];
function setState(id, to, { author = 'system', note = '', ...patch } = {}) {
  const m = get(id);
  if (!m) throw new Error(`mission.setState: no mission ${id}`);
  if (m.state !== to) {
    const allowed = TRANSITIONS[m.state] || [];
    if (!allowed.includes(to)) throw new Error(`mission.setState: illegal transition ${m.state} -> ${to} (mission ${id})`);
  }
  const cols = ['state = ?', 'updated_at = ?'];
  const vals = [to, now()];
  for (const k of SETTABLE) {
    if (patch[k] !== undefined) { cols.push(`${k} = ?`); vals.push(k === 'plan_approved' ? (patch[k] ? 1 : 0) : patch[k]); }
  }
  if (TERMINAL.has(to) || to === 'failed') { cols.push('finished_at = ?'); vals.push(now()); }
  else if (m.finished_at) { cols.push('finished_at = ?'); vals.push(null); }   // a retried mission is live again
  vals.push(id);
  getDb().prepare(`UPDATE missions SET ${cols.join(', ')} WHERE id = ?`).run(...vals);
  // Long text fields are recorded by size, not content.
  const ev = { from: m.state, to };
  for (const [k, v] of Object.entries(patch)) ev[k] = (typeof v === 'string' && v.length > 200) ? `${v.length} chars` : v;
  if (note) ev.note = note;
  _event(id, m.state === to ? 'update' : 'state_change', ev, author);
  return get(id);
}

// Patch columns without changing state (records an 'update' event).
const update = (id, patch) => setState(id, get(id).state, patch);

// USD this mission has spent: its research call plus every board task it created.
function spend(id) {
  const m = get(id);
  if (!m) return 0;
  const row = getDb().prepare(
    `SELECT COALESCE(SUM(CAST(cost_usd AS REAL)), 0) AS usd FROM tasks
     WHERE mission_id = ? AND cost_usd != '' AND CAST(cost_usd AS REAL) > 0`).get(id);
  return (Number(m.research_cost) || 0) + (Number(row.usd) || 0);
}

function tasks(id) {
  return getDb().prepare('SELECT id, title, mode, state, result, branch, pr_url, cost_usd, workspace, created_at, finished_at FROM tasks WHERE mission_id = ? ORDER BY created_at ASC').all(id);
}

module.exports = {
  STATES, ACTIVE,
  create, get, list, active, events, setState, update, spend, tasks,
  _event,
};
