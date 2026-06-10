# Auto Research — Autonomous Optimization Loop

A three-file evolutionary loop that optimizes an asset (code, copy, config) against an
objective score, unattended. Based on Karpathy's Auto Research pattern: the agent mutates
the asset, the scorer measures it, losing variants are discarded, and the loop repeats.

## The Three Files

| File | Role | Who touches it |
|------|------|----------------|
| `instructions.md` | What to optimize and the constraints | Human writes, agent reads |
| `asset/` | The thing being optimized | Agent mutates |
| `score.js` | Objective scoring mechanism | **Untouchable** — agent must never edit |

The scorer being outside the agent's reach is the non-negotiable part. If the agent can
edit the metric, it will optimize the metric instead of the asset.

## How It Works

`run-loop.js` drives the cycle:

1. **Score** the current asset → baseline.
2. **Mutate** — invoke Claude Code headless (`claude -p`) with `instructions.md` + the
   current best asset + the score history. The agent writes a candidate into `asset/`.
3. **Re-score** the candidate.
   - Improved → keep it as the new best (previous best archived in `history/`).
   - Worse or broken → revert to the previous best.
4. **Log** every iteration to `history/log.jsonl` (score, delta, kept/reverted).
5. Repeat until `--iterations` is reached or the target score is hit.

The loop enforces the guardrail at the process level: `score.js` is checksummed before
each iteration — if it changed, the loop aborts and reverts it.

## Usage

```bash
# 1. Put the asset to optimize in auto-research/asset/
# 2. Edit instructions.md (goal, constraints, what "better" means)
# 3. Edit score.js to measure your asset objectively
# 4. Run:
node auto-research/run-loop.js --iterations 10

# Options:
#   --iterations N    max loop cycles (default 5)
#   --target SCORE    stop early when score >= target
#   --dry-run         score the current asset and exit (no mutation)
```

Requires the `claude` CLI on PATH (Claude Code). Each iteration is one headless
invocation — budget accordingly (`--iterations 10` ≈ 10 agent runs).

## Triggering via n8n (overnight runs)

1. In n8n, create a **Schedule Trigger** (e.g. daily at 2am).
2. Add an **Execute Command** node:
   ```
   cd /opt/ai-os && node auto-research/run-loop.js --iterations 10
   ```
3. Add a notification node (Slack/Telegram) posting the tail of
   `auto-research/history/log.jsonl` so you wake up to the score curve.

## Example Scorers

- **Page speed**: run Lighthouse against a locally served page, return the performance score.
- **Test suite**: return % of tests passing minus a penalty per line of code added.
- **Email copy**: score against a rubric with a *separate* judge model call (the judge
  prompt lives inside score.js, where the optimizing agent can't see or edit it).
- **SEO meta**: length limits, keyword presence, duplicate-title detection across pages.

## Anti-Patterns

- Never let the agent "fix" the scorer, even when the scorer has a real bug — stop the
  loop, fix it yourself, restart. (The checksum guard enforces this.)
- Don't use a subjective scorer ("does this look good?") without a fixed rubric — score
  drift makes the evolution random.
- Don't run unattended loops against production assets. Optimize a copy; deploy winners
  manually after review (see `.claude/rules/adversarial-verification.md`).
