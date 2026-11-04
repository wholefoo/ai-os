// Tests agent-worker/: the LiveKit voice agent builds its pipeline on the installed @livekit/agents.
//
// The bug: agent.js was written against the pre-1.0 API and the lockfile installs 1.6.3, so every
// voice session failed before it started — `new llm.ChatContext().append()` is not a function in
// 1.x, `VAD.load()` was passed as an un-awaited Promise, `session.start(room, participant)` is now
// `start({ agent, room })`, `cli.runApp({})` gave job processes no file to import, and Cartesia's
// `voiceId` was silently ignored (the option is `voice`), so every employee had the default voice.
// None of it showed up anywhere: agent-worker is its own package and nothing installed or ran it.
//
// So this suite runs the REAL pipeline against the REAL installed packages, with dummy keys: the
// silero model is loaded, every plugin is constructed, and entry() is driven with a fake job
// context. Only AgentSession.start/say are stubbed — they need a live LiveKit room — and the stub
// records the arguments so the 1.x call shape is asserted, not assumed.
//
// Needs `cd agent-worker && npm ci`. Without it the suite FAILS in CI (where the workflow installs
// it) and skips loudly elsewhere, so a contributor's `npm test` doesn't demand a native voice stack.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { pathToFileURL } = require('url');
const { assert, done, repoRoot, readRepoFile } = require('./test-util');

const AW = path.join(repoRoot, 'agent-worker');
const AGENTS_ESM = path.join(AW, 'node_modules', '@livekit', 'agents', 'dist', 'index.js');

if (!fs.existsSync(AGENTS_ESM)) {
  if (process.env.CI) {
    console.error('FAIL: agent-worker dependencies are not installed — CI must run `npm ci` in agent-worker/ before the suites');
    process.exit(1);
  }
  console.warn('SKIP: agent-worker/node_modules missing — run `cd agent-worker && npm ci` to test the voice pipeline (CI always does)');
  process.exit(0);
}
require('./test-util').requireFinish();

const DUMMY_ENV = {
  LIVEKIT_URL: 'wss://dummy.invalid', LIVEKIT_API_KEY: 'dummy', LIVEKIT_API_SECRET: 'dummy',
  DEEPGRAM_API_KEY: 'dummy', CARTESIA_API_KEY: 'dummy', OPENAI_API_KEY: 'dummy',
};

(async () => {
  // --- both files parse, and neither still uses a pre-1.0 call --------------------------------------
  for (const f of ['agent.js', 'pipeline.js']) {
    execFileSync(process.execPath, ['--check', path.join(AW, f)]);
    assert(true, `node --check agent-worker/${f}`);
  }
  const src = readRepoFile('agent-worker/pipeline.js') + readRepoFile('agent-worker/agent.js');
  assert(!/ChatContext\(\)\.append\(/.test(src), 'no ChatContext().append() — removed in 1.x; the prompt is the Agent\'s instructions');
  assert(!/voiceId\s*:/.test(src), 'no Cartesia `voiceId:` — 1.x ignores it silently; the option is `voice` (TTS options are private, so this one is checked in source)');
  assert(/voice:\s*profile\.cartesiaVoice/.test(src), 'the employee\'s Cartesia voice is passed as `voice`');
  assert(!/runApp\(\s*\{\s*\}\s*\)/.test(src), 'cli.runApp() is given ServerOptions with an agent path, not {}');

  // --- agent.js itself imports and reaches the CLI ---------------------------------------------------
  // `--help` makes runApp print usage and exit 0 — after every import resolved and ServerOptions
  // was constructed, which is the part a stale API breaks. A worker is never started.
  const help = execFileSync(process.execPath, [path.join(AW, 'agent.js'), '--help'],
    { cwd: AW, encoding: 'utf8', env: { ...process.env, ...DUMMY_ENV }, timeout: 60000 });
  assert(/\bstart\b/.test(help) && /LiveKit Agents CLI/.test(help), 'agent.js imports cleanly and its CLI offers the `start` command pm2 runs');

  // --- the real pipeline, constructed with dummy keys ------------------------------------------------
  Object.assign(process.env, DUMMY_ENV);
  // Same file URL the pipeline resolves, so this is the SAME module instance (the package also
  // ships CJS — a require() here would load a second copy and the prototype stubs below would miss).
  const agents = await import(pathToFileURL(AGENTS_ESM).href);
  agents.initializeLogger({ pretty: false, level: 'warn' }); // the worker does this before any job
  const { voice } = agents;
  const p = await import(pathToFileURL(path.join(AW, 'pipeline.js')).href);

  assert(p.getProfile('avatar-nova-123').name === 'Nova', 'avatar-nova-<id> rooms get Nova');
  assert(p.getProfile('avatar-forge-x').name === 'Forge', 'avatar-forge-<id> rooms get Forge');
  assert(p.getProfile('avatar-nobody-1').name === 'Atlas', 'an unknown employee falls back to Atlas');
  assert(p.getProfile(undefined).name === 'Atlas' && p.getProfile('lobby').name === 'Atlas', 'no name / non-avatar room falls back to Atlas');
  assert(Object.keys(p.EMPLOYEE_PROFILES).length === 5, 'all five employee profiles are kept');

  const proc = { userData: {} };
  await p.prewarm(proc);
  assert(proc.userData.vad && typeof proc.userData.vad.stream === 'function',
    'prewarm leaves a loaded silero VAD (not a Promise) in proc.userData');

  const nova = p.getProfile('avatar-nova-1');
  const agent = p.createAgent(nova);
  assert(agent instanceof voice.Agent, 'createAgent returns a voice.Agent');
  assert(agent.instructions === nova.systemPrompt, 'the employee\'s system prompt is the Agent\'s instructions');

  const session = p.createSession(nova, proc.userData.vad);
  assert(session instanceof voice.AgentSession, 'createSession constructs a voice.AgentSession with dummy keys');
  assert(session.vad === proc.userData.vad, 'the session uses the prewarmed VAD, not the auto-provisioned default');
  assert(session.stt && session.llm && session.tts, 'STT, LLM and TTS are all wired');
  assert(session.stt.model === 'nova-3' && session.llm.model === 'gpt-4o' && session.tts.model === 'sonic',
    'Deepgram nova-3 → gpt-4o → Cartesia sonic');

  // --- entry(): the 1.x start() shape, driven with a fake job context --------------------------------
  const calls = [];
  const origStart = voice.AgentSession.prototype.start;
  const origSay = voice.AgentSession.prototype.say;
  voice.AgentSession.prototype.start = async function (...args) { calls.push(['start', args, this]); };
  voice.AgentSession.prototype.say = function (...args) { calls.push(['say', args, this]); return {}; };
  const room = { name: 'avatar-muse-42' };
  const ctx = { room, proc, waitForParticipant: async () => { calls.push(['waitForParticipant']); return {}; } };
  try {
    await p.entry(ctx);
  } finally {
    voice.AgentSession.prototype.start = origStart;
    voice.AgentSession.prototype.say = origSay;
  }
  const muse = p.EMPLOYEE_PROFILES.muse;
  assert(calls.map((c) => c[0]).join(',') === 'start,waitForParticipant,say', `entry starts the session, waits for a participant, then greets (got ${calls.map((c) => c[0])})`);
  const [, startArgs, startedSession] = calls[0];
  assert(startArgs.length === 1 && startArgs[0] && typeof startArgs[0] === 'object', 'start() gets ONE options object — the pre-1.0 start(room, participant) form is gone');
  assert(startArgs[0].room === room, 'start({ room }) is the job\'s room');
  assert(startArgs[0].agent instanceof voice.Agent && startArgs[0].agent.instructions === muse.systemPrompt,
    'start({ agent }) is a voice.Agent carrying the room\'s employee prompt (Muse for avatar-muse-*)');
  assert(startedSession.vad === proc.userData.vad, 'the session entry() starts uses the prewarmed VAD');
  assert(calls[2][1][0] === p.greeting(muse) && /I'm Muse, Creative Director/.test(calls[2][1][0]), 'the greeting names the employee');

  done();
})().catch((e) => { console.error('FAIL:', e && e.stack || e); process.exitCode = 1; done(); });
