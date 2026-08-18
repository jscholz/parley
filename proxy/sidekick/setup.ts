/**
 * First-run setup surface — powers the PWA's onboarding wizard.
 *
 *   GET  /api/sidekick/setup/status  → what's configured, what's detected
 *   POST /api/sidekick/setup         → persist choice + hot-apply
 *
 * Design (FTUE research 2026-07-07, "Agent Zero model gate" pattern):
 * the wizard only ever ENGAGES when the upstream is the in-tree stub
 * still running its echo LLM — i.e. a fresh `npx sidekick-portal` /
 * install.sh trial. Real deployments (hermes/openclaw/custom URL) and
 * already-configured stubs report needsSetup=false and the PWA never
 * shows the gate, so existing installs see zero behavior change.
 *
 * Persistence is the .env file (PARLEY_ENV_FILE when the npx
 * launcher set one, else <repo>/.env) — the same file start-all loads
 * on boot, so choices survive restarts. Hot-apply happens through the
 * stub's loopback-only POST /v1/admin/llm (LLM swap without restart)
 * and a caller-provided setDeepgramKey (TTS goes live immediately;
 * mic STT rides the Python audio-bridge which reads the key at ITS
 * boot — restartRequired flags that honestly).
 */
import fs from 'node:fs';
import type http from 'node:http';

type SetupDeps = {
  /** Absolute path of the .env file choices persist to. */
  envFile: string;
  /** Upstream agent base URL (the stub in trial installs). */
  upstreamUrl: () => string;
  /** Live-swap the proxy's Deepgram key (TTS route). */
  setDeepgramKey: (key: string) => void;
  /** Current Deepgram key presence (for status). */
  hasDeepgramKey: () => boolean;
};

let deps: SetupDeps | null = null;

export function initSetup(d: SetupDeps): void { deps = d; }

// ── helpers ──────────────────────────────────────────────────────────

function json(res: http.ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readBody(req: http.IncomingMessage, cap = 64 * 1024): Promise<string> {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > cap) throw new Error('body too large');
  }
  return raw;
}

/** Upsert KEY=value lines into the env file, preserving everything else
 *  (comments, unrelated keys, ordering). null/'' deletes the key's line.
 *  Values are written verbatim — callers pass plain tokens (API keys,
 *  URLs) that never need quoting. */
export function upsertEnvFile(file: string, patch: Record<string, string | null>): void {
  let lines: string[] = [];
  try { lines = fs.readFileSync(file, 'utf8').split('\n'); } catch { /* new file */ }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of lines) {
    const m = line.match(/^([A-Z0-9_]+)=/);
    const key = m?.[1];
    if (key && key in patch) {
      seen.add(key);
      const v = patch[key];
      if (v === null || v === '') continue;         // delete
      out.push(`${key}=${v}`);                       // replace
    } else {
      out.push(line);
    }
  }
  // Trim a trailing blank so appends don't accumulate gaps.
  while (out.length && out[out.length - 1] === '') out.pop();
  for (const [key, v] of Object.entries(patch)) {
    if (seen.has(key) || v === null || v === '') continue;
    out.push(`${key}=${v}`);
  }
  fs.writeFileSync(file, out.join('\n') + '\n');
}

/** Probe a local Ollama for installed models. Fast-fail: 800ms. */
async function probeOllama(): Promise<{ detected: boolean; models: string[] }> {
  try {
    const r = await fetch('http://127.0.0.1:11434/api/tags', {
      signal: AbortSignal.timeout(800),
    });
    if (!r.ok) return { detected: false, models: [] };
    const data: any = await r.json();
    const models = Array.isArray(data?.models)
      ? data.models.map((m: any) => String(m?.name || '')).filter(Boolean)
      : [];
    return { detected: true, models };
  } catch {
    return { detected: false, models: [] };
  }
}

/** Probe the upstream's /v1/health. The stub reports {llm: <name>};
 *  hermes/openclaw plugins don't — that field's presence identifies a
 *  trial install. */
async function probeUpstream(url: string): Promise<{ ok: boolean; llm: string | null }> {
  try {
    const r = await fetch(`${url.replace(/\/+$/, '')}/v1/health`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!r.ok) return { ok: false, llm: null };
    const data: any = await r.json();
    return { ok: data?.status === 'ok', llm: typeof data?.llm === 'string' ? data.llm : null };
  } catch {
    return { ok: false, llm: null };
  }
}

// ── handlers ─────────────────────────────────────────────────────────

export async function handleSetupStatus(
  _req: http.IncomingMessage, res: http.ServerResponse,
): Promise<void> {
  if (!deps) return json(res, 503, { error: 'setup not initialized' });
  const [upstream, ollama] = await Promise.all([
    probeUpstream(deps.upstreamUrl()),
    probeOllama(),
  ]);
  const isStub = upstream.llm !== null;
  const needsSetup = isStub && (upstream.llm ?? '').startsWith('echo');
  json(res, 200, {
    needsSetup,
    upstream: { ok: upstream.ok, kind: isStub ? 'stub' : 'custom', llm: upstream.llm },
    ollama,
    voice: { configured: deps.hasDeepgramKey() },
  });
}

export async function handleSetupApply(
  req: http.IncomingMessage, res: http.ServerResponse,
): Promise<void> {
  if (!deps) return json(res, 503, { error: 'setup not initialized' });
  let body: any;
  try { body = JSON.parse(await readBody(req) || '{}'); }
  catch { return json(res, 400, { error: 'body is not valid JSON' }); }

  const path = String(body?.path || '');
  const envPatch: Record<string, string | null> = {};
  let llmEnv: Record<string, string | null> | null = null;
  let restartRequired = false;

  if (path === 'cloud') {
    const apiKey = String(body?.apiKey || '').trim();
    if (!apiKey) return json(res, 400, { error: 'apiKey required for the cloud path' });
    const baseUrl = String(body?.baseUrl || '').trim();
    const model = String(body?.model || '').trim();
    llmEnv = {
      AGENT_LLM: 'cloud',
      OPENAI_COMPAT_API_KEY: apiKey,
      OPENAI_COMPAT_BASE_URL: baseUrl || null,
      OPENAI_COMPAT_MODEL: model || null,
    };
    Object.assign(envPatch, llmEnv);
  } else if (path === 'gemini') {
    const apiKey = String(body?.apiKey || '').trim();
    if (!apiKey) return json(res, 400, { error: 'apiKey required for the gemini path' });
    llmEnv = {
      AGENT_LLM: 'gemini',
      GEMINI_API_KEY: apiKey,
      GEMINI_MODEL: String(body?.model || '').trim() || null,
    };
    Object.assign(envPatch, llmEnv);
  } else if (path === 'ollama') {
    llmEnv = {
      AGENT_LLM: 'ollama',
      OLLAMA_URL: String(body?.baseUrl || '').trim() || 'http://127.0.0.1:11434',
      OLLAMA_MODEL: String(body?.model || '').trim() || null,
    };
    Object.assign(envPatch, llmEnv);
  } else if (path === 'custom') {
    const platformUrl = String(body?.platformUrl || '').trim();
    if (!platformUrl) return json(res, 400, { error: 'platformUrl required for the custom path' });
    envPatch.PARLEY_PLATFORM_URL = platformUrl;
    const token = String(body?.platformToken || '').trim();
    if (token) envPatch.PARLEY_PLATFORM_TOKEN = token;
    // The proxy binds its upstream at boot — swapping it live would mean
    // re-initing the whole sidekick module (SSE channel, prefetch, ...).
    // Honest v1: persist + tell the user to restart.
    restartRequired = true;
  } else if (path !== 'voice') {
    return json(res, 400, { error: `unknown path: ${JSON.stringify(path)}` });
  }

  // Voice key rides along with any path (or alone via path='voice').
  const deepgramKey = String(body?.deepgramKey || '').trim();
  if (deepgramKey) envPatch.DEEPGRAM_API_KEY = deepgramKey;
  if (path === 'voice' && !deepgramKey) {
    return json(res, 400, { error: 'deepgramKey required for the voice path' });
  }

  // 1. Persist — same file start-all loads on the next boot.
  try { upsertEnvFile(deps.envFile, envPatch); }
  catch (e: any) {
    return json(res, 500, { error: `could not write ${deps.envFile}: ${e?.message}` });
  }

  // 2. Hot-apply.
  let llm: string | null = null;
  if (llmEnv) {
    try {
      const r = await fetch(`${deps.upstreamUrl().replace(/\/+$/, '')}/v1/admin/llm`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ env: llmEnv }),
        signal: AbortSignal.timeout(3000),
      });
      if (r.ok) llm = (await r.json() as any)?.llm ?? null;
      else restartRequired = true;   // persisted; applies on next boot
    } catch {
      restartRequired = true;
    }
  }
  // TTS goes live immediately (the wizard's voice test exercises it).
  // Mic STT rides the Python audio-bridge, which reads the key at ITS
  // boot — the wizard copy sets that expectation; no restart flag here
  // since the text path + TTS are fully usable.
  if (deepgramKey) deps.setDeepgramKey(deepgramKey);

  json(res, 200, { ok: true, llm, restartRequired, envFile: deps.envFile });
}
