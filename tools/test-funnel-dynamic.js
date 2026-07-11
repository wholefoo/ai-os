// P4 funnel primitive (applyFunnel) + P5 dynamic pages (expandDynamicPages) tests.
const { applyFunnel, expandDynamicPages } = require('../lib/web-studio/pipeline.js');
const aeoEmit = require('../lib/web-studio/aeo-emit.js');
const { assert, done } = require('./test-util');

const CHECKOUT = 'https://buy.stripe.com/test_abc123';

// --- funnel: landing → /offer → checkout, /thanks guaranteed
const funnelPlan = {
  siteName: 'Course X',
  pages: [
    { path: '/', title: 'Landing', sections: [{ type: 'hero', heading: 'Learn X', cta: { label: 'See the offer', href: '/#x' } }] },
    { path: '/offer', title: 'Offer', sections: [
      { type: 'pricing', items: [{ name: 'Full course', price: '$199', cta: { label: 'Buy', href: '/#y' } }] },
      { type: 'cta', heading: 'Ready?', cta: { label: 'Get access', href: '/#z' } },
    ] },
  ],
};
applyFunnel(funnelPlan, CHECKOUT);
const landing = funnelPlan.pages.find((p) => p.path === '/');
const offer = funnelPlan.pages.find((p) => p.path === '/offer');
assert(landing.sections[0].cta.href === '/offer', 'landing CTA points INTO the funnel (/offer)');
assert(offer.sections[0].items[0].cta.href === CHECKOUT, 'pricing-tier CTA points at the checkout link');
assert(offer.sections[1].cta.href === CHECKOUT, 'offer-page section CTA points at the checkout link');
const thanks = funnelPlan.pages.find((p) => p.path === '/thanks');
assert(thanks && thanks.sections.some((s) => s.type === 'steps'), '/thanks page auto-created with next-steps');
assert(funnelPlan.funnelCheckoutUrl === CHECKOUT, 'checkout URL recorded on the plan for rebuild re-application');

// idempotent: re-applying (as every rebuild does) changes nothing
const before = JSON.stringify(funnelPlan);
applyFunnel(funnelPlan, CHECKOUT);
assert(JSON.stringify(funnelPlan) === before, 'applyFunnel is idempotent across rebuilds');

// http (non-https) checkout is refused
const insecure = { pages: [{ path: '/', sections: [{ type: 'cta', cta: { label: 'x', href: '/keep' } }] }] };
applyFunnel(insecure, 'http://not-secure.example/pay');
assert(insecure.pages[0].sections[0].cta.href === '/keep' && !insecure.funnelCheckoutUrl, 'non-https checkout URL is rejected, plan untouched');

// single-page funnel (no offer page): CTAs sell directly
const onePage = { pages: [{ path: '/', sections: [{ type: 'hero', cta: { label: 'Buy', href: '/#a' } }] }] };
applyFunnel(onePage, CHECKOUT);
assert(onePage.pages[0].sections[0].cta.href === CHECKOUT, 'single-page funnel points landing CTA at checkout');

// --- dynamic pages
const dynPlan = {
  siteName: 'Acme Dental', domain: 'acmedental.com',
  pages: [{ path: '/', title: 'Home', sections: [] }],
  dynamic: {
    pathPrefix: 'Areas',
    template: { title: 'Dentist in {{city}}', description: 'Trusted dental care in {{city}}.', sections: [
      { type: 'hero', heading: 'Your dentist in {{city}}', subheading: 'Call {{phone}} — same-week appointments.' },
      { type: 'faq', items: [{ q: 'Do you serve {{city}}?', a: 'Yes — our office is minutes from {{city}}.' }] },
    ] },
    items: [
      { slug: 'Mesa!', city: 'Mesa', phone: '480-555-0100' },
      { slug: 'tempe', city: 'Tempe', phone: '480-555-0101' },
      { slug: '', city: 'NoSlug' },                    // dropped: no usable slug
      { slug: 'mesa', city: 'Dup' },                   // dropped: duplicate path after sanitize
    ],
  },
};
const expanded = expandDynamicPages(dynPlan);
assert(dynPlan.pages.length === 1, 'expansion is pure — original plan untouched');
assert(expanded.pages.length === 3, `1 static + 2 dynamic pages, got ${expanded.pages.length}`);
const mesa = expanded.pages.find((p) => p.path === '/areas/mesa');
assert(mesa && mesa.title === 'Dentist in Mesa' && mesa.sections[0].subheading.includes('480-555-0100'), 'placeholders substituted (prefix + slug sanitized to /areas/mesa)');
assert(mesa.sections[1].items[0].a === 'Yes — our office is minutes from Mesa.', 'substitution reaches nested faq items');
assert(expanded.pages.find((p) => p.path === '/areas/tempe'), 'second row expanded');

// downstream emitters see the expanded pages
assert(aeoEmit.sitemapXml(expanded).includes('/areas/mesa'), 'sitemap includes dynamic pages');
assert(aeoEmit.llmsTxt(expanded).includes('Dentist in Tempe'), 'llms.txt lists dynamic pages');
assert(aeoEmit.okfBundle(expanded, {}).some((f) => f.relPath === 'pages/areas-mesa.md'), 'OKF bundle includes dynamic page concepts');
assert(aeoEmit.faqLdObject(mesa).mainEntity[0].name === 'Do you serve Mesa?', 'dynamic page gets its own FAQPage JSON-LD');

// item cap
const big = expandDynamicPages({ pages: [], dynamic: { pathPrefix: 'x', template: { title: 't' }, items: Array.from({ length: 500 }, (_, i) => ({ slug: 's' + i })) } });
assert(big.pages.length === 200, `item cap enforced at 200, got ${big.pages.length}`);

done();
