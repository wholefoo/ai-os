// lib/library/intake.js
// ============================================================
//  Intake — deciding what a newly-arrived file IS before anything is written to disk.
//
//  Three answers, and the whole module exists to tell them apart:
//
//    DUPLICATE  these exact bytes are already cataloged. Do not store them again, do not mint a
//               second record. Hand back the record that already exists.
//    VERSION    a document with this logical identity is already here, but the bytes differ. Mint a
//               new record that points at its predecessor.
//    NEW        neither — a first version.
//
//  WHY THIS MODULE IS PURE. It writes nothing. It takes the catalog as an array and returns a
//  decision; the caller performs the write. That is deliberate: this is the module that decides
//  whether a person's second upload silently overwrites their first, and a decision that can only
//  be exercised by booting a server and POSTing a real .docx is one nobody re-verifies after the
//  first day. Rev-5's own lesson #5 extracted `paths.js` for exactly this reason. See §9 item 19 for
//  the divergence from P1's manifest wording ("writes bytes to org-docs"), which the route now does.
//
//  WHAT THIS MODULE DOES NOT DO — and must never start doing:
//   - It does not parse. `documents.extract()` owns every format, every zip-bomb guard and every
//     refusal message. A second parser here would be a second place for those guards to be wrong.
//   - It does not name files. Bytes land under a generated uuid; the uploader's filename is a
//     LABEL. A user string that reaches a path is the whole of path traversal.
//   - It does not decide who may read. `readers.buildReaders()` shapes the allowlist entry by entry.
// ============================================================

'use strict';

const catalog = require('./catalog');
const readers = require('./readers');

// The store new uploads land in. `org-docs` is flat and uuid-named, so the filename is never
// user-derived — §4 calls it the strongest of the three and says to prefer it for new content.
const UPLOAD_STORE = 'org-docs';


// What an operator uploading a file through the library IS, in the P0 source vocabulary. There is no
// 'upload' member and one must not be added: `normalizeRecord` falls back to 'agent-output' for an
// unknown source rather than throwing, so an invented value here would silently relabel every
// company document a person uploads as something an agent produced.
const UPLOAD_SOURCE = 'company-doc';

/**
 * The always-false invariant, checked at the REQUEST boundary.
 *
 * `catalog.normalizeRecord` throws on `personaDerived:true`, which is right for an internal
 * programmer error but wrong for an HTTP body — a route would 500 where it should 400. Intake builds
 * an explicit field list, so the flag never reaches normalize on its own; without this check a
 * caller could send it, be silently ignored, and believe the record was marked. Refuse it by name.
 */
function refusePersonaDerived(src) {
  return src && src.personaDerived === true
    ? 'personaDerived is an always-false invariant — persona-derived material does not enter the '
      + 'library through intake. See the contribution path in P2.'
    : null;
}

/**
 * The logical identity of a document, for version chaining: its store plus its title, casefolded.
 *
 * Deliberately NOT the contentHash — that is the identity of one revision, and two revisions of the
 * same document have different ones by definition. Deliberately not the record id either, which is
 * unique per revision. The title is the only thing that survives an edit, which is exactly why
 * dedupe cannot use it and chaining must.
 */
function logicalKey(store, title) {
  return `${String(store || '').trim().toLowerCase()}::${String(title || '').trim().toLowerCase()}`;
}

/** Every record already sharing these exact bytes, whatever they are called or wherever they live. */
function findByHash(records, contentHash) {
  const h = String(contentHash || '').trim().toLowerCase();
  if (!h) return null;
  return (records || []).find((r) => r && r.contentHash === h) || null;
}

/**
 * The head of the version chain for a logical document: the record with this identity that no other
 * record supersedes.
 *
 * Taking "any record with this title" instead would fork the chain on the third upload — v3 would
 * point back at v1 alongside v2, and the history would no longer be a line. The head is the only
 * correct anchor, and it is defined by what points AT it, not by its own fields.
 */
function chainHead(records, store, title) {
  const key = logicalKey(store, title);
  const family = (records || []).filter((r) => r && logicalKey(r.store, r.title) === key);
  if (!family.length) return null;
  const superseded = new Set(family.map((r) => r.supersedes).filter(Boolean));
  // A record nobody supersedes is the head. If several qualify (a chain forked before this fix, or
  // records arrived out of order), the most recently added one is the honest answer — it is the
  // revision a reader would get today.
  const heads = family.filter((r) => !superseded.has(r.id));
  const pool = heads.length ? heads : family;
  return pool.reduce((a, b) => (String(b.addedAt) > String(a.addedAt) ? b : a));
}

/** Walk a chain from any member back to its first version, newest first. */
function versionChain(records, recordId) {
  const byId = new Map((records || []).filter(Boolean).map((r) => [r.id, r]));
  const out = [];
  let cur = byId.get(recordId);
  const seen = new Set();
  while (cur && !seen.has(cur.id)) {   // `seen` guards a cycle written by a bad import
    seen.add(cur.id);
    out.push(cur);
    cur = cur.supersedes ? byId.get(cur.supersedes) : null;
  }
  return out;
}

/**
 * Decide what to do with an arriving document. Writes nothing.
 *
 * @param {object[]} records        the current catalog
 * @param {object}   incoming
 * @param {string}   incoming.id            record id to use if one is minted (a uuid from the caller)
 * @param {string}   incoming.title         the uploader's filename — a LABEL, never a path
 * @param {string}   incoming.contentHash   sha256 hex of the ORIGINAL BYTES, not of the extracted text
 * @param {string}   incoming.format        from documents.extract()
 * @param {number}   incoming.bytes         buffer length
 * @param {string}   incoming.addedBy       who uploaded it
 * @param {string}   [incoming.owner]       defaults to addedBy
 * @param {string}   [incoming.sensitivity] defaults to catalog's fail-closed 'restricted'
 * @param {string}   [incoming.store]       defaults to 'org-docs'
 * @param {object}   [incoming.access]      { principals?, allAgents?, allOperators? } for buildReaders
 * @param {string[]} [incoming.tags]
 * @returns {{ok:true, action:'duplicate'|'version'|'new', record:object|null,
 *            existing:object|null, supersedes:string|null, reason:string}
 *          | {ok:false, error:string}}
 */
function planIntake(records, incoming) {
  const src = (incoming && typeof incoming === 'object') ? incoming : {};
  const list = Array.isArray(records) ? records : [];

  const persona = refusePersonaDerived(src);
  if (persona) return { ok: false, error: persona };

  const title = String(src.title || '').trim();
  if (!title) return { ok: false, error: 'a title is required — send the file name as ?name=' };

  // An empty or malformed hash is refused rather than defaulted. Rev-5's defect #3 was five
  // canonical facts seeded with an empty contentHash collapsing into one record on the first
  // migrate; here the same emptiness would make every upload a duplicate of every other, and the
  // second file a person uploaded would vanish into the first with a cheerful "already have that".
  const contentHash = String(src.contentHash || '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(contentHash)) {
    return { ok: false, error: 'a sha256 contentHash of the original bytes is required' };
  }

  const store = String(src.store || UPLOAD_STORE).trim().toLowerCase();

  // --- 1. Same bytes anywhere? Then it is a duplicate, whatever it is called. --------------------
  // Checked BEFORE the title, and the order is load-bearing: re-uploading an unchanged file under
  // its own name matches both tests, and calling it a version would chain a record to a predecessor
  // with identical content — history that records nothing having happened.
  const dup = findByHash(list, contentHash);
  if (dup) {
    return {
      ok: true,
      action: 'duplicate',
      record: null,
      existing: dup,
      supersedes: null,
      reason: `identical bytes are already cataloged as "${dup.title}" (${dup.id})`,
    };
  }

  // --- 2. Same logical document, different bytes? Then it is the next version. ------------------
  const head = chainHead(list, store, title);

  const record = catalog.normalizeRecord({
    id: src.id,
    title,                                  // label only
    store,
    // Left EMPTY on purpose. The caller writes the bytes under the record's own id, so the path is
    // derivable from the id and storing a second copy of it invites the two to disagree. `org-docs`
    // reads are id-only (§4's read-rule table) precisely so nothing here is user-derived.
    path: '',
    contentHash,
    format: src.format,
    bytes: src.bytes,
    source: UPLOAD_SOURCE,
    owner: src.owner || src.addedBy,
    addedBy: src.addedBy,
    addedAt: src.addedAt,
    readers: readers.buildReaders({
      owner: src.owner || src.addedBy,
      contributor: src.addedBy,
      principals: (src.access && src.access.principals) || [],
      allAgents: !!(src.access && src.access.allAgents),
      allOperators: !!(src.access && src.access.allOperators),
    }),
    sensitivity: src.sensitivity,
    retention: src.retention,
    tags: src.tags,
    supersedes: head ? head.id : null,
  });

  return {
    ok: true,
    action: head ? 'version' : 'new',
    record,
    existing: head,
    supersedes: head ? head.id : null,
    reason: head
      ? `replaces "${head.title}" (${head.id}) — same title in ${store}, different bytes`
      : `first version of "${title}" in ${store}`,
  };
}

/**
 * Catalog a file that is ALREADY in a store, in place. Nothing moves and nothing is written; the
 * caller has already resolved and hashed the file through `paths.resolveRecordPath`.
 *
 * Separate from planIntake because the identity rules differ: an in-place file has a real path
 * inside its store, and re-registering the same path with the same bytes is a no-op rather than a
 * duplicate to be reported. The artifacts tree is written and deleted by other subsystems on their
 * own schedule, so records here are expected to go dangling — §11 says catalog it lightly.
 */
function planRegister(records, incoming) {
  const src = (incoming && typeof incoming === 'object') ? incoming : {};
  const list = Array.isArray(records) ? records : [];

  const persona = refusePersonaDerived(src);
  if (persona) return { ok: false, error: persona };

  const store = String(src.store || '').trim().toLowerCase();
  if (!catalog.VALID_STORES.includes(store)) {
    return { ok: false, error: `store must be one of ${catalog.VALID_STORES.join(', ')}` };
  }
  const recPath = String(src.path || '').trim();
  if (!recPath) return { ok: false, error: 'a path within the store is required' };

  // Validated rather than defaulted, for the same reason UPLOAD_SOURCE is a constant: an unknown
  // source does not fail, it silently becomes 'agent-output', and a mislabelled record is one the
  // chief-librarian's taxonomy can never sort correctly afterwards.
  const source = String(src.source || 'agent-output').trim().toLowerCase();
  if (!catalog.VALID_SOURCES.includes(source)) {
    return { ok: false, error: `source must be one of ${catalog.VALID_SOURCES.join(', ')}` };
  }

  const contentHash = String(src.contentHash || '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(contentHash)) {
    return { ok: false, error: 'a sha256 contentHash of the file is required' };
  }

  // store+path+hash is the migrator's dedupe key, and register must agree with it or a file
  // registered by hand and then swept by `library-migrate` becomes two records for one file.
  const already = list.find((r) => r
    && r.store === store && r.path === recPath && r.contentHash === contentHash);
  if (already) {
    return {
      ok: true, action: 'duplicate', record: null, existing: already, supersedes: null,
      reason: `${store}/${recPath} is already cataloged as ${already.id}`,
    };
  }

  const head = chainHead(list, store, src.title || recPath);
  const record = catalog.normalizeRecord({
    id: src.id,
    title: src.title || recPath,
    store,
    path: recPath,
    contentHash,
    format: src.format,
    bytes: src.bytes,
    source,
    owner: src.owner || src.addedBy,
    addedBy: src.addedBy,
    addedAt: src.addedAt,
    readers: readers.buildReaders({
      owner: src.owner || src.addedBy,
      contributor: src.addedBy,
      principals: (src.access && src.access.principals) || [],
      allAgents: !!(src.access && src.access.allAgents),
      allOperators: !!(src.access && src.access.allOperators),
    }),
    sensitivity: src.sensitivity,
    retention: src.retention,
    tags: src.tags,
    supersedes: head && head.contentHash !== contentHash ? head.id : null,
  });

  return {
    ok: true,
    action: head && head.contentHash !== contentHash ? 'version' : 'new',
    record,
    existing: head,
    supersedes: record.supersedes,
    reason: `registered ${store}/${recPath} in place`,
  };
}

/**
 * Apply an operator's metadata edit to an existing record.
 *
 * Only the fields an operator is allowed to curate, and `readers` is rebuilt through
 * `buildReaders` rather than assigned — a PATCH body is the one place a caller could hand the
 * catalog a raw array containing `all-agents`, and the sentinel must only ever arrive through its
 * explicit flag. Identity fields (id, store, path, contentHash, bytes, format, supersedes) are NOT
 * editable: changing them by hand would break the dedupe key or the version chain silently.
 */
function applyPatch(record, patch) {
  const cur = (record && typeof record === 'object') ? record : null;
  if (!cur) return { ok: false, error: 'no such record' };
  const p = (patch && typeof patch === 'object') ? patch : {};

  const next = { ...cur };
  if (p.title !== undefined) next.title = p.title;
  if (p.tags !== undefined) next.tags = p.tags;
  if (p.sensitivity !== undefined) next.sensitivity = p.sensitivity;
  if (p.retention !== undefined) next.retention = p.retention;
  if (p.owner !== undefined) next.owner = p.owner;

  if (p.readers !== undefined || p.access !== undefined) {
    const a = p.access || {};
    next.readers = readers.buildReaders({
      owner: p.owner !== undefined ? p.owner : cur.owner,
      principals: Array.isArray(p.readers) ? p.readers : (a.principals || []),
      allAgents: a.allAgents === true,
      allOperators: a.allOperators === true,
    });
  }

  // legalHold is deliberately absent: placing or lifting a hold is a legal decision that P3 routes
  // through the approval gate, not a metadata edit an operator makes in passing.

  return { ok: true, record: catalog.normalizeRecord(next) };
}

// Exports are the CONSUMED surface only. `UPLOAD_STORE`, `UPLOAD_SOURCE`, `logicalKey` and
// `findByHash` are deliberately internal: nothing outside this module calls them, and the repo's
// dead-code gate treats a speculative export as a defect rather than a convenience — an export with
// no consumer is a promise to keep something stable that nobody needs.
module.exports = {
  chainHead,
  versionChain,
  planIntake,
  planRegister,
  applyPatch,
};
