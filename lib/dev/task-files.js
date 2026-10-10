// lib/dev/task-files.js
// ============================================================
//  Read one runner output (SUMMARY.md, runner-tests.log, ...) from a finished task workspace, for
//  the mission engine's ship step and failure reasons.
//
//  The workspaces live in a tree the coding AGENT can write (/srv/hermes-tasks is group-writable so
//  the confined agent user can work there). A later task's agent can therefore rename an earlier
//  workspace and put a symlink in its place, or plant a link at a file name. Following either would
//  make this process — which runs as the runner user — read the token, the deploy key or an .env
//  into a mission, the dashboard and Telegram. So a file is read only if its fully resolved path is
//  EXACTLY <tasks root>/<workspace>/.hermes/<name>, it is opened without following a final link,
//  and the opened file is still that path (same inode) and a regular file.
// ============================================================

const fs = require('fs');
const path = require('path');

function createTaskFileReader({ tasksDir, names, maxBytes = 256 * 1024 }) {
  const allowed = new Set(names || []);
  const NOFOLLOW = fs.constants.O_NOFOLLOW || 0;
  return function readTaskFile(task, name) {
    const ws = String((task && task.workspace) || '');
    if (!/^[\w.-]+$/.test(ws) || ws === '.' || ws === '..' || !allowed.has(name)) return '';
    let fd = null;
    try {
      const root = fs.realpathSync(tasksDir);
      const expected = path.join(root, ws, '.hermes', name);
      if (fs.realpathSync(path.join(tasksDir, ws, '.hermes', name)) !== expected) return '';
      fd = fs.openSync(expected, fs.constants.O_RDONLY | NOFOLLOW);
      const st = fs.fstatSync(fd);
      const now = fs.lstatSync(expected);
      // Still the file the path names, and a plain file (not a FIFO, device or directory).
      if (!st.isFile() || st.ino !== now.ino || st.dev !== now.dev) return '';
      if (st.size <= maxBytes) return fs.readFileSync(fd, 'utf8');
      const buf = Buffer.alloc(maxBytes);
      fs.readSync(fd, buf, 0, maxBytes, st.size - maxBytes);   // the tail of a long log
      return buf.toString('utf8');
    } catch {
      return '';
    } finally {
      if (fd !== null) { try { fs.closeSync(fd); } catch {} }
    }
  };
}

module.exports = { createTaskFileReader };
