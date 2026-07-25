// lib/business-clone/compile.js
// ============================================================
//  Compiles a persona object into the prompt block that makes an agent draft as its owner.
//
//  This is the artifact the whole feature exists to produce, and it has three properties worth
//  protecting:
//
//  DETERMINISTIC — the same persona always compiles to the same string, byte for byte. That is what
//  makes the output diffable (P4 shows the owner "here is what changes if you accept this"), what
//  makes a fingerprint meaningful, and what makes a bad draft traceable to an exact prompt state.
//  Nothing here may depend on the clock, a random value, or object key ordering.
//
//  LOSSY ON PURPOSE — empty fields are omitted entirely rather than emitted as "unknown" or "n/a".
//  A prompt full of blanks teaches the model that blanks are normal and invites it to fill them in.
//  A shorter prompt containing only what the owner actually said is both cheaper and more faithful.
//
//  BOUNDARIES LAST — the constraint block is emitted at the end because recency carries weight in a
//  long system prompt. This is a nudge, not a guarantee: persona.checkRedLines re-checks the output
//  in code, because instructions reduce the odds of a violation and never eliminate them.
//
//  Scales are rendered as words, not numbers. "Be blunt; lead with the conclusion" produces
//  markedly more consistent behaviour than "directness: 5/5", which a model has to interpret
//  against an invented rubric.
//
//  Pure module: no model calls, no I/O, no clock.
// ============================================================

'use strict';

const crypto = require('crypto');
const persona = require('./persona');

// Scale renderings. Index 0 is unused so the 1-5 scale indexes directly — off-by-one here would be
// a subtle voice bug rather than a crash, so the shape is kept literal.
const SCALE_WORDS = {
  formality: [null,
    'Very casual. Contractions, lower-case starts, fragments are fine.',
    'Casual and relaxed, but complete sentences.',
    'Neither stiff nor chatty — plain professional register.',
    'Fairly formal. Full sentences, no slang.',
    'Formal throughout. Precise, composed, no contractions.'],
  directness: [null,
    'Diplomatic and indirect. Soften hard points and give context before conclusions.',
    'Tactful. Lead into difficult points gently.',
    'Balanced — clear, without being blunt.',
    'Direct. Say the real thing early.',
    'Blunt. Lead with the conclusion, no cushioning.'],
  warmth: [null,
    'Clinical and impersonal. Stick to substance.',
    'Reserved. Courteous but not personal.',
    'Professionally friendly.',
    'Warm. Acknowledge the person, not just the request.',
    'Very warm. Genuine personal engagement in every message.'],
};

const HUMOR_GUIDANCE = {
  none: 'Use no humour at all.',
  dry: 'Dry, understated humour — sparingly, never at the reader\'s expense.',
  warm: 'Warm, gentle humour that puts people at ease.',
  playful: 'Playful and light, but never flippant about a real problem.',
};

const SENTENCE_GUIDANCE = {
  short: 'Short sentences. Break up anything long.',
  varied: 'Vary sentence length — mix short punches with longer explanation.',
  long: 'Longer, flowing sentences with room for qualification.',
};

const PRICING_GUIDANCE = {
  none: 'Never discuss pricing. Say pricing is handled personally and offer to arrange that.',
  ranges: 'You may give broad pricing ranges, never an exact quote or a commitment.',
  full: 'You may discuss published pricing in full detail.',
};

const RISK_GUIDANCE = {
  conservative: 'Default to caution. When unsure, choose the reversible option and say so.',
  balanced: 'Weigh upside against downside; neither reckless nor timid.',
  aggressive: 'Bias toward action and speed; accept sensible risk to move quickly.',
};

/** Render a labelled list, or nothing at all when empty. */
function listBlock(label, items, bullet = '- ') {
  if (!items || !items.length) return '';
  return `${label}\n${items.map((i) => `${bullet}${i}`).join('\n')}`;
}

function line(label, value) {
  return value ? `${label} ${value}` : '';
}

/** Join sections, dropping empties and collapsing the blank lines they would have left behind. */
function joinSections(parts) {
  return parts.filter((p) => p && String(p).trim()).join('\n\n');
}

function compileIdentity(id) {
  const who = [
    line('Name:', id.ownerName),
    line('Role:', id.role),
    line('Business:', id.businessName),
    line('Industry:', id.industry),
    line('Location:', id.location),
    id.yearsExperience ? `Experience: ${id.yearsExperience} years in this field` : '',
  ].filter(Boolean).join('\n');

  return joinSections([
    who ? `## Who you are\n${who}` : '',
    id.whatTheyDo ? `## What the business does\n${id.whatTheyDo}` : '',
  ]);
}

function compileVoice(v) {
  const traits = [
    v.formality ? SCALE_WORDS.formality[v.formality] : '',
    v.directness ? SCALE_WORDS.directness[v.directness] : '',
    v.warmth ? SCALE_WORDS.warmth[v.warmth] : '',
    v.humor ? HUMOR_GUIDANCE[v.humor] : '',
    v.sentenceLength ? SENTENCE_GUIDANCE[v.sentenceLength] : '',
  ].filter(Boolean).map((t) => `- ${t}`).join('\n');

  return joinSections([
    traits ? `## How you write\n${traits}` : '',
    listBlock('Phrases you actually use (work them in naturally — do not force every one):', v.signaturePhrases),
    listBlock('Never use this language:', v.avoidPhrases),
    listBlock('Vocabulary that is characteristic of you:', v.vocabulary),
    [line('Open with:', v.greeting), line('Sign off with:', v.signoff)].filter(Boolean).join('\n'),
  ]);
}

function compileExpertise(e) {
  const opinions = e.strongOpinions.map((o) => (o.rationale ? `- ${o.claim} — ${o.rationale}` : `- ${o.claim}`)).join('\n');
  const faq = e.faq.map((f) => `Q: ${f.question}\nA: ${f.answer}`).join('\n\n');

  return joinSections([
    listBlock('## What you are expert in', e.domains),
    listBlock('How you work:', e.methodologies),
    listBlock('Credentials you can point to:', e.credentials),
    opinions ? `Where you disagree with your own industry (these are genuinely your views — hold them):\n${opinions}` : '',
    faq ? `## Questions you get constantly, and how you answer them\nReuse this substance and phrasing when it fits; these are your real answers.\n\n${faq}` : '',
  ]);
}

function compileDecisionStyle(d) {
  const rules = d.tradeoffRules
    .map((r) => `- When ${r.when}: choose ${r.prefer}${r.over ? ` over ${r.over}` : ''}.`)
    .join('\n');

  return joinSections([
    d.priorities.length
      ? `## What you protect, in order\nWhen these conflict, the earlier one wins.\n${d.priorities.map((p, i) => `${i + 1}. ${p}`).join('\n')}`
      : '',
    rules ? `Trade-offs you make routinely:\n${rules}` : '',
    d.riskPosture ? `Risk posture: ${RISK_GUIDANCE[d.riskPosture]}` : '',
  ]);
}

/**
 * Boundaries. Emitted last and phrased as absolutes — this block is the difference between a
 * clone that is safe to point at a customer and one that is not.
 */
function compileBoundaries(b) {
  return joinSections([
    '## Hard limits — these override everything above',
    listBlock('Never say any of the following, in any phrasing:', b.neverSay),
    listBlock('Never promise or guarantee anything regarding:', b.neverPromise),
    listBlock('Do NOT answer these topics. Say it needs the owner personally, and stop:', b.requiresHuman),
    listBlock('Never disclose or discuss:', b.confidentialTopics),
    b.pricingDisclosure ? `Pricing: ${PRICING_GUIDANCE[b.pricingDisclosure]}` : '',
    b.competitorPolicy ? `On competitors: ${b.competitorPolicy}` : '',
    'If a request falls outside what you actually know, say so plainly rather than inventing an answer. A draft that admits a gap is useful; a confident wrong answer is not.',
  ]);
}

/**
 * Compile a persona into a system-prompt block.
 *
 * The framing header states that a human reviews the output before it is sent. That is true (the
 * clone is draft-only) and it is load-bearing: it stops the model from hedging defensively the way
 * it would if it believed it were speaking unsupervised to a customer.
 */
function compile(personaInput) {
  const p = persona.normalize(personaInput);
  const name = p.identity.ownerName || 'the owner';

  const header = [
    `You are drafting as ${name}. Not as an assistant helping ${name} — as ${name}.`,
    'Write in the first person, in their voice, using their knowledge and their judgement.',
    '',
    `Everything you produce is reviewed by ${name} before it goes anywhere. Write the real draft:`,
    'do not hedge, do not add disclaimers they would not write, and do not caveat your way out of',
    'having a view. If you genuinely do not know something, say so in their voice.',
  ].join('\n');

  return joinSections([
    header,
    compileIdentity(p.identity),
    compileVoice(p.voice),
    compileExpertise(p.expertise),
    compileDecisionStyle(p.decisionStyle),
    compileBoundaries(p.boundaries),
  ]);
}

/**
 * Short stable hash of the compiled prompt. Stamped onto drafts so a bad output can be traced to
 * the exact prompt that produced it — personaVersion tracks the record, this tracks the artifact,
 * and they can disagree (a schema or wording change here alters every prompt without touching any
 * persona). When that happens, this is the one that explains the behaviour change.
 */
function fingerprint(personaInput) {
  return crypto.createHash('sha256').update(compile(personaInput), 'utf8').digest('hex').slice(0, 12);
}

/** Rough token estimate for cost display. Deliberately crude — 4 chars/token is close enough. */
function estimateTokens(personaInput) {
  return Math.ceil(compile(personaInput).length / 4);
}

module.exports = {
  compile,
  fingerprint,
  estimateTokens,
};
