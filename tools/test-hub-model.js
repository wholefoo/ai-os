// tools/test-hub-model.js
// The hub fields on the article model: kind (article|video), tags, source attribution, featured,
// and video media. Ported from the standalone hub's ingest validator (hub/server/ingest-server.mjs)
// so content written for it behaves the same in Web Studio.
//
// The single most important case is CARRY-OVER: the dashboard editor predates these fields, so a
// save from it omits them. If omission meant "clear", every UI edit would silently erase tags and
// video media that an ingest workflow had set.
'use strict';
const assert = require('assert');
const A = require('../lib/web-studio/articles');

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n        ' + e.message.split('\n')[0]); }
};
const NOW = '2026-09-18T00:00:00.000Z';
const norm = (a, opts = {}) => A.normalizeArticle(a, { now: NOW, ...opts });
const throws = (fn, re, label) => {
  let err = null;
  try { fn(); } catch (e) { err = e; }
  assert.ok(err, label + ' — did not throw');
  if (re) assert.ok(re.test(err.message), label + ' — wrong message: ' + err.message);
  return err;
};

console.log('hub-model');

// ---------- kind ---------------------------------------------------------------------------------
t('an entry defaults to kind "article"', () => {
  assert.strictEqual(norm({ title: 'T', html: '<p>x</p>' }).kind, 'article');
});

t('an unknown kind is rejected', () => {
  throws(() => norm({ title: 'T', kind: 'podcast' }), /kind must be/, 'podcast kind');
});

t('a video with no media is rejected', () => {
  throws(() => norm({ title: 'T', kind: 'video' }), /needs a youtubeId/, 'media-less video');
});

// ---------- YouTube ids ----------------------------------------------------------------------------
t('extracts the id from every common YouTube URL shape', () => {
  const ID = 'dQw4w9WgXcQ';
  for (const u of [ID, 'https://youtu.be/' + ID, 'https://www.youtube.com/watch?v=' + ID,
    'https://m.youtube.com/watch?v=' + ID + '&t=42', 'https://youtube.com/shorts/' + ID,
    'https://www.youtube.com/embed/' + ID, 'https://www.youtube-nocookie.com/embed/' + ID,
    'https://www.youtube.com/live/' + ID]) {
    assert.strictEqual(A.youtubeId(u), ID, 'failed on ' + u);
  }
});

t('refuses look-alike hosts the hub would have accepted', () => {
  // TIGHTENED FROM THE HUB: it tested host.endsWith("youtube.com"), which ACCEPTS
  // evilyoutube.com. An id pulled from an attacker's host is not a YouTube video.
  assert.strictEqual(A.youtubeId('https://evilyoutube.com/watch?v=dQw4w9WgXcQ'), null);
  assert.strictEqual(A.youtubeId('https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ'), null);
});

t('rejects malformed ids', () => {
  for (const v of ['short', 'dQw4w9WgXc', 'dQw4w9WgXcQQ', 'dQw4w9WgX!Q', '', null, 42]) {
    assert.strictEqual(A.youtubeId(v), null, 'accepted ' + JSON.stringify(v));
  }
});

t('a video accepts youtubeUrl and stores only the id', () => {
  const v = norm({ title: 'T', kind: 'video', youtubeUrl: 'https://youtu.be/dQw4w9WgXcQ' });
  assert.strictEqual(v.youtubeId, 'dQw4w9WgXcQ');
});

// ---------- videoUrl + duration --------------------------------------------------------------------
t('videoUrl must be https', () => {
  throws(() => norm({ title: 'T', kind: 'video', videoUrl: 'http://x.example/a.mp4' }), /https/, 'http');
  throws(() => norm({ title: 'T', kind: 'video', videoUrl: 'javascript:alert(1)' }), /https/, 'javascript');
  assert.strictEqual(norm({ title: 'T', kind: 'video', videoUrl: 'https://x.example/a.mp4' }).videoUrl,
    'https://x.example/a.mp4');
});

t('duration must look like a timestamp', () => {
  for (const ok of ['12:34', '1:02:03', '0:59']) {
    assert.strictEqual(norm({ title: 'T', kind: 'video', youtubeId: 'dQw4w9WgXcQ', duration: ok }).duration, ok);
  }
  for (const bad of ['12 minutes', '1:2', '123:45', '<b>1:00</b>']) {
    throws(() => norm({ title: 'T', kind: 'video', youtubeId: 'dQw4w9WgXcQ', duration: bad }),
      /duration/, 'accepted ' + bad);
  }
});

// ---------- tags -----------------------------------------------------------------------------------
t('tags are trimmed and capped at 10', () => {
  assert.deepStrictEqual(norm({ title: 'T', tags: ['  ai ', 'security'] }).tags, ['ai', 'security']);
  throws(() => norm({ title: 'T', tags: Array.from({ length: 11 }, (_, i) => 't' + i) }), /up to 10/, '11 tags');
});

t('tags that would share a URL are deduplicated', () => {
  // "AI" and "ai" render to the same /tags/ai/ page, so they are one tag.
  assert.deepStrictEqual(norm({ title: 'T', tags: ['AI', 'ai', 'Ai'] }).tags, ['AI']);
});

t('C# and C++ stay distinct tags with distinct pages', () => {
  // The hub's slugger mapped both to "c", silently merging two different tag pages.
  const s1 = A.tagSlug('C#'), s2 = A.tagSlug('C++');
  assert.notStrictEqual(s1, s2, 'C# and C++ collide');
  assert.deepStrictEqual(norm({ title: 'T', tags: ['C#', 'C++'] }).tags, ['C#', 'C++']);
});

t('tags with markup or control characters are rejected', () => {
  for (const bad of ['<script>', 'a/b', '"quoted"', '', ' ']) {
    throws(() => norm({ title: 'T', tags: [bad] }), /tags must be/, 'accepted ' + JSON.stringify(bad));
  }
});

// ---------- source attribution ---------------------------------------------------------------------
t('source needs an http(s) url and an optional short name', () => {
  assert.deepStrictEqual(norm({ title: 'T', source: { url: 'https://example.com/p', name: ' Orig ' } }).source,
    { url: 'https://example.com/p', name: 'Orig' });
  throws(() => norm({ title: 'T', source: { url: 'javascript:alert(1)' } }), /source must be/, 'js source');
  throws(() => norm({ title: 'T', source: { url: 'https://x.example', name: 'n'.repeat(121) } }), /source must be/, 'long name');
});

t('source: null clears it', () => {
  const prev = norm({ title: 'T', source: { url: 'https://example.com' } });
  assert.strictEqual(norm({ title: 'T', source: null }, { existing: prev }).source, null);
});

// ---------- image / cover --------------------------------------------------------------------------
t('cover is accepted as an alias for image', () => {
  assert.strictEqual(norm({ title: 'T', cover: '/images/a.webp' }).image, '/images/a.webp');
});

t('dangerous image schemes are rejected', () => {
  for (const bad of ['javascript:alert(1)', 'data:image/svg+xml,<svg onload=alert(1)>', '//evil.example/x.png', 'vbscript:x']) {
    throws(() => norm({ title: 'T', image: bad }), /image\/cover/, 'accepted ' + bad);
  }
});

t('a legacy relative image path still saves', () => {
  // Stored plans hold paths like "images/x.webp". Rejecting them would make an existing article
  // impossible to save from the editor.
  assert.strictEqual(norm({ title: 'T', image: 'images/x.webp' }).image, 'images/x.webp');
});

// ---------- CARRY-OVER: the compatibility guarantee -----------------------------------------------
t('an edit that omits hub fields keeps them — the UI must not erase ingest data', () => {
  const prev = norm({
    title: 'Talk', kind: 'video', youtubeId: 'dQw4w9WgXcQ', duration: '12:34',
    tags: ['ai', 'security'], source: { url: 'https://example.com/talk', name: 'Conf' }, featured: true,
    image: '/c.webp',
  });
  // Exactly what the current dashboard editor sends: title, html, excerpt — nothing else.
  const next = norm({ title: 'Talk (edited)', html: '<p>new notes</p>' }, { existing: prev });
  assert.strictEqual(next.kind, 'video', 'kind was reset');
  assert.strictEqual(next.youtubeId, 'dQw4w9WgXcQ', 'video id was erased');
  assert.strictEqual(next.duration, '12:34', 'duration was erased');
  assert.deepStrictEqual(next.tags, ['ai', 'security'], 'tags were erased');
  assert.deepStrictEqual(next.source, { url: 'https://example.com/talk', name: 'Conf' }, 'source was erased');
  assert.strictEqual(next.featured, true, 'featured was reset');
  assert.strictEqual(next.image, '/c.webp', 'image was erased');
});

t('an explicit empty tag list does clear tags', () => {
  const prev = norm({ title: 'T', tags: ['a'] });
  assert.deepStrictEqual(norm({ title: 'T', tags: [] }, { existing: prev }).tags, []);
});

t('switching a video back to an article drops its media', () => {
  const prev = norm({ title: 'T', kind: 'video', youtubeId: 'dQw4w9WgXcQ', duration: '1:00' });
  const next = norm({ title: 'T', kind: 'article' }, { existing: prev });
  assert.strictEqual(next.youtubeId, null);
  assert.strictEqual(next.duration, null);
});

// ---------- errors are collected, not first-only ---------------------------------------------------
t('every problem in one item is reported at once', () => {
  const e = throws(() => norm({
    title: 'T', kind: 'video', youtubeId: 'bad', videoUrl: 'http://x', duration: 'long',
    tags: 'not-an-array', source: { url: 'ftp://x' },
  }), null, 'multi-error item');
  assert.ok(Array.isArray(e.errors), 'no .errors array');
  assert.ok(e.errors.length >= 5, 'only ' + e.errors.length + ' errors reported: ' + e.errors.join(' | '));
});

t('existing callers reading e.message still get a readable string', () => {
  const e = throws(() => norm({ title: 'T', kind: 'nope' }), /kind must be/, 'message');
  assert.strictEqual(typeof e.message, 'string');
});

// ---------- featured -------------------------------------------------------------------------------
t('featured accepts booleans and the form strings, rejects anything else', () => {
  assert.strictEqual(norm({ title: 'T', featured: true }).featured, true);
  assert.strictEqual(norm({ title: 'T', featured: 'false' }).featured, false);
  throws(() => norm({ title: 'T', featured: 'yes' }), /featured/, 'yes');
});

console.log('  ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
