// lib/library/catalog.js
// ============================================================
//  The catalog record: what the library knows ABOUT a document, never the document itself.
//
//  This module never touches a filesystem and never decides who may read anything. Both of those
//  restrictions are load-bearing, not style:
//
//  - NO I/O. `.magent/library/catalog.json` is metadata only — bytes live in the three physical
//    stores (vault / org-docs / artifacts) and this module never reads or writes them. That is the
//    whole reason the catalog is "an index, not a fourth store" (see library-department-design.md
//    §2). A pure module that cannot touch a file also cannot leak a path, which matters more here
//    than almost anywhere else in the codebase: this is the shape that describes every document on
//    the instance.
//  - NO ACCESS DECISIONS. `searchRecords()` and `filter()` are plain predicates over whatever record array
//    they are handed — they do not consult `readers`, do not know what a "requester" is, and must
//    never be taught to. lib/library/readers.js exists precisely so that ONE module answers "may
//    this requester see this record?" — the moment a second module (this one) also answers that
//    question, the two can diverge, and the one that drifts permissive is the one nobody notices.
//    A test in tools/test-library-catalog.js asserts a record with an EMPTY readers list (nobody may
//    read it) is still returned by searchRecords() — proving the boundary is real, not just a comment.
//
//  normalizeRecord() is the schema gate: every LibraryRecord that ever enters the catalog passes through
//  it. Unknown keys are dropped rather than carried, the same discipline lib/org/extract.js applies
//  to model output — a key the schema does not know is an injection surface, not a feature, and
//  this catalog is read by every agent on the instance (§1). Every OTHER field is silently defaulted
//  or corrected on bad input, matching that same discipline. `personaDerived` is the one exception:
//  the schema names it an always-false INVARIANT (§4), and a `true` value reaching normalizeRecord() means
//  a persona already slipped past the contribution-path tripwire (readers.js's findPersonaLeaks /
//  visibility.js's findLeaks) upstream. Correcting it quietly here would hide exactly the defect the
//  invariant exists to surface, so this one field throws instead of defaulting.
//
//  Two default choices worth flagging explicitly, because the design doc does not pin them down and
//  a future reader should not have to reverse-engineer why they are what they are:
//    - `sensitivity` has no "unset" member in its enum (public/internal/confidential/restricted — no
//      empty string). Missing or invalid input defaults to the MOST restrictive label, not the least
//      — fail closed, the same instinct readers.js states in its own header ("an empty reader list
//      is an unreadable record, not a public one").
//    - `store` defaults to 'vault' on invalid input, because every store this repo has today grew
//      out of the Memory Vault and an unlabeled record is far more likely to be vault content than
//      anything else. This is a judgment call, not something the design doc specifies — flagged here
//      so it can be revisited if a future store makes it wrong.
//
//  `contentHash` is the dedupe key AND the version anchor (§4): two records sharing store+path+hash
//  are the same bytes cataloged twice, not two documents. dedupeByHash() is what makes
//  tools/library-migrate.js idempotent — re-running it must add zero duplicates, and the ONLY way to
//  guarantee that mechanically (rather than by careful caller discipline) is to make dedupe a pure
//  function the migration tool calls, not a rule it re-implements.
//
//  The canonical-facts helpers (canonicalFacts/factValue) read the shelf described in §1/§6 P0 item
//  4 — the structural fix for the stale-number defect. A fact's payload lives in a dedicated `value`
//  field, which §4 of the design doc did not originally include; it was added here rather than
//  reusing an existing field, because the first draft read the record's FIRST TAG and tags are an
//  unordered set. That made a fact's correctness depend on array order (`tags:['counts','68']`
//  answering "counts"), and would have broken every fact the first time anything sorted tags. A shelf
//  whose entire purpose is to end silent numeric drift must not itself be able to fail silently.
//  `value` is null on ordinary document records, where the bytes are the content.
//
//  Pure module: shapes, normalize, dedupe, search/filter predicates. No state, no I/O, and the only
//  two requires are node's own `crypto` (used only to backstop a missing `id` — see idOrGenerate
//  below) and lib/capped-list.js, itself a pure, dependency-free helper. The restriction that
//  matters is "cannot touch a file", not "imports nothing".
// ============================================================

'use strict';

const { randomUUID } = require('crypto');
const { cappedList } = require('../capped-list');

/** Which physical store holds the bytes. See §4's per-store read-guard table — this module does not
 *  implement any of those guards; it only records which one applies. */
const VALID_STORES = Object.freeze(['vault', 'org-docs', 'artifacts']);

/** Where a record came from. 'canonical-fact' is the stale-number shelf (§6 P0 item 4); the other
 *  four map onto the four ways content enters the library across P0-P2. */
const VALID_SOURCES = Object.freeze([
  'company-doc', 'clone-contribution', 'personnel-contribution', 'agent-output', 'canonical-fact',
]);

/** Human-facing label only. `readers` is what actually enforces access — see the module header. */
const VALID_SENSITIVITY = Object.freeze(['public', 'internal', 'confidential', 'restricted']);

/** P0 ships every record at 'keep' (never auto-expire) until an operator sets a real policy (§8). */
const RETENTION_POLICIES = Object.freeze(['keep', 'review', 'expire']);

const HEX64 = /^[0-9a-f]{64}$/;

// ---- small field-level coercers, each doing exactly one job ------------------

function str(v, cap) {
  return String(v == null ? '' : v).trim().slice(0, cap);
}

function lowerStr(v, cap) {
  return str(v, cap).toLowerCase();
}

function oneOf(v, allowed, fallback) {
  const s = String(v == null ? '' : v).trim().toLowerCase();
  return allowed.includes(s) ? s : fallback;
}

function nonNegInt(v) {
  const n = Number(v);
  return (Number.isFinite(n) && n >= 0) ? Math.floor(n) : 0;
}

/** ISO string in, ISO string out — re-serialised through Date so a hand-edited or legacy timestamp
 *  is normalised to the same format every record uses. Invalid input yields null, never "Invalid Date". */
function isoOrNull(v) {
  if (!v) return null;
  const t = new Date(v);
  return Number.isNaN(t.getTime()) ? null : t.toISOString();
}

/** sha256 hex only. Anything else is not a hash this catalog can trust as an identity, so it is
 *  dropped rather than stored as if it were valid — a bad hash silently "matching" nothing is safer
 *  than a bad hash silently colliding with something. */
function hashOrEmpty(v) {
  const s = String(v == null ? '' : v).trim().toLowerCase();
  return HEX64.test(s) ? s : '';
}

/** The id is OURS, never derived from any user string (§4) — so a missing one is backfilled here
 *  rather than left blank, and a supplied one (from a caller re-normalizing an existing record) is
 *  kept verbatim so re-normalizing never reassigns a stable id. `crypto` is a node built-in; this
 *  avoids taking on the `uuid` package just to backstop one field in a module the design doc asks to
 *  stay dependency-free. */
function idOrGenerate(v) {
  const s = str(v, 100);
  return s || randomUUID();
}

/** Trimmed, capped, de-duplicated (case-insensitively) string list — used for both `readers` and
 *  `tags`, which are shaped the same way even though only one of them is a permission. Preserves the
 *  original casing of the FIRST occurrence, since `readers.js` does its own case-insensitive
 *  comparison at read time and a display-facing email/tag should not be silently lower-cased here. */
function strList(v, { cap, maxItems }) {
  return cappedList(v, { cap, maxItems, coerce: scalarStr });
}

/** The admissibility rule for a list field, kept separate from `str` because `str` coerces ANY value
 *  — an object would arrive in `tags` as the literal text "[object Object]". Rejecting non-scalars
 *  here stops that coercion from inventing content that was never in the input. */
function scalarStr(item, cap) {
  if (typeof item !== 'string' && typeof item !== 'number') return '';
  return str(item, cap);
}

function normalizeRetention(input) {
  const src = (input && typeof input === 'object') ? input : {};
  return {
    policy: oneOf(src.policy, RETENTION_POLICIES, 'keep'),
    reviewAt: isoOrNull(src.reviewAt),
    disposeAt: isoOrNull(src.disposeAt),
  };
}

/**
 * Coerce arbitrary input into a complete, schema-valid LibraryRecord. Every field from §4 is present
 * on the output; unknown input keys are dropped, not carried.
 *
 * @param {object} input
 * @returns {object} LibraryRecord
 * @throws {Error} if `input.personaDerived === true` — see the module header. This is the one field
 *   this function refuses to silently correct.
 */
function normalizeRecord(input) {
  const src = (input && typeof input === 'object') ? input : {};

  if (src.personaDerived === true) {
    throw new Error(
      'LibraryRecord.personaDerived must never be true — it is an always-false invariant (see ' +
      '.magent/vault/wiki/library-department-design.md §4). A true value here means persona-derived ' +
      'content reached catalog.normalize() without being refused upstream by the contribution-path ' +
      'tripwire (readers.js findPersonaLeaks / visibility.js findLeaks) — fix the caller; do not ' +
      'silence this by flipping the flag.'
    );
  }

  return {
    id: idOrGenerate(src.id),
    title: str(src.title, 200),                 // label only — NEVER used as a path, see the header
    store: oneOf(src.store, VALID_STORES, 'vault'),
    path: str(src.path, 1000),                   // WITHIN the store — the per-store read guard (§4) is
                                                 // the reader's job, not this module's
    contentHash: hashOrEmpty(src.contentHash),
    format: lowerStr(src.format, 12),
    bytes: nonNegInt(src.bytes),

    source: oneOf(src.source, VALID_SOURCES, 'agent-output'),
    owner: lowerStr(src.owner, 200),
    addedBy: lowerStr(src.addedBy, 200),
    addedAt: isoOrNull(src.addedAt) || new Date().toISOString(),

    // An allowlist, shaped here but never CONSULTED here — see the module header on why access
    // decisions live in readers.js and nowhere else.
    readers: strList(src.readers, { cap: 200, maxItems: 500 }),
    // No safe "unset" member exists in the sensitivity enum (§4) — fail closed on missing/invalid
    // input rather than defaulting to 'public'. See the module header.
    sensitivity: oneOf(src.sensitivity, VALID_SENSITIVITY, 'restricted'),

    retention: normalizeRetention(src.retention),
    legalHold: src.legalHold === true,

    provenanceId: (typeof src.provenanceId === 'string' && src.provenanceId.trim())
      ? src.provenanceId.trim().slice(0, 300)
      : null,

    // The predecessor this record replaces — the id of the previous version of the same logical
    // document, or null for a first version. A REAL FIELD rather than a `tags` entry, which is what
    // §4 originally suggested: tags are an unordered, deduped, capped set, and rev-5's first defect
    // was a canonical fact whose payload lived in its first tag, so correctness depended on the order
    // of an unordered collection. A version pointer has exactly the same shape of failure, and it
    // fails in the direction that loses history. The head of a chain is the record no other record
    // supersedes; walking backwards from it is the whole version list.
    supersedes: (typeof src.supersedes === 'string' && src.supersedes.trim())
      ? src.supersedes.trim().slice(0, 100)
      : null,
    // Always false — see the throw above. Never assigned from `src`.
    personaDerived: false,
    tags: strList(src.tags, { cap: 60, maxItems: 50 }),

    // The canonical-facts shelf's payload. Meaningful ONLY on source:'canonical-fact' records; null
    // on every document record, where the bytes are the content and this would be a second, competing
    // place to look. Kept as a string because a fact's job is to be quoted verbatim into copy — the
    // moment it is a number, some caller formats it differently and the drift the shelf exists to
    // kill reappears as a formatting difference.
    value: (src.value == null || src.value === '') ? null : String(src.value).slice(0, 500),
  };
}

/**
 * Collapse records that are the same bytes cataloged twice (same store + path + contentHash). The
 * FIRST occurrence in the input array wins — callers that want an already-cataloged record's stable
 * id preserved across a re-run (tools/library-migrate.js) must put existing records ahead of freshly
 * discovered candidates in the array they pass in.
 *
 * @param {object[]} records
 * @returns {{ kept: object[], dropped: object[] }}
 */
function dedupeByHash(records) {
  const list = Array.isArray(records) ? records : [];
  const seen = new Set();
  const kept = [];
  const dropped = [];
  for (const r of list) {
    if (!r || typeof r !== 'object') { dropped.push(r); continue; }
    const key = `${String(r.store || '')}::${String(r.path || '')}::${String(r.contentHash || '')}`;
    if (seen.has(key)) {
      dropped.push(r);
    } else {
      seen.add(key);
      kept.push(r);
    }
  }
  return { kept, dropped };
}

/** Does one record match a search query, over title/tags/source/format only. See searchRecords()'s header
 *  note on why `readers` is deliberately absent from this list. */
function matchesQuery(record, q) {
  if (!q) return true;
  const haystacks = [
    record.title,
    ...(Array.isArray(record.tags) ? record.tags : []),
    record.source,
    record.format,
  ];
  return haystacks.some((v) => String(v == null ? '' : v).toLowerCase().includes(q));
}

/**
 * Predicate search over title, tags, source, format — case-insensitive substring match.
 *
 * Deliberately does NOT filter by `readers`. Access is readers.js's job, exclusively — see the
 * module header. Every caller that needs "what can THIS requester find" must compose this with
 * readers.readableBy() itself; searchRecords() answers only "what matches this text", the same way a
 * library's card catalog does not ask who is standing at the desk.
 *
 * @param {object[]} records
 * @param {string} query
 * @returns {object[]}
 */
function searchRecords(records, query) {
  const list = Array.isArray(records) ? records : [];
  const q = String(query == null ? '' : query).trim().toLowerCase();
  return list.filter((r) => r && typeof r === 'object' && matchesQuery(r, q));
}

/**
 * Structured filter over exact-match dimensions. Every provided criterion must match (AND); an
 * omitted criterion imposes no constraint. Like searchRecords(), this does not filter by `readers`.
 *
 * @param {object[]} records
 * @param {{store?:string, source?:string, sensitivity?:string, tag?:string}} [opts]
 * @returns {object[]}
 */
function filter(records, opts) {
  const list = Array.isArray(records) ? records : [];
  const o = opts || {};
  const store = o.store ? String(o.store) : '';
  const source = o.source ? String(o.source) : '';
  const sensitivity = o.sensitivity ? String(o.sensitivity) : '';
  const tag = o.tag ? String(o.tag).trim().toLowerCase() : '';

  return list.filter((r) => {
    if (!r || typeof r !== 'object') return false;
    if (store && r.store !== store) return false;
    if (source && r.source !== source) return false;
    if (sensitivity && r.sensitivity !== sensitivity) return false;
    if (tag) {
      const tags = Array.isArray(r.tags) ? r.tags.map((t) => String(t).toLowerCase()) : [];
      if (!tags.includes(tag)) return false;
    }
    return true;
  });
}

/** Records on the canonical-facts shelf (§6 P0 item 4) — the structural fix for the stale-number
 *  defect. Nothing else about these records is special; they are ordinary LibraryRecords with
 *  source:'canonical-fact'. */
function canonicalFacts(records) {
  const list = Array.isArray(records) ? records : [];
  return list.filter((r) => r && r.source === 'canonical-fact');
}

/** case/whitespace/punctuation-insensitive slug, used only to match a lookup key against a fact's
 *  title without demanding the caller spell it identically ("Licensed agent count" == "licensed-agent-count"). */
function slugify(v) {
  return String(v == null ? '' : v)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * One canonical fact's value, by its title (matched as a slug, so exact spelling/casing does not
 * matter).
 *
 * The value comes from the record's dedicated `value` field. An earlier draft read the first TAG
 * instead, to avoid adding a field the design doc had not specified — but tags are an unordered set,
 * so that made a fact's correctness depend on array order: `tags:['counts','68']` would answer
 * "counts", and any future code that sorted or de-duplicated tags would silently break every fact on
 * the shelf. A shelf built to end silent numeric drift cannot itself fail silently, so the field was
 * added. §4 of the design doc is amended accordingly.
 *
 * @param {object[]} records
 * @param {string} key
 * @returns {string|null} the fact's value, or null when there is no such fact or it carries no value
 */
function factValue(records, key) {
  const wanted = slugify(key);
  if (!wanted) return null;
  const hit = canonicalFacts(records).find((r) => slugify(r.title) === wanted);
  if (!hit) return null;
  return (hit.value == null || hit.value === '') ? null : String(hit.value);
}

module.exports = {
  VALID_STORES,
  VALID_SOURCES,
  VALID_SENSITIVITY,
  RETENTION_POLICIES,
  normalizeRecord,
  dedupeByHash,
  searchRecords,
  filter,
  canonicalFacts,
  factValue,
};
