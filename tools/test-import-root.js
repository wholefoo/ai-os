// tools/test-import-root.js
// ============================================================
//  Which folder an import publishes — and when it must REFUSE instead.
//
//  THE INCIDENT (2026-09-10). An operator pushed a Replit (Vite + React) site to GitHub and
//  imported it. The import "worked", the site published, and the page was BLANK. The repo root
//  held Vite's SOURCE index.html, whose only content is <script type="module" src="/src/main.tsx">.
//  findStaticRoot checks the repo root first, so it took that shell; .tsx is not a static asset,
//  so main.tsx was dropped; the page loaded a file that did not exist. Worse, the helpful "build it
//  first" refusal only fired when there was NO index.html — a Vite repo always has one — and even
//  a committed dist/ would have LOST to the root shell, because '' is the first candidate.
//
//  Pinned here, both directions: shells are skipped when built output exists, refused when it does
//  not, and ordinary static sites — including ones with a plain /src/app.js — are NOT refused.
// ============================================================

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const AdmZip = require('adm-zip');
const { findStaticRoot, importToWorkspace, isUnbuiltAppShell } = require('../lib/web-studio/import');
const { staticBuild } = require('../lib/web-studio/build');

let pass = 0;
const tmps = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'improot-')); tmps.push(d); return d; };
const put = (root, rel, body) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); };
const ok = async (label, fn) => { await fn(); console.log(`ok  : ${label}`); pass++; };

const VITE_SHELL = '<!doctype html><html><head><title>My App</title></head><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>';
const VITE_BUILT = '<!doctype html><html><head><title>My App</title><script type="module" crossorigin src="/assets/index-a1b2c3.js"></script></head><body><div id="root"></div></body></html>';
const viteRepo = (root) => {
  put(root, 'index.html', VITE_SHELL);
  put(root, 'src/main.tsx', 'import React from "react";');
  put(root, 'package.json', '{"name":"app","scripts":{"build":"vite build"}}');
  put(root, 'vite.config.ts', 'export default {}');
};

(async () => {
  try {
    // --- the detector -----------------------------------------------------------------------------------
    await ok('recognises the Vite source shell that caused the blank page', () => {
      const d = tmp(); viteRepo(d);
      assert.strictEqual(isUnbuiltAppShell(d), true);
    });
    await ok('does NOT flag Vite\'s BUILT index.html (hashed /assets/*.js)', () => {
      const d = tmp(); put(d, 'index.html', VITE_BUILT);
      assert.strictEqual(isUnbuiltAppShell(d), false);
    });
    await ok('flags JSX / Vue / Svelte source entries too, and a Create React App template', () => {
      for (const src of ['/src/main.jsx', 'src/main.ts', '/src/main.vue?x=1', '/src/App.svelte']) {
        const d = tmp(); put(d, 'index.html', `<script type="module" src="${src}"></script>`);
        assert.strictEqual(isUnbuiltAppShell(d), true, src);
      }
      const cra = tmp(); put(cra, 'index.html', '<link rel="icon" href="%PUBLIC_URL%/favicon.ico"><div id="root"></div>');
      assert.strictEqual(isUnbuiltAppShell(cra), true, 'CRA public/index.html template');
    });
    await ok('does NOT flag a hand-written static site that happens to use /src/app.js', () => {
      // No package.json, no framework config, plain .js — this is a real site, not a source tree.
      const d = tmp(); put(d, 'index.html', '<h1>Hello</h1><script src="/src/app.js"></script>');
      put(d, 'src/app.js', 'console.log(1)');
      assert.strictEqual(isUnbuiltAppShell(d), false);
    });
    await ok('DOES flag a /src/*.js entry when it sits beside package.json + a framework config', () => {
      const d = tmp(); put(d, 'index.html', '<script type="module" src="/src/main.js"></script>');
      put(d, 'package.json', '{}'); put(d, 'vite.config.js', 'export default {}');
      assert.strictEqual(isUnbuiltAppShell(d), true);
    });

    // --- root selection -------------------------------------------------------------------------------
    await ok('a committed dist/ now WINS over the root source shell (it used to lose)', () => {
      const d = tmp(); viteRepo(d); put(d, 'dist/index.html', VITE_BUILT);
      assert.strictEqual(findStaticRoot(d), path.join(d, 'dist'));
    });
    await ok('build/ wins the same way (Create React App layout)', () => {
      const d = tmp(); put(d, 'public/index.html', '<div id="root"></div><link href="%PUBLIC_URL%/x.css">');
      put(d, 'package.json', '{}'); put(d, 'build/index.html', '<h1>built</h1>');
      assert.strictEqual(findStaticRoot(d), path.join(d, 'build'));
    });
    await ok('Replit full-stack output at dist/public is found', () => {
      const d = tmp(); viteRepo(d); put(d, 'dist/public/index.html', VITE_BUILT);
      assert.strictEqual(findStaticRoot(d), path.join(d, 'dist', 'public'));
    });
    await ok('a single wrapper folder (a downloaded zip) still resolves to its built dist/', () => {
      const d = tmp(); const w = path.join(d, 'my-app-main'); viteRepo(w); put(w, 'dist/index.html', VITE_BUILT);
      assert.strictEqual(findStaticRoot(d), path.join(w, 'dist'));
    });
    await ok('an ordinary static site at the root is still chosen (no regression)', () => {
      const d = tmp(); put(d, 'index.html', '<h1>plain</h1>'); put(d, 'dist/index.html', '<h1>stale copy</h1>');
      assert.strictEqual(findStaticRoot(d), d, 'a real root site must beat an unrelated dist/');
    });

    // --- end to end through the real import + static build ---------------------------------------------
    await ok('source-only Vite repo: import REFUSES — no index.html published, reason says to build', async () => {
      const z = new AdmZip();
      z.addFile('index.html', Buffer.from(VITE_SHELL));
      z.addFile('src/main.tsx', Buffer.from('x'));
      z.addFile('package.json', Buffer.from('{"scripts":{"build":"vite build"}}'));
      const ws = tmp();
      const r = await importToWorkspace({ workspaceDir: ws, zipBuffer: z.toBuffer() });
      assert.strictEqual(r.ok, false, 'must not report success');
      assert.strictEqual(r.hasIndex, false, 'the shell index.html must NOT be ingested');
      assert.ok(/build/i.test(r.reason || '') && /main\.tsx/.test(r.reason || ''), `reason must name the entry and say to build: ${r.reason}`);
      assert.ok(!fs.existsSync(path.join(ws, 'src', 'index.html')));
      // What the server does next: staticBuild must FAIL, so the site becomes build_failed with this
      // reason — never "ready" with a blank page.
      assert.strictEqual(staticBuild(ws).ok, false);
    });
    await ok('same repo WITH a committed dist/: imports the built site, assets included', async () => {
      const z = new AdmZip();
      z.addFile('index.html', Buffer.from(VITE_SHELL));
      z.addFile('package.json', Buffer.from('{}'));
      z.addFile('dist/index.html', Buffer.from(VITE_BUILT));
      z.addFile('dist/assets/index-a1b2c3.js', Buffer.from('console.log("app")'));
      z.addFile('dist/favicon.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      const ws = tmp();
      const r = await importToWorkspace({ workspaceDir: ws, zipBuffer: z.toBuffer() });
      assert.strictEqual(r.ok, true); assert.strictEqual(r.hasIndex, true);
      assert.strictEqual(fs.readFileSync(path.join(ws, 'src', 'index.html'), 'utf8'), VITE_BUILT, 'the BUILT page, not the shell');
      assert.ok(fs.existsSync(path.join(ws, 'src', 'assets', 'index-a1b2c3.js')));
      assert.ok(fs.existsSync(path.join(ws, 'src', 'favicon.png')), 'the favicon that 404ed in the incident is present');
      assert.strictEqual(staticBuild(ws).ok, true);
    });

    console.log(`\nALL TESTS PASSED\n${pass} assertions`);
  } finally {
    for (const d of tmps) { if (path.dirname(d) === os.tmpdir()) fs.rmSync(d, { recursive: true, force: true }); }
  }
})().catch((e) => { console.error(e); process.exitCode = 1; });
