# Runbook — Upgrade Node.js 20 → 24 on the VPS

**Why:** Node 20 (Iron) reached end-of-life on **2026-04-30** — no more security patches.
Node 24 (Active LTS) carries security support through **~April 2028** — the longest runway,
so this jump skips a cycle (Node 22 would only reach 2027-04-30).

**Risk:** This crosses a major version, so the **native-addon ABI changes**. Anything with
compiled native bits — n8n (`sqlite3`), the voice `agent-worker` (LiveKit/silero) — must be
**rebuilt** against Node 24, or those processes will crash-loop on `NODE_MODULE_VERSION`
mismatch. The main `ai-os` server is mostly pure-JS but is rebuilt here too for safety.

**Do this in a maintenance window you can babysit — not fire-and-forget.** Budget ~20 min.

Run everything as root on the VPS unless noted.

---

## 0. Snapshot first (non-negotiable)

Take a **manual Hostinger snapshot** from the panel before touching anything. A runtime
upgrade that breaks native deps is the exact case snapshots exist for. Wait for it to finish.

Also confirm starting state so you can compare after:

```bash
node --version            # expect v20.x
sudo -u aios pm2 status   # note all three online; note restart counters
```

---

## 1. Install Node 24 (NodeSource, Debian)

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs
node --version            # expect v24.x now
which node                # confirm still /usr/bin/node (PM2 systemd unit relies on this path)
```

If `which node` changed paths, stop and tell me — the PM2 startup unit points at the old path.

---

## 2. Update PM2 itself, THEN point its daemon at the new Node

**Critical — learned the hard way on the 20→24 run.** Update the global PM2 *before*
`pm2 update`. A stale PM2 daemon is unstable across a Node *major* bump: it dropped all three
processes (a real outage — empty `pm2 list`, ports 3000/5678 not listening) until PM2 was updated.

```bash
sudo npm install -g pm2@latest    # DO THIS FIRST — skipping it is what caused the outage
sudo -u aios pm2 update            # respawns the PM2 daemon under the new Node, resurrecting processes
```

If `pm2 update` still leaves an empty process list, recover from the saved dump:

```bash
sudo -u aios pm2 kill && sudo -u aios pm2 resurrect
```

---

## 3. Rebuild native modules against the new ABI

> **Tip (used on the 20→24 run):** `node`/`npm` are already the new version after step 1, so you
> can run these rebuilds *before* step 2's `pm2 update` — the processes then respawn with
> already-correct native modules and skip the brief crash-loop window.

**Main app** (`/opt/ai-os`):

```bash
cd /opt/ai-os
sudo -u aios npm rebuild        # recompiles any native deps; pure-JS deps are no-ops
```

**Voice agent-worker** (has LiveKit/silero native bits — full reinstall is safest):

```bash
cd /opt/ai-os/agent-worker
sudo -u aios rm -rf node_modules
sudo -u aios npm install
```

**n8n** (global, bundles `sqlite3`):

```bash
sudo npm install -g n8n         # reinstall rebuilds sqlite3 for Node 24
n8n --version                   # confirm it still resolves
```

---

## 4. Restart everything and verify

```bash
sudo -u aios pm2 restart all --update-env
sleep 10
sudo -u aios pm2 status
```

**Pass criteria** — all three `online`, uptime climbing, and **restart counters NOT ticking
up** (a native-ABI mismatch shows as a fast-climbing ↺). Then:

```bash
# Main server healthy under Node 24:
curl -s http://localhost:3000/api/health; echo
# n8n responding:
curl -sI http://localhost:5678 | head -1
# agent-worker stable (watch for ~15s — restart count must stay put):
sudo -u aios pm2 status | grep agent-worker
```

Want: health `status:ok`, n8n `HTTP/1.1 200`, agent-worker steady at its current ↺.

If `agent-worker` or `n8n` crash-loops here, it's a native module that didn't rebuild —
repeat its step 3 block (rm node_modules + reinstall), or roll back (below).

---

## 5. Persist the PM2 state

```bash
sudo -u aios pm2 save
```

---

## Rollback (if anything won't stabilize)

Fastest: **restore the Hostinger snapshot** from step 0 — it reverts Node and all node_modules
together, cleanly.

Manual alternative (reinstall Node 20, then rebuild):

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
sudo -u aios pm2 update
cd /opt/ai-os && sudo -u aios npm rebuild
cd /opt/ai-os/agent-worker && sudo -u aios rm -rf node_modules && sudo -u aios npm install
sudo npm install -g n8n
sudo -u aios pm2 restart all --update-env && sudo -u aios pm2 save
```

---

## Notes

- The repo's `deploy/install-vps.sh` now pins `NODE_VERSION="24"`, so fresh installs land on
  the supported runtime — this runbook is only for an existing box.
- After a successful upgrade, the next nightly backup (3:30am) captures the working state.
- This box is now on Node 24 (Active LTS, through ~2028). The next major (24 → 26+) follows the
  same steps — bump `NODE_VERSION` / `setup_NN.x`, and keep the `pm2@latest`-before-`pm2 update`
  rule in step 2.
