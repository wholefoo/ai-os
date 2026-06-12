#!/usr/bin/env node
// auto-research/notify.js — post-run notification for the optimization loop.
// Reads history/log.jsonl, decides whether last night produced a new best or
// the target has plateaued, and pushes the verdict via Telegram/Slack
// (whichever is configured in the repo .env). Always prints to stdout so the
// n8n execution log captures the verdict regardless.
//
// Usage: node auto-research/notify.js [--dry-run]   (--dry-run: print only, no sends)

const fs = require('fs');
const path = require('path');

const DIR = __dirname;
try { require(path.join(DIR, '..', 'node_modules', 'dotenv')).config({ path: path.join(DIR, '..', '.env') }); } catch { /* optional */ }

const LOG = path.join(DIR, 'history', 'log.jsonl');
const PLATEAU_RUNS = 3; // runs without improvement before we call it done
const DRY_RUN = process.argv.includes('--dry-run');

function analyze() {
  if (!fs.existsSync(LOG)) return { kind: 'idle', message: 'Auto-research: no runs logged yet.' };
  const entries = fs.readFileSync(LOG, 'utf-8').trim().split('\n').map(l => JSON.parse(l));

  const scored = entries.filter(e => typeof e.score === 'number');
  if (!scored.length) return { kind: 'idle', message: 'Auto-research: log has no scored entries yet.' };
  const best = Math.max(...scored.map(e => e.score));

  // Each run logs exactly one baseline (iteration 0) — baselines are our "nights".
  const runs = entries.filter(e => e.action === 'baseline');
  const lastImprovement = [...entries].reverse().find(e => e.action === 'kept');
  const lastRunAt = runs.length ? runs[runs.length - 1].at : null;

  // Improvement during the most recent run?
  const lastRunKept = lastImprovement && lastRunAt && lastImprovement.at >= lastRunAt;
  if (lastRunKept) {
    const runEntries = entries.filter(e => e.at >= lastRunAt);
    const startScore = runEntries.find(e => e.action === 'baseline')?.score;
    return {
      kind: 'improved',
      message: `Auto-research: new best ${startScore} -> ${best} last run. ` +
        `Kept ${runEntries.filter(e => e.action === 'kept').length} mutation(s). Curve: auto-research/history/log.jsonl`,
    };
  }

  // Count runs since the last improvement (or since the beginning if never improved past baseline)
  const sinceAt = lastImprovement ? lastImprovement.at : '';
  const runsSince = runs.filter(r => r.at > sinceAt).length;
  if (runsSince >= PLATEAU_RUNS) {
    return {
      kind: 'plateau',
      message: `Auto-research: PLATEAU — no improvement in ${runsSince} runs, holding at ${best}/100. ` +
        `Time to harvest: review auto-research/asset/, apply the winner to production, and retarget the loop.`,
    };
  }

  return { kind: 'quiet', message: `Auto-research: no improvement last run (best ${best}/100, ${runsSince} flat run(s) of ${PLATEAU_RUNS} before plateau call).` };
}

async function sendTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) return false;
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chat, text }),
  });
  return res.ok;
}

async function sendSlack(text) {
  const url = process.env.SLACK_WEBHOOK_URL;
  if (!url) return false;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  return res.ok;
}

(async () => {
  const verdict = analyze();
  console.log(`[${verdict.kind}] ${verdict.message}`);

  // Quiet nights don't ping a phone — only improvements and plateaus do.
  if (DRY_RUN || verdict.kind === 'quiet' || verdict.kind === 'idle') return;

  const results = await Promise.allSettled([sendTelegram(verdict.message), sendSlack(verdict.message)]);
  const sent = results.filter(r => r.status === 'fulfilled' && r.value).length;
  console.log(sent ? `Notification sent via ${sent} channel(s).` : 'No notification channel configured (set TELEGRAM_* or SLACK_WEBHOOK_URL in .env).');
})();
