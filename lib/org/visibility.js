// lib/org/visibility.js
// ============================================================
//  What an employer may see of an employee's clone.
//
//  The line, decided deliberately rather than inherited from how other resources work:
//
//    VISIBLE   — that the clone exists and its status, every draft it produced, the verdicts, the
//                red-line violations, the escalations, the cost.
//    NOT VISIBLE — the persona itself, the compiled prompt, the interview transcript.
//
//  The employer's legitimate interest is "what is being said in my company's name", and drafts
//  answer that completely. The persona answers a different question — how this person thinks, what
//  they protect under pressure, the phrases that are unmistakably theirs. That is a psychological
//  profile, and needing the first does not entitle anyone to the second.
//
//  The implementation reflects that asymmetry. These builders construct an ALLOWLISTED object field
//  by field rather than deleting sensitive keys from the full record. A denylist leaks the moment
//  someone adds a field — and the field most likely to be added to a clone record is another piece
//  of the persona.
//
//  Pure module: shapes only. No state, no I/O.
// ============================================================

'use strict';

/** Keys that must never appear in anything an employer receives. Used by the tests as a tripwire. */
const FORBIDDEN_KEYS = ['persona', 'prompt', 'compiledPersona', 'transcript', 'interview', 'corpus', 'feedback', 'suggestion', 'proposed'];

/**
 * What the employer sees of a clone. Built by allowlist.
 *
 * `completeness` is included deliberately: it is a setup-progress number, not content, and an
 * employer needs to know whether onboarding finished. It says nothing about how the person thinks.
 */
function employerCloneView(clone, ownerUser) {
  if (!clone) return null;
  return {
    cloneId: clone.id,
    person: String(clone.clientId || '').toLowerCase(),
    personName: (ownerUser && ownerUser.name) || '',
    name: clone.name,
    role: clone.templateId || '',
    status: clone.status,
    completeness: null,          // filled by the caller from the EFFECTIVE persona
    personaVersion: clone.personaVersion,
    metrics: {
      draftsProduced: (clone.metrics && clone.metrics.draftsProduced) || 0,
      approved: (clone.metrics && clone.metrics.approved) || 0,
      edited: (clone.metrics && clone.metrics.edited) || 0,
      rejected: (clone.metrics && clone.metrics.rejected) || 0,
    },
    createdAt: clone.createdAt,
    updatedAt: clone.updatedAt,
  };
}

/**
 * What the employer sees of a draft: the whole thing. This IS the company's correspondence — the
 * message that came in, what the clone wrote, what the person actually sent, and whether it tripped
 * a limit. Withholding any of it would defeat the point of the visibility being granted at all.
 */
function employerDraftView(draft) {
  if (!draft) return null;
  return {
    id: draft.id,
    cloneId: draft.cloneId,
    person: String(draft.clientId || '').toLowerCase(),
    channel: draft.channel,
    source: draft.source,
    inbound: draft.inbound,
    text: draft.text,
    finalText: draft.finalText,
    status: draft.status,
    blocked: !!draft.blocked,
    violations: draft.violations || [],
    escalationReasons: draft.escalationReasons || [],
    note: draft.note || '',
    cost: draft.cost || 0,
    createdAt: draft.createdAt,
    reviewedAt: draft.reviewedAt,
  };
}

/**
 * Does this payload leak anything it should not? Returns the offending key paths.
 *
 * Exists so the tests can assert the boundary over WHOLE RESPONSES rather than field by field —
 * a check that only inspects the fields someone remembered to check is the same denylist problem
 * one level up.
 */
function findLeaks(payload) {
  const found = [];
  const walk = (node, path) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach((v, i) => walk(v, `${path}[${i}]`)); return; }
    for (const [k, v] of Object.entries(node)) {
      if (FORBIDDEN_KEYS.includes(k)) found.push(path ? `${path}.${k}` : k);
      walk(v, path ? `${path}.${k}` : k);
    }
  };
  walk(payload, '');
  return found;
}

module.exports = {
  FORBIDDEN_KEYS,
  employerCloneView,
  employerDraftView,
  findLeaks,
};
