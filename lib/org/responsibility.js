// lib/org/responsibility.js
// ============================================================
//  Who handles what, defined once for the company.
//
//  This started as "part of clone creation" and was deliberately pulled out of it, for a reason that
//  is the whole point: if five people each declare their own responsibilities inside their own
//  persona, you get overlaps and gaps with NO WAY TO DETECT EITHER. Two people quietly both think
//  they own refunds; nobody owns contract disputes; and the system cannot tell you, because the
//  claims live in five separate documents that never meet. A central map can be checked. Five
//  self-declarations cannot.
//
//  What it buys beyond deduplication — and this is the larger win — is ROUTING. Until now a
//  requiresHuman topic escalated to "the owner", which is correct for a one-person business and
//  wrong for a company. With a map, "this mentions a contract dispute" becomes "this is Sam's".
//  The clone stops being a solo drafting tool and becomes a routing layer over the real org chart.
//
//  Personas REFERENCE this; they do not embed it. A persona says "contract disputes are not mine to
//  answer"; the map says whose they are. Those are different facts with different owners, and
//  copying the second into the first is how a reorganisation leaves ten personas pointing at
//  someone who left.
//
//  Matching uses persona.mentions — the same word-boundary matcher as the red-line and inbound
//  screens. Three matchers for one question is how "AI" started matching inside "again".
//
//  Pure module: shapes, matching, and analysis. No state, no I/O.
// ============================================================

'use strict';

const persona = require('../business-clone/persona');

const MAX_AREAS = 40;
const MAX_TOPICS_PER_AREA = 25;
const MAX_NAME = 120;

function norm(v) {
  return String(v == null ? '' : v).trim();
}
function normEmail(v) {
  return norm(v).toLowerCase();
}

function emptyMap(ownerEmail) {
  return { ownerEmail: normEmail(ownerEmail), areas: [], updatedAt: null };
}

/**
 * Normalise a map. Areas without a name or without a responsible person are dropped rather than
 * stored half-built — an area with no owner is exactly the gap this module exists to surface, and
 * storing it as if it were a real assignment hides the thing worth seeing.
 */
function normalizeMap(input) {
  const src = (input && typeof input === 'object') ? input : {};
  const seenIds = new Set();
  const areas = (Array.isArray(src.areas) ? src.areas : [])
    .map((a) => {
      if (!a || typeof a !== 'object') return null;
      const name = norm(a.name).slice(0, MAX_NAME);
      const handler = normEmail(a.handler);
      if (!name || !handler) return null;
      const topics = (Array.isArray(a.topics) ? a.topics : [])
        .map((t) => norm(t).slice(0, MAX_NAME))
        .filter(Boolean)
        .filter((t, i, arr) => arr.findIndex((x) => x.toLowerCase() === t.toLowerCase()) === i)
        .slice(0, MAX_TOPICS_PER_AREA);
      const id = norm(a.id) || name.toLowerCase().replace(/[^\w]+/g, '-').slice(0, 60);
      if (seenIds.has(id)) return null;
      seenIds.add(id);
      return { id, name, handler, backup: normEmail(a.backup), topics, note: norm(a.note).slice(0, 500) };
    })
    .filter(Boolean)
    .slice(0, MAX_AREAS);

  return { ownerEmail: normEmail(src.ownerEmail), areas, updatedAt: src.updatedAt || null };
}

/**
 * Who should this text go to? Returns every matching area, because a message mentioning two topics
 * genuinely belongs to two people and picking one silently would be a routing decision disguised as
 * a lookup. The caller decides what to do with more than one.
 */
function routeFor(map, text) {
  const m = normalizeMap(map);
  const body = String(text || '').toLowerCase();
  return m.areas
    .filter((a) => a.topics.some((t) => persona.mentions(body, t)))
    .map((a) => ({
      areaId: a.id,
      area: a.name,
      handler: a.handler,
      backup: a.backup || null,
      matched: a.topics.filter((t) => persona.mentions(body, t)),
    }));
}

/**
 * Topics claimed by more than one area. The reason the map is central: this question cannot even be
 * asked of five separate self-declarations.
 */
function findOverlaps(map) {
  const m = normalizeMap(map);
  const byTopic = new Map();
  for (const a of m.areas) {
    for (const t of a.topics) {
      const key = t.toLowerCase();
      if (!byTopic.has(key)) byTopic.set(key, { topic: t, areas: [] });
      byTopic.get(key).areas.push({ areaId: a.id, area: a.name, handler: a.handler });
    }
  }
  return [...byTopic.values()].filter((e) => e.areas.length > 1);
}

/**
 * Escalation topics that nobody owns.
 *
 * This is the dangerous direction. An overlap means two people both look at something; a gap means a
 * clone will refuse to answer and hand off to nobody in particular. Feed it every requiresHuman
 * topic across the org's clones plus the company profile's own.
 */
function findGaps(map, escalationTopics) {
  const m = normalizeMap(map);
  const seen = new Set();
  const gaps = [];
  for (const raw of (escalationTopics || [])) {
    const topic = norm(raw);
    if (!topic) continue;
    const key = topic.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    // A topic is covered if some area's topic matches it, in either direction — an area topic of
    // "contract" covers an escalation topic of "contract dispute", and vice versa.
    const covered = m.areas.some((a) => a.topics.some((t) =>
      persona.mentions(topic.toLowerCase(), t) || persona.mentions(t.toLowerCase(), topic)));
    if (!covered) gaps.push(topic);
  }
  return gaps;
}

/**
 * Areas pointing at somebody who is not in the org. A reorganisation or an offboarding leaves these
 * behind, and an area routed to a departed colleague is a silent black hole.
 */
function findUnknownHandlers(map, memberEmails) {
  const m = normalizeMap(map);
  const members = new Set((memberEmails || []).map(normEmail));
  const out = [];
  for (const a of m.areas) {
    if (!members.has(a.handler)) out.push({ areaId: a.id, area: a.name, handler: a.handler, field: 'handler' });
    if (a.backup && !members.has(a.backup)) out.push({ areaId: a.id, area: a.name, handler: a.backup, field: 'backup' });
  }
  return out;
}

/** Everything worth warning about, in one call, for a dashboard health panel. */
function analyse(map, { escalationTopics = [], memberEmails = [] } = {}) {
  return {
    areas: normalizeMap(map).areas.length,
    overlaps: findOverlaps(map),
    gaps: findGaps(map, escalationTopics),
    unknownHandlers: findUnknownHandlers(map, memberEmails),
  };
}

function getMap(maps, ownerEmail) {
  const key = normEmail(ownerEmail);
  if (!key) return null;
  return (maps || []).find((m) => m && m.ownerEmail === key) || null;
}

module.exports = {
  emptyMap,
  normalizeMap,
  routeFor,
  findOverlaps,
  findGaps,
  findUnknownHandlers,
  analyse,
  getMap,
};
