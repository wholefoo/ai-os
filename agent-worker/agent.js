// AI OS Voice Agent Worker
// Runs alongside the main server as a LiveKit Agent
// Pipeline: Deepgram STT → OpenAI-compatible LLM → Cartesia TTS
//
// Usage: node agent.js
// Requires env vars: LIVEKIT_API_KEY, LIVEKIT_API_SECRET, LIVEKIT_URL,
//   DEEPGRAM_API_KEY, CARTESIA_API_KEY, OPENAI_API_KEY (or ANTHROPIC_API_KEY)

import { cli, defineAgent, llm, voice } from '@livekit/agents';
import * as deepgramPlugin from '@livekit/agents-plugin-deepgram';
import * as cartesiaPlugin from '@livekit/agents-plugin-cartesia';
import * as openaiPlugin from '@livekit/agents-plugin-openai';
import * as sileroPlugin from '@livekit/agents-plugin-silero';
import { config } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

// Load .env from parent directory (ai-os root)
const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, '..', '.env') });

// Agent personality profiles — maps to AI OS Virtual HQ employees
const EMPLOYEE_PROFILES = {
  atlas: {
    name: 'Atlas',
    title: 'CEO & Chief Orchestrator',
    systemPrompt: `You are Atlas, the CEO and Chief Orchestrator of AI OS Corp — a Virtual Corporate Headquarters platform with 51 AI agents across 10 departments. You are confident, strategic, and concise. You help users navigate the platform, understand its capabilities, and make decisions. Speak naturally — you are in a voice conversation. Keep responses under 3 sentences unless asked for detail.`,
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

function getProfile(roomName) {
  const match = (roomName || '').match(/avatar-(\w+)-/);
  const key = match ? match[1] : 'atlas';
  return EMPLOYEE_PROFILES[key] || EMPLOYEE_PROFILES.atlas;
}

export default defineAgent({
  entry: async (ctx) => {
    await ctx.waitForParticipant();

    const profile = getProfile(ctx.room.name);
    console.log(`[AGENT] ${profile.name} (${profile.title}) joined room: ${ctx.room.name}`);

    // Build the voice pipeline
    const session = new voice.AgentSession({
      // Voice Activity Detection
      vad: sileroPlugin.VAD.load(),

      // Speech-to-Text — Deepgram Nova-3
      stt: new deepgramPlugin.STT({ model: 'nova-3' }),

      // LLM — OpenAI (GPT-4o) or configure for Anthropic via base URL
      llm: new openaiPlugin.LLM({ model: 'gpt-4o' }),

      // Text-to-Speech — Cartesia Sonic
      tts: new cartesiaPlugin.TTS({
        model: 'sonic',
        voiceId: profile.cartesiaVoice,
        language: 'en',
      }),

      // Chat context — employee personality
      chatCtx: new llm.ChatContext().append({
        role: 'system',
        text: profile.systemPrompt,
      }),
    });

    // Start the voice agent session
    await session.start(ctx.room, ctx.participant);

    // Send initial greeting
    await session.say(`Hello! I'm ${profile.name}, ${profile.title} at AI OS Corp. How can I help you?`);
  },
});

// Run the agent worker
cli.runApp({});
