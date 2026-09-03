// lib/intel-brief-compiled.js — the Daily Intelligence Statement as a three-stage split.
//
// WHAT THIS SUITE PROTECTS. The compiled brief replaces seven web-searching xhigh agents with an
// HTML scraper and ONE model call. A scraper's failure mode is not a crash — it is a confident
// "no updates" from a page whose markup changed, or a phantom entry from a date buried in an
// identifier. Every fixture below is a shape actually seen on a live provider page on 2026-09-03,
// and the assertions are on VALUES (the title extracted, the ISO date inferred), never counts.
//
// The three findings that shaped it, each caught by running the extractor against the real pages:
//   - Anthropic embeds ISO dates in beta-header names ("clear-at-2026-08-21") → 151 phantom entries
//   - OpenAI's newest "entry" was a deprecation SHUTDOWN date eleven months in the future
//   - Google served its changelog in ARABIC without an Accept-Language header → "no updates"
//
// No test here touches the network or spends a token: fetch and runAgent are both mocks.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { assert, done } = require('./test-util');
const C = require('../lib/intel-brief-compiled');

const NOW = Date.parse('2026-09-03T12:00:00Z');
const iso = (e) => e.map((x) => x.date);

// =============================================================================================
//  htmlToText
// =============================================================================================
{
  const t = C.htmlToText('<h2>September 1, 2026</h2><p>We&#x27;ve launched <b>Fable 5.1</b> &amp; more</p><script>x=1</script>');
  assert(/We've launched Fable 5.1 & more/.test(t), `hex entities and tags are decoded/stripped: ${JSON.stringify(t)}`);
  assert(!/x=1/.test(t), 'script bodies are dropped');
  assert(t.split('\n').length >= 2, 'block elements become line breaks — the extractor works line by line');
}

// =============================================================================================
//  extractEntries — the four real date shapes
// =============================================================================================
{
  const e = C.extractEntries('2026-08-21\nDeepSeek-V4-Flash-Vision-Exp Release\nToday the new model is available.', NOW);
  assert(e.length === 1 && e[0].date === '2026-08-21', 'ISO date on its own line');
  assert(e[0].title === 'DeepSeek-V4-Flash-Vision-Exp Release', `empty residual → title from the NEXT line (got ${JSON.stringify(e[0].title)})`);
}
{
  const e = C.extractEntries('Date: 2026-08-21\nDeepSeek-V4-Pro Update\nDetails here.', NOW);
  assert(e[0].title === 'DeepSeek-V4-Pro Update', `"Date:" label residual → title from the next line, not the literal word "Date" (got ${JSON.stringify(e[0].title)})`);
}
{
  const e = C.extractEntries('September 2, 2026\nGemini 3.8 Flash generally available (GA)\nReleased gemini-3.8-flash.', NOW);
  assert(e[0].date === '2026-09-02' && e[0].precision === 'day', 'long form "September 2, 2026"');
  assert(e[0].title === 'Gemini 3.8 Flash generally available (GA)', 'title taken from the following line');
}
{
  const e = C.extractEntries('August 2026\nGLM 5.3\nThe Agent API now supports GLM 5.3.', NOW);
  assert(e[0].date === '2026-08-01' && e[0].precision === 'month', 'month-year "August 2026" resolves to the 1st with precision:month');
  const e2 = C.extractEntries('September, 2026\nSep 2\nFeature\nUpdated API errors so applications can distinguish overload.', NOW);
  assert(e2.length >= 1 && e2[e2.length - 1].date === '2026-09-02', `OpenAI: "September, 2026" heading then "Sep 2" no-year line → ${iso(e2)}`);
  assert(e2[e2.length - 1].title === 'Updated API errors so applications can distinguish overload.',
    `the "Feature" tag line between date and title is skipped (got ${JSON.stringify(e2[e2.length - 1].title)})`);
}
{
  const e = C.extractEntries('September 2\ngrok-imagine-image-quality retirement on November 2\nOn November 2, 2026, the slug is retired.', NOW);
  assert(e.length === 1 && e[0].date === '2026-09-02', `xAI no-year "September 2" infers the current year (${iso(e)})`);
  assert(/grok-imagine/.test(e[0].title), `and takes the title from the next line even though that line contains a no-year date ("November 2") — got ${JSON.stringify(e[0].title)}`);
}
{
  // Year inference must look BACKWARD across a year boundary.
  const jan = Date.parse('2027-01-05T00:00:00Z');
  const e = C.extractEntries('Dec 30\nYear-end release', jan);
  assert(e[0].date === '2026-12-30', `"Dec 30" read on 2027-01-05 is LAST year, not eleven months in the future (got ${e[0].date})`);
}

// =============================================================================================
//  extractEntries — the traps
// =============================================================================================
{
  const e = C.extractEntries('September 1, 2026\nWe launched Fable 5.1.\nTurn-scoped messages are in beta ( mid-conversation-system-clear-at-2026-08-21 header).\nthinking.display accepts updates ( thinking-display-updates-2026-08-18 header).', NOW);
  assert(e.length === 1, `ISO dates INSIDE identifiers do not open entries — one entry, not three (got ${e.length}: ${iso(e)})`);
  assert(/clear-at-2026-08-21/.test(e[0].body), 'the identifier stays inside the entry body where it belongs');
}
{
  const e = C.extractEntries('Aug 26\nUpdate\nAnnounced deprecation of whisper-1; shutdown on 2027-02-26.\nMore text.', NOW);
  assert(e.length === 1 && e[0].date === '2026-08-26', `a FUTURE date ("2027-02-26") inside an entry never becomes the entry date (got ${iso(e)})`);
}
{
  const e = C.extractEntries('September 1, 2026\nAugust 27, 2026\nAugust 26, 2026\nSeptember 1, 2026\nWe launched Fable 5.1 today.', NOW);
  assert(e.length === 1 && /Fable 5.1/.test(e[0].title), `a run of bare dates is a TABLE OF CONTENTS, not entries — only the real one survives (got ${e.length}: ${e.map((x) => x.title)})`);
}
{
  const e = C.extractEntries('September 2\nImagine image API updates\nDetails.\n2026-09-02 Last updated', NOW);
  assert(e.length === 1 && e[0].title === 'Imagine image API updates', `a "Last updated" footer is metadata: skipped, and it does not truncate the entry before it (got ${e.map((x) => x.title)})`);
}
{
  const e = C.extractEntries('Product · September 1, 2026\nManus Resumes Independent Operations\nWe are entering the next chapter.', NOW);
  assert(e[0].title === 'Manus Resumes Independent Operations', `a short category tag ("Product ·") residual yields the next line as title (got ${JSON.stringify(e[0].title)})`);
}
{
  assert(C.extractEntries('', NOW).length === 0, 'empty text → no entries');
  assert(C.extractEntries('Just prose with no dates at all, about nothing in particular.', NOW).length === 0, 'prose with no date anchors → no entries, never a fabricated one');
}

// =============================================================================================
//  isRecent
// =============================================================================================
{
  assert(C.isRecent({ date: '2026-09-01', precision: 'day' }, NOW), 'two days ago is recent');
  assert(!C.isRecent({ date: '2026-08-21', precision: 'day' }, NOW), '13 days ago is not (window is 7)');
  assert(C.isRecent({ date: '2026-08-01', precision: 'month' }, NOW), 'a month-precision "August" entry seen on Sept 3 counts — last month is within reach');
  assert(!C.isRecent({ date: '2026-06-01', precision: 'month' }, NOW), 'a month-precision "June" entry does not');
  assert(!C.isRecent({ date: '2027-02-26', precision: 'day' }, NOW), 'a future date is never recent');
}

// =============================================================================================
//  fetchAllSources — the honesty flags, and the headers that keep Google in English
// =============================================================================================
(async () => {
  const seen = [];
  const mockFetch = (script) => async (url, opts) => {
    seen.push({ url, opts });
    const r = script(url);
    if (r instanceof Error) throw r;
    return { status: 200, statusText: 'OK', body: r };
  };
  const sources = [
    { provider: 'Healthy',  url: 'https://a.example/changelog' },
    { provider: 'Quiet',    url: 'https://b.example/changelog' },
    { provider: 'Unparsed', url: 'https://c.example/changelog' },
    { provider: 'Down',     url: 'https://d.example/changelog' },
    { provider: 'Google',   url: 'https://ai.google.dev/gemini-api/docs/changelog' },
  ];
  const out = await C.fetchAllSources({
    now: NOW, sources,
    fetch: mockFetch((url) => {
      if (/a\.example/.test(url)) return '<h2>September 2, 2026</h2><p>New thing shipped</p>';
      if (/b\.example/.test(url)) return '<h2>June 2, 2026</h2><p>Old thing</p>';
      if (/c\.example/.test(url)) return '<div>Welcome to our totally redesigned page with no dates anywhere</div>';
      if (/d\.example/.test(url)) return new Error('ECONNRESET');
      return '<h2>September 1, 2026</h2><p>Agentic video understanding</p>';
    }),
  });
  const by = Object.fromEntries(out.map((s) => [s.provider, s]));

  assert(by.Healthy.fetched && by.Healthy.parsed === 1 && by.Healthy.recent === 1 && !by.Healthy.unparsed, 'a healthy source: fetched, parsed, recent');
  assert(by.Quiet.fetched && by.Quiet.parsed === 1 && by.Quiet.recent === 0 && !by.Quiet.unparsed,
    'a QUIET source (entries, none recent) is healthy with recent=0 — this is the genuine "no updates" case');
  assert(by.Unparsed.fetched && by.Unparsed.status === 200 && by.Unparsed.parsed === 0 && by.Unparsed.unparsed === true,
    'a page that fetched 200 but yielded ZERO dated entries is flagged UNPARSED — the markup changed, the news did not');
  assert(by.Quiet.unparsed === false && by.Unparsed.recent === 0 && by.Quiet.recent === 0,
    'quiet and unparsed BOTH have recent=0 — the `unparsed` flag is the only thing that tells them apart, which is why it exists');
  assert(!by.Down.fetched && /ECONNRESET/.test(by.Down.error) && by.Down.parsed === 0, 'a fetch failure is reported as an error, and one failed source does not fail the run');

  const g = seen.find((s) => /ai\.google\.dev/.test(s.url));
  assert(/[?&]hl=en\b/.test(g.url), `Google is fetched with hl=en pinned (${g.url}) — without it the page arrived in Arabic on 2026-09-03`);
  assert(seen.every((s) => s.opts && s.opts.headers && /^en/.test(s.opts.headers['Accept-Language'] || '')),
    'EVERY fetch sends Accept-Language: en — a localised changelog is unreadable to an English month matcher and reports as "no updates"');
  assert(!/[?&]hl=/.test(seen.find((s) => /a\.example/.test(s.url)).url), 'the hl= pin is Google-specific — other sources are fetched at their exact URL');

  // =============================================================================================
  //  runIntelBriefCompiled — exactly ONE model call, the right tag, honest inputs, a measurable sidecar
  // =============================================================================================
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'intel-compiled-'));
  const calls = [];
  const deps = {
    runAgent: async (agent, task, opts) => {
      calls.push({ agent, task, opts });
      return { ok: true, content: '# Daily Intelligence Statement\n## Executive Summary\nFine.\n## Latest Provider Updates\n- x\n## Strategic Assessment\ny\n## Suggested Implementations\nz\n## Sources & Confidence\nw', model: 'opus-5-xhigh', inputTokens: 1800, outputTokens: 900, cost: 0.0315 };
    },
    log: () => {}, broadcast: () => {},
  };
  const fetchOnce = mockFetch((url) => {
    if (/c\.example/.test(url)) return '<div>redesigned, no dates</div>';
    if (/d\.example/.test(url)) return new Error('timeout');
    return '<h2>September 2, 2026</h2><p>New thing shipped</p>';
  });

  // Monkey-patch the module's source list for the run via the exported fetch injection — the run
  // reads SOURCES internally, so drive it through a wrapper fetch that answers for the real URLs.
  const real = C.SOURCES;
  const answer = (url) => (/x\.ai/.test(url) ? '<div>redesigned, no dates</div>' : /manus/.test(url) ? new Error('timeout') : '<h2>September 2, 2026</h2><p>New thing shipped</p>');
  const meta = await C.runIntelBriefCompiled(deps, { dir, now: NOW, fetch: mockFetch(answer) });

  assert(calls.length === 1, `EXACTLY ONE model call (got ${calls.length}) — this is the whole experiment; eleven became one`);
  assert(calls[0].agent === 'comms-director' && calls[0].opts.skill === 'intel-brief-compiled:comms-director',
    `the one call is the comms-director, tagged intel-brief-compiled:* so the ledger can separate it from the eleven-call version (got ${calls[0].agent} / ${calls[0].opts.skill})`);
  assert(calls[0].opts.maxTokens === undefined, 'no maxTokens is passed — executeAgent\'s own default applies; this week established that a tight ceiling on an xhigh agent returns a truncated statement');

  const task = calls[0].task;
  assert(/xAI\s+\(UNPARSED/.test(task), 'the statement task tells the model xAI was UNPARSED — "treat as UNKNOWN, not as no updates"');
  assert(/Manus\s+\(FETCH FAILED/.test(task), 'and that Manus FAILED to fetch');
  assert(/Anthropic\s+\(1 new entry/.test(task), 'and that Anthropic had one new entry');
  assert(/primary sources/i.test(task) && /Do not invent facts/.test(task), 'the model is told these are primary sources and not to invent beyond them');
  assert(/## Sources & Confidence/.test(task) && /UNPARSED or FAILED — say so plainly/.test(task), 'the Sources & Confidence section is required to name unparsed/failed sources');

  assert(meta.file && fs.existsSync(path.join(dir, meta.file)), `a .docx was written (${meta.file})`);
  const side = JSON.parse(fs.readFileSync(path.join(dir, meta.file.replace(/\.docx$/, '.json')), 'utf8'));
  assert(side.mode === 'compiled' && side.llmCalls === 1, 'the sidecar records mode=compiled and llmCalls=1');
  assert(side.sourcesHealthy === real.length - 2 && side.sourcesTotal === real.length, `sidecar counts healthy sources honestly: ${side.sourcesHealthy}/${side.sourcesTotal} (one unparsed, one failed)`);
  assert(side.cost === 0.0315 && side.inputTokens === 1800 && side.outputTokens === 900, 'the sidecar carries THIS run\'s cost and tokens — a cost record independent of the ledger');
  assert(Array.isArray(side.seenKeys) && side.seenKeys.length === real.length - 2, 'seenKeys records every recent entry reported, for tomorrow\'s dedupe');
  const xai = side.sources.find((s) => s.provider === 'xAI');
  assert(xai.unparsed === true && xai.status === 200, 'per-source health is in the sidecar — this is what the OVERSEER reads to notice a broken scraper');

  // --- dedupe: a second run the same day reports nothing new, and still makes exactly one call ---
  calls.length = 0;
  const meta2 = await C.runIntelBriefCompiled(deps, { dir, now: NOW, fetch: mockFetch(answer) });
  assert(calls.length === 1, 'the second run still makes exactly one call');
  assert(/Anthropic\s+\(no new entries/.test(calls[0].task), 'entries already reported yesterday are DEDUPED — the model is told "no new entries", not shown the same news twice');
  assert(meta2.file !== meta.file, 'a same-day second run gets a suffixed filename rather than overwriting');

  // --- an unavailable comms-director fails the run loudly, writes nothing ---
  const before = fs.readdirSync(dir).length;
  let threw = null;
  try { await C.runIntelBriefCompiled({ runAgent: async () => ({ ok: false, error: 'provider down' }), log: () => {} }, { dir, now: NOW, fetch: mockFetch(answer) }); }
  catch (e) { threw = e.message; }
  assert(/provider down/.test(threw || ''), 'if the one model call fails, the run throws with the reason');
  assert(fs.readdirSync(dir).length === before, '...and writes no docx — a statement with no statement in it is not a deliverable');

  fs.rmSync(dir, { recursive: true, force: true });
  done();
})();
