// Google Maps prospecting (lib/leads/prospects.js): provider selection, DataForSEO/Places
// normalization into the common prospect shape, the managed-website-fit scorer, email
// extraction/ranking from a business's own page, query validation, and the search()/prospect()
// network entrypoints — all exercised with injected fetchImpl/deps.safeFetch mocks, no network.
const { assert, done } = require('./test-util');
const {
  pickProspectProvider, normalizeDataforseo, normalizePlaces,
  scoreProspect, extractEmails, rankEmail, enrichEmail,
  validateQuery, search, prospect,
} = require('../lib/leads/prospects');

(async () => {
  // --- pickProvider: which credential wins
  assert(pickProspectProvider({ dataforseo_login: 'a', dataforseo_password: 'b' }) === 'dataforseo', 'dataforseo picked when login+password set');
  assert(pickProspectProvider({ google_places_api_key: 'k' }) === 'places', 'places picked when only a Places API key is set');
  assert(pickProspectProvider({}) === null, 'no credentials configured -> null provider');
  assert(pickProspectProvider({ dataforseo_login: 'a', dataforseo_password: 'b', google_places_api_key: 'k' }) === 'dataforseo', 'dataforseo wins when both are configured');

  // --- normalizeDataforseo: field mapping + defensive defaults
  const dfsFixture = { tasks: [{ result: [{ items: [
    { type: 'maps_search', title: 'Riverside Dental', place_id: 'ChIJfull1', cid: 555, category: 'Dentist', address: '100 Elm St, Austin, TX', phone: '(512) 555-0100', url: 'https://riversidedental.com', rating: { value: 4.7, votes_count: 128 } },
    { type: 'maps_search', place_id: 'ChIJnotitle' }, // no title -> dropped
    { type: 'maps_search', title: 'NoFrills LLC' },   // sparse -> defaults
    {}, // malformed item -> must not throw
  ] }] }] };
  let dfsResult;
  let dfsThrew = false;
  try { dfsResult = normalizeDataforseo(dfsFixture); } catch { dfsThrew = true; }
  assert(!dfsThrew && dfsResult.length === 2, `normalizeDataforseo does not throw on malformed items; no-title item dropped (got ${dfsResult && dfsResult.length})`);
  const dfsFull = dfsResult[0];
  assert(
    dfsFull.name === 'Riverside Dental' && dfsFull.placeId === 'ChIJfull1' && dfsFull.website === 'https://riversidedental.com' &&
    typeof dfsFull.rating === 'number' && dfsFull.rating === 4.7 && typeof dfsFull.reviews === 'number' && dfsFull.reviews === 128 &&
    dfsFull.mapsUrl.includes('ChIJfull1'),
    `full item field mapping: name/placeId/website/rating/reviews/mapsUrl (${JSON.stringify(dfsFull)})`
  );
  const dfsSparse = dfsResult[1];
  assert(
    dfsSparse.name === 'NoFrills LLC' && dfsSparse.placeId === '' && dfsSparse.website === '' &&
    dfsSparse.rating === null && dfsSparse.reviews === 0 && dfsSparse.mapsUrl === '',
    `missing/absent fields default to ''/null/0 (${JSON.stringify(dfsSparse)})`
  );

  // --- normalizePlaces: field mapping + empty input
  const placesFixture = { places: [{
    id: 'places/ChIJreal1', displayName: { text: 'Sunny Cafe' }, formattedAddress: '200 Congress Ave, Austin, TX',
    nationalPhoneNumber: '(512) 555-0200', websiteUri: 'https://sunnycafe.com', rating: 4.2, userRatingCount: 87,
    primaryTypeDisplayName: { text: 'Cafe' }, googleMapsUri: 'https://maps.google.com/?cid=999',
  }] };
  const placesResult = normalizePlaces(placesFixture);
  assert(
    placesResult.length === 1 && placesResult[0].placeId === 'places/ChIJreal1' && placesResult[0].name === 'Sunny Cafe' &&
    placesResult[0].category === 'Cafe' && placesResult[0].address === '200 Congress Ave, Austin, TX' &&
    placesResult[0].phone === '(512) 555-0200' && placesResult[0].website === 'https://sunnycafe.com' &&
    placesResult[0].rating === 4.2 && placesResult[0].reviews === 87 && placesResult[0].mapsUrl === 'https://maps.google.com/?cid=999',
    `full Places field mapping (${JSON.stringify(placesResult[0])})`
  );
  assert(normalizePlaces({}).length === 0, 'normalizePlaces({}) returns []');

  // --- scoreProspect: website-status ranking + additive signals + cap
  const pNoSite = scoreProspect({ website: '' });
  const pSocial = scoreProspect({ website: 'https://facebook.com/mybiz' });
  const pHttp = scoreProspect({ website: 'http://old-shop.biz' });
  const pHttps = scoreProspect({ website: 'https://modern-shop.com' });
  assert(
    pNoSite.score > pSocial.score && pSocial.score > pHttp.score && pHttp.score > pHttps.score && /no website/.test(pNoSite.reasons[0]),
    `no-website > social-page > http:// > clean https, and reasons mention it (scores: ${pNoSite.score}, ${pSocial.score}, ${pHttp.score}, ${pHttps.score})`
  );
  const cleanBase = { website: 'https://clean-site.com' };
  const baseScore = scoreProspect(cleanBase).score;
  assert(
    scoreProspect({ ...cleanBase, phone: '555-1234' }).score === baseScore + 15 &&
    scoreProspect({ ...cleanBase, reviews: 5 }).score === baseScore + 10 &&
    scoreProspect({ ...cleanBase, reviews: 50 }).score === baseScore + 15 &&
    scoreProspect({ ...cleanBase, rating: 4.5 }).score === baseScore + 10 &&
    scoreProspect({ ...cleanBase, rating: 2.5 }).score === baseScore + 5 &&
    scoreProspect({ ...cleanBase, email: 'a@b.com' }).score === baseScore + 15,
    'phone(+15)/established-reviews(+10)/high-volume-reviews(+15)/well-rated(+10)/weak-rating(+5)/email(+15) each add their bonus'
  );
  const maxedProspect = scoreProspect({ website: '', phone: '555-0000', reviews: 60, rating: 4.8, email: 'a@b.com' });
  assert(maxedProspect.score === 100 && maxedProspect.reasons.length === 6, `every bonus combined caps at 100 with all reasons collected (score=${maxedProspect.score}, reasons=${maxedProspect.reasons.length})`);

  // --- extractEmails / rankEmail: mailto (plain + encoded), plain-text, lowercase+dedupe, junk filter, ranking
  const emailHtml = `
    <a href="mailto:jane@biz.com">Email Jane</a>
    <a href="mailto:John%40Biz.com?subject=Hello">Email John</a>
    <img src="logo@2x.png" alt="logo">
    <p>Reach us at INFO@BIZ.COM or noreply@biz.com for support.</p>
    <p>Please do not email test@example.com, abc@sentry.io, or xyz@wixpress.com.</p>
    <p>You can also reach Jane directly at JANE@biz.com.</p>
  `;
  const emails = extractEmails(emailHtml);
  assert(emails.includes('jane@biz.com') && emails.includes('john@biz.com') && emails.includes('info@biz.com'), `finds mailto (plain + URL-encoded) and plain-text emails, lowercased (${emails.join(', ')})`);
  assert(emails.length === 3, `dedupes case-different repeats of the same address (${emails.join(', ')})`);
  assert(!emails.some((e) => /2x\.png|noreply|example\.com|sentry|wixpress/.test(e)), 'filters junk: image filenames, noreply@, example/sentry/wixpress domains');
  assert(emails.indexOf('jane@biz.com') < emails.indexOf('info@biz.com'), 'named-person email ranked before the generic info@');
  assert(rankEmail('jane@biz.com') === 0 && rankEmail('info@biz.com') === 1 && rankEmail('billing@biz.com') === 2, 'rankEmail order: named=0, generic=1, secondary-generic=2');

  // --- enrichEmail: homepage hit, /contact fallback, throw-safe, social short-circuit, no website
  const callsA = [];
  const eA = await enrichEmail('https://realbiz.com', { safeFetch: async (url) => { callsA.push(url); return { body: '<p>Contact owner@realbiz.com for a quote.</p>' }; } });
  assert(eA === 'owner@realbiz.com' && callsA.length === 1 && callsA[0] === 'https://realbiz.com', 'homepage email found on first fetch, no /contact fallback needed');

  const callsB = [];
  const eB = await enrichEmail('https://needcontact.com', { safeFetch: async (url) => {
    callsB.push(url);
    if (/\/contact$/.test(url)) return { body: '<a href="mailto:hello@needcontact.com">Email us</a>' };
    return { body: '<p>no email on this page</p>' };
  } });
  assert(eB === 'hello@needcontact.com' && callsB.length === 2 && callsB[1] === 'https://needcontact.com/contact', 'empty homepage falls through to /contact page');

  const eC = await enrichEmail('https://blocked.com', { safeFetch: async () => { throw new Error('SSRF-blocked'); } });
  assert(eC === null, 'a throwing fetcher resolves to null, never throws');

  let callsD = 0;
  const eD = await enrichEmail('https://facebook.com/mybiz', { safeFetch: async () => { callsD++; return { body: 'x@y.com' }; } });
  assert(eD === null && callsD === 0, 'a social-page-as-website short-circuits without ever calling the fetcher');

  const eE = await enrichEmail('', { safeFetch: async () => ({ body: 'a@b.com' }) });
  assert(eE === null, 'no website means no enrichment attempt');

  // --- validateQuery
  assert(validateQuery({ keyword: 'dentist', location: 'Austin, TX', limit: 10 }).length === 0, 'valid query passes with no errors');
  assert(validateQuery({ keyword: '', location: '' }).length === 2, 'missing keyword and location collect 2 errors');
  assert(validateQuery({ keyword: 'dentist', location: 'Austin, TX', limit: 0 }).length === 1 && validateQuery({ keyword: 'dentist', location: 'Austin, TX', limit: 51 }).length === 1, 'limit outside 1-50 rejected (0 and 51)');
  assert(validateQuery({ keyword: 'dentist', location: 'Austin, TX', limit: undefined }).length === 0, 'undefined limit is fine (default applied later)');

  // --- search(): provider dispatch + error surfacing, via injected fetchImpl
  const dfsCfg = { dataforseo_login: 'agency', dataforseo_password: 'secret' };
  const dfsOkJson = { status_code: 20000, tasks: [{ status_code: 20000, result: [{ items: [
    { type: 'maps_search', title: 'Shop A', place_id: 'P1' },
    { type: 'maps_search', title: 'Shop B', place_id: 'P2' },
    { type: 'maps_search', title: 'Shop C', place_id: 'P3' },
  ] }] }] };
  const rDfs = await search({ keyword: 'coffee', location: 'Austin, TX', limit: 2, cfg: dfsCfg, fetchImpl: async () => ({ ok: true, status: 200, json: async () => dfsOkJson }) });
  assert(rDfs.provider === 'dataforseo' && rDfs.prospects.length === 2, `dataforseo search capped at limit (got ${rDfs.prospects.length})`);

  const dfsErrJson = { status_code: 40100, status_message: 'Auth error. Invalid login/password.', tasks: [] };
  const errThrown = await search({ keyword: 'coffee', location: 'Austin, TX', cfg: dfsCfg, fetchImpl: async () => ({ ok: true, status: 200, json: async () => dfsErrJson }) }).then(() => null, (e) => e);
  assert(errThrown && /Auth error\. Invalid login\/password\./.test(errThrown.message), `DataForSEO error status_code surfaces status_message (${errThrown && errThrown.message})`);

  const placesCfg = { google_places_api_key: 'KEY123' };
  const placesOkJson = { places: [{ id: 'places/1', displayName: { text: 'Best Cafe' }, formattedAddress: '1 St', rating: 4.1, userRatingCount: 10 }] };
  const rPlaces = await search({ keyword: 'cafe', location: 'Austin, TX', cfg: placesCfg, fetchImpl: async () => ({ ok: true, status: 200, json: async () => placesOkJson }) });
  assert(rPlaces.provider === 'places' && rPlaces.prospects.length === 1, 'places provider used when only google_places_api_key is set');

  const noProviderThrown = await search({ keyword: 'x', location: 'y', cfg: {}, fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }) }).then(() => null, (e) => e);
  assert(noProviderThrown && /no prospecting provider/i.test(noProviderThrown.message), 'no provider configured throws a clear error');

  // --- prospect(): full run — search, enrich (bounded to non-social real sites), score, sort
  const prospectCfg = { dataforseo_login: 'agency', dataforseo_password: 'secret' };
  const threeBizJson = { status_code: 20000, tasks: [{ status_code: 20000, result: [{ items: [
    { type: 'maps_search', title: 'No Site LLC', place_id: 'P1', phone: '555-0001', rating: { value: 4.8, votes_count: 60 } },
    { type: 'maps_search', title: 'Facebook Biz', place_id: 'P2', url: 'https://facebook.com/facebookbiz', phone: '555-0002' },
    { type: 'maps_search', title: 'Real Site Co', place_id: 'P3', url: 'https://realsiteco.com', phone: '555-0003', rating: { value: 3.9, votes_count: 8 } },
  ] }] }] };
  const dfsFetchForProspect = async () => ({ ok: true, status: 200, json: async () => threeBizJson });

  const enrichCalls = [];
  const safeFetchMock = async (url) => {
    enrichCalls.push(url);
    if (url === 'https://realsiteco.com') return { body: '<a href="mailto:owner@realsiteco.com">Email owner</a>' };
    return { body: '<p>no email</p>' };
  };
  const prospectResult = await prospect({ keyword: 'plumber', location: 'Austin, TX', cfg: prospectCfg, deps: { fetchImpl: dfsFetchForProspect, safeFetch: safeFetchMock } });
  assert(prospectResult.provider === 'dataforseo' && prospectResult.prospects.length === 3 && prospectResult.prospects[0].name === 'No Site LLC', `results sorted by score descending, no-website prospect first (order: ${prospectResult.prospects.map((p) => p.name).join(', ')})`);
  assert(prospectResult.prospects.every((p) => typeof p.score === 'number' && Array.isArray(p.reasons) && p.reasons.length > 0), 'every prospect has a numeric score and non-empty reasons');
  const realSiteProspect = prospectResult.prospects.find((p) => p.name === 'Real Site Co');
  const otherProspects = prospectResult.prospects.filter((p) => p.name !== 'Real Site Co');
  assert(realSiteProspect.email === 'owner@realsiteco.com' && otherProspects.every((p) => p.email === undefined), 'only the crawlable real-website prospect gets an enriched email');
  assert(enrichCalls.length === 1 && enrichCalls[0] === 'https://realsiteco.com', 'enrichment skips no-website and social-page prospects, fetches only the real site, stops at the homepage');

  const enrichCallsOff = [];
  const safeFetchOff = async (url) => { enrichCallsOff.push(url); return { body: '' }; };
  const prospectResultOff = await prospect({ keyword: 'plumber', location: 'Austin, TX', cfg: prospectCfg, enrich: false, deps: { fetchImpl: dfsFetchForProspect, safeFetch: safeFetchOff } });
  assert(enrichCallsOff.length === 0 && prospectResultOff.prospects.every((p) => p.email === undefined), 'enrich:false skips email enrichment entirely');

  done();
})().catch((e) => { console.error('FAIL: suite crashed —', e.message); process.exitCode = 1; done(); });
