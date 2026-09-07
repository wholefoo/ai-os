'use strict';
const fs = require('fs');
const { execFileSync } = require('child_process');
const enableMicrophone = require('../lib/deploy/nginx-policy');
const filename = '/etc/nginx/sites-available/ai-os';
const original = fs.readFileSync(filename, 'utf8');
const updated = enableMicrophone(original);
if (original === updated) { console.log('Microphone policy already allows this origin.'); process.exit(0); }
if (!process.argv.includes('--apply')) { console.log('Microphone policy needs updating. Run with --apply as root to validate and reload.'); process.exit(1); }
const stat = fs.lstatSync(filename);
if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Expected a regular nginx configuration file');
const backup = `${filename}.before-microphone-${Date.now()}`;
fs.copyFileSync(filename, backup, fs.constants.COPYFILE_EXCL);
fs.chmodSync(backup, stat.mode);
fs.chownSync(backup, stat.uid, stat.gid);
try {
  fs.writeFileSync(filename, updated);
  execFileSync('/usr/sbin/nginx', ['-t'], { stdio: 'inherit' });
  execFileSync('/usr/bin/systemctl', ['reload', 'nginx'], { stdio: 'inherit' });
  console.log(`Microphone policy updated; original saved at ${backup}`);
} catch (error) {
  fs.copyFileSync(backup, filename);
  execFileSync('/usr/sbin/nginx', ['-t'], { stdio: 'inherit' });
  execFileSync('/usr/bin/systemctl', ['reload', 'nginx'], { stdio: 'inherit' });
  throw error;
}
