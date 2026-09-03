#!/usr/bin/env node
// tools/intel-brief-compare.js — trigger and measure the intel-brief experiment ON THE VPS.
//
//   node tools/intel-brief-compare.js run compiled     # trigger the 1-call version, wait, report
//   node tools/intel-brief-compare.js run baseline     # trigger the 11-call version, wait, report
//   node tools/intel-brief-compare.js report           # just print what the ledger + sidecars hold
//
// WHY A SCRIPT AND NOT A ONE-LINER. The first attempt was an ssh command with node -e inside
// xargs inside sh -c — three layers of quoting — and it died with "syntax error near unexpected
// token `('" before running anything. This repo's own notes already say: complex quoting goes in
// a file. It also fixes the one credential exposure the one-liner had: the admin token is read
// from .env IN-PROCESS here and used in a fetch() header, so it never appears in a shell variable,
// a process list, or any printed line. Nothing this script prints is a secret.
//
// Named without the test- prefix so tools/test-all.js never runs it: `run` spends real money.
// `report` is free and is what tools/test-intel-brief-compare.js exercises.

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const BRIEFS = path.join(ROOT, 'data', 'intel-briefs');
const LEDGER = path.join(ROOT, '.magent', 'state', 'cost-ledger.json');
const BASE = process.env.AIOS_BASE || 'http://localhost:3000';

const MODES = { compiled: { hermes: 'intel-brief-compiled', waitMs: 240000, isMode: (m) => m.mode === 'compiled' },
                baseline: { hermes: 'intel-brief',          waitMs: 600000, isMode: (m) => m.mode !== 'compiled' } };

function token() {
  if (process.env.API_TOKEN) return process.env.API_TOKEN.trim();
  try {
    const m = fs.readFileSync(path.join(ROOT, '.env'), 'utf8').match(/^API_TOKEN\s*=\s*(.+)$/m);
    if (m) return m[1].trim().replace(/^["']|["']$/g, '');
  } catch { /* fall through */ }
  return null;
}

function ledgerGroup(prefix) {
  let rows = [];
  try { rows = JSON.parse(fs.readFileSync(LEDGER, 'utf8')).filter((x) => String(x.skill || '').startsWith(prefix)); } catch { /* no ledger */ }
  const sum = (k) => rows.reduce((s, x) => s + (Number(x[k]) || 0), 0);
  return {
    calls: rows.length,
    cost: +sum('cost').toFixed(4),
    inTok: sum('inputTokens'), outTok: sum('outputTokens'),
    models: [...new Set(rows.map((x) => x.model).filter(Boolean))],
    skills: [...new Set(rows.map((x) => x.skill))],
    first: rows[0] && rows[0].timestamp, last: rows[rows.length - 1] && rows[rows.length - 1].timestamp,
  };
}

function sidecars() {
  try {
    return fs.readdirSync(BRIEFS).filter((f) => f.endsWith('.json'))
      .map((f) => { try { return { ...JSON.parse(fs.readFileSync(path.join(BRIEFS, f), 'utf8')), _file: f, _mtime: fs.statSync(path.join(BRIEFS, f)).mtimeMs }; } catch { return null; } })
      .filter((m) => m && m.kind === 'intel-brief')
      .sort((a, b) => b._mtime - a._mtime);
  } catch { return []; }
}

function report() {
  const c = ledgerGroup('intel-brief-compiled');
  const b = ledgerGroup('intel-brief:');
  console.log('\n── LEDGER (all rows the persisted ledger holds for each version) ──');
  console.log('COMPILED :', JSON.stringify(c));
  console.log('BASELINE :', JSON.stringify(b));
  if (c.calls && b.calls) {
    const ratio = (b.cost / (c.cost || 1e-9)).toFixed(1);
    console.log(`\n   baseline is ${ratio}× the cost of compiled  (${b.calls} calls vs ${c.calls}; ${b.inTok + b.outTok} vs ${c.inTok + c.outTok} tokens)`);
  } else {
    console.log(`\n   ${!c.calls ? 'no compiled rows yet — run: node tools/intel-brief-compare.js run compiled' : ''}${!b.calls ? '\n   no baseline rows yet — run: node tools/intel-brief-compare.js run baseline  (~$1-2)' : ''}`);
  }
  for (const [name, def] of Object.entries(MODES)) {
    const m = sidecars().find(def.isMode);
    console.log(`\n── LATEST ${name.toUpperCase()} STATEMENT ──`);
    if (!m) { console.log('   (none)'); continue; }
    console.log('  ', JSON.stringify({ file: m.file, createdAt: m.createdAt, llmCalls: m.llmCalls ?? (name === 'baseline' ? 11 : null), cost: m.cost ?? null,
      sourcesHealthy: m.sourcesHealthy, sourcesTotal: m.sourcesTotal, entriesNew: m.entriesNew, consultantsReported: m.consultantsReported, consultantsTotal: m.consultantsTotal }));
    if (Array.isArray(m.sources)) {
      const bad = m.sources.filter((s) => s.unparsed || s.error);
      if (bad.length) console.log('   source problems:', bad.map((s) => `${s.provider}: ${s.error ? 'FAILED ' + s.error : 'UNPARSED'}`).join(' | '));
    }
    console.log('   summary:', String(m.summary || '').replace(/\s+/g, ' ').slice(0, 700));
  }
  console.log('');
}

async function run(mode) {
  const def = MODES[mode];
  if (!def) { console.error(`unknown mode "${mode}" — use compiled | baseline`); process.exit(2); }
  const tok = token();
  if (!tok) { console.error('No API_TOKEN in the environment or .env — cannot trigger a run.'); process.exit(2); }

  const before = new Set(sidecars().map((m) => m._file));
  const started = Date.now();
  const res = await fetch(`${BASE}/api/hermes/delegate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
    // `task` is required by the route (400 without it). The intel-brief branches treat a task equal
    // to the mode name as "no operator focus note", so sending the mode name IS the neutral value.
    body: JSON.stringify({ mode: def.hermes, task: def.hermes }),
  });
  if (!res.ok) { console.error(`trigger failed: HTTP ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`); process.exit(1); }
  const j = await res.json().catch(() => ({}));
  if (j.demo === true || /^\[DEMO\]/.test(String(j.result || ''))) { console.error('the instance is in DEMO_MODE — nothing here would be evidence'); process.exit(1); }
  console.log(`${mode}: triggered (${def.hermes}) — waiting up to ${def.waitMs / 1000}s for a new statement sidecar`);

  // The run is async; its completion is a NEW sidecar of the right mode. Poll for that rather than
  // sleeping a fixed time — a fixed sleep either wastes minutes or reads the ledger too early.
  while (Date.now() - started < def.waitMs) {
    await new Promise((r) => setTimeout(r, 5000));
    process.stdout.write('.');
    const fresh = sidecars().filter((m) => !before.has(m._file) && def.isMode(m));
    if (fresh.length) {
      console.log(`\n${mode}: done in ${Math.round((Date.now() - started) / 1000)}s → ${fresh[0].file}`);
      report();
      return;
    }
  }
  console.log(`\n${mode}: no new sidecar after ${def.waitMs / 1000}s — the run may have FAILED. Check: sudo -iu aios pm2 logs ai-os --lines 40 --nostream | grep intel-brief`);
  report();
  process.exit(1);
}

// `probe`: fetch every source through the SAME safeFetch production uses and show what came back.
// Exists because the first VPS run reported all seven sources UNPARSED while the identical extractor
// parsed all seven from the dev box minutes earlier — and the dev check had used Node's global
// fetch(), not safeFetch. Different user-agent, different redirect handling: a seam nobody tested.
// This prints status, body length, the first 200 chars of TEXT, and whether the page looks like a
// bot challenge, so the difference is READ rather than guessed at.
async function probe() {
  const C = require('../lib/intel-brief-compiled');
  const { safeFetch } = require('../lib/net/safe-fetch');
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'net', 'safe-fetch.js'), 'utf8');
  const ua = (src.match(/DEFAULT_UA\s*=\s*['"`]([^'"`]+)/) || [])[1] || '(unknown)';
  console.log('safeFetch default User-Agent:', ua, '\n');
  const rows = await C.fetchAllSources({ fetch: safeFetch, now: Date.now() });
  for (const r of rows) {
    let head = '';
    let challenge = false;
    try {
      const res = await safeFetch(r.url, { timeoutMs: 15000, maxBytes: 2_000_000, accept: 'text/html', headers: { 'Accept-Language': 'en-US,en;q=0.9' } });
      const text = C.htmlToText(res.body);
      head = text.slice(0, 200).replace(/s+/g, ' ');
      challenge = /just a moment|checking your browser|enable javascript|cf-chl|attention required|access denied|verify you are human/i.test(res.body);
      console.log(`${r.provider.padEnd(11)} HTTP ${res.status}  body ${String(res.body.length).padStart(7)}b  dated ${String(r.parsed).padStart(3)}  recent ${r.recent}${r.unparsed ? '  UNPARSED' : ''}${challenge ? '  <<< BOT CHALLENGE PAGE' : ''}${r.error ? '  ERROR ' + r.error : ''}`);
      console.log(`             ${JSON.stringify(head)}`);
    } catch (e) {
      console.log(`${r.provider.padEnd(11)} FETCH THREW: ${e.message}`);
    }
  }
}

const [cmd, arg] = process.argv.slice(2);
if (cmd === 'probe') { probe(); }
else if (cmd === 'run') run(arg || 'compiled');
else if (cmd === 'report' || !cmd) report();
else { console.error('usage: node tools/intel-brief-compare.js run compiled|baseline  |  report  |  probe'); process.exit(2); }
