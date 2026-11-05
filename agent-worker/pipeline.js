// AI OS Voice Agent — the pipeline, kept apart from agent.js so it can be imported without
// starting a worker: agent.js calls cli.runApp() at module load, which parses argv and either
// starts the worker or prints usage and exits. tools/test-agent-worker.js imports THIS file.
//
// Written against the @livekit/agents 1.x API (lockfile: 1.6.3), following the official
// agents-js examples (examples/src/cartesia.ts, basic_agent.ts) and the silero plugin's own
// documented prewarm pattern. The pre-1.0 API this replaced failed on every session:
// ChatContext.append() no longer exists, VAD.load() returns a Promise, session.start() takes
// an options object with a voice.Agent, and Cartesia's option is `voice`, not `voiceId`.

import { voice } from '@livekit/agents';
import * as deepgramPlugin from '@livekit/agents-plugin-deepgram';
import * as cartesiaPlugin from '@livekit/agents-plugin-cartesia';
import * as openaiPlugin from '@livekit/agents-plugin-openai';
import * as sileroPlugin from '@livekit/agents-plugin-silero';

// Agent personality profiles — maps to AI OS Virtual HQ employees
export const EMPLOYEE_PROFILES = {
  atlas: {
    name: 'Atlas',
    title: 'CEO & Chief Orchestrator',
    systemPrompt: `You are Atlas, the CEO and Chief Orchestrator of AI OS Corp — a Virtual Corporate Headquarters platform with 73 AI agents across 11 departments. You are confident, strategic, and concise. You help users navigate the platform, understand its capabilities, and make decisions. Speak naturally — you are in a voice conversation. Keep responses under 3 sentences unless asked for detail.`,
    cartesiaVoice: '79a125e8-cd45-4c13-8a67-188112f4dd22',
  },
  nova: {
    name: 'Nova',
    title: 'CTO & Architect',
    systemPrompt: `You are Nova, the CTO and Chief Architect of AI OS Corp. You are analytical, precise, and technically deep. You explain architecture decisions, model routing, and system design. Keep voice responses concise — 2-3 sentences.`,
    cartesiaVoice: '9626c31c-bec5-4cca-baa8-f8ba9e84c8bc',
  },
  muse: {
    name: 'Muse',
    title: 'Creative Director',
    systemPrompt: `You are Muse, the Creative Director of AI OS Corp. You are expressive, imaginative, and enthusiastic about creative possibilities. You talk about video, image, audio generation and design. Keep it lively and short.`,
    cartesiaVoice: 'a0e99841-438c-4a64-b679-ae501e7d6091',
  },
  justice: {
    name: 'Justice',
    title: 'General Counsel',
    systemPrompt: `You are Justice, the General Counsel of AI OS Corp. You are measured, authoritative on legal matters — licensing, compliance, contracts, IP. Keep voice responses brief and professional.`,
    cartesiaVoice: 'ee7ea9f8-c0c1-498c-9f63-95b6a17deaaa',
  },
  forge: {
    name: 'Forge',
    title: 'Engineering Lead',
    systemPrompt: `You are Forge, the Engineering Lead at AI OS Corp. You are hands-on, practical, and focused on implementation. You talk about code, debugging, and getting things built. Keep responses direct.`,
    cartesiaVoice: '41534e16-2966-4c6b-9670-111411def906',
  },
};

export function getProfile(roomName) {
  const match = (roomName || '').match(/avatar-(\w+)-/);
  const key = match ? match[1] : 'atlas';
  return EMPLOYEE_PROFILES[key] || EMPLOYEE_PROFILES.atlas;
}

export const greeting = (profile) =>
  `Hello! I'm ${profile.name}, ${profile.title} at AI OS Corp. How can I help you?`;

// Runs once per job process, before any job is assigned: the silero ONNX model is loaded here
// so a session doesn't pay for it on its first turn.
export async function prewarm(proc) {
  proc.userData.vad = await sileroPlugin.VAD.load();
}

// The per-employee system prompt is the Agent's `instructions` (1.x), not a session chat context.
export const createAgent = (profile) => new voice.Agent({ instructions: profile.systemPrompt });

export function createSession(profile, vad) {
  return new voice.AgentSession({
    // Voice Activity Detection — the silero instance loaded in prewarm
    vad,

    // Speech-to-Text — Deepgram Nova-3
    stt: new deepgramPlugin.STT({ model: 'nova-3' }),

    // LLM — OpenAI (GPT-4o) or configure for Anthropic via base URL
    llm: new openaiPlugin.LLM({ model: 'gpt-4o' }),

    // Text-to-Speech — Cartesia Sonic
    tts: new cartesiaPlugin.TTS({
      model: 'sonic',
      voice: profile.cartesiaVoice,
      language: 'en',
    }),
  });
}

export async function entry(ctx) {
  const profile = getProfile(ctx.room.name);
  const session = createSession(profile, ctx.proc.userData.vad);

  // start() connects to the room itself when the job context hasn't yet (1.x auto-connect)
  await session.start({ agent: createAgent(profile), room: ctx.room });
  console.log(`[AGENT] ${profile.name} (${profile.title}) joined room: ${ctx.room.name}`);

  // Greet once someone is there to hear it. say() returns a SpeechHandle; like the official
  // examples it isn't awaited — awaiting a SpeechHandle waits for the whole greeting to play out.
  await ctx.waitForParticipant();
  session.say(greeting(profile));
}
