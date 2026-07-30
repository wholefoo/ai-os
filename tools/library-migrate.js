#!/usr/bin/env node
// tools/library-migrate.js
// ============================================================
//  Backfills catalog records for the three pre-existing physical stores — IN PLACE. Nothing here
//  moves a single byte; it only mints metadata for files that already exist (library-department-
//  design.md §6 Phase 0 item 3). Run before the catalog read path exists at all, and safe to run
//  again after it does — repeatedly, forever.
//
//  Why this is a standalone script and not "just call server.js's loadState": server.js boots an
//  Express app, opens a port, starts cron jobs and a websocket server as a side effect of being
//  required. A migration CLI must not do any of that, so this file reimplements the exact same
//  <STATE_DIR>/<key>.json convention (readStateFile/writeStateFile below) — same directory, same
//  atomic tmp-then-rename write — rather than requiring server.js for it.
//
//  IDEMPOTENCE is the whole point of a migration tool that gets re-run. It is achieved mechanically,
//  not by care: every file on disk is turned into a candidate record with a real contentHash, the
//  EXISTING catalog is loaded and placed FIRST in the array handed to catalog.dedupeByHash(), and
//  first-occurrence-wins means an already-cataloged file's stable id survives every re-run while the
//  freshly-generated duplicate (same store+path+contentHash) is the one that gets dropped. Get the
//  ordering backwards and every run would reassign every id — silently, since the counts would still
//  look right.
//
//  Store-by-store defaults (§6 P0 item 3, plus judgment calls flagged where the design doc is silent
//  — see the P0 handoff report for the fuller reasoning):
//    vault      — source 'agent-output' for raw/outputs, 'company-doc' for wiki (as specified).
//                 sensitivity 'internal', readers ['all-agents'], retention {policy:'keep'} — all
//                 exactly as specified. This is pre-existing "company knowledge" content with no
//                 per-org owner, so `owner` is left blank.
//    org-docs   — store 'org-docs' (as specified). Source/sensitivity/readers are NOT specified in
//                 §6 P0 item 3 for this store, so a judgment call: these are per-ORG documents
//                 (server.js's `org_documents` state carries an orgKey per file) and P0 does not
//                 owner-scope the library routes yet (that is explicitly Phase 2 — see D-VAULTAUTH /
//                 the CLIENT_API_ALLOW discussion in §8). Granting 'all-agents' here the way vault
//                 content gets it would let an agent acting for org A read org B's uploaded business
//                 documents through the same catalog, which is a real cross-tenant leak the moment a
//                 second org exists. So these default to readers:[] (cataloged but unreadable by
//                 anyone until a human or a later phase grants explicit readers — fail closed, same
//                 instinct as readers.js) and sensitivity:'confidential'.
//    artifacts  — store 'artifacts', source 'agent-output' (as specified — "lighter metadata", left
//                 otherwise unspecified). Treated the same as vault (sensitivity 'internal', readers
//                 ['all-agents']): this is agent-authored planning/research output, not customer
//                 data, so the same low-risk default applies.
//
//  contentHash reuses lib/provenance's sha256Hex(buf) rather than a second hashing helper (per the
//  P0 handoff spec) — it accepts a Buffer directly, which is exactly what fs.readFileSync() returns.
//
//  Usage:
//    node tools/library-migrate.js               backfill + write
//    node tools/library-migrate.js --dry-run      report what would be added; write nothing
//    node tools/library-migrate.js --reconcile    also prune records whose bytes no longer exist
//    node tools/library-migrate.js --artifacts recent:30   include artifacts touched in 30 days
//    node tools/library-migrate.js --artifacts all         include the WHOLE artifacts tree
//    node tools/library-migrate.js --drop-artifacts        remove existing artifact records first
//
//  Artifacts default to SKIP. That tree is a stream, not a collection — on the production instance
//  it grew ~11,000 files a month, and cataloging all of it produced 22,034 records in an 18 MB state
//  file that `saveState` rewrites, synchronously and in full, on every single library write. To
//  re-baseline an instance that already swallowed the tree:
//    node tools/library-migrate.js --drop-artifacts && sudo -iu aios pm2 restart ai-os
// ============================================================

'use strict';

const fs = require('fs');
const path = require('path');

const catalog = require('../lib/library/catalog');
// The sentinels come from readers.js rather than being retyped as literals here: the access
// model owns their spelling, and a migration that invented its own 'all-operators' string
// would grant nothing while looking correct.
const { ALL_AGENTS, ALL_OPERATORS } = require('../lib/library/readers');
const documents = require('../lib/org/documents');
const { sha256Hex } = require('../lib/provenance');

const ROOT = path.join(__dirname, '..');
const MAGENT_DIR = path.join(ROOT, '.magent');
const STATE_DIR = path.join(MAGENT_DIR, 'state');      // MUST match server.js's STATE_DIR exactly
const VAULT_DIR = path.join(MAGENT_DIR, 'vault');
const ORG_DOCS_DIR = path.join(MAGENT_DIR, 'org-docs');
const ARTIFACTS_DIR = path.join(MAGENT_DIR, 'artifacts');

// Hardcoded in at least five places in server.js already (§9 gotcha #2/§11) — this migration tool is
// unavoidably a sixth. Kept as its own constant so it is at least easy to find.
const VAULT_FOLDERS = ['raw', 'wiki', 'outputs'];

// ---- state I/O — same convention as server.js's loadState/saveState, standalone (see header) -----

function readStateFile(key, fallback) {
  const fp = path.join(STATE_DIR, `${key}.json`);
  if (!fs.existsSync(fp)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(fp, 'utf-8'));
  } catch (e) {
    console.error(`[library-migrate] could not parse ${key}.json, treating as empty: ${e.message}`);
    return fallback;
  }
}

function writeStateFile(key, data) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const fp = path.join(STATE_DIR, `${key}.json`);
  const tmp = `${fp}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, fp);   // atomic replace — a crash mid-write can't truncate/corrupt the live file
}

// ---- per-store candidate collection ---------------------------------------------------------------

/** vault/{raw,wiki,outputs}/<file> — flat, so `path` is simply "<folder>/<file>", relative to the
 *  vault store root (VAULT_DIR), never prefixed with "vault/" itself. */
function collectVaultCandidates() {
  const out = [];
  for (const folder of VAULT_FOLDERS) {
    const dir = path.join(VAULT_DIR, folder);
    if (!fs.existsSync(dir)) continue;
    const files = fs.readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isFile() && !d.name.startsWith('.'));
    for (const f of files) {
      const fpath = path.join(dir, f.name);
      const buf = fs.readFileSync(fpath);
      const stat = fs.statSync(fpath);
      out.push(catalog.normalizeRecord({
        title: f.name,
        store: 'vault',
        path: `${folder}/${f.name}`,
        contentHash: sha256Hex(buf),
        format: documents.extensionOf(f.name),
        bytes: stat.size,
        source: folder === 'wiki' ? 'company-doc' : 'agent-output',
        owner: '',
        addedBy: 'library-migrate',
        addedAt: stat.mtime.toISOString(),
        readers: [ALL_AGENTS, ALL_OPERATORS],
        sensitivity: 'internal',
        retention: { policy: 'keep' },
        tags: [folder],
      }));
    }
  }
  return out;
}

/** org-docs/<uuid>.txt — flat, id-named, and the uuid alone carries no human-readable metadata.
 *  server.js's `org_documents` state (the `orgDocs` array, saved under state key 'org_documents')
 *  is the only place the original filename/orgKey/uploader/upload time live, so it is cross-
 *  referenced here — the same way the archivist is meant to EXTEND lib/org/documents.js rather than
 *  re-derive what it already tracks. */
function collectOrgDocsCandidates() {
  const out = [];
  if (!fs.existsSync(ORG_DOCS_DIR)) return out;

  const orgDocsMeta = readStateFile('org_documents', []);
  const metaById = new Map(
    (Array.isArray(orgDocsMeta) ? orgDocsMeta : [])
      .filter((d) => d && d.id)
      .map((d) => [String(d.id), d])
  );

  const files = fs.readdirSync(ORG_DOCS_DIR, { withFileTypes: true })
    .filter((d) => d.isFile() && !d.name.startsWith('.') && d.name.endsWith('.txt'));
  for (const f of files) {
    const id = f.name.slice(0, -'.txt'.length);
    const meta = metaById.get(id) || null;
    const fpath = path.join(ORG_DOCS_DIR, f.name);
    const buf = fs.readFileSync(fpath);
    const stat = fs.statSync(fpath);
    out.push(catalog.normalizeRecord({
      title: (meta && meta.filename) || f.name,
      store: 'org-docs',
      path: f.name,
      contentHash: sha256Hex(buf),
      format: (meta && meta.format) || documents.extensionOf((meta && meta.filename) || ''),
      bytes: stat.size,
      source: 'company-doc',
      owner: (meta && meta.orgKey) || '',
      addedBy: (meta && meta.uploadedBy) || 'library-migrate',
      addedAt: (meta && meta.uploadedAt) || stat.mtime.toISOString(),
      // See the file header: no owner-scoping exists on library routes until P2, so this defaults
      // shut rather than open.
      readers: [],
      sensitivity: 'confidential',
      retention: { policy: 'keep' },
      tags: [],
    }));
  }
  return out;
}

/** artifacts/{docs,code,media,research,web-studio,youtube}/… — a NESTED tree, unlike the other two
 *  stores (§4's per-store table / §9 gotcha #9). `path` is the file's location relative to
 *  ARTIFACTS_DIR with forward slashes, regardless of host OS, so a catalog built on Windows and one
 *  built on the Linux VPS store identical path strings. */
function collectArtifactsCandidates(artifacts) {
  const mode = (artifacts && artifacts.mode) || 'skip';
  const out = [];
  // Skipping is the default and it short-circuits before the walk: on the production tree that walk
  // reads and sha256s every file, so 22k artifacts is 22k reads nobody asked for.
  if (mode === 'skip') return out;
  if (!fs.existsSync(ARTIFACTS_DIR)) return out;

  const cutoff = mode === 'recent'
    ? Date.now() - (artifacts.days * 86400000)
    : null;

  const walk = (dir) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      if (!e.isFile()) continue;

      // Age is checked from statSync BEFORE the file is read and hashed — filtering after would
      // cost the same I/O the filter exists to avoid.
      if (cutoff !== null) {
        let mtime;
        try { mtime = fs.statSync(full).mtimeMs; } catch { continue; }
        if (mtime < cutoff) continue;
      }

      const rel = path.relative(ARTIFACTS_DIR, full).split(path.sep).join('/');
      // Containment is structural here (this walk only ever descends into ARTIFACTS_DIR's own
      // subdirectories) but asserted anyway, on principle — the same discipline §4 demands of the
      // future read route, applied at the point the path value is minted rather than trusted later.
      if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) continue;

      const buf = fs.readFileSync(full);
      const stat = fs.statSync(full);
      const category = rel.split('/')[0];
      out.push(catalog.normalizeRecord({
        title: e.name,
        store: 'artifacts',
        path: rel,
        contentHash: sha256Hex(buf),
        format: documents.extensionOf(e.name),
        bytes: stat.size,
        source: 'agent-output',
        owner: '',
        addedBy: 'library-migrate',
        addedAt: stat.mtime.toISOString(),
        readers: [ALL_AGENTS, ALL_OPERATORS],
        sensitivity: 'internal',
        // 'review', not 'keep'. An artifact is transient output that another subsystem deletes on
        // its own schedule, so promising to retain it is a promise this department cannot keep —
        // and 'keep' on a stream means the catalog only ever grows. §11: expect these to go
        // dangling, and reconcile.
        retention: { policy: 'review' },
        tags: [category],
      }));
    }
  };
  walk(ARTIFACTS_DIR);
  return out;
}

// ---- reconcile: prune records whose bytes are no longer on disk -----------------------------------

/** Where this record's bytes SHOULD be, resolved per its store. Mirrors the §4 per-store shape —
 *  vault/artifacts paths are "<subpath within the store>", org-docs paths are the bare filename. */
function resolveStorePath(record) {
  // Defensive on shape, not just on store. The catalog is a hand-editable JSON file, and this used to
  // throw on a null/incomplete record — which aborted the whole --reconcile pass on the first bad
  // entry and left the operator to find it by eye. An unresolvable record now returns null and is
  // handled by the caller, so one malformed row cannot take out the tool.
  if (!record || typeof record !== 'object') return null;
  if (typeof record.path !== 'string' || !record.path) return null;
  if (record.store === 'vault') return path.join(VAULT_DIR, record.path);
  if (record.store === 'org-docs') return path.join(ORG_DOCS_DIR, record.path);
  if (record.store === 'artifacts') return path.join(ARTIFACTS_DIR, record.path);
  return null;
}

/** A record whose bytes vanished out from under the catalog (§8 risk: "store/catalog desync") is
 *  pruned rather than left dangling. Returns { survivors, pruned } so the caller can report exactly
 *  what went, not just a count. */
/**
 * Records that legitimately have NO bytes on disk, and must therefore never be pruned for lacking
 * them.
 *
 * `canonical-fact` records ARE their value — there is no file, and their `path` is a synthetic
 * `canonical/<slug>` that exists only to give each fact a distinct dedupe identity. Reconcile's test
 * is "do the bytes still exist", which is meaningless for them and answers no every time.
 *
 * This is the SECOND time the canonical-facts shelf has been silently destroyed by a mechanism that
 * assumed every record maps to a file. The first was dedupe collapsing five facts into one (they
 * shared an empty store+path+hash key); the synthetic path added to fix THAT is exactly what makes
 * them look dangling HERE. Both failures were total, silent, and only visible by counting afterwards.
 *
 * So the rule is a positive allowlist of what reconcile may examine, not a growing list of exceptions:
 * if a source has no bytes, it is not a candidate for byte-based pruning. A future bytes-less source
 * must be added here, and the test below fails until it is.
 */
const BYTELESS_SOURCES = Object.freeze(['canonical-fact']);

function reconcile(records) {
  const survivors = [];
  const pruned = [];
  const malformed = [];
  for (const r of Array.isArray(records) ? records : []) {
    // A non-record is neither a survivor nor "pruned for missing bytes" — calling it pruned would
    // report a deletion that never described a real document. Counted separately so a corrupt catalog
    // row is visible rather than folded into the prune tally.
    if (!r || typeof r !== 'object') { malformed.push(r); continue; }
    // Bytes-less records skip the existence test entirely — they cannot fail it meaningfully.
    if (BYTELESS_SOURCES.includes(r.source)) { survivors.push(r); continue; }
    const resolved = resolveStorePath(r);
    if (resolved && fs.existsSync(resolved)) survivors.push(r);
    else pruned.push(r);
  }
  return { survivors, pruned, malformed };
}

// ---- main -------------------------------------------------------------------------------------------

/**
 * How much of the artifacts tree to catalog. Default `skip`, and that default is the whole point.
 *
 * Artifacts are not a document collection, they are a STREAM: on the production instance the tree
 * grew ~11,000 files a month, evenly, with no sign of slowing. Cataloging all of it produced 22,034
 * records and an 18 MB state file — and `saveState` rewrites that entire file synchronously on every
 * single library write, so each upload paid for every artifact ever produced. §11 said to catalog
 * this tree "lightly"; the first implementation had no way to express lightly, so following the
 * documented command was enough to do the wrong thing.
 *
 *   --artifacts skip        (default) do not catalog the artifacts tree at all
 *   --artifacts recent:30   catalog artifacts modified in the last 30 days
 *   --artifacts all         the old behaviour, now something you have to ask for by name
 */
function parseArtifactsMode(args) {
  const flag = args.find((a) => a === '--artifacts' || a.startsWith('--artifacts='));
  if (!flag) return { mode: 'skip', days: 0 };

  const raw = flag.includes('=')
    ? flag.split('=').slice(1).join('=')
    : (args[args.indexOf(flag) + 1] || '');
  const value = String(raw).trim().toLowerCase();

  if (value === 'skip' || value === '') return { mode: 'skip', days: 0 };
  if (value === 'all') return { mode: 'all', days: 0 };

  const m = value.match(/^recent:(\d+)$/);
  if (m && Number(m[1]) > 0) return { mode: 'recent', days: Number(m[1]) };

  return { mode: 'invalid', days: 0, raw: value };
}

function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const doReconcile = args.includes('--reconcile');
  const dropArtifacts = args.includes('--drop-artifacts');
  const artifacts = parseArtifactsMode(args);

  if (artifacts.mode === 'invalid') {
    console.error(`[library-migrate] --artifacts: expected skip | recent:<days> | all, got "${artifacts.raw}"`);
    process.exitCode = 1;
    return;
  }

  const existing = readStateFile('library_catalog', []);
  let existingList = Array.isArray(existing) ? existing : [];

  // --drop-artifacts runs BEFORE candidates are collected, so `--drop-artifacts --artifacts recent:30`
  // is a re-baseline in one pass rather than two runs with a window in between where the catalog is
  // empty of them.
  let droppedArtifacts = 0;
  if (dropArtifacts) {
    const before = existingList.length;
    existingList = existingList.filter((r) => !(r && r.store === 'artifacts'));
    droppedArtifacts = before - existingList.length;
  }

  const existingIds = new Set(existingList.map((r) => r && r.id).filter(Boolean));

  const candidates = [
    ...collectVaultCandidates(),
    ...collectOrgDocsCandidates(),
    ...collectArtifactsCandidates(artifacts),
  ];

  // Existing records FIRST: on a duplicate, dedupeByHash keeps the first occurrence, so an
  // already-cataloged file keeps its stable id and the fresh candidate (which just got a brand new
  // id from catalog.normalizeRecord()) is the one dropped. Reverse this order and every id would reshuffle
  // on every run.
  const { kept, dropped } = catalog.dedupeByHash([...existingList, ...candidates]);
  const added = kept.filter((r) => !existingIds.has(r.id));
  const skippedDuplicate = dropped.length;

  let finalRecords = kept;
  let prunedRecords = [];
  if (doReconcile) {
    const result = reconcile(kept);
    finalRecords = result.survivors;
    prunedRecords = result.pruned;
    // Corrupt rows are dropped from the catalog but reported apart from the prune tally — they were
    // never records of a real document, so counting them as pruned would overstate what was deleted.
    if (result.malformed.length) {
      console.log(`[library-migrate] dropped (malformed):  ${result.malformed.length} — entries that were not records at all`);
    }
  }

  if (dropArtifacts) {
    console.log(`[library-migrate] dropped (artifacts):  ${droppedArtifacts} — existing artifact records removed before this pass`);
  }
  const artifactsLabel = artifacts.mode === 'recent' ? `recent:${artifacts.days}` : artifacts.mode;
  console.log(`[library-migrate] artifacts mode:       ${artifactsLabel}${artifacts.mode === 'skip' ? '  (default — pass --artifacts recent:<days>|all to include them)' : ''}`);
  console.log(`[library-migrate] existing catalog:     ${existingList.length} record(s)`);
  console.log(`[library-migrate] candidates found:     ${candidates.length} (vault + org-docs${artifacts.mode === 'skip' ? '' : ' + artifacts'})`);
  console.log(`[library-migrate] added:                ${added.length}`);
  console.log(`[library-migrate] skipped (duplicate):  ${skippedDuplicate}`);
  if (added.length) {
    for (const r of added) console.log(`  + [${r.store}] ${r.path}  (${r.source}, ${r.bytes}B, sensitivity=${r.sensitivity})`);
  }
  if (doReconcile) {
    console.log(`[library-migrate] pruned (missing):     ${prunedRecords.length}`);
    for (const r of prunedRecords) console.log(`  - [${r.store}] ${r.path}  (id ${r.id}) — bytes no longer on disk`);
  }

  if (dryRun) {
    console.log('[library-migrate] --dry-run: no state was written');
    return;
  }

  writeStateFile('library_catalog', finalRecords);
  console.log(`[library-migrate] wrote ${finalRecords.length} record(s) to ${path.join(STATE_DIR, 'library_catalog.json')}`);

  // A RUNNING server will not see any of this until it restarts.
  //
  // server.js reads `library_catalog` into memory once, at module load, and never re-reads it. This
  // tool writes the same file from OUTSIDE that process, so until a restart the API reports whatever
  // the catalog held at boot — typically just the seeded canonical facts — while the file on disk has
  // everything. Nothing is lost, and the numbers above are what is really stored; the two views
  // simply disagree until the process is recycled.
  //
  // This reminder exists because that disagreement looks exactly like the migration having silently
  // failed, and the natural next move — run it again — reports "added: 0, skipped: N" and reinforces
  // the wrong conclusion. Saying it here costs one line and removes a whole debugging session.
  // Both branches change what the API should serve: an add makes new records available, a prune
  // removes records the running process still thinks exist. A run that only skipped duplicates
  // changed nothing, so it stays quiet — a reminder that fires on a no-op run is one people learn
  // to ignore, which is how the real warning gets missed later.
  if (added.length || prunedRecords.length) {
    console.log('');
    console.log('[library-migrate] NOTE: a running server still has the OLD catalog in memory.');
    console.log('[library-migrate]       Restart it for the API to serve these records:');
    console.log('[library-migrate]         pm2 restart ai-os            # if pm2 runs as you');
    console.log('[library-migrate]         sudo -iu aios pm2 restart ai-os   # VPS: pm2 runs as the app user');
    console.log('[library-migrate]       Until then /api/library reports the pre-migration count.');
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  parseArtifactsMode,
  collectVaultCandidates,
  collectOrgDocsCandidates,
  collectArtifactsCandidates,
  resolveStorePath,
  reconcile,
  BYTELESS_SOURCES,
};
