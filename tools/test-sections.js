// Render tests for the P3 section library (testimonials, pricing, faq, stats, team, steps)
// + FAQPage JSON-LD + knowledge extraction for the new item fields.
const { renderSection, renderPage, buildSiteKnowledge } = require('../lib/web-studio/pipeline.js');
const aeoEmit = require('../lib/web-studio/aeo-emit.js');

const { assert, done } = require('./test-util');

// --- renderers
const testimonial = renderSection({ type: 'testimonials', heading: 'What clients say', items: [{ quote: 'Best <ever>', name: 'Ann Lee', role: 'CEO, Acme' }] }, {});
assert(testimonial.includes('&ldquo;Best &lt;ever&gt;&rdquo;') && testimonial.includes('Ann Lee'), 'testimonials render + escape HTML in quotes');

const pricing = renderSection({ type: 'pricing', heading: 'Plans', items: [
  { name: 'Basic', price: '$29', period: '/mo', features: ['One site', 'Email support'], cta: { label: 'Start', href: '/#contact' } },
  { name: 'Pro', price: '$99', period: '/mo', features: ['Everything in Basic'], highlight: true, cta: { label: 'Go Pro', href: '/#contact' } },
] }, {});
assert(pricing.includes('$29') && pricing.includes('One site') && pricing.includes('Go Pro'), 'pricing renders names/prices/features/ctas');
assert(pricing.includes('ring-brand'), 'highlighted plan gets the emphasis ring');

const faqSection = { type: 'faq', heading: 'FAQ', items: [{ q: 'Do you take insurance?', a: 'Yes, most major plans.' }, { q: 'Hours?', a: 'Mon-Sat 8-6.' }] };
const faq = renderSection(faqSection, {});
assert(faq.includes('<details') && faq.includes('Do you take insurance?') && faq.includes('Yes, most major plans.'), 'faq renders as zero-JS details/summary accordion');

const stats = renderSection({ type: 'stats', items: [{ value: '1,200+', label: 'patients served' }] }, {});
assert(stats.includes('1,200+') && stats.includes('patients served'), 'stats render');

const team = renderSection({ type: 'team', items: [{ name: 'Jane Roe', role: 'Founder', bio: 'Started in 2010.' }] }, {});
assert(team.includes('JR') && team.includes('Founder'), 'team renders with CSS initials avatar');

const steps = renderSection({ type: 'steps', heading: 'How it works', items: [{ title: 'Book', body: 'Pick a time.' }, { title: 'Visit', body: 'We handle the rest.' }] }, {});
assert(steps.includes('<ol') && steps.includes('Book') && steps.includes('>2<'), 'steps render numbered');

// unknown type still degrades to prose (regression)
const unknown = renderSection({ type: 'wat', body: 'x' }, {});
assert(unknown.includes('<section'), 'unknown type falls back to prose');

// --- FAQPage JSON-LD
const page = { path: '/', title: 'Home', sections: [faqSection, { type: 'hero', heading: 'Hi' }] };
const ld = aeoEmit.faqLdObject(page);
assert(ld && ld['@type'] === 'FAQPage' && ld.mainEntity.length === 2 && ld.mainEntity[0].acceptedAnswer.text === 'Yes, most major plans.', 'faqLdObject builds FAQPage from faq items');
assert(aeoEmit.faqLdObject({ sections: [{ type: 'faq', items: [] }] }) === null, 'no empty FAQPage emitted');
const astro = renderPage(page, undefined, { siteName: 'T', pages: [] });
assert(astro.includes('FAQPage') && astro.includes('application/ld+json'), 'renderPage embeds FAQPage JSON-LD');

// --- knowledge extraction picks up new fields
const plan = { siteName: 'T', pages: [{ path: '/', title: 'Home', sections: [faqSection,
  { type: 'pricing', items: [{ name: 'Basic', price: '$29', period: '/mo', features: ['One site'] }] },
  { type: 'stats', items: [{ value: '15', label: 'years' }] }] }] };
const know = buildSiteKnowledge(plan)[0].text;
assert(know.includes('Do you take insurance?') && know.includes('$29') && know.includes('years'), `site-chat knowledge carries faq/pricing/stats content`);
const okf = aeoEmit.okfBundle(plan, {});
const home = okf.find((f) => f.relPath === 'pages/home.md').body;
assert(home.includes('**Do you take insurance?**') && home.includes('$29 /mo — One site') && home.includes('**15** years'), 'OKF bundle formats faq/pricing/stats per type');

done();
