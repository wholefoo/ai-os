// AI OS Voice Agent Worker
// Runs alongside the main server as a LiveKit Agent
// Pipeline: Deepgram STT → Claude LLM → Cartesia TTS
//
// Usage: node agent.js
// Requires: LIVEKIT_API_KEY, LIVEKIT_API_SECRET, LIVEKIT_URL,
//           DEEPGRAM_API_KEY, CARTESIA_API_KEY, ANTHROPIC_API_KEY

import { cli, defineAgent, llm, voice } from '@livekit/agents';
import { deepgram } from '@livekit/agents-plugin-deepgram';
import { cartesia } from '@livekit/agents-plugin-cartesia';
import { anthropic } from '@livekit/agents-plugin-anthropic';
import { silero } from '@livekit/agents-plugin-silero';
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
    systemPrompt: `You are Atlas, the CEO and Chief Orchestrator of AI OS Corp — a Virtual Corporate Headquarters platform with 51 AI agents across 10 departments. You are confident, strategic, and concise. You help users navigate the platform, understand its capabilities, and make decisions. Speak naturally — you are in a voice conversation, not writing an essay. Keep responses under 3 sentences unless the user asks for detail.`,
    cartesiaVoice: '79a125e8-cd45-4c13-8a67-188112f4dd22', // confident male
  },
  nova: {
    name: 'Nova',
    title: 'CTO & Architect',
    systemPrompt: `You are Nova, the CTO and Chief Architect of AI OS Corp. You are analytical, precise, and technically deep. You explain architecture decisions, model routing, and system design. Keep voice responses concise — 2-3 sentences. Use technical terms naturally but explain when asked.`,
    cartesiaVoice: '9626c31c-bec5-4cca-baa8-f8ba9e84c8bc', // clear female
  },
  muse: {
    name: 'Muse',
    title: 'Creative Director',
    systemPrompt: `You are Muse, the Creative Director of AI OS Corp. You are expressive, imaginative, and enthusiastic about creative possibilities — video, image, audio, design. You talk about Gemini Omni Studio, visual design, and creative workflows. Keep it lively and inspiring. Short voice responses.`,
    cartesiaVoice: 'a0e99841-438c-4a64-b679-ae501e7d6091', // warm female
  },
  justice: {
    name: 'Justice',
    title: 'General Counsel',
    systemPrompt: `You are Justice, the General Counsel of AI OS Corp. You are measured, thoughtful, and authoritative on legal matters — licensing, compliance, contracts, IP protection. You speak clearly and precisely. Keep voice responses brief and professional.`,
    cartesiaVoice: 'ee7ea9f8-c0c1-498c-9f63-95b6a17deaaa', // mature male
  },
  forge: {
    name: 'Forge',
    title: 'Engineering Lead',
    systemPrompt: `You are Forge, the Engineering Lead at AI OS Corp. You are hands-on, practical, and focused on implementation. You talk about code, debugging, architecture, and getting things built. Keep voice responses direct and action-oriented.`,
    cartesiaVoice: '41534e16-2966-4c6b-9670-111411def906', // steady male
  },
};

// Default to Atlas if no employee specified
function getProfile(roomName) {
  const match = (roomName || '').match(/avatar-(\w+)-/);
  const key = match ? match[1] : 'atlas';
  return EMPLOYEE_PROFILES[key] || EMPLOYEE_PROFILES.atlas;
}

export default defineAgent({
  entry: async (ctx) => {
    // Wait for a participant to connect
    await ctx.waitForParticipant();

    const profile = getProfile(ctx.room.name);
    console.log(`[AGENT] ${profile.name} (${profile.title}) joined room: ${ctx.room.name}`);

    // Build the voice pipeline
    const session = new voice.AgentSession({
      // Voice Activity Detection — detects when the user starts/stops speaking
      vad: silero.VAD.load(),

      // Speech-to-Text — Deepgram Nova-3
      stt: new deepgram.STT({ model: 'nova-3' }),

      // LLM — Claude (Anthropic)
      llm: new anthropic.LLM({ model: 'claude-sonnet-4-20250514' }),

      // Text-to-Speech — Cartesia Sonic
      tts: new cartesia.TTS({
        model: 'sonic',
        voice: profile.cartesiaVoice,
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
cli.runApp({
  // The agent automatically connects to LiveKit Cloud using env vars:
  // LIVEKIT_API_KEY, LIVEKIT_API_SECRET, LIVEKIT_URL
});
