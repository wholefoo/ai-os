'use strict';
const { DatabaseSync } = require('node:sqlite');
const { createHash } = require('crypto');

// Durable delivery is separate from the payment receipt: retrying email must never re-grant a plan.
module.exports = function createInviteQueue({ filename, findUser, persistUsers, newToken, publicUrl, emailConfig, send, report }) {
  const db = new DatabaseSync(filename);
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS invites (id TEXT PRIMARY KEY, email TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, due INTEGER NOT NULL DEFAULT 0);`);
  let busy = false;
  return {
    enqueue(id, email) {
      db.prepare('INSERT OR IGNORE INTO invites(id,email) VALUES (?,?)').run(id, email);
    },
    async drain(now = Date.now()) {
      if (busy) return;
      busy = true;
      try {
        const jobs = db.prepare("SELECT * FROM invites WHERE status != 'sent' AND due <= ? ORDER BY due LIMIT 20").all(now);
        for (const job of jobs) {
          const claim = db.prepare("UPDATE invites SET status='sending', due=?, attempts=attempts+1 WHERE id=? AND status!='sent' AND due<=?").run(Date.now() + 120000, job.id, now);
          if (!claim.changes) continue;
          try {
            const user = findUser(job.email);
            if (!user || user.disabled || user.plan === 'free' || user.passwordHash) {
              db.prepare("UPDATE invites SET status='sent' WHERE id=?").run(job.id);
              continue;
            }
            if (!user.setupToken || !Number.isFinite(Date.parse(user.setupToken.expiresAt)) || Date.parse(user.setupToken.expiresAt) < Date.now() + 86400000) {
              const previous = user.setupToken;
              user.setupToken = { token: newToken(), expiresAt: new Date(Date.now() + 7 * 86400000).toISOString() };
              if (!persistUsers()) { user.setupToken = previous; throw new Error('Could not save setup token'); }
            }
            const base = new URL(publicUrl());
            if (base.protocol !== 'https:' || base.username || base.password) throw new Error('Configure AIOS_PUBLIC_URL as an HTTPS origin');
            const link = `${base.origin}/set-password?token=${encodeURIComponent(user.setupToken.token)}`;
            const result = await send({ cfg: emailConfig(), to: user.email, subject: 'Set up your AI OS account',
              text: `Your website subscription is ready. Set your password using this single-use link:\n\n${link}\n\nThis link expires in seven days. If you did not request this account, ignore this email.`,
              transactional: true, idempotencyKey: createHash('sha256').update(job.id + user.setupToken.token).digest('hex') });
            if (!result.ok) throw new Error('Account invitation delivery failed');
            db.prepare("UPDATE invites SET status='sent' WHERE id=?").run(job.id);
          } catch (error) {
            const delay = Math.min(86400000, 60000 * 2 ** Math.min(job.attempts, 10));
            db.prepare("UPDATE invites SET status='pending', due=? WHERE id=?").run(Date.now() + delay, job.id);
            // Do not log provider error bodies: they may echo the password link.
            report(`Account invitation requires retry for receipt ${job.id}: ${error.message}`);
          }
        }
      } finally { busy = false; }
    },
    close() { db.close(); },
  };
};
