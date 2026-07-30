// lib/library/contribute.js
// ============================================================
//  A person, or a person's clone, putting something INTO the library.
//
//  This is the highest-leverage leak path in the whole department, and the reason it gets its own
//  module rather than a branch inside intake.js. Everything else here is the instance's own
//  material — the operator's documents, the vault, agent output. A contribution is somebody's, and
//  the library is read by every agent on the instance. Get the reader set wrong once and a named
//  person's material is platform-wide.
//
//  Three rules, in the order they are enforced:
//
//    1. REFUSE PERSONA-DERIVED MATERIAL. Not "strip it", not "warn" — refuse, and say which field
//       tripped. `readers.findPersonaLeaks` walks the whole payload for visibility.js's
//       FORBIDDEN_KEYS (persona, prompt, compiledPersona, transcript, interview, corpus, feedback,
//       suggestion, proposed) plus a hand-set `personaDerived:true`.
//    2. BUILD `readers` BY ALLOWLIST, contributor-first, and NEVER a sentinel. `all-agents` is not
//       reachable from this module at any input — see the note on buildReaders below.
//    3. DEFAULT NARROW. Absent named principals, the only reader is the contributor. A contribution
//       nobody else can read is a recoverable mistake; one everybody can read is not.
//
//  WHAT RULE 1 DOES NOT CATCH, stated plainly so nobody mistakes its reach: `findPersonaLeaks` is a
//  STRUCTURAL guard. It inspects object KEYS, so `{persona: {...}}` is refused and a prose blob that
//  happens to describe how someone thinks is not. It stops the mechanical accident — a caller
//  passing a persona object through — and it cannot stop a person deciding to paste their own
//  profile into a text field. The narrow default reader set is what limits the blast radius of that
//  second case, which is why rule 3 is not merely a convenience.
//
//  Pure. Returns a decision; the route writes. Same reasoning as intake.js.
// ============================================================

'use strict';

const catalog = require('./catalog');
const readers = require('./readers');
// The text ceiling is IMPORTED, not restated. documents.js owns what "too long" means for extracted
// text, and a second constant with the same name and intent is two numbers that drift apart the
// first time one of them is tuned — the dead-code gate flags exactly that as a duplicate export.
const { MAX_TEXT_CHARS } = require('../org/documents');

// Where a contribution's bytes land. Flat and uuid-named, so the contributor's filename never
// reaches a path — the same store P1's uploads use, for the same reason.
const CONTRIBUTION_STORE = 'org-docs';

// Who is contributing, mapped to the catalog's source vocabulary. A closed map rather than a string
// passed through: an unrecognised source silently normalises to 'agent-output' (P1 §9 item 23), and
// on this path that would relabel a person's private contribution as instance material — which is
// exactly the class of record the operator override CAN read.
const KIND_SOURCE = Object.freeze({
  personnel: 'personnel-contribution',
  clone: 'clone-contribution',
});

const KINDS = Object.freeze(Object.keys(KIND_SOURCE));

/**
 * Decide whether a contribution may be stored, and as what. Writes nothing.
 *
 * @param {object}   incoming
 * @param {string}   incoming.id           record id to mint (a uuid from the caller)
 * @param {string}   incoming.kind         'personnel' | 'clone'
 * @param {string}   incoming.contributor  the person's address — the org key for this contribution
 * @param {string}   incoming.title        a label, never a path
 * @param {string}   incoming.text         the content
 * @param {string[]} [incoming.principals] additional named readers
 * @param {string}   [incoming.cloneId]    which clone, when kind === 'clone'
 * @param {string[]} [incoming.tags]
 * @param {string}   [incoming.contentHash] sha256 of the text, from the caller
 * @returns {{ok:true, record:object, reason:string} | {ok:false, error:string, leaks?:string[]}}
 */
function planContribution(incoming) {
  const src = (incoming && typeof incoming === 'object') ? incoming : {};

  // --- Rule 1, and it runs FIRST -----------------------------------------------------------------
  // Before validation, before shaping, before anything that might normalise a forbidden field out of
  // sight. A refusal has to be able to say what tripped it, and it can only do that while the
  // offending payload is still intact.
  const leaks = readers.findPersonaLeaks(src);
  if (leaks.length) {
    return {
      ok: false,
      error: 'that contribution contains persona-derived material and cannot be published to the '
        + 'library, which every agent on this instance can read. Remove the offending field(s) and '
        + 'contribute the finished work instead of the material it was derived from.',
      leaks,
    };
  }

  const kind = String(src.kind || '').trim().toLowerCase();
  if (!KINDS.includes(kind)) {
    return { ok: false, error: `kind must be one of ${KINDS.join(', ')}` };
  }
  if (kind === 'clone' && !String(src.cloneId || '').trim()) {
    return { ok: false, error: 'a clone contribution must name the clone it came from' };
  }

  const contributor = String(src.contributor || '').trim().toLowerCase();
  if (!contributor) return { ok: false, error: 'a contributor is required' };

  const title = String(src.title || '').trim();
  if (!title) return { ok: false, error: 'a title is required' };

  const text = String(src.text == null ? '' : src.text);
  if (!text.trim()) return { ok: false, error: 'there is nothing to contribute — the text is empty' };
  if (text.length > MAX_TEXT_CHARS) {
    return { ok: false, error: `that is longer than the ${MAX_TEXT_CHARS} character limit` };
  }

  const contentHash = String(src.contentHash || '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(contentHash)) {
    return { ok: false, error: 'a sha256 contentHash of the text is required' };
  }

  // --- Rule 2 and 3 ------------------------------------------------------------------------------
  // No allAgents, no allOperators — not as a default, not as an option. buildReaders only emits a
  // sentinel when its own boolean flag is set, and this call site never sets one, so there is no
  // input to this function that produces a broadly-readable contribution. The contributor is added
  // twice (owner and contributor) because buildReaders dedupes and the two roles are conceptually
  // distinct; a later change that stops treating the contributor as owner should not silently drop
  // them from their own reader list.
  const allowlist = readers.buildReaders({
    owner: contributor,
    contributor,
    principals: Array.isArray(src.principals) ? src.principals : [],
  });

  const record = catalog.normalizeRecord({
    id: src.id,
    title,
    store: CONTRIBUTION_STORE,
    path: '',                          // addressed by record id; see intake.js
    contentHash,
    format: 'md',
    bytes: Buffer.byteLength(text, 'utf8'),
    source: KIND_SOURCE[kind],
    owner: contributor,
    addedBy: contributor,
    addedAt: src.addedAt,
    readers: allowlist,
    // Fail closed on the sensitivity scale too. A contribution is somebody's until they say
    // otherwise; an operator can widen it later through the P1 patch route, deliberately.
    sensitivity: 'confidential',
    retention: { policy: 'keep' },
    tags: Array.isArray(src.tags) ? src.tags : [],
  });

  // Belt and braces: the record we are about to hand back must itself be clean. normalizeRecord
  // drops unknown keys, so this cannot fail today — which is the point of asserting it. If a future
  // field carries a forbidden name into the schema, this catches it at the boundary rather than
  // after it is in the catalog every agent reads.
  const residual = readers.findPersonaLeaks(record);
  if (residual.length) {
    return { ok: false, error: 'internal: the shaped record still trips the persona tripwire', leaks: residual };
  }

  return {
    ok: true,
    record,
    reason: `${KIND_SOURCE[kind]} readable by ${allowlist.length} named principal(s), no broad grant`,
  };
}

// The consumed surface only — `CONTRIBUTION_STORE` and `KINDS` are internal, and MAX_TEXT_CHARS
// belongs to documents.js, which is where a caller should read it from.
module.exports = {
  planContribution,
};
