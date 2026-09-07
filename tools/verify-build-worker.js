'use strict';
// Explicit deployment acceptance test; never runs as part of the Windows unit suite.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert/strict');
const { isolatedBuild } = require('../lib/web-studio/isolated-build');
if (process.argv.includes('--if-configured')) {
  require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });
  if (process.env.AIOS_BUILD_BACKEND !== 'bubblewrap') {
    console.log('Non-Docker worker is not enabled; generated builds need the setup in deploy/hosting/BUILD-WORKER.md.');
    process.exit(0);
  }
}
if (process.platform !== 'linux' || !process.getuid || process.getuid() === 0) throw new Error('Run this verification as the unprivileged application user on Linux');
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'aios-worker-verify-'));
const canary = path.join(workspace, 'host-secret');
(async () => {
  try {
    fs.writeFileSync(canary, 'HOST_SECRET');
    fs.mkdirSync(path.join(workspace, 'src/pages'), { recursive: true });
    fs.writeFileSync(path.join(workspace, 'package.json'), '{"type":"module"}');
    fs.writeFileSync(path.join(workspace, 'src/pages/index.astro'), '<html><body>isolated-build-ok</body></html>');
    fs.writeFileSync(path.join(workspace, 'astro.config.mjs'), `
      import fs from 'node:fs'; import net from 'node:net'; import assert from 'node:assert/strict';
      import { lookup } from 'node:dns/promises';
      assert.equal((await lookup('localhost', {family:4})).address, '127.0.0.1');
      assert.equal(fs.existsSync(${JSON.stringify(canary)}), false);
      assert.equal(fs.existsSync('/home/aios'), false);
      assert.equal(process.env.AIOS_VERIFY_SECRET, undefined);
      await new Promise((resolve,reject) => {
        const socket = net.connect({host:'1.1.1.1',port:443});
        socket.once('connect',()=>{socket.destroy();reject(new Error('Network escaped sandbox'));});
        socket.once('error',resolve); socket.setTimeout(2000,()=>{socket.destroy();reject(new Error('Network isolation inconclusive'));});
      });
      export default {};`);
    process.env.AIOS_BUILD_BACKEND = 'bubblewrap';
    process.env.AIOS_VERIFY_SECRET = 'must-not-reach-build';
    await isolatedBuild(workspace, 60000);
    assert.match(fs.readFileSync(path.join(workspace, 'dist/index.html'), 'utf8'), /isolated-build-ok/);
    console.log('PASS: generated build works; host files, application secrets and outbound network are inaccessible.');
  } finally {
    if (path.dirname(workspace) !== os.tmpdir() || !path.basename(workspace).startsWith('aios-worker-verify-')) throw new Error('Unsafe cleanup path');
    fs.rmSync(workspace, { recursive: true, force: true });
  }
})().catch(error => { console.error(error.buildLog || error.message); process.exitCode = 1; });
