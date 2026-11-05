// The video avatar's lip-sync path. A LiveAvatar LITE session (the default) does NO text-to-speech —
// repeat(text) throws "Not permitted in LITE mode" — so its lips only move to PCM we send it. Until
// 2026-11-05 sendToHeyGen() always called repeat(); it threw, the catch fell back to TTS, and every
// reply was heard while the face never moved.
//
// Two parts: lib/tts-request.js (the /api/tts body: voice + format allow-lists, `format: 'pcm'`), and
// dashboard/js/app.js sendToHeyGen() — its REAL source is lifted out of app.js and run in a sandbox
// against a fake avatar session and a fake /api/tts, so the behaviour is tested, not the spelling.
const vm = require('vm');
const { assert, done, readRepoFile } = require('./test-util');
const { buildTtsBody, TTS_FORMATS } = require('../lib/tts-request');
require('./test-util').requireFinish();

// ---------- lib/tts-request.js ---------------------------------------------------------------------
const b = buildTtsBody({ text: 'Hello', voice: 'nova', instructions: 'calm', format: 'pcm' });
assert(b.model === 'gpt-4o-mini-tts' && b.input === 'Hello' && b.voice === 'nova' && b.instructions === 'calm' && b.response_format === 'pcm',
  "format: 'pcm' asks OpenAI for raw PCM (24 kHz 16-bit mono — what a LiveAvatar LITE session lip-syncs to)");
assert(buildTtsBody({ text: 'x' }).response_format === 'mp3', 'no format -> mp3 (the browser-played default is unchanged)');
assert(['wav', 'flac', 'opus', '', null, 42, 'PCM'].every((f) => buildTtsBody({ text: 'x', format: f }).response_format === 'mp3'), 'any other format falls back to mp3 (allow-list, exact match)');
assert([...TTS_FORMATS].sort().join() === 'mp3,pcm', 'only mp3 and pcm are allowed');
assert(buildTtsBody({ text: 'x', voice: 'darth' }).voice === 'onyx' && buildTtsBody({ text: 'x', voice: 'shimmer' }).voice === 'shimmer', 'unknown voice -> onyx; known voice kept');
assert(buildTtsBody({ text: 'y'.repeat(5000) }).input.length === 4096, 'input capped at OpenAI\'s 4096');
assert(!('instructions' in buildTtsBody({ text: 'x', instructions: 7 })) && buildTtsBody({ text: 'x', instructions: 'z'.repeat(900) }).instructions.length === 500,
  'instructions only when a string, capped at 500');
assert(/buildTtsBody\(\{ text, voice, instructions, format \}\)/.test(readRepoFile('server.js')) && /format: body\.response_format/.test(readRepoFile('server.js')),
  'server.js /api/tts builds its body here and reports the format it returned');

// ---------- dashboard/js/app.js sendToHeyGen(), run for real ----------------------------------------
const appSrc = readRepoFile('dashboard/js/app.js');
// Lift one top-level function's source out of app.js by its header, matching braces to its end.
function liftFn(header) {
  const start = appSrc.indexOf(header);
  assert(start >= 0, `app.js has ${header.replace(/ \{$/, '')}`);
  let depth = 0;
  for (let i = appSrc.indexOf('{', start); i < appSrc.length; i++) {
    if (appSrc[i] === '{') depth++;
    else if (appSrc[i] === '}' && --depth === 0) return appSrc.slice(start, i + 1);
  }
  return '';
}
// sendToHeyGen and the /api/tts helper it shares with speakText().
const fnSrc = `${liftFn("async function requestTts(text, format = 'mp3') {")}\n${liftFn('async function sendToHeyGen(text) {')}`;

function sandbox({ mode = 'LITE', active = true, tts, repeatThrows = false, endDuringFetch = false } = {}) {
  const calls = [];
  const ctx = {
    heygenSessionActive: active,
    heygenAvatar: active ? {
      mode,
      repeat: (t) => { calls.push(['repeat', t]); if (mode === 'LITE') throw new Error('Not permitted in LITE mode'); },
      repeatAudio: (a) => { calls.push(['repeatAudio', a]); if (repeatThrows) throw new Error('Session needs to be connected to send command event'); },
    } : null,
    localStorage: { getItem: () => 'tok' },
    AVATAR_PROFILES: { muse: { voice: 'shimmer', persona: 'lively' } },
    avatarState: { employee: 'muse' },
    console: { warn: () => {}, error: () => {} },
    fetch: async (url, opts) => {
      calls.push(['fetch', url, JSON.parse(opts.body)]);
      if (endDuringFetch) ctx.heygenSessionActive = false;
      return { json: async () => tts };
    },
  };
  vm.createContext(ctx);
  vm.runInContext(fnSrc, ctx);
  return { run: (text) => vm.runInContext(`sendToHeyGen(${JSON.stringify(text)})`, ctx), calls };
}
const PCM = { ok: true, format: 'pcm', audioContent: 'AAAA' };

(async () => {
  let s = sandbox({ tts: PCM });
  assert(await s.run('Hi there') === true, 'LITE: resolves true when the avatar was given speech');
  const f = s.calls.find((c) => c[0] === 'fetch');
  assert(f && f[1] === '/api/tts' && f[2].format === 'pcm' && f[2].voice === 'shimmer' && f[2].instructions === 'lively' && f[2].text === 'Hi there',
    "LITE: asks /api/tts for format 'pcm' in the employee's own voice and persona");
  assert(s.calls.some((c) => c[0] === 'repeatAudio' && c[1] === 'AAAA'), 'LITE: hands the PCM to repeatAudio() (which chunks it and ends the utterance)');
  assert(!s.calls.some((c) => c[0] === 'repeat'), 'LITE: never calls repeat(text) — it throws "Not permitted in LITE mode"');

  s = sandbox({ tts: { ok: true, format: 'mp3', audioContent: 'SUQz' } });
  assert(await s.run('x') === false && !s.calls.some((c) => c[0] === 'repeatAudio'), 'LITE: mp3 (an older server) is NEVER sent as PCM — false, so the caller speaks it via TTS');
  s = sandbox({ tts: { ok: false, error: 'OpenAI API key not configured', fallback: true } });
  assert(await s.run('x') === false && !s.calls.some((c) => c[0] === 'repeatAudio'), 'LITE: a TTS failure -> false (caller falls back to TTS)');
  s = sandbox({ tts: PCM, repeatThrows: true });
  assert(await s.run('x') === false, 'LITE: repeatAudio throwing (no session WebSocket) -> false, not an unhandled error');
  s = sandbox({ tts: PCM, endDuringFetch: true });
  assert(await s.run('x') === false && !s.calls.some((c) => c[0] === 'repeatAudio'), 'LITE: the session ending while speech is generated -> nothing sent, false');

  s = sandbox({ mode: 'FULL', tts: PCM });
  assert(await s.run('Hello') === true && s.calls.some((c) => c[0] === 'repeat' && c[1] === 'Hello') && !s.calls.some((c) => c[0] === 'fetch'),
    'FULL: repeat(text) as before — LiveAvatar does the TTS, no /api/tts call');

  s = sandbox({ active: false, tts: PCM });
  assert(await s.run('x') === false && s.calls.length === 0, 'no active session -> false, nothing fetched or sent');

  // The callers wait for the answer: an un-awaited async call is a Promise, which is always truthy —
  // TTS would then be skipped even when the avatar said nothing (silence).
  assert(/videoSpoke = !didTriggered && heygenSessionActive && await sendToHeyGen\(reply\)/.test(appSrc), 'sendAvatarMessage awaits sendToHeyGen (a bare Promise would silence the fallback)');
  assert(/if \(await sendToHeyGen\(greeting\)\) addAvatarBotMessageNoSpeak\(greeting\);\s*else addAvatarBotMessage\(greeting\);/.test(appSrc), 'the connect greeting is spoken by the face when possible, else by TTS');
  assert((appSrc.match(/sendToHeyGen\(/g) || []).length === 3, 'sendToHeyGen has exactly the definition + the two awaited call sites');
  assert(/const data = await requestTts\(text\);/.test(liftFn('async function speakText(text) {')), 'speakText() uses the same /api/tts helper (mp3, played in the page)');

  done();
})().catch((e) => { console.error('FAIL:', e && e.stack || e); process.exitCode = 1; done(); });
