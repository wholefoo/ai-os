// lib/dev/ship.js
// ============================================================
//  The SHIP facet: turn a finished build into a hand-off package — what changed, how it was verified,
//  a PR link pre-filled with the description, and a DEPLOY CHECKLIST derived from the changed paths.
//
//  Deterministic on purpose (no model call): the checklist encodes this repo's own deploy lessons —
//  npm ci before restart, never chained; runner script = reinstall; units = daemon-reload; pull from
//  upstream on Hermes-Dev — and those must be exactly right every time, not paraphrased by a model.
//  Hermes-Dev never merges or deploys: this package is what a human acts on.
// ============================================================

// Each rule: which changed paths trigger it, and the checklist line(s) it adds. Order = deploy order.
const RULES = [
  {
    id: 'deps',
    match: (f) => f === 'package.json' || f === 'package-lock.json',
    steps: [
      'Dependencies changed: run `npm ci` as the APP user (prod: `aios` with `--omit=dev`; Hermes-Dev: `hermes`), confirm it exits 0, THEN restart. Never chain the install into the restart, and never run npm as root.',
    ],
  },
  {
    id: 'migration',
    match: (f) => /^lib\/[^/]+\/db\.js$/.test(f),
    steps: ['A database schema changed: the migration runs when the service opens the database. Back up `.magent/` first (checkpoint the WAL or copy the -wal/-shm sidecars together).'],
  },
  {
    id: 'runner',
    match: (f) => f === 'deploy/coding-instance/hermes-task',
    steps: ['The coding runner changed: on Hermes-Dev reinstall it — `sudo install -o root -g root -m 755 /home/hermes/work/ai-os/deploy/coding-instance/hermes-task /usr/local/bin/hermes-task` (a git pull does not update it).'],
  },
  {
    id: 'launcher',
    match: (f) => f === 'deploy/coding-instance/hermes-agent-launch' || f === 'deploy/coding-instance/claude-policy.json',
    steps: ['The agent launcher or sandbox policy changed: these are installed root-owned OUTSIDE the repo (/usr/local/sbin, /etc/claude-code) by the coding-instance install scripts — re-run the matching install step, then run `sudo -iu hermes hermes-task --probe` and require PROBE: PASS.'],
  },
  {
    id: 'units',
    match: (f) => /\.service$/.test(f),
    // The coding-instance units are TEMPLATES (@HERMES_USER@, @APP_DIR@, @NODE_BIN@), rendered into
    // /etc/systemd/system by the script that owns each — copying the repo file would install the raw
    // placeholders. Both scripts are idempotent and daemon-reload themselves.
    steps: ['A systemd unit changed. The deploy/coding-instance units are TEMPLATES (@HERMES_USER@ and friends) — do NOT copy them: re-render with the script that owns each (`ai-os-board-dispatcher.service` → `sudo bash deploy/coding-instance/enable-board-dispatcher.sh`; `ai-os-hermes.service` → re-run `deploy/coding-instance/provision.sh`, idempotent). Both run `systemctl daemon-reload`; confirm with `systemctl cat <unit>` and `systemd-analyze verify /etc/systemd/system/<unit>`.'],
  },
  {
    id: 'board',
    match: (f) => f.startsWith('lib/board/') || f.startsWith('lib/dev/'),
    steps: ['Board/mission code changed: on Hermes-Dev restart BOTH `ai-os-hermes.service` and `ai-os-board-dispatcher.service`.'],
  },
  {
    id: 'server',
    match: (f) => f === 'server.js' || f.startsWith('lib/') || f === 'ecosystem.config.js',
    steps: ['Server code changed: restart the app (prod: `sudo -u aios PM2_HOME=/home/aios/.pm2 pm2 restart ai-os --update-env` — root pm2 is an empty daemon; Hermes-Dev: `sudo systemctl restart ai-os-hermes.service`) and confirm the uptime reset.'],
  },
  {
    id: 'static',
    match: (f) => f.startsWith('dashboard/') || f.startsWith('public/'),
    steps: ['Front-end files changed: served from disk, live on pull — but purge Cloudflare if the change does not show, and static assets can never confirm a server-side deploy.'],
  },
];

const DOC_ONLY = (f) => /\.(md|txt)$/i.test(f) || f.startsWith('docs/');

function deployChecklist(changedFiles = []) {
  const files = (changedFiles || []).map((f) => String(f).trim().replace(/\\/g, '/')).filter(Boolean);
  const lines = [
    'Review and merge the PR on GitHub (Hermes-Dev never merges).',
    'Pull the merge: prod `sudo -u aios git -C /opt/ai-os pull --ff-only origin master`; Hermes-Dev from `upstream`, NOT `origin` (the fork): `git fetch upstream master && git merge --ff-only upstream/master`.',
  ];
  if (!files.length) {
    lines.push('Changed files unknown — check the PR diff and apply the matching steps below by hand.');
    return { lines, rules: [], docOnly: false };
  }
  if (files.every(DOC_ONLY)) {
    lines.push('Documentation only — nothing to restart or install.');
    return { lines, rules: [], docOnly: true };
  }
  const fired = RULES.filter((r) => files.some(r.match));
  for (const r of fired) lines.push(...r.steps);
  if (!fired.length) lines.push('No install/restart rule matched these paths — review the diff to decide whether a restart is needed.');
  // Only for changes a site visitor can see (served code or assets). A unit-file or runner change has
  // no user-facing path, and an always-on line teaches the reader to skip the checklist's last step.
  if (fired.some((r) => r.id === 'server' || r.id === 'static')) {
    lines.push('Verify on the path the user actually takes (through the CDN, not just the origin).');
  }
  return { lines, rules: fired.map((r) => r.id), docOnly: false };
}

// GitHub accepts title/body query parameters on a compare URL with expand=1, which pre-fills the
// PR form. The body is capped so the URL stays well under length limits; the full package lives on
// the mission.
const PR_BODY_MAX = 1800;
function prefilledPrUrl(compareUrl, title, body) {
  if (!compareUrl) return '';
  let u;
  try { u = new URL(compareUrl); } catch { return compareUrl; }
  u.searchParams.set('expand', '1');
  if (title) u.searchParams.set('title', String(title).slice(0, 120));
  if (body) {
    const b = String(body);
    u.searchParams.set('body', b.length > PR_BODY_MAX ? `${b.slice(0, PR_BODY_MAX)}\n\n…(truncated — full notes on the mission)` : b);
  }
  return u.toString();
}

function buildShipPackage({ mission, task, summaryMd = '', changedFiles = [], spentUsd = 0 }) {
  const files = (changedFiles || []).filter(Boolean);
  const { lines } = deployChecklist(files);
  const summary = String(summaryMd || '').trim() || '_The builder wrote no SUMMARY.md._';
  const prTitle = `hermes: ${mission.title}`.slice(0, 120);
  const prBody = [
    `Mission \`${mission.id}\` — built by Hermes-Dev from an operator-approved plan.`,
    '',
    summary,
    '',
    `Tests: the full suite passed on a clean checkout before push.`,
  ].join('\n');
  const md = [
    `# Ship package — ${mission.title}`,
    '',
    `- **Mission:** \`${mission.id}\``,
    `- **Branch:** \`${task.branch || '(none)'}\``,
    `- **Tests:** passed on a clean checkout (runner verify)`,
    `- **Build attempts:** ${mission.build_attempts}`,
    `- **Mission spend:** $${Number(spentUsd || 0).toFixed(2)} of $${Number(mission.budget_usd).toFixed(2)}`,
    `- **Changed files (${files.length}):** ${files.length ? files.map((f) => `\`${f}\``).join(', ') : 'unknown'}`,
    '',
    '## What the builder says it did',
    summary,
    '',
    '## Deploy checklist',
    ...lines.map((l, i) => `${i + 1}. ${l}`),
  ].join('\n');
  return { md, prUrl: prefilledPrUrl(task.pr_url, prTitle, prBody) };
}

module.exports = { deployChecklist, prefilledPrUrl, buildShipPackage };
