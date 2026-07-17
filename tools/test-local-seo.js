// Local SEO / Google Business Profile audit (lib/leads/local-seo.js): brand derivation from a
// domain, normalizing DataForSEO my_business_info responses + a carried-through prospect record
// into the common GBP shape, local-pack rank lookup (place_id first, then fuzzy name match), the
// 0-100 completeness/review/rank scorer + its findings, and the analyzeLocal() network entrypoint
// exercised entirely via an injected deps.dfsRequest mock — no network.
const { assert, done } = require('./test-util');
const {
  deriveBrand, normalizeMyBusiness, gbpFromProspect, findLocalRank, scoreLocal, analyzeLocal,
} = require('../lib/leads/local-seo');

(async () => {
  // --- deriveBrand: domain -> best-effort brand keyword (protocol/www/path/TLD stripped, separators -> spaces)
  assert(deriveBrand('https://www.riverside-dental.com/path') === 'riverside dental', `strips protocol/www/path/TLD, hyphens -> spaces (${deriveBrand('https://www.riverside-dental.com/path')})`);
  assert(deriveBrand('acmeDental.com') === 'acmeDental', `does NOT lowercase — only strips the TLD (${deriveBrand('acmeDental.com')})`);
  assert(deriveBrand('http://my_shop-site.co.uk/some/path') === 'my shop site', `multi-part TLD stripped in one pass; underscores/hyphens -> spaces (${deriveBrand('http://my_shop-site.co.uk/some/path')})`);
  assert(deriveBrand('') === '' && deriveBrand(undefined) === '', 'empty/undefined domain -> empty string, never throws');

  // --- normalizeMyBusiness: DataForSEO business_data/google/my_business_info/live -> one GBP shape
  const mbFullFixture = { tasks: [{ result: [{ items: [{
    title: 'Riverside Dental', category: 'Dentist', address: '100 Elm St, Austin, TX 78701', phone: '(512) 555-0100',
    url: 'https://riversidedental.com', rating: { value: 4.8, votes_count: 212 },
    work_time: { work_hours: { monday: '9:00-17:00', tuesday: '9:00-17:00' } },
    total_photos: 42, description: 'Top-rated family dentist serving Austin for 20 years.',
    is_claimed: true, place_id: 'ChIJabc123XYZ',
  } ] }] }] };
  const mbFull = normalizeMyBusiness(mbFullFixture);
  assert(
    mbFull && mbFull.name === 'Riverside Dental' && mbFull.category === 'Dentist' && mbFull.address === '100 Elm St, Austin, TX 78701' &&
    mbFull.phone === '(512) 555-0100' && mbFull.website === 'https://riversidedental.com' && mbFull.rating === 4.8 && mbFull.reviews === 212 &&
    mbFull.hasHours === true && mbFull.photos === 42 && mbFull.hasDescription === true && mbFull.claimed === true && mbFull.placeId === 'ChIJabc123XYZ',
    `full item maps every field (${JSON.stringify(mbFull)})`
  );

  const mbNoTitle = normalizeMyBusiness({ tasks: [{ result: [{ items: [{ category: 'Dentist', place_id: 'X' }] }] }] });
  assert(mbNoTitle === null, 'item with no title/name -> null');

  assert(normalizeMyBusiness({}) === null, 'empty {} response -> null');

  const mbSparse = normalizeMyBusiness({ tasks: [{ result: [{ items: [{ title: 'Sparse Biz', work_time: { work_hours: {} } }] }] }] });
  assert(mbSparse.hasHours === false && mbSparse.photos === 0 && mbSparse.hasDescription === false, `empty work_hours object -> hasHours false, missing total_photos -> photos 0, missing description -> hasDescription false (${JSON.stringify(mbSparse)})`);

  // --- gbpFromProspect: a carried-through prospect record -> the same partial GBP shape
  const prospectRecord = { name: 'Green Thumb Landscaping', category: 'Landscaper', address: '22 Pine Ln, Austin, TX', phone: '555-3000', website: 'https://greenthumblandscaping.com', rating: 4.6, reviews: 95, placeId: 'PGT001' };
  const gbpFromP = gbpFromProspect(prospectRecord);
  assert(
    gbpFromP.name === 'Green Thumb Landscaping' && gbpFromP.category === 'Landscaper' && gbpFromP.address === '22 Pine Ln, Austin, TX' &&
    gbpFromP.phone === '555-3000' && gbpFromP.website === 'https://greenthumblandscaping.com' && gbpFromP.rating === 4.6 && gbpFromP.reviews === 95 &&
    gbpFromP.placeId === 'PGT001' && gbpFromP._fromProspect === true,
    `prospect fields map through (${JSON.stringify(gbpFromP)})`
  );
  assert(gbpFromP.hasHours === null && gbpFromP.photos === null && gbpFromP.hasDescription === null && gbpFromP.claimed === null, 'hours/photos/description/claimed are all null — unknown from prospecting alone');
  assert(gbpFromProspect(null) === null, 'null prospect -> null');

  // --- findLocalRank: rank in a Maps SERP by exact place_id, else a fuzzy (case/space-insensitive) name match
  const mapsFixture = { tasks: [{ result: [{ items: [
    { type: 'maps_search', title: 'Downtown Dental', place_id: 'P1', rank_absolute: 1 },
    { type: 'maps_search', title: 'Riverside Dental Clinic', place_id: 'P2', rank_absolute: 2 },
    { type: 'maps_search', title: 'Smile Center', place_id: 'P3', rank_absolute: 3 },
  ] }] }] };
  assert(findLocalRank(mapsFixture, { placeId: 'P2', name: 'zzz-nomatch' }) === 2, 'exact place_id match wins regardless of the name');
  assert(findLocalRank(mapsFixture, { name: 'riverside dental' }) === 2, 'fuzzy case/space-insensitive substring name match when no placeId is given');
  assert(findLocalRank(mapsFixture, { placeId: 'PX', name: 'nonexistent business' }) === null, 'no placeId or name match -> null');
  assert(findLocalRank({ tasks: [{ result: [{ items: [] }] }] }, { placeId: 'P1', name: 'anything' }) === null, 'empty items list -> null');

  // --- scoreLocal: GBP + local-pack rank -> 0-100 health score + gap findings for the pitch
  const noGbpScore = scoreLocal({ gbp: null });
  assert(noGbpScore.applicable === false && noGbpScore.score === null, 'no gbp -> applicable false, score null');
  assert(noGbpScore.findings.length > 0 && /No Google Business Profile/i.test(noGbpScore.findings[0].issue), 'no-gbp findings mention the missing Google Business Profile');

  const strongGbp = {
    name: 'Riverside Dental', category: 'Dentist', website: 'https://riversidedental.com', phone: '555-0100',
    hasHours: true, photos: 8, hasDescription: true, rating: 4.6, reviews: 120, claimed: true,
  };
  const strongScore = scoreLocal({ gbp: strongGbp, localRank: 2, keyword: 'dentist austin' });
  assert(strongScore.score === 100, `fully-complete GBP + top-3 local rank hits the 100 clamp (score=${strongScore.score})`);
  assert(strongScore.applicable === true && strongScore.local.present === true && strongScore.local.localRank === 2, 'applicable true, local.present true, local.localRank carried through');

  const weakGbp = {
    name: 'Old Shop', category: '', website: '', phone: '', hasHours: false, photos: 1, hasDescription: false,
    rating: 3.2, reviews: 4, claimed: false,
  };
  const weakScore = scoreLocal({ gbp: weakGbp, localRank: null, keyword: 'shop austin' });
  assert(weakScore.applicable === true && weakScore.score < 40 && weakScore.score >= 0, `weak GBP scores low but stays clamped >= 0 (score=${weakScore.score})`);
  assert(weakScore.findings.some((f) => f.severity === 'high'), 'weak GBP produces at least one high-severity finding');
  assert(weakScore.findings.some((f) => /review/i.test(f.issue)), 'a finding calls out the low review count');
  assert(weakScore.findings.some((f) => /local pack/i.test(f.issue)), 'a finding calls out absence from the local pack');

  const midGbp = {
    name: 'Mid Shop', category: 'Shop', website: 'https://midshop.com', phone: '', hasHours: false, photos: 2,
    hasDescription: false, rating: 3.5, reviews: 12, claimed: true,
  };
  const tierTop = scoreLocal({ gbp: midGbp, localRank: 1, keyword: 'shop austin' }).score;
  const tierMid = scoreLocal({ gbp: midGbp, localRank: 8, keyword: 'shop austin' }).score;
  const tierNone = scoreLocal({ gbp: midGbp, localRank: null, keyword: 'shop austin' }).score;
  assert(tierTop > tierMid && tierMid > tierNone, `local-pack rank tiers strictly descend: top3=${tierTop} > #8=${tierMid} > not-ranked=${tierNone}`);

  // --- analyzeLocal: injected deps.dfsRequest, no network. Records every endpoint the mock is called with.
  const prospectForAnalyze = {
    name: 'Riverside Dental', category: 'Dentist', address: '100 Elm St, Austin, TX', phone: '555-0100',
    website: 'https://riversidedental.com', rating: 4.5, reviews: 80, placeId: 'P3',
  };
  const mapsFixtureForProspect = { tasks: [{ result: [{ items: [
    { type: 'maps_search', title: 'A Dental', place_id: 'P1', rank_absolute: 1 },
    { type: 'maps_search', title: 'B Dental', place_id: 'P2', rank_absolute: 2 },
    { type: 'maps_search', title: 'Riverside Dental', place_id: 'P3', rank_absolute: 3 },
  ] }] }] };
  const calls1 = [];
  const result1 = await analyzeLocal({
    domain: 'riversidedental.com', keyword: 'dentist', location: 'Austin, TX', prospect: prospectForAnalyze,
    deps: { dfsRequest: async (endpoint) => {
      calls1.push(endpoint);
      if (endpoint === 'serp/google/maps/live/advanced') return mapsFixtureForProspect;
      throw new Error(`unexpected endpoint: ${endpoint}`);
    } },
  });
  assert(result1.applicable === true && result1.local.present === true && result1.local.localRank === 3, `prospect-sourced GBP + maps lookup finds rank 3 (${JSON.stringify(result1.local)})`);
  assert(calls1.includes('serp/google/maps/live/advanced') && !calls1.includes('business_data/google/my_business_info/live'), `only the maps endpoint is called when gbp came from the prospect (calls: ${calls1.join(', ')})`);

  const myBizFixture = { tasks: [{ result: [{ items: [{
    title: 'Acme Plumbing', category: 'Plumber', address: '5 Oak Rd, Austin, TX', phone: '555-2000', url: 'https://acmeplumbing.com',
    rating: { value: 4.4, votes_count: 30 }, work_time: { work_hours: { monday: '9-5' } }, total_photos: 6,
    description: 'Reliable plumbing services around Austin.', is_claimed: true, place_id: 'PACME',
  } ] }] }] };
  const mapsFixtureForLookup = { tasks: [{ result: [{ items: [{ type: 'maps_search', title: 'Acme Plumbing', place_id: 'PACME', rank_absolute: 5 }] }] }] };
  const calls2 = [];
  const result2 = await analyzeLocal({
    domain: 'acmeplumbing.com', keyword: '', location: 'Austin, TX', prospect: null,
    deps: { dfsRequest: async (endpoint) => {
      calls2.push(endpoint);
      if (endpoint === 'business_data/google/my_business_info/live') return myBizFixture;
      if (endpoint === 'serp/google/maps/live/advanced') return mapsFixtureForLookup;
      throw new Error(`unexpected endpoint: ${endpoint}`);
    } },
  });
  assert(calls2.includes('business_data/google/my_business_info/live'), `no prospect -> looks the business up by brand name (calls: ${calls2.join(', ')})`);
  assert(result2.applicable === true && result2.local.present === true, 'my_business_info lookup found a GBP -> applicable true');

  const result3 = await analyzeLocal({
    domain: 'randomsite.com', keyword: '', prospect: null,
    deps: { dfsRequest: async (endpoint) => {
      if (endpoint === 'business_data/google/my_business_info/live') return {};
      throw new Error('should not query maps when no gbp was found');
    } },
  });
  assert(result3.applicable === false && result3.score === null, 'my_business_info returns no match -> non-local site path, applicable false, score null');

  let result4Threw = false;
  let result4;
  try {
    result4 = await analyzeLocal({ domain: 'anotherbiz.com', prospect: null, deps: { dfsRequest: async () => { throw new Error('network down'); } } });
  } catch { result4Threw = true; }
  assert(!result4Threw && result4 && result4.applicable === false, 'a dfsRequest that throws on my_business_info is swallowed — analyzeLocal never throws, applicable false');

  const result5 = await analyzeLocal({ domain: 'nodeps.com', prospect: null, deps: {} });
  assert(result5.applicable === false, 'no dfsRequest and no prospect -> nothing to look up, applicable false, never throws');

  done();
})().catch((e) => { console.error('FAIL: suite crashed —', e.message); process.exitCode = 1; done(); });
