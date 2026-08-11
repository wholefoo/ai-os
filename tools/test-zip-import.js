// tools/test-zip-import.js
// ============================================================
//  lib/web-studio/import.js — the ZIP import gates. Untested until 2026-08-11.
//
//  WHY THIS EXISTS NOW. DEP-04 required clearing the `npm audit` HIGHs so the CI gate could stop
//  being `continue-on-error`. Three cleared with a lockfile bump; the fourth, adm-zip, needs a
//  SEMVER-MAJOR upgrade — and this file is the one place where an adm-zip API change would be
//  catastrophic and SILENT.
//
//  The zip-bomb gate reads `entry.header.size` and `entry.header.compressedSize` BEFORE
//  decompressing anything, and both are coalesced with `|| 0`. If a major version renamed or
//  restructured `header`, those reads become undefined, fall through to 0, and every bomb check
//  passes trivially. Nothing throws. The import still "works". The guard is simply gone.
//
//  The audit called these defences "independently verified" — an agent READ them. Reading cannot
//  detect that a future dependency will hollow them out, which is exactly what these assertions do.
//
//  Every fixture is built with adm-zip itself, so the archives are whatever the INSTALLED version
//  produces. That is deliberate: it means these tests exercise the real pairing of writer and
//  reader, not a hand-rolled fixture frozen at one version.
// ============================================================

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const AdmZip = require('adm-zip');
const { extractZip, sanitizeRelPath, MAX_TOTAL_BYTES, MAX_FILES } = require('../lib/web-studio/import');

let pass = 0;
const ok = (label, fn) => { fn(); console.log(`ok  : ${label}`); pass++; };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'zipimp-'));

// --- 1. A normal archive extracts. -------------------------------------------------------------
ok('extracts an ordinary archive and reports what it wrote', () => {
  const z = new AdmZip();
  z.addFile('index.html', Buffer.from('<h1>hi</h1>'));
  z.addFile('css/site.css', Buffer.from('body{color:red}'));
  const d = tmp();
  const r = extractZip(z.toBuffer(), d);
  assert.deepStrictEqual(r.written.sort(), ['css/site.css', 'index.html']);
  assert.strictEqual(fs.readFileSync(path.join(d, 'index.html'), 'utf8'), '<h1>hi</h1>');
  assert.ok(r.bytes > 0 && r.count === 2);
  fs.rmSync(d, { recursive: true, force: true });
});

// --- 2. ZIP-SLIP: traversal entries never land outside the destination. ------------------------
//
// ⚠️ `z.addFile('../evil.html', …)` DOES NOT PRODUCE A TRAVERSAL ENTRY. adm-zip normalises the
// leading `../` away as it writes, so the archive contains a harmless `evil.html` and a test built
// that way passes while exercising nothing — it asserts that a safe archive is safe. I wrote that
// version first and it "failed" against correct code, which is what exposed the fixture bug.
// The entry name must therefore be set AFTER the entry exists, which adm-zip preserves verbatim
// through toBuffer(). Verify any change here by printing the entryNames actually in the archive.
ok('refuses traversal entries (zip-slip) and writes nothing outside destDir', () => {
  const z = new AdmZip();
  z.addFile('placeholder1.html', Buffer.from('nope'));
  z.addFile('placeholder2.html', Buffer.from('nope'));
  z.addFile('ok.html', Buffer.from('yes'));
  const es = z.getEntries();
  es[0].entryName = '../escaped.html';
  es[1].entryName = '../../nested/escaped2.html';
  const names = new AdmZip(z.toBuffer()).getEntries().map(e => e.entryName);
  assert.ok(names.includes('../escaped.html'),
    `fixture is not malicious — archive contains ${JSON.stringify(names)}`);
  const d = tmp();
  const parent = path.dirname(d);
  const before = new Set(fs.readdirSync(parent));
  const r = extractZip(z.toBuffer(), d);
  assert.deepStrictEqual(r.written, ['ok.html'], 'only the safe entry may be written');
  assert.strictEqual(r.warnings.length, 2, 'both traversal entries must be REPORTED, not dropped silently');
  const after = new Set(fs.readdirSync(parent));
  for (const f of after) assert.ok(before.has(f) || path.join(parent, f) === d, `leaked outside destDir: ${f}`);
  fs.rmSync(d, { recursive: true, force: true });
});

// --- 3. THE HEADER-SHAPE CANARY. ---------------------------------------------------------------
// This is the assertion that an adm-zip major bump would break. It does NOT go through extractZip:
// it pins the two fields the gate depends on, so a failure names the cause instead of showing up as
// a mysteriously-permissive bomb check.
ok('adm-zip entries still expose header.size and header.compressedSize as numbers', () => {
  const z = new AdmZip();
  z.addFile('a.html', Buffer.alloc(4096, 0x41));
  const entries = new AdmZip(z.toBuffer()).getEntries();
  assert.strictEqual(entries.length, 1);
  const h = entries[0].header;
  assert.ok(h, 'entry.header must exist — the zip-bomb gate reads it before decompressing');
  assert.strictEqual(typeof h.size, 'number', 'header.size must be a number, not undefined');
  assert.strictEqual(h.size, 4096, 'header.size must be the UNCOMPRESSED size');
  assert.strictEqual(typeof h.compressedSize, 'number', 'header.compressedSize must be a number');
  assert.strictEqual(typeof entries[0].entryName, 'string');
  assert.strictEqual(typeof entries[0].isDirectory, 'boolean');
});

// --- 4. ZIP BOMB by declared total, rejected BEFORE decompression. -----------------------------
// Highly-compressible zeros: a few hundred KB on disk declaring >30MB uncompressed. If header.size
// ever reads undefined, declaredTotal becomes 0, this throw never happens, and this test fails.
ok('rejects an archive DECLARING more than the 30MB cap, before inflating it', () => {
  const z = new AdmZip();
  const chunk = Buffer.alloc(8 * 1024 * 1024, 0);
  for (let i = 0; i < 5; i++) z.addFile(`big${i}.html`, chunk);   // 40MB declared > 30MB cap
  const buf = z.toBuffer();
  assert.ok(buf.length < MAX_TOTAL_BYTES, 'fixture must be SMALL on disk — that is what makes it a bomb');
  const d = tmp();
  assert.throws(() => extractZip(buf, d), /30 MB|size cap|uncompressed cap/i,
    'a 40MB-declared archive must be refused');
  fs.rmSync(d, { recursive: true, force: true });
});

// --- 5. Compression-ratio guard. ---------------------------------------------------------------
ok('skips an entry whose declared/compressed ratio looks like a bomb', () => {
  const z = new AdmZip();
  z.addFile('normal.html', Buffer.from('<p>ordinary</p>'));
  z.addFile('bomb.html', Buffer.alloc(4 * 1024 * 1024, 0));   // ratio far above 200, under both caps
  const d = tmp();
  const r = extractZip(z.toBuffer(), d);
  assert.ok(r.warnings.some(w => /suspicious ratio/.test(w)), `expected a ratio warning, got ${JSON.stringify(r.warnings)}`);
  assert.ok(!r.written.includes('bomb.html'), 'the suspicious entry must not be written');
  assert.ok(r.written.includes('normal.html'), 'one bad entry must not kill the whole import');
  fs.rmSync(d, { recursive: true, force: true });
});

// --- 6. Extension allowlist — an executable payload is not a static asset. ---------------------
ok('drops entries outside the static-asset allowlist', () => {
  const z = new AdmZip();
  z.addFile('index.html', Buffer.from('ok'));
  z.addFile('payload.sh', Buffer.from('rm -rf /'));
  z.addFile('.env', Buffer.from('SECRET=1'));
  const d = tmp();
  const r = extractZip(z.toBuffer(), d);
  assert.deepStrictEqual(r.written, ['index.html']);
  assert.ok(!fs.existsSync(path.join(d, 'payload.sh')));
  fs.rmSync(d, { recursive: true, force: true });
});

// --- 7. sanitizeRelPath: the category, not a list of names. -----------------------------------
ok('sanitizeRelPath rejects traversal, absolute, dotfile and control-char names', () => {
  for (const bad of ['../x.html', 'a/../../x.html', '/etc/x.html', 'C:/x.html', '.git/config.html',
                     'node_modules/x.html', '.hidden.html', 'x.html\u0000.png', '', 'dir/']) {
    assert.strictEqual(sanitizeRelPath(bad), null, `must reject: ${JSON.stringify(bad)}`);
  }
  assert.strictEqual(sanitizeRelPath('a/b/c.html'), 'a/b/c.html');
  assert.strictEqual(sanitizeRelPath('a\\b\\c.css'), 'a/b/c.css', 'windows separators normalise');
});

// --- 8. The file-count cap is a HARD stop, not a warning. --------------------------------------
ok('MAX_FILES is a hard stop that throws rather than silently truncating', () => {
  assert.strictEqual(typeof MAX_FILES, 'number');
  const z = new AdmZip();
  for (let i = 0; i < MAX_FILES + 5; i++) z.addFile(`f${i}.html`, Buffer.from('x'));
  const d = tmp();
  assert.throws(() => extractZip(z.toBuffer(), d), /file-count cap/i,
    'exceeding the count cap must throw — a silent truncation is the defect class this repo keeps hitting');
  fs.rmSync(d, { recursive: true, force: true });
});

console.log(`\nALL TESTS PASSED\n${pass} assertions`);
