// lib/dev/task-files.js: the mission engine reads runner outputs from a tree the coding agent can
// write, so every way of pointing a read somewhere else must come back empty.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { assert, cleanupAndFinish, serverSource } = require('./test-util');
const { createTaskFileReader } = require('../lib/dev/task-files');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskfiles-'));
const tasks = path.join(dir, 'tasks');
const secret = path.join(dir, 'secret.env');
fs.writeFileSync(secret, 'TELEGRAM_BOT_TOKEN=do-not-read\n');
const mk = (ws, files) => {
  fs.mkdirSync(path.join(tasks, ws, '.hermes'), { recursive: true });
  for (const [n, c] of Object.entries(files)) fs.writeFileSync(path.join(tasks, ws, '.hermes', n), c);
};
const read = createTaskFileReader({ tasksDir: tasks, names: ['SUMMARY.md', 'runner-tests.log'], maxBytes: 16 });

mk('ws1', { 'SUMMARY.md': 'did it', 'runner-tests.log': 'x'.repeat(40) + 'TAIL-END', 'other.txt': 'no' });
assert(read({ workspace: 'ws1' }, 'SUMMARY.md') === 'did it', 'a regular file in a workspace is read');
assert(read({ workspace: 'ws1' }, 'runner-tests.log') === 'xxxxxxxxTAIL-END', 'a long file returns only its tail (maxBytes)');
assert(read({ workspace: 'ws1' }, 'other.txt') === '', 'a name outside the allowlist is refused');
assert(read({ workspace: '..' }, 'SUMMARY.md') === '' && read({ workspace: 'a/b' }, 'SUMMARY.md') === '' && read({}, 'SUMMARY.md') === '' && read(null, 'SUMMARY.md') === '',
  'a workspace name that could leave the tree (.., a slash) or is missing is refused');
assert(read({ workspace: 'nope' }, 'SUMMARY.md') === '', 'a missing workspace reads as empty, not an error');

// A FILE symlink needs a privilege on Windows; CI (Linux) and the box always run this case.
let canLinkFile = true;
try { fs.symlinkSync(secret, path.join(dir, 'probe-link')); } catch { canLinkFile = false; }
if (!canLinkFile) {
  console.log('skip: cannot create file symlinks here — the file-link case runs on Linux CI');
} else {
  mk('ws2', {});
  fs.symlinkSync(secret, path.join(tasks, 'ws2', '.hermes', 'SUMMARY.md'));
  assert(read({ workspace: 'ws2' }, 'SUMMARY.md') === '', 'a file that is a link to a secret is NOT followed');
}
// DIRECTORY links: 'junction' needs no privilege on Windows and is followed like a symlink; the type
// is ignored on Linux. So these cases run everywhere.
const dirLink = (target, p) => fs.symlinkSync(target, p, 'junction');
{

  // A later agent renames a finished workspace and puts a link to its own directory in its place.
  const evil = path.join(dir, 'evil');
  fs.mkdirSync(path.join(evil, '.hermes'), { recursive: true });
  fs.writeFileSync(path.join(evil, '.hermes', 'SUMMARY.md'), 'planted');
  dirLink(evil, path.join(tasks, 'ws3'));
  assert(read({ workspace: 'ws3' }, 'SUMMARY.md') === '', 'a workspace replaced by a link to another directory is NOT followed');

  mk('ws4', {});
  dirLink(path.join(evil, '.hermes'), path.join(tasks, 'ws4', '.hermes-link'));
  fs.rmSync(path.join(tasks, 'ws4', '.hermes'), { recursive: true });
  fs.renameSync(path.join(tasks, 'ws4', '.hermes-link'), path.join(tasks, 'ws4', '.hermes'));
  assert(read({ workspace: 'ws4' }, 'SUMMARY.md') === '', 'a .hermes replaced by a link is NOT followed');

  // The tasks root itself may legitimately be reached through a link (e.g. a mounted /srv).
  dirLink(tasks, path.join(dir, 'tasks-link'));
  const viaLink = createTaskFileReader({ tasksDir: path.join(dir, 'tasks-link'), names: ['SUMMARY.md'] });
  assert(viaLink({ workspace: 'ws1' }, 'SUMMARY.md') === 'did it', 'a tasks ROOT reached through a link still works');
}

const src = serverSource();
assert(/createTaskFileReader\(\{\s*tasksDir: TASKS_DIR,/.test(src), 'server.js reads task files through createTaskFileReader');
assert(!/fs\.statSync\(p\)[\s\S]{0,200}readFileSync\(p, 'utf8'\)/.test(src), 'the old link-following reader is gone from server.js');
cleanupAndFinish(dir);
