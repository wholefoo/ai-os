// Tests the persona screen's handling of INHERITED company values in dashboard/js/clones.js.
//
// This suite exists because of a real complaint from production. The server was already correct:
// GET /api/clones/:id returns an `inherited` block from lib/org/profile.inheritedFrom, and
// effectivePersona merges those values at every decision site. The dashboard simply never read the
// block. So an employee — or the founder — opened the persona tab and saw Business, Industry and
// "What the business does" blank, with an empty input for each in the correction form, on an
// instance whose company document already answered all three.
//
// That is worse than cosmetic. A blank box is an instruction to type something, and typing there
// copies a company value into a personal record — the exact thing lib/org/profile.js is built to
// prevent, and the thing that makes a company fact impossible to correct centrally afterwards.
//
// The suite loads the browser file in a VM with the two globals it uses, then renders. No jsdom,
// no server: these functions are string builders, and asserting on their output is what a person
// looking at the screen would see.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const profile = require('../lib/org/profile');
const persona = require('../lib/business-clone/persona');
const { assert, done, serverSource } = require('./test-util');

const src = fs.readFileSync(path.join(__dirname, '..', 'dashboard', 'js', 'clones.js'), 'utf8');
const ctx = {
  escapeHtml: (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
  timeAgo: () => 'now',
  capitalize: (s) => s,
  fetchJSON: async () => ({}),
  showSettingsToast: () => {},
  document: { getElementById: () => null },
  console,
};
vm.createContext(ctx);
vm.runInContext(src, ctx);

// The inherited block is built by the REAL module, not hand-written. A test that invents the shape
// keeps passing after inheritedFrom changes it, which is the one failure this suite must not have.
const ORG = profile.normalizeProfile({
  ownerEmail: 'owner@example.com',
  identity: { businessName: 'Cedar Plant Hire', industry: 'Construction equipment', whatTheyDo: 'We hire out excavators and dumpers to builders across the county.' },
  boundaries: { neverSay: ['cheapest anywhere'], requiresHuman: ['insurance claims'], pricingDisclosure: 'ranges' },
});
const INHERITED = profile.inheritedFrom(ORG);
const EMPLOYEE = persona.normalize({
  identity: { ownerName: 'Sam', role: 'Yard manager' },
  boundaries: { neverSay: ['guaranteed same day'] },
});

// --- the view: a company-answered field is shown, and shown as the company's -------------------
const view = ctx.clPersonaHtml(EMPLOYEE, INHERITED);
assert(view.includes('Cedar Plant Hire'), 'the business name the company gave is displayed, not a blank row');
assert(view.includes('Construction equipment'), 'and the industry');
assert(view.includes('excavators and dumpers'), 'and what the business does');
assert((view.match(/from the company/g) || []).length >= 3,
  'each inherited value is LABELLED as the company\'s — an unlabelled value looks like something this person said, and they would try to edit it');

const own = ctx.clPersonaHtml(persona.normalize({ ...EMPLOYEE, identity: { ...EMPLOYEE.identity, businessName: 'the yard' } }), INHERITED);
assert(own.includes('the yard') && !own.includes('Cedar Plant Hire'),
  'a person who described the business in their own words keeps them — the company FILLS BLANKS, it does not overwrite, matching effectivePersona');

// Boundaries are additive, so both sets must be visible. Showing only the merged total would hide
// which lines this person can actually take back.
assert(view.includes('cheapest anywhere') && view.includes('guaranteed same day'),
  'company limits appear alongside the person\'s own rather than replacing them');

// Pricing is the one field where the company does not merely fill a blank: the MORE RESTRICTIVE of
// the two wins. A view that showed the person's own value here would disagree with the prompt the
// clone is actually compiled with.
const loose = ctx.clPersonaHtml(persona.normalize({ boundaries: { pricingDisclosure: 'full' } }), INHERITED);
const effLoose = profile.effectivePersona(persona.normalize({ boundaries: { pricingDisclosure: 'full' } }), ORG);
assert(loose.includes(effLoose.boundaries.pricingDisclosure) && !/>full</.test(loose),
  'a looser personal pricing rule DISPLAYS the company\'s stricter one, agreeing with effectivePersona rather than with the raw record');
const strict = ctx.clPersonaHtml(persona.normalize({ boundaries: { pricingDisclosure: 'none' } }), INHERITED);
assert(strict.includes('none'), 'a stricter personal rule is kept — the merge is restrictive-wins, not company-wins');

// --- the correction form: the original complaint -----------------------------------------------
const form = ctx.clPersonaFormHtml(EMPLOYEE, INHERITED);
for (const k of profile.inheritedIdentityFields(ORG)) {
  assert(!form.includes(`id="clF-identity-${k}"`),
    `${k} renders NO editable input while the company answers it — an empty box invites this person to retype what the company document already says, and clSavePersona reads the DOM, so the absent element is also what stops the value being copied onto them`);
}
assert(form.includes('Cedar Plant Hire'), 'the company\'s answer is still SHOWN in the form, read-only — hiding the field entirely would look like it was never asked');
assert(form.includes('id="clF-identity-ownerName"') && form.includes('id="clF-identity-role"'),
  'fields that are genuinely this person\'s stay editable');
assert(form.includes('id="clF-boundaries-neverSay"'),
  'an ADDITIVE company limit keeps its input — the person can add their own, they just cannot remove the company\'s');

// --- and none of this fires on an instance with no company profile ------------------------------
const solo = ctx.clPersonaFormHtml(EMPLOYEE, profile.inheritedFrom(profile.emptyProfile('x@y.com')));
for (const k of ['businessName', 'industry', 'whatTheyDo']) {
  assert(solo.includes(`id="clF-identity-${k}"`),
    `with no company profile, ${k} is editable exactly as it was — a sole trader is asked everything`);
}
assert(!ctx.clPersonaHtml(EMPLOYEE, {}).includes('from the company'),
  'and nothing claims a company answer that does not exist');

// --- the wiring itself, which is what actually broke ---------------------------------------------
// The functions above can be perfect while the caller passes nothing. That is precisely the bug
// this suite was written for: both render functions worked, and clRenderDetail dropped the block.
assert(/clPersonaFormHtml\(c\.persona \|\| \{\}, c\.inherited\)/.test(src) && /clPersonaHtml\(c\.persona \|\| \{\}, c\.inherited\)/.test(src),
  'clRenderDetail PASSES c.inherited to both renderers — a correct renderer called without it is the whole defect');
assert(/inherited: orgProfile\.inheritedFrom\(/.test(serverSource()),
  'and the clone detail route still sends an `inherited` block for it to read');

done();
