// auto-research/score.js — THE UNTOUCHABLE SCORER
// The optimizing agent must NEVER edit this file. run-loop.js checksums it
// before every iteration and aborts the loop if it changed.
//
// Contract: print a single JSON line to stdout and exit 0:
//   { "score": <number 0-100>, "details": { ... } }
// A thrown error or non-zero exit means "candidate is broken" → automatic revert.
//
// TEMPLATE — replace the example below with an objective measurement of YOUR asset.

const fs = require('fs');
const path = require('path');

const ASSET_DIR = path.join(__dirname, 'asset');

function score() {
  // EXAMPLE: score a text asset on length discipline and banned-filler avoidance.
  // Replace with your real metric (run tests, run Lighthouse, call a judge model, etc.)
  const files = fs.existsSync(ASSET_DIR)
    ? fs.readdirSync(ASSET_DIR).filter(f => !f.startsWith('.'))
    : [];
  if (!files.length) throw new Error('asset/ is empty — nothing to score');

  const text = files.map(f => fs.readFileSync(path.join(ASSET_DIR, f), 'utf-8')).join('\n');

  const FILLER = /in today's fast-paced world|game-changer|unlock the power|delve|it's important to note/gi;
  const fillerHits = (text.match(FILLER) || []).length;
  const lengthPenalty = Math.max(0, (text.length - 2000) / 200);

  const value = Math.max(0, Math.min(100, 100 - fillerHits * 10 - lengthPenalty));
  return { score: value, details: { files: files.length, chars: text.length, fillerHits } };
}

console.log(JSON.stringify(score()));
