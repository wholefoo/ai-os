// lib/intel-brief-compiled.js — the Daily Intelligence Statement, redrawn as a three-stage split.
//
// ══════════════════════════════════════════════════════════════════════════════════════════════
//  THE EXPERIMENT THIS FILE IS
// ══════════════════════════════════════════════════════════════════════════════════════════════
//  lib/intel-brief.js produces the same document in ELEVEN model calls: seven consultants — each an
//  xhigh agent with web-search tools, told to go find its provider's news — then synthesis,
//  orchestrator, architect, comms-director. The deterministic middle is hiding in plain sight:
//  SEVEN AGENTS ARE BEING USED AS WEB SCRAPERS. Every provider publishes a changelog. Fetching a
//  changelog is an HTTP request. Asking an xhigh model to search for it, read it and report back is
//  the probabilistic-bottleneck version of `curl` — slower, costlier, and with a hallucination
//  margin the synthesis then compounds.
//
//  This file draws the LLM boundary TIGHT, the way the "Statistical Parameter Parser →
//  Deterministic Task Automator → Contextual Results Formatter" split describes:
//
//    STAGE 1  DETERMINISTIC   fetch the seven primary-source changelogs, extract dated entries,
//                            keep the recent window, dedupe against what yesterday's brief already
//                            reported.                                      0 model calls.
//    STAGE 2  LLM             ONE call: the comms-director writes the statement from those deltas.
//    STAGE 3  DETERMINISTIC   render the same .docx the current pipeline renders.  0 model calls.
//
//  Eleven calls become one. And the inputs are the changelogs THEMSELVES rather than a model's
//  recollection of them — so the redraw is not only cheaper, it is more grounded. That is the
//  two-wins claim, and this file exists to MEASURE it, not assert it: both versions tag the cost
//  ledger (`intel-brief:*` vs `intel-brief-compiled:*`), so one run of each is a real comparison.
//
// ══════════════════════════════════════════════════════════════════════════════════════════════
//  WHAT IS DELIBERATELY DIFFERENT, SO THE COMPARISON IS HONEST
// ══════════════════════════════════════════════════════════════════════════════════════════════
//  The current pipeline spends two calls on judgment (orchestrator assessment, architect
//  proposals) before the comms-director writes. Here those are FOLDED INTO the single writing call —
//  the same five sections are requested, from the same author, in one pass. That is a real
//  reduction in "deliberation", and the comparison must judge the OUTPUT quality as well as the
//  cost, or "cheaper" is meaningless. What is NOT lost: the perspective the consultants were
//  supposed to add ("ask Gemini about Gemini") was always a probabilistic reading of the same
//  changelog this file fetches directly.
//
//  ── THE HONESTY RULE THAT MATTERS MORE THAN THE PARSING ──
//  None of the seven sources offers an RSS/Atom feed (checked 2026-09-03). So this is an HTML
//  scraper, and scrapers are brittle. A source that returns 200 but yields ZERO dated entries is
//  reported as UNPARSED — the page's markup changed — and never as "no updates". Those are opposite
//  situations, and a consultant agent could not tell them apart either; it would simply say "no
//  significant updates" with full confidence. See [[assert-on-values-not-counts]].
//
//  Agents' role under this model, in the operator's words: authors, engineers and OVERSEERS of
//  automations — not their executors. The comms-director still writes; nothing else reasons.
// ══════════════════════════════════════════════════════════════════════════════════════════════

'use strict';

const fs = require('fs');
const path = require('path');
const { safeFetch } = require('./net/safe-fetch');
const { saveBriefDocx } = require('./intel-brief');

/** Primary sources. Verified 2026-09-03: all seven are dated HTML changelogs; none has a feed. */
const SOURCES = Object.freeze([
  { provider: 'Anthropic',  url: 'https://platform.claude.com/docs/en/release-notes/overview' },
  { provider: 'OpenAI',     url: 'https://developers.openai.com/api/docs/changelog' },
  { provider: 'Google',     url: 'https://ai.google.dev/gemini-api/docs/changelog' },
  { provider: 'DeepSeek',   url: 'https://api-docs.deepseek.com/updates' },
  { provider: 'xAI',        url: 'https://docs.x.ai/docs/release-notes' },
  { provider: 'Perplexity', url: 'https://docs.perplexity.ai/changelog/changelog' },
  { provider: 'Manus',      url: 'https://manus.im/blog' },
]);

const RECENT_DAYS = 7;          // matches the current pipeline's "roughly the last 7 days"
const MAX_ENTRY_CHARS = 600;
const MAX_ENTRIES_PER_SOURCE = 8;
const FETCH_TIMEOUT_MS = 15000;

// ---------------------------------------------------------------------------------------------
//  Stage 1a — HTML → text
// ---------------------------------------------------------------------------------------------

/** Crude but sufficient: drop script/style, turn block tags into newlines, strip the rest. */
function htmlToText(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<\/?(p|div|li|h[1-6]|br|tr|section|article|header|footer|dt|dd)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(parseInt(n, 10)))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

// ---------------------------------------------------------------------------------------------
//  Stage 1b — dated-entry extraction
// ---------------------------------------------------------------------------------------------

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const MONTH_RE = '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*';
// FOUR shapes, every one seen on a live page (checked against all seven sources 2026-09-03):
//   ISO         "2026-08-21"          DeepSeek — and, the trap, INSIDE identifiers on Anthropic's
//                                     page ("clear-at-2026-08-21"). An ISO date may be preceded only
//                                     by whitespace/start/bracket, never by - or _, or beta-header
//                                     names open phantom entries mid-paragraph (151 of them did).
//   long        "September 2, 2026"   Anthropic, Google, Manus, Perplexity
//   month-year  "August 2026" / "September, 2026"   xAI + Perplexity headings; OpenAI year headings
//   no-year     "Aug 29" / "September 2"            OpenAI and xAI entry lines — year is INFERRED
const DATE_ANCHOR = new RegExp(
  '(?:^|[\\s(\\[—–])(' +
  '(\\d{4})-(\\d{2})-(\\d{2})' +                                   // 2-4   ISO
  '|(' + MONTH_RE + ')\\.?\\s+(\\d{1,2}),?\\s+(\\d{4})' +             // 5-7   long
  '|(' + MONTH_RE + ')\\.?,?\\s+(\\d{4})' +                          // 8-9   month-year
  '|(' + MONTH_RE + ')\\.?\\s+(\\d{1,2})' +                          // 10-11 no-year
  ')(?=[\\s):\\]—–,.]|$)',
  'i',
);

/** Page metadata that carries a date but is never an entry. A closed category, so a list is honest. */
const METADATA_LABEL = /^(last\s+updated|updated\s+on|updated|published|posted|date|on this page)\s*[:.]?$/i;
/** A tag line between date and title: OpenAI's "Feature"/"Update", Manus's category words. */
const TAG_LINE = /^[A-Za-z][A-Za-z ]{0,18}$/;

function monthIndex(name) {
  const n = String(name).toLowerCase().slice(0, 3);
  return MONTHS.findIndex((m) => m.startsWith(n));
}

/**
 * Parse a date match into {iso, precision}. Month-only dates resolve to the 1st and carry
 * precision:'month' so recency filtering can be lenient with them (a "September 2026" entry seen on
 * the 3rd is recent even though "the 1st" is not strictly within the window).
 */
function parseDate(m, now = Date.now()) {
  if (m[2]) return { iso: `${m[2]}-${m[3]}-${m[4]}`, precision: 'day' };
  if (m[10]) {
    // No year on the line (OpenAI "Aug 29", xAI "September 2"). Assume the current year; if that
    // lands in the future — "Dec 30" read in January — it was last year. Changelogs run backwards in
    // time, so this is right far more often than a fixed guess, and precision stays 'day'.
    const mi = monthIndex(m[10]);
    if (mi < 0) return null;
    const y = new Date(now).getUTCFullYear();
    const cand = Date.UTC(y, mi, Number(m[11]));
    const year = cand > now + 86400000 ? y - 1 : y;
    return { iso: `${year}-${String(mi + 1).padStart(2, '0')}-${String(m[11]).padStart(2, '0')}`, precision: 'day' };
  }
  if (m[5]) {
    const mi = monthIndex(m[5]);
    if (mi < 0) return null;
    return { iso: `${m[7]}-${String(mi + 1).padStart(2, '0')}-${String(m[6]).padStart(2, '0')}`, precision: 'day' };
  }
  if (m[8]) {
    const mi = monthIndex(m[8]);
    if (mi < 0) return null;
    return { iso: `${m[9]}-${String(mi + 1).padStart(2, '0')}-01`, precision: 'month' };
  }
  return null;
}

/**
 * Walk the text; every line carrying a date anchor opens an entry that runs until the next anchor.
 *
 * Generic on purpose. Per-provider CSS selectors would be more precise and would break the first
 * time any of seven vendors restyled a page — silently, as "no updates". A date-anchored walk
 * survives restyling because the DATES survive restyling; and when it does fail it fails to ZERO,
 * which the caller reports as UNPARSED rather than as an empty week.
 */
/**
 * Is this line an ENTRY DATE line? Returns {d, residual} or null.
 *
 * One place for all three rejections, so the main walk and the title-lookahead agree:
 *   - a FUTURE date is a reference inside an entry ("shutdown on 2027-02-26"), never the entry's
 *     own date — OpenAI's newest "entry" was a deprecation notice eleven months out;
 *   - a NO-YEAR date only counts when the line is essentially just the date ("Aug 29",
 *     "September 2 "). "grok-imagine retirement on November 2" is prose that HAPPENS to contain one,
 *     and treating it as an entry both split the real entry and — because the year-back rule fired
 *     on a forward reference — dated it 2025. Bare-ness is the discriminator: entry date lines are
 *     short, sentences are not;
 *   - anything else that matched is a real anchor.
 */
function dateLineOf(line, now, futureLimit) {
  const m = line.match(DATE_ANCHOR);
  if (!m) return null;
  const d = parseDate(m, now);
  if (!d) return null;
  if (Date.parse(d.iso + 'T00:00:00Z') > futureLimit) return null;
  const residual = line.replace(m[0], '').replace(/^[\s:—–\-|·•]+|[\s:—–\-|·•]+$/g, '').trim();
  if (m[10] && residual.length > 20) return null;          // no-year date inside prose
  return { d, residual };
}

function extractEntries(text, now = Date.now()) {
  const lines = String(text || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const entries = [];
  let cur = null;
  const futureLimit = now + 86400000;
  const isDateLine = (l) => !!dateLineOf(l, now, futureLimit);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const hit = dateLineOf(line, now, futureLimit);
    const d = hit && hit.d;
    if (d) {
      const residual = hit.residual;
      // "Last updated" / "On this page": page metadata with a date on it. Not an entry — skip, and do
      // NOT close the current entry either, or a footer would truncate the last real one.
      if (/last\s+updated|on this page|updated\s+on/i.test(residual)) continue;
      // A bare date immediately followed by ANOTHER bare date is a table of contents, not content.
      // Anthropic's page lists every entry date in a nav block; each opened a phantom entry whose
      // "body" was the rest of the nav. Skip without closing the current entry.
      if (!residual && i + 1 < lines.length && isDateLine(lines[i + 1])) continue;
      if (cur) entries.push(cur);
      // Title-after-date layouts. If the date line's residual is empty, a bare label ("Date:"), or a
      // short tag ("Product ·", "Feature"), the title is on the NEXT non-date line — skipping one
      // further tag line if there is one (OpenAI: date / "Feature" / title).
      let title = residual;
      let consumed = 0;
      if (!title || METADATA_LABEL.test(title) || (TAG_LINE.test(title) && title.length <= 20)) {
        let j = i + 1;
        if (j < lines.length && TAG_LINE.test(lines[j]) && !isDateLine(lines[j])) j++;
        if (j < lines.length && !isDateLine(lines[j])) { title = lines[j]; consumed = j - i; }
      }
      cur = { date: d.iso, precision: d.precision, title: title.slice(0, 200), body: '' };
      i += consumed;
    } else if (cur && cur.body.length < MAX_ENTRY_CHARS) {
      cur.body += (cur.body ? ' ' : '') + line;
    }
  }
  if (cur) entries.push(cur);
  return entries
    .map((e) => ({ ...e, body: e.body.slice(0, MAX_ENTRY_CHARS), title: e.title || e.body.slice(0, 120) }))
    // A date with nothing attached is a table-of-contents line, not an entry. Require SOME content.
    .filter((e) => (e.title && e.title.length >= 4) || e.body.length >= 20);
}

/** Recent = within RECENT_DAYS of `now`; month-precision entries count if their month is current or last. */
function isRecent(entry, now, days = RECENT_DAYS) {
  const t = Date.parse(entry.date + 'T00:00:00Z');
  if (!Number.isFinite(t)) return false;
  if (entry.precision === 'month') {
    const n = new Date(now); const e = new Date(t);
    const monthsApart = (n.getUTCFullYear() - e.getUTCFullYear()) * 12 + (n.getUTCMonth() - e.getUTCMonth());
    return monthsApart >= 0 && monthsApart <= 1;
  }
  return now - t <= days * 86400000 && t <= now + 86400000;
}

/** Stable key for dedupe across days: provider + date + first 80 chars of the title, normalised. */
function entryKey(provider, e) {
  return `${provider}|${e.date}|${String(e.title).toLowerCase().replace(/\s+/g, ' ').slice(0, 80)}`;
}

// ---------------------------------------------------------------------------------------------
//  Stage 1 — fetch all sources
// ---------------------------------------------------------------------------------------------

/**
 * @returns {Promise<Array<{provider, url, fetched, status, parsed, recent, unparsed, error, entries}>>}
 *   `unparsed` is the load-bearing flag: fetched fine, found no dated entries — the page changed,
 *   NOT the news. It is reported, never silently folded into "no updates".
 */
async function fetchAllSources({ fetch = safeFetch, now = Date.now(), sources = SOURCES, log = () => {} } = {}) {
  return Promise.all(sources.map(async (s) => {
    const out = { provider: s.provider, url: s.url, fetched: false, status: null, parsed: 0, recent: 0, unparsed: false, error: null, entries: [] };
    try {
      // Accept-Language is NOT optional. Without it Google served the Gemini changelog in ARABIC on
      // 2026-09-03 (locale inferred from the caller's IP), the English month matcher found nothing, and
      // the best source in the set silently became "no updates". The hl= query pin is belt-and-braces
      // for Google specifically, which honours it over the header.
      const url = /ai\.google\.dev/.test(s.url) && !/[?&]hl=/.test(s.url) ? s.url + (s.url.includes('?') ? '&' : '?') + 'hl=en' : s.url;
      const r = await fetch(url, { timeoutMs: FETCH_TIMEOUT_MS, maxBytes: 2_000_000, accept: 'text/html', headers: { 'Accept-Language': 'en-US,en;q=0.9' } });
      // safeFetch RETURNS THE BODY STRING, not {status, body} — that shape belongs to safeRequest, the
      // function right below it, and its JSDoc was misread for this one. The first VPS run reported all
      // seven sources UNPARSED because `r.body` was undefined. Nothing upstream caught it: the dev-box
      // check used global fetch().text(), and the unit-test mock returned the WRONG shape — the mock
      // had encoded the assumption, so the test proved the code agreed with itself. Accept both shapes
      // here so neither a string nor an object can ever again read as an empty page.
      const body = typeof r === 'string' ? r : (r && typeof r.body === 'string' ? r.body : '');
      out.status = typeof r === 'string' ? 200 : (r && r.status) || null;
      out.fetched = true;
      if (!body) { out.error = 'fetch returned no body'; out.fetched = false; return out; }
      const all = extractEntries(htmlToText(body), now);
      out.parsed = all.length;
      out.unparsed = all.length === 0;
      out.entries = all.filter((e) => isRecent(e, now)).slice(0, MAX_ENTRIES_PER_SOURCE);
      out.recent = out.entries.length;
      log(`[intel-brief-compiled] ${s.provider}: ${out.parsed} dated entries, ${out.recent} recent${out.unparsed ? ' — UNPARSED (markup changed?)' : ''}`);
    } catch (e) {
      out.error = e && e.message ? e.message : String(e);
      log(`[intel-brief-compiled] ${s.provider}: FETCH FAILED — ${out.error}`);
    }
    return out;
  }));
}

// ---------------------------------------------------------------------------------------------
//  Dedupe against the previous compiled brief
// ---------------------------------------------------------------------------------------------

/** The most recent compiled brief's sidecar, if any, holds the keys it already reported. */
function loadPreviouslySeen(dir) {
  try {
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort().reverse();
    for (const f of files) {
      const meta = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (meta && meta.mode === 'compiled' && Array.isArray(meta.seenKeys)) return new Set(meta.seenKeys);
    }
  } catch { /* no history is fine */ }
  return new Set();
}

// ---------------------------------------------------------------------------------------------
//  Stage 2 — the ONE model call
// ---------------------------------------------------------------------------------------------

function buildStatementTask({ dateLabel, sources, newEntries }) {
  const byProvider = {};
  for (const { provider, entry } of newEntries) (byProvider[provider] = byProvider[provider] || []).push(entry);

  const intel = sources.map((s) => {
    const items = byProvider[s.provider] || [];
    const status = s.error ? `FETCH FAILED (${s.error})`
      : s.unparsed ? 'UNPARSED — the page fetched but no dated entries were found (its markup may have changed); treat as UNKNOWN, not as "no updates"'
        : items.length ? `${items.length} new entr${items.length === 1 ? 'y' : 'ies'} in the last ${RECENT_DAYS} days`
          : `no new entries in the last ${RECENT_DAYS} days (${s.parsed} older entries seen; source is healthy)`;
    const lines = items.map((e) => `  - [${e.date}${e.precision === 'month' ? ' (month)' : ''}] ${e.title}${e.body ? ` — ${e.body}` : ''}`);
    return `### ${s.provider}  (${status})\n${lines.join('\n') || '  (nothing new)'}`;
  }).join('\n\n');

  return [
    `Write today's official daily statement for the platform owner, as the Communications Director.`,
    `Structure it in markdown with exactly these sections:`,
    `# Daily Intelligence Statement — ${dateLabel}`,
    `## Executive Summary  (3-5 sentences)`,
    `## Latest Provider Updates  (bulleted, grouped by provider, only what the sources below support)`,
    `## Strategic Assessment  (what matters for the AI OS platform, what is noise, what deserves action — under 250 words)`,
    `## Suggested Implementations  (top 3-5 concrete changes this intel actually justifies: what, where, expected benefit, rough effort)`,
    `## Sources & Confidence  (which sources were fetched cleanly, which had nothing new, which were UNPARSED or FAILED — say so plainly)`,
    ``,
    `The inputs below were fetched DIRECTLY from each provider's own changelog — they are primary sources,`,
    `not summaries. Do not invent facts beyond them. An UNPARSED or FAILED source means we do not know,`,
    `and the statement must say that rather than imply quiet.`,
    ``,
    `--- PRIMARY-SOURCE DELTAS (fetched ${new Date().toISOString().slice(0, 16)}Z) ---`,
    intel,
  ].join('\n');
}

// ---------------------------------------------------------------------------------------------
//  The run
// ---------------------------------------------------------------------------------------------

/**
 * deps = { runAgent, log?, broadcast? } — runAgent is server.js executeAgent, exactly as the
 * current pipeline receives it, so routing, cost ledger and gates are identical.
 *
 * @returns meta with the measurement a comparison needs: sources[], entries, llmCalls (=1).
 */
async function runIntelBriefCompiled(deps, { dir, fetch, now = Date.now() } = {}) {
  const log = (deps && deps.log) || (() => {});
  const dateLabel = new Date(now).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

  // Stage 1: deterministic.
  const sources = await fetchAllSources({ fetch: fetch || safeFetch, now, log });
  const seen = loadPreviouslySeen(dir);
  const newEntries = [];
  const seenKeys = [];
  for (const s of sources) {
    for (const e of s.entries) {
      const k = entryKey(s.provider, e);
      seenKeys.push(k);
      if (!seen.has(k)) newEntries.push({ provider: s.provider, entry: e });
    }
  }
  const healthy = sources.filter((s) => s.fetched && !s.unparsed).length;
  log(`[intel-brief-compiled] ${healthy}/${sources.length} sources healthy; ${newEntries.length} new entries after dedupe; 0 model calls so far`);

  // Stage 2: ONE model call. No maxTokens passed — executeAgent's own default applies, and this week
  // established at some cost that a tight ceiling on an xhigh agent returns a truncated answer.
  const comms = await deps.runAgent('comms-director', buildStatementTask({ dateLabel, sources, newEntries }), { skill: 'intel-brief-compiled:comms-director' });
  if (!comms || !comms.ok || !comms.content) throw new Error((comms && comms.error) || 'comms-director produced no statement');

  // Stage 3: deterministic.
  const meta = await saveBriefDocx({
    dir, kind: 'intel-brief', statement: comms.content,
    extraMeta: {
      mode: 'compiled',
      llmCalls: 1,
      sourcesHealthy: healthy, sourcesTotal: sources.length,
      sources: sources.map((s) => ({ provider: s.provider, fetched: s.fetched, status: s.status, parsed: s.parsed, recent: s.recent, unparsed: s.unparsed, error: s.error })),
      entriesRecent: sources.reduce((n, s) => n + s.recent, 0),
      entriesNew: newEntries.length,
      seenKeys,
      // Carried so the sidecar itself is a cost record for THIS run, independent of the ledger.
      inputTokens: comms.inputTokens || 0, outputTokens: comms.outputTokens || 0, cost: comms.cost || 0, model: comms.model || null,
    },
  });
  log(`[intel-brief-compiled] wrote ${meta.file} — 1 model call, ${comms.inputTokens || 0} in / ${comms.outputTokens || 0} out`);
  return meta;
}

// entryKey, buildStatementTask and RECENT_DAYS are internal to the run; FILE_RE belongs to
// lib/intel-brief.js and re-exporting it here made the same name resolvable from two paths.
module.exports = { SOURCES, htmlToText, extractEntries, isRecent, fetchAllSources, runIntelBriefCompiled };
