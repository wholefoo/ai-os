// lib/leads/local-seo.js — Local SEO / Google Business Profile audit dimension.
//
// The 7th audit agent. For local businesses (dentists, trades, salons — exactly the prospecting
// target) their Google Business Profile and local-pack ranking often matter MORE than organic SEO,
// and it's the most visceral thing to show a prospect. This scores:
//   - GBP presence + completeness (hours, phone, website, photos, description, category, claimed)
//   - review signals (rating + volume)
//   - local-pack ranking for their niche keyword in their city
//
// COMPLIANCE: DataForSEO Business Data + Maps SERP APIs, never scraping. Business identity comes
// from a carried-through prospect record when the audit was launched from prospecting (exact name +
// placeId + rating/reviews already in hand — reliable), else a best-effort lookup by a brand name
// derived from the domain. Non-local sites (SaaS, etc.) with no GBP match return applicable:false so
// the dimension is excluded from the composite and the lead email — never a misleading red zero.
//
// Pure logic (derive/normalize/score) is exported for the unit suite; the one network entrypoint
// (analyzeLocal) takes an injected deps.dfsRequest so tests never touch the wire.

const clean = (s, max = 300) => String(s == null ? '' : s).trim().slice(0, max);

// 'riverside-dental.com' -> 'riverside dental' (best-effort GBP-lookup keyword when no prospect).
function deriveBrand(domain) {
  return String(domain || '')
    .replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/.*$/, '')
    .replace(/\.[a-z.]+$/i, '')       // strip TLD
    .replace(/[-_.]+/g, ' ').trim();
}

// DataForSEO business_data/google/my_business_info/live -> one GBP shape (all fields defensive).
function normalizeMyBusiness(dfsResponse) {
  const item = dfsResponse?.tasks?.[0]?.result?.[0]?.items?.[0];
  if (!item || !(item.title || item.name)) return null;
  const work = item.work_time?.work_hours || item.work_hours || item.work_time || null;
  const photos = Number(item.total_photos ?? item.photos_count ?? (Array.isArray(item.photos) ? item.photos.length : 0)) || 0;
  return {
    name: clean(item.title || item.name, 200),
    category: clean(item.category, 120),
    address: clean(item.address, 300),
    phone: clean(item.phone, 40),
    website: clean(item.url || item.domain || '', 300),
    rating: Number(item.rating?.value) || null,
    reviews: Number(item.rating?.votes_count) || 0,
    hasHours: !!(work && (Array.isArray(work) ? work.length : Object.keys(work).length)),
    photos,
    hasDescription: !!clean(item.description, 5),
    claimed: item.is_claimed === true || item.claimed === true,
    placeId: clean(item.place_id || (item.cid != null ? `cid:${item.cid}` : ''), 120),
  };
}

// A carried-through prospect record (from lib/leads/prospects.js) → the same partial GBP shape.
// We know it HAS a maps listing (that's where it came from) plus rating/reviews/category/site.
function gbpFromProspect(p) {
  if (!p) return null;
  return {
    name: clean(p.name, 200),
    category: clean(p.category, 120),
    address: clean(p.address, 300),
    phone: clean(p.phone, 40),
    website: clean(p.website, 300),
    rating: Number(p.rating) || null,
    reviews: Number(p.reviews) || 0,
    hasHours: null, photos: null, hasDescription: null, claimed: null, // unknown from prospecting alone
    placeId: clean(p.placeId, 120),
    _fromProspect: true,
  };
}

// Find the business's rank (1-based) in a Maps SERP by placeId (best), else fuzzy name match.
function findLocalRank(mapsResponse, { placeId, name } = {}) {
  const items = (mapsResponse?.tasks?.[0]?.result?.[0]?.items || []).filter((i) => i && (i.type === 'maps_search' || i.title));
  const normName = String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (placeId && it.place_id && it.place_id === placeId) return it.rank_absolute || (i + 1);
    if (normName && String(it.title || '').toLowerCase().replace(/[^a-z0-9]/g, '').includes(normName)) return it.rank_absolute || (i + 1);
  }
  return null;
}

// Score the local presence 0–100 (higher = healthier; a weak/absent GBP scores LOW, which correctly
// flags the prospect as needing help) + surface the GAPS as findings for the pitch.
function scoreLocal({ gbp, localRank, keyword }) {
  if (!gbp) {
    return {
      applicable: false, score: null, local: { present: false },
      findings: [{ severity: 'info', issue: 'No Google Business Profile found for this site', recommendation: 'This looks like a non-local business, or the profile is unclaimed/mismatched. If they serve a local area, claiming and completing a Google Business Profile is the single highest-impact local move.' }],
    };
  }
  let score = 20; // GBP exists
  const findings = [];
  const gap = (cond, sev, issue, rec) => { if (cond) findings.push({ severity: sev, issue, recommendation: rec }); };

  findings.push({ severity: 'info', issue: `Google Business Profile found: ${gbp.name}${gbp.category ? ` (${gbp.category})` : ''}`, recommendation: gbp.claimed === false ? 'Profile appears UNCLAIMED — claim it immediately to control the listing.' : 'Profile is live; the gaps below are the opportunities.' });

  if (gbp.website) score += 10; else gap(true, 'high', 'No website linked on the Google Business Profile', 'Add the website URL to the profile — it drives the "Website" button clicks that convert.');
  if (gbp.phone) score += 10; else gap(true, 'high', 'No phone number on the profile', 'Add a local phone number so customers can call directly from search.');
  if (gbp.claimed) score += 5; else if (gbp.claimed === false) score += 0;
  if (gbp.hasHours) score += 10; else if (gbp.hasHours === false) gap(true, 'medium', 'No business hours on the profile', 'Add opening hours — profiles without hours lose clicks and rank lower locally.');
  if (gbp.photos >= 5) score += 10; else if (gbp.photos != null) gap(gbp.photos < 5, 'medium', `Only ${gbp.photos} photo(s) on the profile`, 'Add 5+ photos — listings with photos get significantly more calls and direction requests.');
  if (gbp.hasDescription) score += 5; else if (gbp.hasDescription === false) gap(true, 'low', 'No business description on the profile', 'Add a keyword-rich description of the services and service area.');
  if (gbp.category) score += 5; else gap(true, 'medium', 'No primary category set', 'Set the most specific matching category — it strongly influences which searches you appear in.');

  if (gbp.rating != null && gbp.rating >= 4) score += 10;
  else if (gbp.rating != null && gbp.rating > 0) gap(true, 'medium', `Rating is ${gbp.rating}★`, 'A sub-4★ rating suppresses clicks — a review-generation campaign is a fast win.');
  if (gbp.reviews >= 50) score += 15; else if (gbp.reviews >= 10) score += 10;
  else gap(gbp.reviews < 10, 'high', `Only ${gbp.reviews} review(s)`, 'Low review volume caps local ranking. Ask recent customers for reviews — the platform can automate the requests.');

  // Local-pack ranking for their niche keyword.
  if (localRank != null) {
    if (localRank <= 3) { score += 15; findings.push({ severity: 'info', issue: `Ranks #${localRank} in the Google local pack for "${keyword}"`, recommendation: 'Top-3 local visibility — protect it with steady reviews and posts.' }); }
    else if (localRank <= 10) { score += 8; gap(true, 'medium', `Ranks #${localRank} in the local pack for "${keyword}" (below the top 3)`, 'The top-3 pack gets the vast majority of clicks. GBP completeness + reviews are the levers to climb.'); }
    else { gap(true, 'high', `Not in the top 10 of the local pack for "${keyword}" (currently #${localRank})`, 'Effectively invisible in local search for the core term — the biggest opportunity here.'); }
  } else {
    gap(true, 'high', `Does not appear in the Google local pack for "${keyword}"`, 'No local-pack presence for the core term — completing the profile and building reviews is where to start.');
  }

  return {
    applicable: true,
    score: Math.max(0, Math.min(100, score)),
    local: { present: true, name: gbp.name, category: gbp.category, rating: gbp.rating, reviews: gbp.reviews, localRank: localRank ?? null, claimed: gbp.claimed, website: gbp.website, phone: gbp.phone, photos: gbp.photos, hasHours: gbp.hasHours },
    findings,
  };
}

// analyzeLocal({domain, keyword, location, prospect, deps}) -> { score, findings, local, applicable }
// deps.dfsRequest(endpoint, bodyArray) = server.js's DataForSEO caller (injected; mocked in tests).
async function analyzeLocal({ domain, keyword, location = 'United States', prospect = null, deps = {} }) {
  const dfsRequest = deps.dfsRequest;
  let gbp = gbpFromProspect(prospect);

  // If we don't already have GBP data from a prospect, look it up by a domain-derived brand name.
  if (!gbp && dfsRequest) {
    const brand = deriveBrand(domain);
    if (brand) {
      try {
        const r = await dfsRequest('business_data/google/my_business_info/live', [{ keyword: brand, location_name: location, language_name: 'English' }]);
        gbp = normalizeMyBusiness(r);
      } catch { /* lookup failed — treated as no GBP below */ }
    }
  }
  if (!gbp) return scoreLocal({ gbp: null });

  // Local-pack rank for the niche keyword (from the GBP/prospect category, else the brand).
  const nicheKeyword = clean(keyword || gbp.category || deriveBrand(domain), 120);
  let localRank = null;
  if (dfsRequest && nicheKeyword) {
    try {
      const maps = await dfsRequest('serp/google/maps/live/advanced', [{ keyword: `${nicheKeyword} ${clean(gbp.address, 80) || location}`, language_code: 'en', location_name: location, depth: 20 }]);
      localRank = findLocalRank(maps, { placeId: gbp.placeId, name: gbp.name });
    } catch { /* rank unknown */ }
  }
  return scoreLocal({ gbp, localRank, keyword: nicheKeyword });
}

module.exports = { deriveBrand, normalizeMyBusiness, gbpFromProspect, findLocalRank, scoreLocal, analyzeLocal };
