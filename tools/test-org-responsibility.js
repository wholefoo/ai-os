// Tests lib/org/responsibility: routing an escalation to the person who actually owns it, and the
// three things a CENTRAL map can detect that five separate self-declarations cannot — overlaps,
// gaps, and areas pointing at somebody who is no longer here.
const persona = require('../lib/business-clone/persona');
const resp = require('../lib/org/responsibility');

const { assert, done } = require('./test-util');

const MAP = resp.normalizeMap({
  ownerEmail: 'dana@whitfield.com',
  areas: [
    { name: 'Legal', handler: 'Sam@Whitfield.com', topics: ['contract dispute', 'liability'], note: 'Anything with a lawyer in it' },
    { name: 'Finance', handler: 'jo@whitfield.com', backup: 'dana@whitfield.com', topics: ['refund', 'invoice'] },
    { name: 'Safety', handler: 'dana@whitfield.com', topics: ['injury'] },
  ],
});

// --- normalisation
assert(MAP.areas.length === 3, 'three areas survive normalisation');
assert(MAP.areas[0].handler === 'sam@whitfield.com', 'handler addresses are normalised');
assert(MAP.areas[0].id === 'legal', 'an id is derived from the name when not supplied');

// An area with no name or no handler is DROPPED, not stored half-built — an unassigned area is the
// exact gap this module exists to surface, and storing it hides the thing worth seeing.
const partial = resp.normalizeMap({ areas: [
  { name: 'Nameless handler only', handler: 'x@y.com' },
  { name: 'No handler' },
  { handler: 'orphan@y.com' },
  { name: 'Dupe', handler: 'a@b.com', id: 'dupe' },
  { name: 'Dupe again', handler: 'c@d.com', id: 'dupe' },
] });
assert(partial.areas.length === 2, `areas without a name or handler are dropped, and duplicate ids collapse (got ${partial.areas.length})`);
assert(partial.areas.every((a) => a.name && a.handler), 'every stored area has both');

const capped = resp.normalizeMap({ areas: [{ name: 'Big', handler: 'x@y.com', topics: Array.from({ length: 80 }, (_, i) => `t${i}`) }] });
assert(capped.areas[0].topics.length === 25, 'topics per area are capped');
const dupeTopics = resp.normalizeMap({ areas: [{ name: 'D', handler: 'x@y.com', topics: ['Refund', 'refund', 'REFUND'] }] });
assert(dupeTopics.areas[0].topics.length === 1, 'topics dedupe case-insensitively');

// --- routing: the actual payoff
const legal = resp.routeFor(MAP, 'We need to talk about the contract dispute on our March order.');
assert(legal.length === 1 && legal[0].handler === 'sam@whitfield.com', 'a contract dispute routes to Sam, not to the owner');
assert(legal[0].area === 'Legal' && legal[0].matched.includes('contract dispute'), 'the route says which area and which topic matched');

const finance = resp.routeFor(MAP, 'Can I get a refund on invoice 4021?');
assert(finance.length === 1 && finance[0].handler === 'jo@whitfield.com', 'money goes to Jo');
assert(finance[0].backup === 'dana@whitfield.com', 'and carries the backup');
assert(finance[0].matched.length === 2, 'both matching topics are reported');

// Two topics genuinely belong to two people. Silently picking one would be a routing DECISION
// disguised as a lookup, so both come back and the caller decides.
const both = resp.routeFor(MAP, 'There was an injury, and now they want a refund.');
assert(both.length === 2, `a message spanning two areas returns both (got ${both.length})`);
assert(both.map((r) => r.handler).sort().join(',') === 'dana@whitfield.com,jo@whitfield.com', 'both handlers');

assert(resp.routeFor(MAP, 'Do you install the chairs you sell?').length === 0, 'an ordinary message routes nowhere');
assert(resp.routeFor(null, 'refund').length === 0, 'no map, no routes');

// Matching uses the SAME word-boundary matcher as the red-line and inbound screens. Three matchers
// for one question is how "AI" started matching inside "again".
const shortMap = resp.normalizeMap({ areas: [{ name: 'AI', handler: 'x@y.com', topics: ['AI'] }] });
assert(resp.routeFor(shortMap, 'Please advise again about this').length === 0, 'a short topic does not match inside a word');
assert(resp.routeFor(shortMap, 'Can your AI do this?').length === 1, 'but does as a word');

// --- OVERLAPS: the question you cannot ask of five separate declarations
assert(resp.findOverlaps(MAP).length === 0, 'a clean map has no overlaps');
const overlapping = resp.normalizeMap({ areas: [
  { name: 'Legal', handler: 'sam@x.com', topics: ['refund', 'contract'] },
  { name: 'Finance', handler: 'jo@x.com', topics: ['Refund', 'invoice'] },
] });
const ov = resp.findOverlaps(overlapping);
assert(ov.length === 1 && ov[0].topic.toLowerCase() === 'refund', 'a topic claimed twice is surfaced');
assert(ov[0].areas.length === 2, 'with both claimants named');
assert(ov[0].areas.map((a) => a.handler).includes('sam@x.com'), 'so the owner knows who to ask');

// --- GAPS: the dangerous direction — a clone refuses and hands off to nobody
assert(resp.findGaps(MAP, ['contract dispute', 'refund']).length === 0, 'covered topics are not gaps');
const gaps = resp.findGaps(MAP, ['contract dispute', 'data breach', 'press enquiry']);
assert(gaps.length === 2 && gaps.includes('data breach'), `uncovered escalation topics are surfaced (${gaps.join(', ')})`);

// Coverage matches in EITHER direction — an area topic of "contract" covers "contract dispute",
// and an area topic of "contract dispute" covers an escalation topic of "contract".
const broad = resp.normalizeMap({ areas: [{ name: 'Legal', handler: 's@x.com', topics: ['contract'] }] });
assert(resp.findGaps(broad, ['contract dispute']).length === 0, 'a broad area covers a specific escalation topic');
const narrow = resp.normalizeMap({ areas: [{ name: 'Legal', handler: 's@x.com', topics: ['contract dispute'] }] });
assert(resp.findGaps(narrow, ['contract']).length === 0, 'and a specific area covers a broad one');

assert(resp.findGaps(MAP, ['REFUND']).length === 0, 'gap detection is case-insensitive');
assert(resp.findGaps(MAP, ['refund', 'refund', 'Refund']).length === 0, 'and deduplicates');
assert(resp.findGaps(MAP, []).length === 0 && resp.findGaps(MAP, null).length === 0, 'no topics, no gaps');

// --- handlers who are no longer here. An offboarding leaves these behind and they are silent.
const members = ['dana@whitfield.com', 'sam@whitfield.com', 'jo@whitfield.com'];
assert(resp.findUnknownHandlers(MAP, members).length === 0, 'all handlers present is clean');
const afterSamLeaves = resp.findUnknownHandlers(MAP, ['dana@whitfield.com', 'jo@whitfield.com']);
assert(afterSamLeaves.length === 1 && afterSamLeaves[0].handler === 'sam@whitfield.com', 'a departed handler is surfaced');
assert(afterSamLeaves[0].field === 'handler' && afterSamLeaves[0].area === 'Legal', 'naming the area that now routes nowhere');
const backupGone = resp.findUnknownHandlers(MAP, ['sam@whitfield.com', 'jo@whitfield.com']);
assert(backupGone.some((u) => u.field === 'backup'), 'a departed BACKUP is surfaced too');

// --- the one-call health summary
const health = resp.analyse(MAP, { escalationTopics: ['contract dispute', 'data breach'], memberEmails: ['dana@whitfield.com', 'jo@whitfield.com'] });
assert(health.areas === 3, 'the summary counts areas');
assert(health.gaps.includes('data breach'), 'and reports gaps');
assert(health.unknownHandlers.length === 1, 'and departed handlers');
assert(Array.isArray(health.overlaps), 'and overlaps');

assert(resp.getMap([MAP], 'DANA@whitfield.com') === MAP, 'map lookup is case-insensitive');
assert(resp.getMap([MAP], 'other@x.com') === null, 'another org has no map here');

// --- personas REFERENCE the map, they do not embed it
const p = persona.normalize({ boundaries: { requiresHuman: ['contract dispute'] } });
assert(!JSON.stringify(p).includes('sam@whitfield.com'), 'a persona holds the topic, never the handler — a reorganisation must not have to rewrite ten personas');

done();
