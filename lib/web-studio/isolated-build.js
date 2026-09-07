'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomUUID } = require('crypto');
const { execFile } = require('child_process');

const LIMIT = 64 * 1024 * 1024;
function copyTree(source, destination, budget = { bytes: 0, files: 0 }) {
  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw new Error('Build tree contains a link or special file');
  if (++budget.files > 10000 || (budget.bytes += stat.isFile() ? stat.size : 0) > LIMIT) throw new Error('Build tree exceeds size limit');
  if (stat.isDirectory()) {
    fs.mkdirSync(destination, { recursive: true });
    for (const name of fs.readdirSync(source)) copyTree(path.join(source, name), path.join(destination, name), budget);
  } else fs.copyFileSync(source, destination);
}
function command(args, timeout, executable = 'docker') {
  return new Promise((resolve, reject) => {
    execFile(executable, args, { timeout, windowsHide: true, encoding: 'buffer', maxBuffer: LIMIT,
      env: { ...process.env, ...(executable !== 'docker' && process.getuid ? { XDG_RUNTIME_DIR: `/run/user/${process.getuid()}`, DBUS_SESSION_BUS_ADDRESS: `unix:path=/run/user/${process.getuid()}/bus` } : {}) },
    }, (error, stdout, stderr) => {
      if (error) { error.buildLog = `${stdout || ''}\n${stderr || ''}`; reject(error); }
      else resolve({ stdout, log: String(stderr || '') });
    });
  });
}
function extractArtifacts(archive, destination) {
  fs.mkdirSync(destination, { recursive: true });
  let count = 0;
  for (let offset = 0; offset + 512 <= archive.length;) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every(b => b === 0)) break;
    const field = (a, b) => header.subarray(a, b).toString().split('\0')[0];
    const name = [field(345, 500), field(0, 100)].filter(Boolean).join('/').replace(/^\.\//, '');
    const sizeText = field(124, 136).trim();
    const size = parseInt(sizeText || '0', 8), type = field(156, 157);
    if (!/^[0-7]*$/.test(sizeText) || !Number.isSafeInteger(size) || size < 0 || offset + 512 + size > archive.length) throw new Error('Invalid artifact archive');
    if (!['', '0', '5'].includes(type) || name.includes('\\') || name.includes(':') || path.posix.isAbsolute(name) || name.split('/').includes('..') || ++count > 10000) throw new Error('Unsafe build artifact');
    const target = path.resolve(destination, name);
    if (target !== destination && !target.startsWith(destination + path.sep)) throw new Error('Artifact escapes output');
    if (type === '5') fs.mkdirSync(target, { recursive: true });
    else { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, archive.subarray(offset + 512, offset + 512 + size)); }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
}
async function isolatedBuild(workspace, timeoutMs) {
  const image = process.env.AIOS_BUILD_IMAGE;
  const native = process.env.AIOS_BUILD_BACKEND === 'bubblewrap';
  if (!native && !image) throw new Error('Isolated build worker is not configured. Install the non-Docker worker described in deploy/hosting/BUILD-WORKER.md.');
  if (native && process.platform !== 'linux') throw new Error('The bubblewrap build worker requires Linux');
  timeoutMs = Math.min(Math.max(Number(timeoutMs) || 180000, 1000), 300000);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'aios-build-'));
  const input = path.join(temp, 'input');
  const name = `aios-build-${randomUUID()}`;
  fs.mkdirSync(input);
  try {
    const budget = { bytes: 0, files: 0 };
    for (const entry of ['package.json', 'astro.config.mjs', 'tailwind.config.mjs', 'src', 'public']) {
      const source = path.join(workspace, entry);
      if (fs.existsSync(source)) copyTree(source, path.join(input, entry), budget);
    }
    // Only staged source is visible. No host credentials, socket, parent directory, or network.
    const buildScript = 'set -eu; cp -R /input /work/site; cp -R /opt/build/node_modules /work/site/node_modules; cd /work/site; ./node_modules/.bin/astro build >&2; tar --format=ustar -C dist -cf - .';
    const result = native ? await command([
      '--user', '--quiet', '--pipe', '--wait', '--collect', `--unit=${name}`,
      '--property=MemoryMax=768M', '--property=MemorySwapMax=0', '--property=TasksMax=128',
      '--property=CPUQuota=100%', `--property=RuntimeMaxSec=${Math.ceil(timeoutMs / 1000)}`,
      '--property=KillMode=control-group', '--property=TimeoutStopSec=2', '--property=NoNewPrivileges=yes',
      '/usr/bin/bwrap', '--unshare-all', '--die-with-parent', '--new-session', '--cap-drop', 'ALL', '--clearenv',
      '--ro-bind', '/usr', '/usr', '--ro-bind', '/bin', '/bin', '--ro-bind', '/lib', '/lib',
      ...(fs.existsSync('/lib64') ? ['--ro-bind', '/lib64', '/lib64'] : []),
      '--ro-bind', '/opt/aios-build-runtime', '/opt/build', '--ro-bind', input, '/input',
      '--tmpfs', '/work', '--tmpfs', '/tmp', '--proc', '/proc', '--dev', '/dev', '--chdir', '/work',
      '--setenv', 'PATH', '/usr/bin:/bin', '--setenv', 'HOME', '/tmp',
      '--setenv', 'NODE_OPTIONS', '--max-old-space-size=512', '--setenv', 'CI', '1',
      '--setenv', 'ASTRO_TELEMETRY_DISABLED', '1', '/bin/sh', '-c', buildScript,
    ], timeoutMs + 5000, '/usr/bin/systemd-run') : await command(['run', '--rm', '--pull=never', '--log-driver=none', '--name', name,
      '--network=none', '--read-only', '--user=1000:1000', '--cap-drop=ALL',
      '--security-opt=no-new-privileges', '--memory=768m', '--memory-swap=768m', '--cpus=1', '--pids-limit=128',
      '--tmpfs=/work:rw,exec,size=512m,mode=1777', '--tmpfs=/tmp:rw,noexec,size=64m,mode=1777',
      '--mount', `type=bind,source=${input},target=/input,readonly`,
      '--env=NODE_OPTIONS=--max-old-space-size=512', '--env=CI=1', '--env=ASTRO_TELEMETRY_DISABLED=1',
      '--entrypoint=/bin/sh', image, '-c',
      buildScript], timeoutMs);
    // The container has exited. Reject escaping links and oversized artifacts before serving any bytes.
    const verified = path.join(temp, 'verified');
    extractArtifacts(result.stdout, verified);
    if (!fs.existsSync(path.join(verified, 'index.html'))) throw new Error('Build produced no index.html');
    const dist = path.join(workspace, 'dist');
    if (fs.existsSync(dist) && fs.lstatSync(dist).isSymbolicLink()) throw new Error('Invalid output directory');
    fs.rmSync(dist, { recursive: true, force: true });
    fs.cpSync(verified, dist, { recursive: true });
    return result.log;
  } finally {
    // Killing the Docker client alone does not stop its container.
    if (native) await command(['--user', 'stop', `${name}.service`], 10000, '/usr/bin/systemctl').catch(() => {});
    else await command(['rm', '-f', name], 10000).catch(() => {});
    if (path.dirname(temp) !== os.tmpdir() || !path.basename(temp).startsWith('aios-build-')) throw new Error('Invalid build staging directory');
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
module.exports = { isolatedBuild, copyTree, extractArtifacts };
