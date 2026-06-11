#!/usr/bin/env node
// auto-research/run-loop.js — drives the mutate → score → keep/revert cycle.
// Usage: node auto-research/run-loop.js [--iterations N] [--target SCORE] [--dry-run]

const { execFileSync, execSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const ASSET_DIR = path.join(DIR, 'asset');
const HISTORY_DIR = path.join(DIR, 'history');
const SCORER = path.join(DIR, 'score.js');
const LOG = path.join(HISTORY_DIR, 'log.jsonl');

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? Number(args[i + 1]) : fallback;
};
const ITERATIONS = opt('--iterations', 5);
const TARGET = opt('--target', Infinity);
const DRY_RUN = args.includes('--dry-run');

const sha = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

function runScorer() {
  const out = execFileSync(process.execPath, [SCORER], { timeout: 5 * 60 * 1000 }).toString().trim();
  const result = JSON.parse(out.split('\n').pop());
  if (typeof result.score !== 'number') throw new Error('scorer returned no numeric score');
  return result;
}

function snapshot(label) {
  const dest = path.join(HISTORY_DIR, label);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(ASSET_DIR, dest, { recursive: true });
  return dest;
}

function restore(label) {
  const src = path.join(HISTORY_DIR, label);
  fs.rmSync(ASSET_DIR, { recursive: true, force: true });
  fs.cpSync(src, ASSET_DIR, { recursive: true });
}

function log(entry) {
  fs.appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
}

function mutate(iteration, best) {
  const instructions = fs.readFileSync(path.join(DIR, 'instructions.md'), 'utf-8');
  const recent = fs.existsSync(LOG)
    ? fs.readFileSync(LOG, 'utf-8').trim().split('\n').slice(-10).join('\n')
    : '(no history yet)';
  const prompt = [
    'You are one iteration of an autonomous optimization loop.',
    `Current best score: ${best.score}. Details: ${JSON.stringify(best.details)}`,
    '',
    '== INSTRUCTIONS ==', instructions,
    '',
    '== RECENT SCORE HISTORY (learn from losses) ==', recent,
    '',
    `Mutate the files in ${ASSET_DIR} to raise the score. Make ONE focused change.`,
    'You may ONLY write inside auto-research/asset/. Do not touch score.js or run-loop.js.',
  ].join('\n');

  execSync(`claude -p ${JSON.stringify(prompt)} --allowedTools "Read,Write,Edit,Glob,Grep"`, {
    cwd: path.join(DIR, '..'),
    stdio: ['ignore', 'inherit', 'inherit'],
    timeout: 15 * 60 * 1000,
  });
}

// ---- main ----
fs.mkdirSync(HISTORY_DIR, { recursive: true });
if (!fs.existsSync(ASSET_DIR) || !fs.readdirSync(ASSET_DIR).length) {
  console.error('asset/ is empty. Put the asset to optimize in auto-research/asset/ first.');
  process.exit(1);
}
if (!DRY_RUN) {
  try {
    execSync('claude --version', { stdio: 'ignore', timeout: 30000 });
  } catch {
    console.error('The `claude` CLI is required for mutation but was not found on PATH.');
    console.error('Install: npm install -g @anthropic-ai/claude-code  (and set ANTHROPIC_API_KEY)');
    process.exit(1);
  }
}

const scorerHash = sha(SCORER);
let best = runScorer();
console.log(`Baseline score: ${best.score}`);
log({ iteration: 0, score: best.score, action: 'baseline', details: best.details });
if (DRY_RUN) process.exit(0);

snapshot('best');

for (let i = 1; i <= ITERATIONS && best.score < TARGET; i++) {
  console.log(`\n— Iteration ${i}/${ITERATIONS} (best: ${best.score}) —`);
  try {
    mutate(i, best);

    // Guardrail: the agent must not have touched the scorer.
    if (sha(SCORER) !== scorerHash) {
      console.error('FATAL: score.js was modified by the agent. Reverting and aborting.');
      execSync(`git checkout -- ${JSON.stringify(SCORER)}`, { cwd: path.join(DIR, '..') });
      restore('best');
      log({ iteration: i, action: 'aborted-scorer-tampered' });
      process.exit(1);
    }

    const candidate = runScorer();
    if (candidate.score > best.score) {
      console.log(`KEPT: ${best.score} → ${candidate.score}`);
      log({ iteration: i, score: candidate.score, action: 'kept', delta: candidate.score - best.score, details: candidate.details });
      best = candidate;
      snapshot('best');
      snapshot(`iter-${String(i).padStart(3, '0')}-kept`);
    } else {
      console.log(`REVERTED: candidate scored ${candidate.score} (best ${best.score})`);
      log({ iteration: i, score: candidate.score, action: 'reverted', details: candidate.details });
      restore('best');
    }
  } catch (e) {
    console.error(`Iteration ${i} broke the asset (${e.message}). Reverting.`);
    log({ iteration: i, action: 'reverted-broken', error: String(e.message).slice(0, 200) });
    restore('best');
  }
}

console.log(`\nDone. Final best score: ${best.score}. Log: ${path.relative(process.cwd(), LOG)}`);
