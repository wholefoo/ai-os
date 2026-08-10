#!/usr/bin/env node
/*
 * seclint — deterministic security linter for the AI OS codebase.
 *
 * Encodes the recurring vulnerability classes found in the 2026-07-01 audit so they cannot
 * silently regress. It is intentionally pattern-based (fast, zero-token, no network) — it catches
 * the ~90% that are mechanical; the deeper /audit multi-agent pass covers the reasoning-heavy rest.
 *
 * Rules (ERROR blocks CI; WARN is advisory):
 *   R1 route-no-auth (ERROR) — a mutating API route (post/put/delete) with NO middleware between the
 *                              path and the (req,res) handler. Public routes are allowlisted below.
 *   R2 path-traversal (ERROR) — path.join(...) fed a req.params/query/body value with no basename() guard.
 *   R3 shell-injection (ERROR) — execSync/exec with an interpolated template string (use execFile/spawn arrays).
 *   R4 jsonld-breakout (ERROR) — set:html={JSON.stringify(...)} without a `< -> <` escape (generated-site XSS).
 *   R5 innerhtml-unescaped (WARN) — .innerHTML assigned a template literal with a ${...} not wrapped in escapeHtml/esc.
 *
 * Suppress a single line with a trailing:  // seclint-ok: <reason>   (or // seclint-disable-line [rule])
 *
 * Usage:
 *   node tools/seclint.js [file ...]     scan given files (or the default set if none given)
 *   node tools/seclint.js --ci           scan the default set; exit 1 if any ERROR (WARN never fails)
 *   node tools/seclint.js --hook         read {tool_input:{file_path}} from stdin; scan that one file
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// Mutating API routes that are deliberately public (no auth by design). Keep this list tight.
const PUBLIC_ROUTES = [
  '/api/auth/login', '/api/auth/logout', '/api/auth/set-password', '/api/auth/request-reset',
  '/api/seo/free-audit', '/api/support/contact', '/api/stripe/webhook', '/api/webhooks/stripe',
];

/**
 * Every `${...}` in a line, at EVERY nesting depth, with braces matched properly.
 *
 * A regex cannot do this: `\$\{([^}]*)\}` stops at the first `}`, so a nested interpolation both
 * truncates its parent and never appears in its own right. Scanning from every index means an inner
 * `${...}` is reported alongside the outer one rather than swallowed by it — which is the whole
 * point, since the inner one is where the unescaped value usually lives.
 *
 * Unterminated interpolations are dropped: a template literal continuing onto the next line cannot
 * be judged from this line alone, and guessing would invent findings. That IS a known blind spot of
 * a line-based linter — multi-line templates are not covered by this rule at all.
 */
function interpolations(line) {
  const out = [];
  for (let i = 0; i + 1 < line.length; i++) {
    if (line[i] !== '$' || line[i + 1] !== '{') continue;
    let depth = 1, j = i + 2;
    while (j < line.length && depth > 0) {
      if (line[j] === '{') depth++;
      else if (line[j] === '}') depth--;
      if (depth === 0) break;
      j++;
    }
    if (depth === 0) out.push(line.slice(i + 2, j).trim());
  }
  return out;
}

const rules = [
  {
    id: 'route-no-auth',
    level: 'error',
    // app.post('/api/x', (req  -> handler directly after the path string = no middleware
    test(line) {
      const m = line.match(/\bapp\.(post|put|delete)\(\s*(['"`])(\/api\/[^'"`]+)\2\s*,\s*(async\s*)?\(\s*req\b/);
      if (!m) return null;
      const route = m[3];
      if (PUBLIC_ROUTES.includes(route)) return null;
      return `mutating route ${m[1].toUpperCase()} ${route} has no auth middleware (add requireAdmin / requireClientOrAdmin, or allowlist if public)`;
    },
  },
  {
    id: 'path-traversal',
    level: 'error',
    test(line) {
      if (!/\bpath\.join\s*\(/.test(line)) return null;
      if (!/req\.(params|query|body)\b/.test(line)) return null;
      if (/\bbasename\s*\(/.test(line)) return null;
      return 'path.join() built from req input without path.basename() — path traversal risk';
    },
  },
  {
    id: 'shell-injection',
    level: 'error',
    test(line) {
      if (/\b(execSync|exec)\s*\(\s*`[^`]*\$\{/.test(line)) {
        return 'shell command built by string interpolation — use execFile()/spawn() with an argument array';
      }
      return null;
    },
  },
  {
    id: 'jsonld-breakout',
    level: 'error',
    test(line) {
      if (!/set:html\s*=\s*\{/.test(line)) return null;
      if (!/JSON\.stringify/.test(line)) return null;
      if (/u003c/i.test(line)) return null; // has the < -> < escape
      return 'set:html with un-escaped JSON.stringify can break out of </script> — escape < to \\u003c';
    },
  },
  {
    id: 'innerhtml-unescaped',
    level: 'warn',
    test(line) {
      if (!/\.innerHTML\s*(\+?=)/.test(line)) return null;
      if (!line.includes('${')) return null;

      // THIS RULE USED TO SKIP THE MOST DANGEROUS SHAPE THERE IS. Two defects compounded:
      //   1. `/\.map\(/` was in the safe() list, so ANY expression containing `.map(` was waved
      //      through — and a row builder is the single likeliest place for unescaped user data.
      //   2. Interpolations were pulled with /\$\{([^}]*)\}/, whose `[^}]*` stops at the FIRST `}`.
      //      For `${rows.map(r => `<li>${r.name}</li>`).join('')}` that captures the fragment
      //      "rows.map(r => `<li>${r.name" — one expression, containing `.map(`, therefore "safe".
      //      The inner `${r.name}` was never seen as an expression at all.
      // Net effect: `el.innerHTML = \`${rows.map(r => \`<li>${r.name}</li>\`).join('')}\`` passed
      // clean. Verified against the real linter on 2026-08-10 before changing it — the flat
      // `${u.name}` was flagged while both nested cases were not.
      //
      // Now every `${...}` is brace-matched at EVERY depth, and an expression that itself contains
      // a nested template literal is treated as a CONTAINER: not flagged on its own (its value is
      // assembled HTML, not a leaf value), because its inner interpolations are checked separately
      // by the same scan. The `.map(` exemption is gone — `${ids.map(i => i.raw).join(',')}` is a
      // real injection vector and now reports. Use `// seclint-ok: <reason>` where it truly is not.
      const exprs = interpolations(line);
      const safe = e =>
        /^escapeHtml\(/.test(e) || /^esc\(/.test(e) || /^escapeAttr\(/.test(e) ||
        /^\s*['"`]/.test(e) || /^[\d.]+$/.test(e) || e === '';
      const bad = exprs.filter(e => !e.includes('`') && !safe(e));
      if (!bad.length) return null;
      return `innerHTML interpolates possibly-unescaped value(s): ${bad.slice(0, 2).map(e => e.slice(0, 40)).join(', ')} — wrap in escapeHtml()`;
    },
  },
];

function scanFile(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const findings = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/seclint-(ok|disable-line|disable-next-line)/.test(line) ||
        (i > 0 && /seclint-disable-next-line/.test(lines[i - 1]))) continue;
    for (const rule of rules) {
      const msg = rule.test(line);
      if (msg) findings.push({ file: path.relative(ROOT, file), line: i + 1, rule: rule.id, level: rule.level, msg });
    }
  }
  return findings;
}

function defaultFileSet() {
  const out = [];
  const add = p => { if (fs.existsSync(p)) out.push(p); };
  add(path.join(ROOT, 'server.js'));
  const walk = dir => {
    if (!fs.existsSync(dir)) return;
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f);
      const st = fs.statSync(p);
      if (st.isDirectory()) { if (f !== 'node_modules') walk(p); }
      else if (/\.(js|mjs|astro)$/.test(f)) out.push(p);
    }
  };
  walk(path.join(ROOT, 'lib'));
  walk(path.join(ROOT, 'dashboard', 'js'));
  return out;
}

function report(findings) {
  const errors = findings.filter(f => f.level === 'error');
  const warns = findings.filter(f => f.level === 'warn');
  for (const f of findings) {
    const tag = f.level === 'error' ? 'ERROR' : 'warn ';
    console.log(`  [${tag}] ${f.file}:${f.line}  (${f.rule})\n          ${f.msg}`);
  }
  console.log(`\nseclint: ${errors.length} error(s), ${warns.length} warning(s) across ${new Set(findings.map(f => f.file)).size} file(s).`);
  return errors.length;
}

function main() {
  const args = process.argv.slice(2);

  if (args.includes('--hook')) {
    // PostToolUse hook: {tool_input:{file_path}} arrives on stdin. Scan just that file; exit 2 so any
    // findings are surfaced back to Claude as feedback (non-blocking — the edit already happened).
    let raw = '';
    process.stdin.on('data', d => (raw += d));
    process.stdin.on('end', () => {
      let file;
      try { file = JSON.parse(raw)?.tool_input?.file_path; } catch { /* ignore */ }
      // Only scan code files inside this repo (ROOT-contained), regardless of the folder name.
      if (!file || !/\.(js|mjs|astro)$/.test(file)) process.exit(0);
      const rel = path.relative(ROOT, path.resolve(file));
      if (rel.startsWith('..') || path.isAbsolute(rel)) process.exit(0);
      const findings = scanFile(file);
      if (!findings.length) process.exit(0);
      console.error(`seclint flagged ${findings.length} issue(s) in ${path.basename(file)}:`);
      for (const f of findings) console.error(`  [${f.level}] ${f.file}:${f.line} (${f.rule}) — ${f.msg}`);
      process.exit(2);
    });
    return;
  }

  const ci = args.includes('--ci');
  const files = args.filter(a => !a.startsWith('--'));
  const targets = files.length ? files.map(f => path.resolve(f)) : defaultFileSet();
  const findings = targets.flatMap(scanFile);
  const errorCount = report(findings);
  if (ci && errorCount > 0) process.exit(1);
}

main();
