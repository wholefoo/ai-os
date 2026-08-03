// Every place that decides whether a clone is READY must judge the EFFECTIVE persona.
//
// From a live failure: the founder finished his interview, the dashboard showed "Put to work", he
// clicked it, and the server answered "cannot activate". Both were right about what they measured.
// summarize() is handed the effective persona (personal + inherited company facts), so the button
// rendered; setStatus() checked clone.persona, so the write refused. Two functions in the same file
// disagreeing about what "ready" means, and the owner caught in between — told his clone was
// missing things he could see on his own persona screen, with no amount of further interviewing
// able to fix it, because those facts belong to the company and never enter a person's record.
//
// The whole class is covered here rather than the one button, because the same raw-persona read
// appeared at six sites and the others fail just as loudly: onboarding that never completes, and a
// dashboard nudging someone to finish an interview with nothing left to ask.
//
// The fixture is the real shape: a person with voice/expertise/decisions/limits of their own, whose
// IDENTITY comes from the company. That is every employee, and the founder too once a company
// profile exists.
const store = require('../lib/business-clone/store');
const onboarding = require('../lib/business-clone/onboarding');
const persona = require('../lib/business-clone/persona');
const profile = require('../lib/org/profile');
const { assert, done, serverSource } = require('./test-util');

const ORG = profile.normalizeProfile({
  ownerEmail: 'owner@example.com',
  identity: { businessName: 'Cedar Plant Hire', industry: 'Construction equipment', whatTheyDo: 'We hire excavators and dumpers to builders across the county.' },
  boundaries: { neverSay: ['cheapest anywhere'], requiresHuman: ['insurance claims'], pricingDisclosure: 'ranges' },
});

// Everything a PERSON can answer, and nothing the company owns.
const personalOnly = persona.normalize({
  identity: { ownerName: 'Dana', role: 'Owner', yearsExperience: 18 },
  voice: { formality: 3, directness: 4, warmth: 4, humor: 'warm', signaturePhrases: ['no surprises'], avoidPhrases: ['synergy'], signoff: '- Dana' },
  expertise: { domains: ['plant hire'], methodologies: ['weekly yard check'], credentials: ['CPA'], strongOpinions: [{ claim: 'day rates beat weekly' }], faq: [{ question: 'delivery?', answer: 'next day' }] },
  decisionStyle: { priorities: ['safety'], tradeoffRules: [{ when: 'tight', prefer: 'safety', over: 'speed' }], riskPosture: 'balanced', escalationTriggers: ['legal'] },
  boundaries: { neverSay: ['guaranteed'], neverPromise: ['same day'], requiresHuman: ['complaints'], pricingDisclosure: 'ranges' },
});

const effectiveOf = (clone) => profile.effectivePersona(clone.persona, ORG);
const mk = () => ({ id: 'c1', clientId: 'owner@example.com', persona: persona.normalize(personalOnly), personaVersion: 3, status: 'ready', corpus: [], interview: { turns: [] }, metrics: {}, createdAt: null, updatedAt: null });

// --- the premise: this persona is NOT usable alone, and IS usable merged --------------------------
// If either of these ever flips, the rest of the suite proves nothing.
assert(persona.isUsable(personalOnly).usable === false,
  'the fixture is genuinely incomplete on its own — it does not know what the business does');
assert(persona.isUsable(profile.effectivePersona(personalOnly, ORG)).usable === true,
  'and genuinely usable once the company facts merge in — this is the exact gap the bug fell into');

// --- setStatus: the reported bug -----------------------------------------------------------------
let threw = null;
try { store.setStatus(mk(), 'active'); } catch (e) { threw = e.message; }
assert(threw && /cannot activate/.test(threw),
  'judged by the raw persona, activation is refused — the old behaviour, kept as the control');

const ok = store.setStatus(mk(), 'active', effectiveOf);
assert(ok.status === 'active',
  'judged by the EFFECTIVE persona, the same clone activates — this is what the owner was blocked on');

// The resolver form and the plain-object form must agree; the object form is what summarize() takes.
assert(store.setStatus(mk(), 'active', profile.effectivePersona(personalOnly, ORG)).status === 'active',
  'a pre-computed effective persona works too');

// The bar itself must still be real. A guard that accepts everything is not a fix.
const empty = { ...mk(), persona: persona.normalize({ identity: { ownerName: 'X' } }) };
let stillRefuses = false;
try { store.setStatus(empty, 'active', effectiveOf); } catch { stillRefuses = true; }
assert(stillRefuses,
  'a genuinely thin persona is STILL refused even with company facts merged — the company supplies identity, not a voice or judgement');

// --- setStatus and summarize must agree, which is the actual invariant ---------------------------
// State it as the relationship rather than two separate facts: whenever the dashboard says usable,
// activation must succeed. The bug was precisely a divergence between these two.
for (const p of [personalOnly, persona.normalize({ identity: { ownerName: 'X' } })]) {
  const clone = { ...mk(), persona: persona.normalize(p) };
  const shown = store.summarize(clone, effectiveOf(clone));
  let activated = true;
  try { store.setStatus(clone, 'active', effectiveOf); } catch { activated = false; }
  assert(shown.usable === activated,
    `what the dashboard reports as usable (${shown.usable}) and what activation allows (${activated}) are the SAME judgement — a button that appears and then refuses is the bug this suite exists for`);
}

// --- setPersona: status must advance out of 'interviewing' ---------------------------------------
const interviewing = { ...mk(), status: 'interviewing' };
store.setPersona(interviewing, personalOnly);
assert(interviewing.status === 'interviewing',
  'raw judgement leaves them stuck at interviewing — the control');

const advancing = { ...mk(), status: 'interviewing' };
store.setPersona(advancing, personalOnly, effectiveOf);
assert(advancing.status === 'ready',
  'effective judgement advances to ready when the interview has nothing left to ask');

// The resolver is evaluated AFTER the new persona is assigned. A caller computing the effective
// persona before the call would judge the persona being replaced, so the function form exists to
// make that ordering impossible to get wrong.
const seen = [];
store.setPersona({ ...mk(), status: 'interviewing' }, personalOnly, (c) => { seen.push(c.persona.voice.signoff); return effectiveOf(c); });
assert(seen[0] === '- Dana', 'the resolver sees the NEXT persona, not the previous one');

// An explicit pause is still never overridden.
const paused = { ...mk(), status: 'paused' };
store.setPersona(paused, personalOnly, effectiveOf);
assert(paused.status === 'paused', "an owner's explicit pause survives a persona update");

// --- onboarding: completion and nudging ----------------------------------------------------------
const clones = [mk()];

const rawRec = onboarding.createRecord('owner@example.com');
onboarding.acceptDisclosure(rawRec);
onboarding.reconcile(rawRec, clones);
assert(rawRec.status === 'in_progress', 'raw judgement never completes onboarding — the control');
assert(onboarding.shouldPrompt(rawRec, clones) === true, 'and nudges forever');

const effRec = onboarding.createRecord('owner@example.com');
onboarding.acceptDisclosure(effRec);
onboarding.reconcile(effRec, clones, effectiveOf);
assert(effRec.status === 'completed', 'effective judgement completes onboarding');
assert(onboarding.shouldPrompt(effRec, clones, effectiveOf) === false,
  'and stops nudging someone to finish an interview that has nothing left to ask');

const ov = onboarding.overview(effRec, clones, effectiveOf);
assert(ov.status === 'completed' && ov.shouldPrompt === false, 'the overview agrees');
assert(ov.bestCompleteness === persona.completeness(effectiveOf(clones[0])).overall,
  'and reports completeness against the effective persona, matching the number on the clone screen');

// --- defaults are unchanged, so a solo owner with no company profile is unaffected ---------------
const solo = { ...mk(), persona: persona.normalize({ ...personalOnly, identity: { ...personalOnly.identity, businessName: 'Solo Ltd', industry: 'Trades', whatTheyDo: 'I fix boilers.' } }) };
assert(store.setStatus(solo, 'active').status === 'active',
  'a complete personal persona still activates with NO resolver passed — the fix is additive');
const soloRec = onboarding.createRecord('solo@example.com');
onboarding.acceptDisclosure(soloRec);
onboarding.reconcile(soloRec, [solo]);
assert(soloRec.status === 'completed', 'and their onboarding still completes without one');

// --- the wiring, which is where this class of bug actually lives ---------------------------------
// The modules can be correct while a route forgets the argument. That is how the raw-persona read
// survived here in the first place: summarize() was fixed and given a judgeBy parameter, and the
// two functions beside it were left reading clone.persona.
const fs = require('fs');
const path = require('path');
const src = serverSource();

// Bounded by `;` rather than `)`: these calls contain nested calls of their own
// (`listClones(businessClones, clientId)`), so a `[^)]*` window stops at the first inner paren and
// reports a correctly-wired site as broken. My first version of these three assertions did exactly
// that — the check was wrong, not the code.
for (const [call, why] of [
  [/cloneStore\.setStatus\([^;]*?cloneEffective\)/, 'the status route judges by the effective persona'],
  [/cloneOnb\.reconcile\([^;]*?cloneEffective\)/, 'onboarding reconcile does too'],
]) {
  assert(call.test(src), why);
}
assert((src.match(/cloneOnb\.overview\([^;]*?cloneEffective\)/g) || []).length === 4,
  'all four overview call sites pass it — one left behind reports a different status than its neighbours');
assert((src.match(/cloneStore\.setPersona\([^;]*cloneEffective\)/g) || []).length === 3,
  'all three setPersona call sites pass it — the interview, the correction form, and an accepted evolution proposal');

// No site may read the raw persona to decide readiness. Written as a sweep rather than a list so a
// NEW route cannot quietly reintroduce it.
const rawReadiness = /isUsable\(\s*(?:clone|c)\.persona\s*\)/g;
for (const f of ['lib/business-clone/store.js', 'lib/business-clone/onboarding.js']) {
  const body = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  assert(!rawReadiness.test(body),
    `${f} contains no isUsable(clone.persona) — readiness is judged by what the clone actually speaks with`);
}

done();
