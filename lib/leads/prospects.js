// lib/leads/prospects.js — Google Business Profile / Google Maps local-business prospecting.
//
// Finds local businesses for a niche + area ("dentists in Austin") and scores each one for
// MANAGED-WEBSITE FIT — the platform's own offer ($997 setup + $250/mo): a business with no
// website, or a Facebook page standing in for one, is the hottest possible prospect.
//
// COMPLIANCE BY DESIGN: no scraping of Google Maps itself (ToS + anti-bot). Two API providers
// behind one seam, picked by which credential is configured:
//   dataforseo : POST /v3/serp/google/maps/live/advanced (the SEO agency's existing account —
//                Basic auth from settings.seo.dataforseo_login/password)
//   places     : Google Places API (New) places:searchText (GOOGLE_PLACES_API_KEY)
// Email enrichment fetches the business's OWN public website (via the SSRF-pinned safeFetch)
// looking for a published contact email — gentle, two pages max per site, best-effort only.
//
// Pure logic (normalize/score/extract/validate) is exported for the unit suite; network calls
// take injected fetchers so tests never touch the wire.

const PROVIDERS = ['dataforseo', 'places'];

function pickProspectProvider(cfg = {}) {
  if (cfg.dataforseo_login && cfg.dataforseo_password) return 'dataforseo';
  if (cfg.google_places_api_key) return 'places';
  return null;
}

// Social/link-hub pages standing in for a real website — for our purposes that IS "no website"
// (and an even stronger signal: they wanted a web presence but never got a real one).
const SOCIAL_AS_SITE = /facebook\.com|instagram\.com|linktr\.ee|wa\.me|whatsapp\.com|m\.me|business\.site|linkedin\.com|yelp\.com/i;

const clean = (s, max = 300) => String(s == null ? '' : s).trim().slice(0, max);

// ---------- provider normalization → one prospect shape ----------
// { placeId, name, category, address, phone, website, rating, reviews, mapsUrl }

function normalizeDataforseo(taskResponse) {
  const items = taskResponse?.tasks?.[0]?.result?.[0]?.items || [];
  return items
    .filter((i) => i && (i.type === 'maps_search' || i.title))
    .map((i) => ({
      placeId: clean(i.place_id || (i.cid != null ? `cid:${i.cid}` : ''), 120),
      name: clean(i.title, 200),
      category: clean(i.category, 120),
      address: clean(i.address, 300),
      phone: clean(i.phone, 40),
      website: clean(i.url || i.domain || '', 300),
      rating: Number(i.rating?.value) || null,
      reviews: Number(i.rating?.votes_count) || 0,
      mapsUrl: i.place_id ? `https://www.google.com/maps/place/?q=place_id:${encodeURIComponent(i.place_id)}` : '',
    }))
    .filter((p) => p.name);
}

function normalizePlaces(json) {
  const places = json?.places || [];
  return places.map((p) => ({
    placeId: clean(p.id, 120),
    name: clean(p.displayName?.text || p.displayName, 200),
    category: clean(p.primaryTypeDisplayName?.text || p.primaryTypeDisplayName || '', 120),
    address: clean(p.formattedAddress, 300),
    phone: clean(p.nationalPhoneNumber, 40),
    website: clean(p.websiteUri || '', 300),
    rating: Number(p.rating) || null,
    reviews: Number(p.userRatingCount) || 0,
    mapsUrl: clean(p.googleMapsUri || '', 300),
  })).filter((p) => p.name);
}

// ---------- managed-website fit score (0–100, with human-readable reasons) ----------
function scoreProspect(p) {
  let score = 0;
  const reasons = [];
  const site = String(p.website || '');
  const noSite = !site;
  const socialSite = !noSite && SOCIAL_AS_SITE.test(site);

  if (noSite) { score += 45; reasons.push('no website at all — prime managed-website prospect'); }
  else if (socialSite) { score += 35; reasons.push('social page instead of a real website'); }
  else if (/^http:\/\//i.test(site)) { score += 15; reasons.push('website has no HTTPS'); }

  if (p.phone) { score += 15; reasons.push('phone listed (reachable)'); }
  if (p.reviews >= 5) { score += 10; reasons.push(`established (${p.reviews} reviews)`); }
  if (p.rating != null && p.rating >= 4) { score += 10; reasons.push(`well-rated (${p.rating}★)`); }
  else if (p.rating != null && p.rating > 0 && p.rating < 3.5) { score += 5; reasons.push('weak rating — reputation-management angle'); }
  if (p.reviews >= 50) { score += 5; reasons.push('high review volume — real customer flow'); }
  if (p.email) { score += 15; reasons.push('contact email found'); }

  return { score: Math.min(100, score), reasons };
}

// ---------- email extraction from a business's own public page ----------
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const JUNK_EMAIL = /\.(png|jpe?g|gif|webp|svg|css|js)$|@(example|sentry|wixpress|placeholder|domain|email|test|yourdomain|sentry-next)\.|^(no-?reply|noreply|donotreply)@|@[0-9]+x\./i;

function extractEmails(html) {
  const found = new Set();
  const text = String(html || '');
  for (const m of text.match(/mailto:([^"'?\s>]+)/gi) || []) {
    const e = decodeURIComponent(m.slice(7)).trim().toLowerCase();
    if (EMAIL_RE.test(e) && !JUNK_EMAIL.test(e)) found.add(e);
    EMAIL_RE.lastIndex = 0;
  }
  for (const e of text.match(EMAIL_RE) || []) {
    const low = e.toLowerCase();
    if (!JUNK_EMAIL.test(low)) found.add(low);
  }
  // Prefer human-ish inboxes over generic ones, generic over the rest — deterministic order.
  const ranked = [...found].sort((a, b) => rankEmail(a) - rankEmail(b));
  return ranked;
}
function rankEmail(e) {
  if (/^(info|contact|hello|office|admin|team|support|sales)@/.test(e)) return 1;
  if (/^(billing|accounts?|jobs|careers|press)@/.test(e)) return 2;
  return 0; // named person beats the generics
}

// Fetch homepage (and /contact if the homepage yields nothing) via the injected safeFetch.
// Never throws; returns the best email or null.
async function enrichEmail(website, deps) {
  const fetcher = deps && deps.safeFetch;
  if (!fetcher || !website || SOCIAL_AS_SITE.test(website)) return null;
  const base = /^https?:\/\//i.test(website) ? website : `https://${website}`;
  for (const url of [base, new URL('/contact', base).toString()]) {
    try {
      const r = await fetcher(url, { maxBytes: 400_000, timeoutMs: 8000 });
      const html = r && (r.body || r.text || r);
      const emails = extractEmails(typeof html === 'string' ? html : String(html || ''));
      if (emails.length) return emails[0];
    } catch { /* unreachable/blocked site — fine, move on */ }
  }
  return null;
}

// ---------- search (network via injected fetch) ----------
function validateQuery({ keyword, location, limit }) {
  const errs = [];
  if (!clean(keyword, 120)) errs.push('keyword is required (e.g. "dentist")');
  if (!clean(location, 160)) errs.push('location is required (e.g. "Austin, TX")');
  const n = Number(limit);
  if (limit != null && (!Number.isFinite(n) || n < 1 || n > 50)) errs.push('limit must be 1–50');
  return errs;
}

async function search({ keyword, location, limit = 20, cfg = {}, fetchImpl = fetch }) {
  const provider = pickProspectProvider(cfg);
  if (!provider) throw new Error('no prospecting provider configured — set DataForSEO credentials (Settings → SEO Agency) or a Google Places API key');
  const cap = Math.min(Math.max(Number(limit) || 20, 1), 50);

  if (provider === 'dataforseo') {
    const auth = Buffer.from(`${cfg.dataforseo_login}:${cfg.dataforseo_password}`).toString('base64');
    const r = await fetchImpl('https://api.dataforseo.com/v3/serp/google/maps/live/advanced', {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
      body: JSON.stringify([{ keyword: `${clean(keyword, 120)} ${clean(location, 160)}`, language_code: 'en', depth: cap, location_name: 'United States' }]),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.status_code >= 40000) throw new Error(`DataForSEO: ${j.status_message || `HTTP ${r.status}`}`);
    const t = j.tasks && j.tasks[0];
    if (t && t.status_code >= 40000) throw new Error(`DataForSEO task: ${t.status_message}`);
    return { provider, prospects: normalizeDataforseo(j).slice(0, cap) };
  }

  const r = await fetchImpl('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': cfg.google_places_api_key,
      'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.nationalPhoneNumber,places.websiteUri,places.rating,places.userRatingCount,places.primaryTypeDisplayName,places.googleMapsUri',
    },
    body: JSON.stringify({ textQuery: `${clean(keyword, 120)} in ${clean(location, 160)}`, maxResultCount: Math.min(cap, 20) }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Google Places: ${j.error?.message || `HTTP ${r.status}`}`);
  return { provider, prospects: normalizePlaces(j).slice(0, cap) };
}

// Full run: search → optional email enrichment (bounded concurrency) → score → sort by fit.
async function prospect({ keyword, location, limit, enrich = true, cfg, deps = {} }) {
  const { provider, prospects } = await search({ keyword, location, limit, cfg, fetchImpl: deps.fetchImpl || fetch });

  if (enrich) {
    const withSites = prospects.filter((p) => p.website && !SOCIAL_AS_SITE.test(p.website));
    let i = 0;
    const workers = Array.from({ length: Math.min(3, withSites.length) }, async () => {
      while (i < withSites.length) {
        const p = withSites[i++];
        p.email = await enrichEmail(p.website, deps);
      }
    });
    await Promise.all(workers);
  }

  for (const p of prospects) Object.assign(p, scoreProspect(p));
  prospects.sort((a, b) => b.score - a.score);
  return { provider, prospects };
}

module.exports = {
  pickProspectProvider,
  normalizeDataforseo, normalizePlaces,
  scoreProspect, extractEmails, rankEmail, enrichEmail,
  validateQuery, search, prospect,
};
