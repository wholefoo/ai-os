// Shared micro-harness for the tools/test-*.js suites: streaming ok/FAIL lines, non-zero exit
// on any failure, no framework. Keep it tiny — these run standalone via `node tools/test-x.js`.
const fs = require('fs');
const assert = (cond, msg) => { if (!cond) { console.error('FAIL:', msg); process.exitCode = 1; } else console.log('ok  :', msg); };
const done = () => console.log(process.exitCode ? '\nTESTS FAILED' : '\nALL TESTS PASSED');
// For suites that mkdtempSync a scratch dir: remove it, then report. Shared because three suites
// ended with the identical two-line rmSync+done() pattern.
const cleanupAndFinish = (dir) => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); done(); };

// server.js as text, for the suites that assert a route is actually wired the way its module expects.
//
// CRLF is normalised HERE, once, because several of those assertions match a MULTI-LINE literal. This
// repo checks out with CRLF on Windows, so a pattern like `'executeAgent(\n    skill.agent,'` stops
// matching the moment git rewrites the file — which any branch checkout does. That failure reads
// exactly like a code regression and is not one. Same discipline as lib/handbooks/schema.js split():
// normalise at the boundary where the text is read, so nothing downstream has to think about it.
const serverSource = () =>
  fs.readFileSync(require('path').join(__dirname, '..', 'server.js'), 'utf8').replace(/\r\n?/g, '\n');

// The repo root, and any repo file as CRLF-normalised text. Three suites had grown the identical
// six-line preamble (fs/path require + ROOT + a normalising read); adding a fourth tripped the
// duplication gate, which was right — the fix is one helper, not four copies. Accepts a repo-relative
// path or an absolute one, so existing `read(path.join(ROOT, x))` call sites keep working.
//
// Normalisation is NOT cosmetic here: this repo checks out with mixed line endings, and a suite that
// matches a multi-line pattern against a raw read fails in a way that looks like a code regression.
const repoRoot = require('path').join(__dirname, '..');
const readRepoFile = (p) =>
  fs.readFileSync(require('path').isAbsolute(p) ? p : require('path').join(repoRoot, p), 'utf8')
    .replace(/\r\n?/g, '\n');

// Drive the REAL seclint CLI over a throwaway fixture file. All three tools/test-seclint-*.js
// suites do this rather than importing seclint's logic, and each says so in its own header — the
// point is that a suite must not be able to pass while the SHIPPED linter fails. That decision is
// one idea held in three places, and it had been written out three times: mkdtemp a scratch dir,
// write the fixture, execFileSync, and fold stderr into the result. Anything that changes about
// invoking the CLI — a new required flag, a config path, `process.execPath` instead of 'node' —
// has to be changed in all three today. That is what makes it shared rather than merely similar.
//
// Only the regex each suite applies to the output differs (`innerhtml-unescaped` lines, {line,rule}
// pairs, a `innerhtml-dataflow` count), so `run` returns the raw text and each suite keeps its own
// parse — the part that is genuinely per-rule stays per-rule.
//
// stdout and stderr are concatenated because seclint EXITS NON-ZERO as soon as it finds anything,
// which is the normal case for a fixture built to trip a rule: the findings arrive via the throw,
// not the return. Reading only the return value would report every interesting fixture as clean.
const seclintFixture = (prefix) => {
  const nodePath = require('path');
  const { execFileSync } = require('child_process');
  const seclint = nodePath.join(__dirname, 'seclint.js');
  const dir = fs.mkdtempSync(nodePath.join(require('os').tmpdir(), prefix));
  const write = (name, src) => {
    const f = nodePath.join(dir, name);
    fs.writeFileSync(f, src);
    return f;
  };
  return {
    dir,
    /** Combined stdout+stderr of seclint over `src`. */
    run: (src) => {
      const f = write('fixture.js', src);
      try {
        return execFileSync('node', [seclint, f], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (e) {
        return String(e.stdout || '') + String(e.stderr || '');
      }
    },
    /** The CLI's exit status over `src`. A rule at `error` that still exits 0 is cosmetic, so the
     *  suites assert this separately from the finding count. */
    exitCode: (src) => {
      const f = write('ci-fixture.js', src);
      try {
        execFileSync('node', [seclint, f], { stdio: ['ignore', 'pipe', 'pipe'] });
        return 0;
      } catch (e) {
        return e.status || 1;
      }
    },
    /** `seclint --ci` over the real repo — every suite ends by asserting the codebase itself is
     *  clean under its rule, because tightening a linter only counts once the code passes it.
     *  `code` is `e.status` verbatim, NOT `e.status || 1`: a run killed by a signal reports
     *  undefined, which fails an `=== 0` assertion, and that is the behaviour to keep. */
    ci: () => {
      try {
        return { out: execFileSync('node', [seclint, '--ci'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), code: 0 };
      } catch (e) {
        return { out: String(e.stdout || '') + String(e.stderr || ''), code: e.status };
      }
    },
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
};

module.exports = { assert, done, cleanupAndFinish, serverSource, repoRoot, readRepoFile, seclintFixture };
