// AI OS Voice Agent Worker
// Runs alongside the main server as a LiveKit Agent
// Pipeline: Deepgram STT → OpenAI-compatible LLM → Cartesia TTS (Silero VAD)
//
// Usage: node agent.js start   (pm2 passes `start` — see ecosystem.config.js)
// Requires env vars: LIVEKIT_API_KEY, LIVEKIT_API_SECRET, LIVEKIT_URL,
//   DEEPGRAM_API_KEY, CARTESIA_API_KEY, OPENAI_API_KEY (or ANTHROPIC_API_KEY)
//
// The pipeline itself lives in pipeline.js. This file stays the thin entrypoint the official
// @livekit/agents 1.x examples use, because cli.runApp() runs at import — nothing that needs
// testing can live here.

import { ServerOptions, cli, defineAgent } from '@livekit/agents';
import { config } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { prewarm, entry } from './pipeline.js';

// Load .env from parent directory (ai-os root)
const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, '..', '.env') });

export default defineAgent({ prewarm, entry });

// Run the agent worker. `agent` is the path job processes import this file's default export from.
cli.runApp(new ServerOptions({ agent: fileURLToPath(import.meta.url) }));
