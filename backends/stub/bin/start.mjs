#!/usr/bin/env node
// CLI entry for the parley stub agent.
//
// Run via `node agent/bin/start.mjs` or `npm start` from the agent
// folder. Reads config from environment variables:
//
//   AGENT_HOST              default 127.0.0.1
//   AGENT_PORT              default 4001
//   AGENT_DATA_DIR          default ./data    (where conversations.json lives)
//   AGENT_BEARER_TOKEN      optional. when set, /v1/responses requires
//                           Authorization: Bearer <token>.
//
//   AGENT_LLM               'echo' | 'gemini' | 'ollama'. when unset,
//                           we auto-pick: gemini if GEMINI_API_KEY,
//                           ollama if OLLAMA_URL, else echo.
//   GEMINI_API_KEY          required for gemini
//   GEMINI_MODEL            default gemini-2.0-flash
//   OLLAMA_URL              default http://127.0.0.1:11434
//   OLLAMA_MODEL            default llama3.2

import { resolve } from 'node:path';
import { Conversations } from '../src/conversations.mjs';
import { pickAdapter } from '../src/llm/index.mjs';
import { createServer } from '../src/server.mjs';

const HOST = process.env.AGENT_HOST || '127.0.0.1';
const PORT = Number.parseInt(process.env.AGENT_PORT || '4001', 10);
const DATA_DIR = resolve(process.env.AGENT_DATA_DIR || './data');
const BEARER_TOKEN = process.env.AGENT_BEARER_TOKEN || undefined;

const conversations = new Conversations(`${DATA_DIR}/conversations.json`);
await conversations.load();

// Swappable adapter: the first-run setup wizard reconfigures the LLM
// live (POST /v1/admin/llm, proxied by parley) without a process
// restart. The delegate keeps createServer's `llm` reference stable
// while the active adapter underneath changes.
let active = pickAdapter();
const llm = {
  get name() { return active.name; },
  stream(messages) { return active.stream(messages); },
};
const reconfigure = (envPatch) => {
  for (const [k, v] of Object.entries(envPatch || {})) {
    if (v === null || v === undefined || v === '') delete process.env[k];
    else process.env[k] = String(v);
  }
  active = pickAdapter();
  console.log(`[stub-agent] llm reconfigured → ${active.name}`);
  return active.name;
};

const server = createServer({ conversations, llm, bearerToken: BEARER_TOKEN, reconfigure });
server.listen(PORT, HOST, () => {
  console.log(`[stub-agent] listening on http://${HOST}:${PORT}`);
  console.log(`[stub-agent] llm: ${llm.name}`);
  console.log(`[stub-agent] data dir: ${DATA_DIR}`);
  if (BEARER_TOKEN) console.log('[stub-agent] bearer token: required');
});

const flushAndExit = async (signal) => {
  console.log(`[stub-agent] ${signal} received, flushing state`);
  try { await conversations.flush(); } catch {}
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
};
process.on('SIGINT', () => void flushAndExit('SIGINT'));
process.on('SIGTERM', () => void flushAndExit('SIGTERM'));
