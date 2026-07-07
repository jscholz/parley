// Sidekick proxy — model capability + auxiliary-vision advertisement
// endpoints. Both are thin pass-throughs to the upstream plugin. No
// catalog cache, no regex fallback, no OpenRouter dependency — the
// upstream owns the ground truth (e.g. hermes's models.dev registry +
// live config).
//
// Two endpoints exposed:
//   GET /api/sidekick/model-capabilities?model=Y[&provider=X]
//     Returns the full ModelCapabilities shape from the upstream's
//     capability lookup (e.g. hermes's agent.models_dev
//     .get_model_capabilities) — the same data it consults at request
//     time for native-vs-text image routing.
//   GET /api/sidekick/auxiliary-models
//     Returns {vision: <model_id> | null} reflecting the configured
//     auxiliary.vision.model. PWA reads this to show the "will route
//     through X" hint when the primary doesn't support vision.
//
// History note: this module previously cached an OpenRouter-derived
// modality map and a regex fallback for non-cataloged models. Both
// were dropped (May 2026) in favor of asking the upstream directly.

import http from 'node:http';

const UPSTREAM_URL = (process.env.UPSTREAM_URL || 'http://127.0.0.1:8645').replace(/\/+$/, '');
const UPSTREAM_TOKEN = (process.env.UPSTREAM_TOKEN || process.env.SIDEKICK_PLATFORM_TOKEN || '').trim();

// ── Auxiliary vision advertisement ────────────────────────────────────
// Short server-side memo so rapid PWA polls (visibility-change retries,
// settings-changed handlers) don't hammer the plugin. 30s is enough to
// recover from a config-edit-then-/restart on the upstream; a stale
// value just makes the +button briefly mis-labeled, never broken.

const VISION_MEMO_MS = 30 * 1000;
let visionMemo: { value: string | null; at: number } | null = null;
let visionInFlight: Promise<string | null> | null = null;

async function fetchVisionFallbackModelLive(): Promise<string | null> {
  if (!UPSTREAM_TOKEN) return null;
  try {
    const r = await fetch(`${UPSTREAM_URL}/v1/sidekick/auxiliary-models`, {
      headers: { authorization: `Bearer ${UPSTREAM_TOKEN}` },
    });
    if (!r.ok) return null;
    const j = await r.json() as { vision?: string | null };
    return typeof j?.vision === 'string' && j.vision ? j.vision : null;
  } catch {
    return null;
  }
}

async function getVisionFallbackModel(): Promise<string | null> {
  if (visionMemo && Date.now() - visionMemo.at < VISION_MEMO_MS) {
    return visionMemo.value;
  }
  if (visionInFlight) return visionInFlight;
  visionInFlight = fetchVisionFallbackModelLive().finally(() => {
    visionInFlight = null;
  });
  const value = await visionInFlight;
  visionMemo = { value, at: Date.now() };
  return value;
}

export async function handleSidekickAuxiliaryModels(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const vision = await getVisionFallbackModel();
  res.statusCode = 200;
  res.setHeader('content-type', 'application/json');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify({ vision }));
}

// ── Model capabilities ────────────────────────────────────────────────
// Per-model fetch from the upstream's capability registry (e.g.
// hermes's models.dev). Per-(provider, model) memo so rapid
// model-switching in the PWA doesn't hammer the plugin. 60s TTL is
// short enough that capability updates land quickly after an upstream
// upgrade refreshes its registry.

type CapabilitiesResponse = {
  provider: string | null;
  model: string;
  known: boolean;
  supports_vision?: boolean;
  supports_tools?: boolean;
  supports_reasoning?: boolean;
  context_window?: number;
  max_output_tokens?: number;
  model_family?: string;
};

const CAPS_TTL_MS = 60 * 1000;
const capsMemo = new Map<string, { value: CapabilitiesResponse; at: number }>();

async function fetchCapabilitiesLive(
  provider: string,
  model: string,
): Promise<CapabilitiesResponse | null> {
  if (!UPSTREAM_TOKEN) return null;
  const qs = new URLSearchParams();
  if (provider) qs.set('provider', provider);
  qs.set('model', model);
  try {
    const r = await fetch(
      `${UPSTREAM_URL}/v1/sidekick/model-capabilities?${qs.toString()}`,
      { headers: { authorization: `Bearer ${UPSTREAM_TOKEN}` } },
    );
    if (!r.ok) return null;
    return await r.json() as CapabilitiesResponse;
  } catch {
    return null;
  }
}

export async function handleSidekickModelCapabilities(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const url = new URL(req.url || '/', 'http://x');
  const provider = (url.searchParams.get('provider') || '').trim();
  const model = (url.searchParams.get('model') || '').trim();
  if (!model) {
    res.statusCode = 400;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: 'model query param required' }));
    return;
  }
  const key = `${provider}::${model}`;
  const memo = capsMemo.get(key);
  let value: CapabilitiesResponse | null;
  if (memo && Date.now() - memo.at < CAPS_TTL_MS) {
    value = memo.value;
  } else {
    value = await fetchCapabilitiesLive(provider, model);
    // Memoize FAILURES too (as known:false) — an upstream without the
    // capabilities endpoint (the token-less trial stub, older plugins)
    // used to produce a 502 per request, and the PWA's attach-gate
    // retried each failure instantly: a zero-backoff loop hammering
    // ~500 req/s that pegged the tab until the browser killed it
    // (field bug 2026-07-07: white screen ~5-10s after load on npx
    // installs). known:false IS the correct answer for "nobody can
    // vouch for this model" — serve it as a 200 and cache it under the
    // same TTL so recovery (plugin upgrade, token added) still lands
    // within a minute.
    if (!value) {
      value = { provider: provider || null, model, known: false };
    }
    capsMemo.set(key, { value, at: Date.now() });
  }
  res.statusCode = 200;
  res.setHeader('content-type', 'application/json');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(value));
}
