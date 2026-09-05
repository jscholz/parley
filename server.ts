#!/usr/bin/env node
/**
 * Parley server.
 * - GET /              → serves index.html
 * - GET /<path>        → serves static assets
 * - GET /config        → runtime config (gateway token) from env
 * - POST /tts          → Deepgram Aura TTS proxy (audio/mp3)
 * - POST /gen-image    → Gemini image generation
 * - GET  /weather      → Open-Meteo weather proxy
 * - GET  /link-preview → OG metadata for a URL
 * - GET  /spotify-check → Spotify oEmbed validation
 * - POST /transcribe   → batch STT (forwards to audio-bridge /v1/transcribe)
 * - GET  /screenshot   → ?url= → page screenshot via persistent Chromium (fallback for sites with no OG)
 * - GET  /render       → ?url=&mode=text|html → DOM after JS (for the `browser` agent skill)
 */
import http from 'node:http';
import https from 'node:https';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import YAML from 'yaml';
import { readEnv } from './proxy/env.mjs';
import { isLiveDataHome } from './proxy/dataHome.mjs';
import { resolveConfigPath } from './proxy/configPath.mjs';
import * as parley from './proxy/parley/index.ts';
import { initSetup, handleSetupStatus, handleSetupApply } from './proxy/parley/setup.ts';
import {
  FRONTEND_SETTINGS,
  readAllFrontend,
  coerceValue,
  writeOne as writeFrontendSetting,
  persist as persistDeployDoc,
  type FrontendSettingKey,
} from './proxy/parley/frontend-config.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Deployment config ────────────────────────────────────────────────
// Non-secret tuning lives in parley.config.yaml (gitignored). Secrets
// stay in .env. Env vars ALWAYS override the file — convenient for
// Docker/CI where mounting a file is awkward but env injection is easy.
// Missing file is fine; defaults + env vars cover the ground.
//
// PARLEY_CONFIG env var can point at a config path outside the repo
// (e.g. a private fork with keys and personal keyterms). Useful so the
// public repo stays generic while deployment config lives privately.
// Filename preference: parley.config.yaml, then the legacy
// parley.config.yaml, then config.yaml (proxy/configPath.mjs).
const CONFIG_PATH = resolveConfigPath(__dirname);
/** Parse the deployment config. Preserves comments via YAML.Document for
 *  round-trippable edits (used by the keyterms save path). */
function loadDeployConfigDoc(): YAML.Document.Parsed | null {
  if (!CONFIG_PATH) return null;
  try {
    const raw = fsSync.readFileSync(CONFIG_PATH, 'utf8');
    console.log(`[config] loaded ${path.basename(CONFIG_PATH)}`);
    return YAML.parseDocument(raw);
  } catch (e: any) {
    console.warn(`[config] failed to load ${CONFIG_PATH}: ${e.message}`);
    return null;
  }
}
let deployDoc = loadDeployConfigDoc();
/** Plain-JS view of the config — used for reads. Re-derived when the doc
 *  is mutated (e.g. keyterms save). */
function cfgAsJS(): any {
  return deployDoc ? deployDoc.toJS() : {};
}
let DEPLOY_CFG = cfgAsJS();
/** Last-loaded mtime so reloadConfigIfChanged can skip unchanged files. */
let lastConfigMtime = CONFIG_PATH && fsSync.existsSync(CONFIG_PATH)
  ? fsSync.statSync(CONFIG_PATH).mtimeMs : 0;

/** Cheap hook — stat the config file; if newer than last load, re-parse
 *  + rebuild any derived state (preferred-model globs). Called from
 *  endpoints that get polled by the settings UI (models-catalog on a
 *  30s interval, /config on settings-panel open) so VSCode edits to
 *  parley.config.yaml get picked up without a service restart. */
function reloadConfigIfChanged(): boolean {
  if (!CONFIG_PATH || !fsSync.existsSync(CONFIG_PATH)) return false;
  try {
    const m = fsSync.statSync(CONFIG_PATH).mtimeMs;
    if (m <= lastConfigMtime) return false;
    lastConfigMtime = m;
    deployDoc = loadDeployConfigDoc();
    DEPLOY_CFG = cfgAsJS();
    return true;
  } catch (e: any) {
    console.warn('[config] reload failed:', e.message);
    return false;
  }
}
/** Resolve a value by precedence: env var → config file → fallback.
 *  `cfgPath` may be an array of dotted paths tried in order. */
function cfgVal<T>(envName: string, cfgPath: string | string[], fallback: T): T {
  const env = readEnv(envName);
  if (env != null && env !== '') return env as unknown as T;
  const paths = Array.isArray(cfgPath) ? cfgPath : [cfgPath];
  for (const onePath of paths) {
    const parts = onePath.split('.');
    let cur: any = DEPLOY_CFG;
    for (const p of parts) {
      if (cur == null) break;
      cur = cur[p];
    }
    if (cur != null && cur !== '') return cur as T;
  }
  return fallback;
}

const PORT = Number(cfgVal('PORT', 'server.port', 3001));
const HOST = cfgVal('HOST', 'server.host', '127.0.0.1') as string;
const HTTPS_CERT_FILE = cfgVal('PARLEY_HTTPS_CERT_FILE', 'server.https.cert_file', '') as string;
const HTTPS_KEY_FILE = cfgVal('PARLEY_HTTPS_KEY_FILE', 'server.https.key_file', '') as string;
const HTTPS_ENABLED = HTTPS_CERT_FILE !== '' || HTTPS_KEY_FILE !== '';
// Dual mode: cert pair + PARLEY_HTTPS_PORT → main server stays HTTP,
// an auxiliary HTTPS listener binds that port on 0.0.0.0 (see bottom of
// file). Cert pair alone = legacy single-HTTPS-server behavior.
const HTTPS_PORT = Number(cfgVal('PARLEY_HTTPS_PORT', 'server.https.port', 0));
const DUAL_HTTPS = HTTPS_ENABLED && HTTPS_PORT > 0;

function createHttpServer(handler: http.RequestListener): http.Server | https.Server {
  if (!HTTPS_ENABLED || DUAL_HTTPS) return http.createServer(handler);
  if (!HTTPS_CERT_FILE || !HTTPS_KEY_FILE) {
    throw new Error('HTTPS requires both PARLEY_HTTPS_CERT_FILE and PARLEY_HTTPS_KEY_FILE');
  }
  return https.createServer({
    cert: fsSync.readFileSync(HTTPS_CERT_FILE),
    key: fsSync.readFileSync(HTTPS_KEY_FILE),
  }, handler);
}

// Mutable: the first-run setup wizard can supply the key live
// (POST /api/parley/setup) — TTS starts working without a restart.
let DEEPGRAM_KEY = process.env.DEEPGRAM_API_KEY || '';
if (!DEEPGRAM_KEY) {
  console.warn('DEEPGRAM_API_KEY not set — voice STT/TTS and /transcribe disabled');
}
const GOOGLE_KEY = process.env.GOOGLE_API_KEY;  // optional — /gen-image disabled if missing

const DEFAULT_TTS_MODEL = 'aura-2-thalia-en';
const IMAGE_MODEL = 'gemini-2.5-flash-image';   // "Nano Banana"

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.map': 'application/json',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  // Silero VAD assets — WebAssembly + ONNX model bytes loaded by
  // @ricky0123/vad-web at MicVAD.new() time. application/wasm enables
  // browser WebAssembly.instantiateStreaming (fast path); without it
  // ORT falls back to fetch+compile which works but adds ~50-150 ms
  // to cold start. application/octet-stream for .onnx is what
  // onnxruntime-web fetches directly into a model URL — content-type
  // doesn't gate behavior, but octet-stream is the correct value.
  '.wasm': 'application/wasm',
  '.onnx': 'application/octet-stream',
};

async function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  let filePath = url.pathname;
  if (filePath === '/' || filePath === '') filePath = '/index.html';
  if (filePath === '/index.html') {
    // Hashed-asset build (#182): build.mjs writes build/index.html with the
    // import map + hashed entry script injected. Prefer it; fall back to
    // the tracked root index.html for unhashed dev/watch builds.
    try {
      const data = await fs.readFile(path.join(__dirname, 'build/index.html'));
      res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' });
      res.end(data);
      return;
    } catch { /* no hashed build present */ }
  }
  const full = path.join(__dirname, filePath);
  if (!full.startsWith(__dirname)) { res.writeHead(403); res.end('forbidden'); return; }
  try {
    const data = await fs.readFile(full);
    const ext = path.extname(full).toLowerCase();
    // Content-hashed modules never change under the same URL — let HTTP
    // caches keep them. Everything else stays no-cache (the SW owns
    // offline caching policy).
    const immutable = /\.[0-9a-f]{10}\.mjs$/.test(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    res.end(data);
  } catch (e) {
    res.writeHead(404); res.end('not found');
  }
}

async function handleTts(req, res) {
  let body = '';
  req.on('data', chunk => { body += chunk; if (body.length > 1e6) req.destroy(); });
  req.on('end', async () => {
    let payload;
    try { payload = JSON.parse(body); } catch { res.writeHead(400); res.end('invalid json'); return; }
    const text = (payload.text || '').toString().trim();
    const model = (payload.model || DEFAULT_TTS_MODEL).toString();
    if (!text) { res.writeHead(400); res.end('text required'); return; }
    if (text.length > 2000) { res.writeHead(400); res.end('text too long (>2000 chars)'); return; }

    const dgUrl = `https://api.deepgram.com/v1/speak?model=${encodeURIComponent(model)}&encoding=mp3`;
    try {
      const dgRes = await fetch(dgUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Token ${DEEPGRAM_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ text }),
      });
      if (!dgRes.ok) {
        const err = await dgRes.text();
        console.error(`Deepgram TTS error ${dgRes.status}: ${err.slice(0, 200)}`);
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'tts_failed', status: dgRes.status, message: err.slice(0, 300) }));
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'audio/mpeg',
        'Cache-Control': 'no-cache',
        'Transfer-Encoding': 'chunked',
      });
      // Stream the body through
      const reader = dgRes.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(Buffer.from(value));
      }
      res.end();
    } catch (e) {
      console.error('TTS proxy error:', e);
      if (!res.headersSent) res.writeHead(500);
      res.end('tts proxy error');
    }
  });
  req.on('error', () => { if (!res.headersSent) res.writeHead(500); res.end('upstream error'); });
}

async function handleGenImage(req, res) {
  if (!GOOGLE_KEY) { res.writeHead(503, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'GOOGLE_API_KEY not set' })); return; }
  let body = '';
  req.on('data', c => { body += c; if (body.length > 1e5) req.destroy(); });
  req.on('end', async () => {
    let payload;
    try { payload = JSON.parse(body); } catch { res.writeHead(400); res.end('invalid json'); return; }
    const prompt = (payload.prompt || '').toString().trim();
    if (!prompt) { res.writeHead(400); res.end('prompt required'); return; }
    if (prompt.length > 1500) { res.writeHead(400); res.end('prompt too long'); return; }

    const gUrl = `https://generativelanguage.googleapis.com/v1beta/models/${IMAGE_MODEL}:generateContent?key=${encodeURIComponent(GOOGLE_KEY)}`;
    try {
      const gRes = await fetch(gUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { responseModalities: ['IMAGE'] },
        }),
      });
      const data = await gRes.json();
      if (!gRes.ok) {
        console.error(`Gemini image error ${gRes.status}:`, JSON.stringify(data).slice(0, 500));
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'gen_failed', status: gRes.status, detail: data?.error?.message || 'unknown' }));
        return;
      }
      const parts = data?.candidates?.[0]?.content?.parts || [];
      const imgPart = parts.find(p => p.inlineData?.data);
      if (!imgPart) {
        const text = parts.find(p => p.text)?.text || '';
        console.error('Gemini image: no inlineData', text.slice(0, 200));
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'no_image_returned', text }));
        return;
      }
      const mime = imgPart.inlineData.mimeType || 'image/png';
      const dataUri = `data:${mime};base64,${imgPart.inlineData.data}`;
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
      res.end(JSON.stringify({ image: dataUri, prompt, mime }));
    } catch (e) {
      console.error('gen-image proxy error:', e);
      if (!res.headersSent) res.writeHead(500);
      res.end('gen proxy error');
    }
  });
  req.on('error', () => { if (!res.headersSent) res.writeHead(500); res.end('upstream error'); });
}

// Naive in-process cache for link previews (URL → { at, data })
const linkPreviewCache = new Map();
const LINK_PREVIEW_TTL_MS = 60 * 60 * 1000;

/**
 * SSRF guard — block requests to private / internal hosts. Used on
 * /link-preview and /screenshot since both fetch arbitrary client-supplied
 * URLs from the server, and are exposed to the public internet whenever
 * Tailscale Funnel is active.
 * Returns null if safe, otherwise a string reason.
 */
function ssrfReject(target) {
  let parsed;
  try { parsed = new URL(target); } catch { return 'bad url'; }
  if (!/^https?:$/i.test(parsed.protocol)) return 'non-http protocol';
  const host = parsed.hostname.toLowerCase();
  // Localhost
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '0.0.0.0') return 'loopback';
  // Metadata services (AWS, GCP, Azure)
  if (host === '169.254.169.254' || host === 'metadata.google.internal') return 'cloud metadata';
  // RFC1918 private ranges
  if (/^10\./.test(host)) return 'private 10/8';
  if (/^192\.168\./.test(host)) return 'private 192.168/16';
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return 'private 172.16/12';
  // Link-local + CG-NAT
  if (/^169\.254\./.test(host)) return 'link-local';
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host)) return 'CG-NAT (tailscale range)';
  // IPv6 loopback / ULA / link-local
  if (host.startsWith('[::1]') || host.startsWith('[fc') || host.startsWith('[fd') || host.startsWith('[fe80')) return 'ipv6 private';
  return null;
}

function parseOg(html) {
  const get = (names) => {
    for (const n of names) {
      const re = new RegExp(`<meta[^>]+(?:property|name)=["']${n}["'][^>]+content=["']([^"']+)["']`, 'i');
      const m = html.match(re) || html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${n}["']`, 'i'));
      if (m) return m[1];
    }
    return null;
  };
  const decodeEntities = (s) => !s ? s : s
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#x?([0-9a-f]+);/gi,
      (_, c) => String.fromCharCode(parseInt(c, c.length === 1 ? 10 : 16)));
  const titleTag = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  return {
    title: decodeEntities(get(['og:title', 'twitter:title']) || (titleTag ? titleTag[1] : null)),
    description: decodeEntities(get(['og:description', 'twitter:description', 'description'])),
    image: decodeEntities(get(['og:image', 'twitter:image', 'twitter:image:src'])),
    siteName: decodeEntities(get(['og:site_name', 'application-name'])),
  };
}

async function handleLinkPreview(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const target = url.searchParams.get('url');
  if (!target || !/^https?:\/\//i.test(target)) { res.writeHead(400); res.end('bad url'); return; }
  const reject = ssrfReject(target);
  if (reject) { res.writeHead(403); res.end(`blocked: ${reject}`); return; }

  // Cache hit
  const cached = linkPreviewCache.get(target);
  if (cached && (Date.now() - cached.at) < LINK_PREVIEW_TTL_MS) {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600' });
    res.end(JSON.stringify(cached.data));
    return;
  }

  try {
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 6000);
    const r = await fetch(target, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Parley/1.0)',
        'Accept': 'text/html,application/xhtml+xml',
      },
    });
    clearTimeout(timeout);
    const ctype = r.headers.get('content-type') || '';
    if (!ctype.includes('text/html')) {
      const data = { url: target, title: null, description: null, image: null, siteName: null };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
      return;
    }
    // Read up to ~256KB of HTML — enough for <head>
    const reader = r.body.getReader();
    const parts = []; let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value); total += value.length;
      if (total > 256 * 1024) { try { reader.cancel(); } catch {} break; }
    }
    const html = Buffer.concat(parts).toString('utf-8');
    const og = parseOg(html);
    // Resolve relative image URLs
    if (og.image && !/^https?:\/\//i.test(og.image)) {
      try { og.image = new URL(og.image, r.url || target).toString(); } catch {}
    }
    // Check if the site allows iframe embedding
    const xfo = (r.headers.get('x-frame-options') || '').toLowerCase();
    const csp = (r.headers.get('content-security-policy') || '').toLowerCase();
    const frameable = !xfo && !csp.includes('frame-ancestors');
    const data = { url: target, ...og, frameable };
    linkPreviewCache.set(target, { at: Date.now(), data });
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600' });
    res.end(JSON.stringify(data));
  } catch (e) {
    console.error('link-preview err:', e.message);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ url: target, title: null, description: null, image: null, siteName: null, error: e.message }));
  }
}

// Weather fallback coords. London is the last-resort fallback — users
// see a real city's weather rather than a broken card on Null Island.
// Resolution order (handleWeather): explicit ?lat/?lon → explicit config
// coords → ?tz-derived coords (browser timezone) → London.
const CONFIG_WEATHER_LAT = cfgVal('PARLEY_WEATHER_LAT', 'weather.lat', '') as string;
const CONFIG_WEATHER_LON = cfgVal('PARLEY_WEATHER_LON', 'weather.lon', '') as string;
const FALLBACK_WEATHER_LAT = 51.5074;
const FALLBACK_WEATHER_LON = -0.1278;

// Geocode an IANA timezone to approximate coords by its representative
// city (the last path segment: "America/New_York" → "New York"). The
// browser already hands us its timezone for the clock, so weather can
// piggyback on it with no geolocation permission prompt. Cached per tz.
const tzGeocodeCache = new Map<string, { lat: number; lon: number } | null>();
async function geocodeTimezone(tz: string): Promise<{ lat: number; lon: number } | null> {
  if (tzGeocodeCache.has(tz)) return tzGeocodeCache.get(tz)!;
  const city = tz.split('/').pop()?.replace(/_/g, ' ').trim();
  if (!city) { tzGeocodeCache.set(tz, null); return null; }
  try {
    const r = await fetch(
      `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=en&format=json`,
      { signal: AbortSignal.timeout(5000) },
    );
    const data = await r.json();
    const hit = data?.results?.[0];
    const coords = hit ? { lat: hit.latitude, lon: hit.longitude } : null;
    tzGeocodeCache.set(tz, coords);
    return coords;
  } catch {
    tzGeocodeCache.set(tz, null);
    return null;
  }
}

async function handleWeather(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const qLat = url.searchParams.get('lat');
  const qLon = url.searchParams.get('lon');
  const tz = url.searchParams.get('tz');

  let lat: number, lon: number;
  if (qLat && qLon) {
    lat = parseFloat(qLat); lon = parseFloat(qLon);
  } else if (CONFIG_WEATHER_LAT && CONFIG_WEATHER_LON) {
    lat = parseFloat(CONFIG_WEATHER_LAT); lon = parseFloat(CONFIG_WEATHER_LON);
  } else if (tz) {
    const geo = await geocodeTimezone(tz);
    lat = geo ? geo.lat : FALLBACK_WEATHER_LAT;
    lon = geo ? geo.lon : FALLBACK_WEATHER_LON;
  } else {
    lat = FALLBACK_WEATHER_LAT; lon = FALLBACK_WEATHER_LON;
  }

  const omUrl = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,weather_code,wind_speed_10m,is_day&daily=temperature_2m_max,temperature_2m_min,weather_code&timezone=auto&forecast_days=5`;
  try {
    const r = await fetch(omUrl);
    const data = await r.json();
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=600' });
    res.end(JSON.stringify(data));
  } catch (e) {
    res.writeHead(502); res.end('weather fetch failed');
  }
}

// Spotify oEmbed validation — check if a Spotify URL resolves before embedding.
async function handleSpotifyCheck(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const spotifyUrl = url.searchParams.get('url');
  if (!spotifyUrl || !spotifyUrl.includes('spotify.com')) {
    res.writeHead(400); res.end('bad url'); return;
  }
  try {
    const r = await fetch(`https://open.spotify.com/oembed?url=${encodeURIComponent(spotifyUrl)}`, {
      signal: AbortSignal.timeout(5000),
    });
    if (r.ok) {
      const data = await r.json();
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600' });
      res.end(JSON.stringify({ ok: true, title: data.title, thumbnail_url: data.thumbnail_url }));
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, status: r.status }));
    }
  } catch (e) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: e.message }));
  }
}

// ── Chromium screenshot service ────────────────────────────────────────────
// Persistent browser instance — launched once, reused for all screenshots.
// Each request: new tab → navigate → screenshot → close tab.
// Disabled when PARLEY_DISABLE_SCREENSHOT=1 (Pi 3 and other low-RAM
// targets that can't afford a Chromium process).
import { chromium } from 'playwright-core';

const SCREENSHOT_DISABLED = !!cfgVal('PARLEY_DISABLE_SCREENSHOT', 'server.disable_screenshot', false);

let browser = null;
const screenshotCache = new Map(); // url → { at, buffer }
const SCREENSHOT_CACHE_TTL = 60 * 60 * 1000; // 1 hour

async function getBrowser() {
  if (browser && browser.isConnected()) return browser;
  console.log('launching persistent Chromium...');
  browser = await chromium.launch({
    // Prefer an explicit deployment override, then Playwright's managed
    // Chromium. Hard-coding /usr/bin/chromium breaks on Ubuntu 24.04,
    // where the apt package is a Snap shim and no such binary exists.
    executablePath: process.env.PLAYWRIGHT_CHROMIUM || chromium.executablePath(),
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
  });
  console.log('Chromium ready');
  return browser;
}

async function handleScreenshot(req, res) {
  if (SCREENSHOT_DISABLED) {
    res.writeHead(501, { 'Content-Type': 'text/plain' });
    res.end('screenshot disabled (PARLEY_DISABLE_SCREENSHOT=1)');
    return;
  }
  const url = new URL(req.url, `http://${req.headers.host}`);
  const target = url.searchParams.get('url');
  if (!target || !/^https?:\/\//i.test(target)) {
    res.writeHead(400); res.end('bad url'); return;
  }
  const reject = ssrfReject(target);
  if (reject) { res.writeHead(403); res.end(`blocked: ${reject}`); return; }

  // Cache check
  const cached = screenshotCache.get(target);
  if (cached && (Date.now() - cached.at) < SCREENSHOT_CACHE_TTL) {
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=3600' });
    res.end(cached.buffer);
    return;
  }

  try {
    const b = await getBrowser();
    const page = await b.newPage({ viewport: { width: 1280, height: 800 } });
    try {
      await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 10000 });
      // Brief wait for lazy-loaded images/fonts
      await page.waitForTimeout(1500);
      const buffer = await page.screenshot({ type: 'png' });
      screenshotCache.set(target, { at: Date.now(), buffer });
      // Prune old cache entries
      if (screenshotCache.size > 50) {
        for (const [k, v] of screenshotCache) {
          if (Date.now() - v.at > SCREENSHOT_CACHE_TTL) screenshotCache.delete(k);
        }
      }
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=3600' });
      res.end(buffer);
    } finally {
      await page.close();
    }
  } catch (e) {
    console.error('screenshot error:', e.message);
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
}

// ── DOM-rendered page fetch (for the `browser` agent skill) ────────────────
// Reuses the same persistent Chromium as /screenshot. Useful when a page
// is React/Vue/Angular-rendered and `curl <url>` returns the empty shell.
//
// Wait strategy: page.goto waits for 'load'; we then soft-wait for
// `networkidle` (up to `wait` ms, default 5000, cap 10000) so post-
// hydration fetches settle before we snapshot. Catches the fail-silent
// case where a live-polling page never goes idle.
//
// Query params:
//   url       — required, http(s) only, passes ssrfReject
//   mode      — 'text' (default) | 'html'
//   wait      — max ms to wait for network idle after load (default 5000, cap 10000)
//   maxlen    — cap on output length (default 30_000, cap 2_000_000).
//               Deliberately small so exploration doesn't blow out context.
//               Raise explicitly when you know you need more.
//   selector  — CSS selector; if present, return innerText/outerHTML of
//               just that subtree instead of the whole document. Huge
//               context saver for structured-data extraction.
const renderCache = new Map();
const RENDER_CACHE_TTL_MS = 60 * 60 * 1000;

async function handleRender(req, res) {
  if (SCREENSHOT_DISABLED) {
    res.writeHead(501, { 'Content-Type': 'text/plain' });
    res.end('render disabled (PARLEY_DISABLE_SCREENSHOT=1)');
    return;
  }
  const url = new URL(req.url, `http://${req.headers.host}`);
  const target = url.searchParams.get('url');
  if (!target || !/^https?:\/\//i.test(target)) {
    res.writeHead(400); res.end('bad url'); return;
  }
  const reject = ssrfReject(target);
  if (reject) { res.writeHead(403); res.end(`blocked: ${reject}`); return; }
  const mode = url.searchParams.get('mode') === 'html' ? 'html' : 'text';
  const wait = Math.min(parseInt(url.searchParams.get('wait') || '5000', 10) || 5000, 10000);
  const maxlen = Math.min(parseInt(url.searchParams.get('maxlen') || '30000', 10) || 30000, 2_000_000);
  const selector = url.searchParams.get('selector') || '';

  const cacheKey = `${mode}|${selector}|${target}`;
  const cached = renderCache.get(cacheKey);
  if (cached && (Date.now() - cached.at) < RENDER_CACHE_TTL_MS) {
    res.writeHead(200, {
      'Content-Type': mode === 'html' ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    });
    res.end(cached.body.slice(0, maxlen));
    return;
  }

  try {
    const b = await getBrowser();
    const page = await b.newPage({ viewport: { width: 1280, height: 2000 } });
    try {
      await page.goto(target, { waitUntil: 'load', timeout: 15000 });
      // Soft-wait for network idle. If the page keeps polling (live
      // dashboards), we don't want to hang — catch the timeout and
      // snapshot what we have.
      await page.waitForLoadState('networkidle', { timeout: wait }).catch(() => {});
      let body;
      if (selector) {
        // Extract just the requested subtree. Error cleanly if missing.
        body = await page.evaluate(
          ({ sel, asHtml }) => {
            const el = document.querySelector(sel);
            if (!el) return null;
            return asHtml ? el.outerHTML : (el.innerText || '');
          },
          { sel: selector, asHtml: mode === 'html' },
        );
        if (body === null) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `selector not found: ${selector}` }));
          return;
        }
      } else {
        body = mode === 'html'
          ? await page.content()
          : await page.evaluate(() => document.body?.innerText ?? '');
      }
      renderCache.set(cacheKey, { at: Date.now(), body });
      if (renderCache.size > 50) {
        for (const [k, v] of renderCache) {
          if (Date.now() - v.at > RENDER_CACHE_TTL_MS) renderCache.delete(k);
        }
      }
      const truncated = body.length > maxlen;
      res.writeHead(200, {
        'Content-Type': mode === 'html' ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8',
        'Cache-Control': 'public, max-age=3600',
        ...(truncated ? { 'X-Render-Truncated': `${body.length}` } : {}),
      });
      res.end(body.slice(0, maxlen));
    } finally {
      await page.close();
    }
  } catch (e) {
    console.error('render error:', e.message);
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
}

// ── Batch transcription proxy: POST /transcribe → audio-bridge /v1/transcribe ──
// Forwards to audio bridge — STT abstraction lives there. Swap providers via
// bridge config, both live + memo paths follow. The bridge calls the same
// STTProvider as the WebRTC streaming path (see audio-bridge/providers/stt.py).
async function handleTranscribe(req, res) {
  const contentType = req.headers['content-type'] || 'audio/webm';
  const chunks = [];
  let size = 0;
  req.on('data', (chunk) => {
    size += chunk.length;
    if (size > 25 * 1024 * 1024) { console.error('transcribe: body over 25MB cap — destroying request'); req.destroy(); return; }
    chunks.push(chunk);
  });
  const startedAt = Date.now();
  req.on('end', async () => {
    const body = Buffer.concat(chunks);
    // Request log (one line per upload, low volume) — the device-side
    // failure mode here is SILENT (client swallows transient errors), so
    // this is the ground truth for "did the POST arrive and how far did
    // it get" when debugging mobile upload wedges.
    console.log(`transcribe: ${Math.round(body.length / 1024)}KB ${contentType} origin=${req.headers.origin || '-'} recv=${Date.now() - startedAt}ms`);
    if (!body.length) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'empty body' }));
      return;
    }
    try {
      const upstream = new URL('/v1/transcribe', AUDIO_BRIDGE_UPSTREAM);
      // Forward the PWA's query string (specifically ?keyterms=…&keyterms=…)
      // through to the bridge. Without this, per-user keyterm biasing on
      // memo / batch transcription is silently dropped — bridge sees an
      // empty query and falls back to the configured base spec.
      const incomingQuery = req.url.includes('?') ? req.url.slice(req.url.indexOf('?') + 1) : '';
      if (incomingQuery) upstream.search = incomingQuery;
      // Bounded: a hung bridge otherwise holds this connection open
      // forever and the client's retry loop never gets an answer.
      const bridgeRes = await fetch(upstream.toString(), {
        method: 'POST',
        headers: { 'Content-Type': contentType },
        body,
        signal: AbortSignal.timeout(120_000),
      });
      const data = await bridgeRes.json().catch(() => ({}));
      if (!bridgeRes.ok) {
        const errMsg = (data && (data.error?.message || data.error)) || `bridge ${bridgeRes.status}`;
        console.error(`transcribe bridge error ${bridgeRes.status}: ${JSON.stringify(errMsg).slice(0, 200)}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: errMsg }));
        return;
      }
      const transcript = (data && data.transcript) || '';
      console.log(`transcribe: ok ${transcript.length} chars in ${Date.now() - startedAt}ms`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, transcript }));
    } catch (e) {
      const timedOut = e?.name === 'TimeoutError' || e?.name === 'AbortError';
      console.error(`transcribe proxy error after ${Date.now() - startedAt}ms:`, e);
      if (!res.headersSent) res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: timedOut ? 'bridge timeout' : e.message }));
    }
  });
  req.on('error', (e) => {
    // Half-received uploads land here (client abort, dead radio mid-body).
    console.error(`transcribe: request stream error after ${Date.now() - startedAt}ms at ${Math.round(size / 1024)}KB:`, e?.message);
    if (!res.headersSent) res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'upstream error' }));
  });
}

// Client config endpoint — serves runtime config from env vars so
// secrets are not hardcoded in the HTML, and so per-deployment tuning
// (app name, default coords) can be set without a rebuild.
const GW_TOKEN = process.env.GW_TOKEN || '';

// STT keyterm seed list. Read from parley.config.yaml's `stt.keyterms`
// (a YAML list); the PWA fetches this ONCE on first boot to seed each
// user's IndexedDB-backed list, then reads/writes only IDB thereafter.
// Edits to the yaml affect new users only — existing installs keep
// their per-user IDB list. Falls back to FALLBACK_KEYTERMS if the yaml
// is missing the section (or parley is running without a config).
const FALLBACK_KEYTERMS: string[] = ['Parley', 'Deepgram'];

/** Resolve the keyterm seed list from parley.config.yaml. Strings
 *  are trimmed + deduped (case-insensitive). Anything non-string in
 *  the array is dropped silently. Reads via the live DEPLOY_CFG so a
 *  yaml mtime-triggered reload picks up edits without a restart. */
function readSeedKeyterms(): string[] {
  const raw = DEPLOY_CFG?.stt?.keyterms;
  if (!Array.isArray(raw)) return [...FALLBACK_KEYTERMS];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string') continue;
    const t = entry.trim();
    if (!t) continue;
    const k = t.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out.length ? out : [...FALLBACK_KEYTERMS];
}

/** Serve the seed keyterms as newline-separated text. Used by the PWA
 *  ONLY for first-boot IDB seeding — subsequent reads/writes happen
 *  entirely client-side. There is no POST companion: editing keyterms
 *  via the chip UI mutates IndexedDB, not this file. */
async function handleKeytermsGet(_req, res) {
  const terms = readSeedKeyterms();
  const body = terms.join('\n') + '\n';
  res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-cache' });
  res.end(body);
}

/** GET /api/parley/config — flat snapshot of every PWA setting
 *  with its current value (yaml override or built-in default). */
function handleParleyConfigGet(_req, res) {
  const snapshot = readAllFrontend(DEPLOY_CFG);
  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
  res.end(JSON.stringify({ settings: snapshot }));
}

/** POST /api/parley/config/<key> — write one setting. Body is
 *  `{value: <new>}`. Persists to parley.config.yaml under
 *  `frontend.<category>.<key>:`. Returns the updated value. */
async function handleParleyConfigSet(req, res, key: string) {
  if (!Object.prototype.hasOwnProperty.call(FRONTEND_SETTINGS, key)) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `unknown setting: ${key}` } }));
    return;
  }
  const chunks: Buffer[] = [];
  for await (const c of req) {
    chunks.push(c);
    if (chunks.reduce((n, b) => n + b.length, 0) > 64 * 1024) {
      res.writeHead(413, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'body too large' } }));
      return;
    }
  }
  let body: any;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'invalid json' } }));
    return;
  }
  let value;
  try { value = coerceValue(key as FrontendSettingKey, body?.value); }
  catch (e: any) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: e?.message || 'invalid value' } }));
    return;
  }
  if (!CONFIG_PATH) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'no parley.config.yaml configured (set PARLEY_CONFIG)' } }));
    return;
  }
  if (!deployDoc) deployDoc = YAML.parseDocument('frontend: {}\n');
  try {
    writeFrontendSetting(deployDoc, key as FrontendSettingKey, value);
    await persistDeployDoc(deployDoc, CONFIG_PATH);
    DEPLOY_CFG = cfgAsJS();
    // Pin the mtime so reloadConfigIfChanged() doesn't double-rebuild
    // on the next config-touching request.
    try { lastConfigMtime = fsSync.statSync(CONFIG_PATH).mtimeMs; } catch {}
  } catch (e: any) {
    console.error(`[config] write failed for ${key}:`, e?.message);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: e?.message || 'write failed' } }));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ key, value }));
}

// ── Debug-relay: PWA logs → on-disk files ────────────────────────────────
//
// When the PWA has `?debug-relay=1` (or `localStorage.debug_relay=1`), it
// POSTs batches of log lines here every 250ms. We append to a per-session
// file under `${tmpdir}/parley-debug/` and update a `latest.log` symlink
// to the most recent file. AI agents and developers can
// `cat /tmp/parley-debug/latest.log` to see live diagnostic output
// without copy-pasting from the browser console.
//
// /tmp is the right home: ephemeral by definition (tmpfs on Pi, cleared
// on reboot on Mac), no disk pressure on the host's working tree, and
// safe to enable by default if we ever want to. Smokes / playwright runs
// don't set the flag, so the dir only accumulates real interactive
// sessions either way.

const DEBUG_LOG_DIR = path.join(os.tmpdir(), 'parley-debug');
const DEBUG_LOG_KEEP = 20;
const DEBUG_LOG_MAX_BODY = 256 * 1024;       // 256 KB per POST
const DEBUG_LOG_SID_RE = /^[A-Za-z0-9._-]{1,80}$/;

function ensureDebugDir(): void {
  try { fsSync.mkdirSync(DEBUG_LOG_DIR, { recursive: true }); }
  catch (e: any) { console.error('[debug-relay] mkdir failed:', e?.message); }
}

/** Prune old per-session log files. Run once on server boot. Keeps
 *  the N most-recently-modified .log files; deletes the rest. */
function pruneDebugLogs(): void {
  try {
    if (!fsSync.existsSync(DEBUG_LOG_DIR)) return;
    const entries = fsSync.readdirSync(DEBUG_LOG_DIR)
      .filter(f => f.endsWith('.log') && f !== 'latest.log')
      .map(f => {
        const p = path.join(DEBUG_LOG_DIR, f);
        try { return { p, mtime: fsSync.statSync(p).mtimeMs }; }
        catch { return null; }
      })
      .filter((e): e is { p: string; mtime: number } => e !== null)
      .sort((a, b) => b.mtime - a.mtime);
    for (const e of entries.slice(DEBUG_LOG_KEEP)) {
      try { fsSync.unlinkSync(e.p); }
      catch (err: any) { console.error('[debug-relay] unlink failed:', err?.message); }
    }
  } catch (e: any) {
    console.error('[debug-relay] prune failed:', e?.message);
  }
}

ensureDebugDir();
pruneDebugLogs();

async function handleDebugLogs(req, res) {
  if (req.method !== 'POST') {
    res.writeHead(405); res.end('method not allowed'); return;
  }
  // Read body with a hard size cap so a misbehaving client can't
  // fill the disk. 256KB is ~3000 typical log lines per POST.
  const chunks: Buffer[] = [];
  let total = 0;
  let aborted = false;
  await new Promise<void>((resolve) => {
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > DEBUG_LOG_MAX_BODY) {
        aborted = true;
        try { req.destroy(); } catch { /* noop */ }
        resolve();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve());
    req.on('error', () => resolve());
  });
  if (aborted) {
    res.writeHead(413); res.end('payload too large'); return;
  }
  let parsed: { sid?: string; lines?: string[] };
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    res.writeHead(400); res.end('invalid json'); return;
  }
  const sid = String(parsed.sid || '');
  if (!DEBUG_LOG_SID_RE.test(sid)) {
    res.writeHead(400); res.end('invalid sid'); return;
  }
  const lines = Array.isArray(parsed.lines) ? parsed.lines : [];
  if (lines.length === 0) {
    res.writeHead(204); res.end(); return;
  }
  const filePath = path.join(DEBUG_LOG_DIR, `${sid}.log`);
  const symlinkPath = path.join(DEBUG_LOG_DIR, 'latest.log');
  try {
    // Append all lines in one write — node's appendFile call is
    // atomic at the OS level for typical line sizes.
    await fs.appendFile(filePath, lines.join(''), 'utf8');
    // Update the latest.log symlink to point at this file. Best-
    // effort: if symlink update fails (Windows, mount permissions),
    // the per-session file still grows fine.
    try {
      await fs.rm(symlinkPath, { force: true });
      await fs.symlink(`${sid}.log`, symlinkPath);
    } catch { /* noop */ }
  } catch (e: any) {
    console.error('[debug-relay] append failed:', e?.message);
    res.writeHead(500); res.end('append failed'); return;
  }
  res.writeHead(204); res.end();
}

function handleConfig(_req, res) {
  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
  res.end(JSON.stringify({
    gwToken: GW_TOKEN,
    mapsEmbedKey: process.env.MAPS_EMBED_KEY || '',
    // Skinning — per-install overrides for app name / agent label / primary
    // theme color. Resolved via parley.config.yaml (app.*) then env var
    // then default. See config.example.yaml.
    appName: cfgVal('PARLEY_APP_NAME', 'app.name', 'Parley'),
    appSubtitle: cfgVal('PARLEY_APP_SUBTITLE', 'app.subtitle', 'Agent Portal'),
    agentLabel: cfgVal('PARLEY_AGENT_LABEL', 'app.agent_label', 'Clawdian'),
    // Any valid CSS color (hex, rgb(), hsl()). Empty = keep stylesheet default.
    themePrimary: cfgVal('PARLEY_THEME_PRIMARY', 'app.theme_primary', ''),
    // Which BackendAdapter the client loads. Always 'hermes-gateway'
    // post-refactor — the legacy openclaw / openai-compat / zeroclaw
    // direct-PWA-to-LLM adapters were removed in step 7. Setting any
    // other value loads hermes-gateway anyway.
    backend: cfgVal('PARLEY_BACKEND', 'backend.type', 'hermes-gateway'),
  }));
}

// Parley audio bridge — standalone Python aiortc service for WebRTC
// signaling + STT + TTS. The proxy forwards /api/rtc/* to the bridge;
// the bridge POSTs back to /api/parley/messages with {chat_id, text}
// for agent dispatch (single parley→agent gateway). See
// ~/code/parley/audio-bridge/.
const AUDIO_BRIDGE_UPSTREAM = cfgVal(
  'PARLEY_AUDIO_BRIDGE_URL',
  'backend.audio_bridge.url',
  'http://127.0.0.1:8643',
) as string;

const HOME = os.homedir();

// ─── Parley agent contract ────────────────────────────────────────────
// The proxy talks to ANY upstream that speaks the abstract agent
// contract (HTTP+SSE — see docs/ABSTRACT_AGENT_PROTOCOL.md).
// backends/hermes/plugin is the typical upstream; the stub agent under
// `agent/` is a hermes-free reference. With no token configured,
// `/api/parley/*` endpoints return 503.
const PARLEY_UPSTREAM_URL = cfgVal('PARLEY_PLATFORM_URL',
  ['backend.parley_platform.url'],
  'http://127.0.0.1:8645') as string;
parley.init({
  token: readEnv('PARLEY_PLATFORM_TOKEN')
    || (cfgVal('PARLEY_PLATFORM_TOKEN',
      ['backend.parley_platform.token'], '') as string),
  url: PARLEY_UPSTREAM_URL,
  // Backend switch (claude-code wiring 2026-07-14): `backend: claude-code`
  // in parley.config.yaml (or PARLEY_BACKEND env, which wins inside
  // init) selects the in-process Agent SDK upstream; the claude_code
  // block carries its config (cwd, allowlist, model, approvals, …).
  backend: cfgVal('PARLEY_BACKEND', 'backend.name', 'http') as string,
  claudeCode: (cfgVal('', 'claude_code', null) as Record<string, unknown> | null) ?? undefined,
});

// Meeting-capture transcription pipeline (proxy/parley/
// captureTranscribe.ts): hooks segment arrivals into audio-bridge
// batch STT → rolling transcript.md → doc_show pushes, plus the
// start-message + post-stop ingest turn. Wired only when the bridge
// is configured — without it, captures still record + store (stop
// completes immediately; retro-transcription stays possible since
// raw segments persist). Boot recovery re-enqueues anything a restart
// interrupted.
// Gate on STT actually being configured (audit 2026-07-09 1.2): wiring
// the pipeline against a dead bridge burned ~18s of retries per
// segment, filled transcripts with failure markers, and fired spurious
// ingest turns — while capture.ts's no-hooks path already does the
// right thing (record + store, stop completes immediately, transcripts
// retro-runnable once STT exists). DEEPGRAM_KEY is the honest proxy
// for "the bridge can transcribe"; a key added later via the setup
// wizard wires the pipeline on the next restart.
if (DEEPGRAM_KEY) {
  parley.initCaptureTranscription({
    bridgeUrl: AUDIO_BRIDGE_UPSTREAM,
    // Same vocabulary biasing the memo/dictate paths get (§Phase 4b) —
    // live closure so yaml config reloads apply without a restart.
    keytermsFn: readSeedKeyterms,
  });
  void parley.recoverPendingTranscriptions(parley.listCaptures);
} else {
  console.warn('[capture] transcription pipeline not wired (no DEEPGRAM_API_KEY) — captures record+store only');
}

// Capture janitor (postmortem 2026-08-18): expire never-activated
// pending captures to 'failed' IN PLACE (a reload during "Starting
// microphone…" must reconcile without announcing or deleting), heal
// stale recordings, and purge Recently-Deleted captures only after the
// retention window. Also runs inline on every create; the timer covers
// the no-new-capture case. unref(): never keeps the process alive.
setInterval(() => {
  void parley.sweepCaptures().catch((e: unknown) => {
    console.warn(`[capture] sweep failed: ${String(e)}`);
  });
}, 60_000).unref();

// First-run wizard backing (proxy/parley/setup.ts). Persists to the
// same .env start-all loads (PARLEY_ENV_FILE from the npx launcher,
// else the repo-root .env) and live-swaps the TTS key above.
initSetup({
  envFile: readEnv('PARLEY_ENV_FILE') || path.join(__dirname, '.env'),
  upstreamUrl: () => PARLEY_UPSTREAM_URL,
  setDeepgramKey: (key: string) => { DEEPGRAM_KEY = key; },
  hasDeepgramKey: () => !!DEEPGRAM_KEY,
});

// ── WebRTC voice transport proxy: /api/rtc/* → audio-bridge /v1/rtc/* ────────
// The audio bridge (~/code/parley/audio-bridge/) is a standalone Python
// aiortc service on :8643. The bridge owns WebRTC signaling, STT, and
// TTS; it POSTs back through this proxy at /api/parley/messages with
// {chat_id, text} for agent dispatch (single parley→agent gateway).
//
// Body sizes are tiny (an SDP offer is <4KB, ICE candidates <1KB) so no
// special streaming concerns. No auth header forwarding — the bridge is
// loopback-only and the agent token is irrelevant here.
function handleRtcProxy(req, res) {
  const suffix = req.url.replace(/^\/api\/rtc/, '') || '/';
  const upstreamPath = `/v1/rtc${suffix}`;
  const upstream = new URL(upstreamPath, AUDIO_BRIDGE_UPSTREAM);

  const headers = {};
  for (const h of ['content-type', 'content-length', 'accept']) {
    if (req.headers[h]) headers[h] = req.headers[h];
  }

  const lib = upstream.protocol === 'https:' ? https : http;
  const upReq = lib.request({
    hostname: upstream.hostname,
    port: upstream.port || (upstream.protocol === 'https:' ? 443 : 80),
    path: upstream.pathname + upstream.search,
    method: req.method,
    headers,
  }, (upRes) => {
    const out = { ...upRes.headers };
    delete out.connection;
    delete out['transfer-encoding'];
    res.writeHead(upRes.statusCode || 502, out);
    upRes.pipe(res);
  });

  upReq.on('error', (e) => {
    console.error('rtc proxy: upstream error:', e.message);
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: `upstream unreachable: ${e.message}` }));
    } else {
      res.end();
    }
  });

  if (req.method === 'POST' || req.method === 'PUT') req.pipe(upReq);
  else upReq.end();
}

// ── CORS for the Capacitor local-asset shell ────────────────────────────
// The native iOS shell serves its assets from capacitor://localhost and
// reaches this proxy cross-origin (see src/apiBase.ts). Browsers gate those
// calls behind CORS, so we must echo Access-Control-* headers. We do NOT
// open this up to `*`: the proxy is an authenticated gateway to the agent,
// and a blanket allow would let any website a user visits script requests to
// their host. Instead we allow only the known native-shell origins. The web
// PWA is same-origin with the proxy, so it never needs these headers.
//
// Auth is bearer/token-based and the one cross-origin-relevant client fetch
// uses credentials:'same-origin' (i.e. omitted cross-origin), so we don't
// send Access-Control-Allow-Credentials.
const CORS_ALLOWED_ORIGINS = new Set([
  'capacitor://localhost',
  'ionic://localhost',
  'http://localhost',
  'https://localhost',
]);

/** Set CORS response headers when the request comes from an allowed
 *  native-shell origin. Uses res.setHeader so the values merge into every
 *  downstream res.writeHead (Node gives writeHead precedence only on
 *  conflicting keys — no handler sets Access-Control-* itself). */
function applyCors(req: http.IncomingMessage, res: http.ServerResponse): void {
  const origin = req.headers.origin;
  if (origin && CORS_ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
}

const requestHandler: http.RequestListener = async (req, res) => {
  applyCors(req, res);
  if (req.method === 'OPTIONS') {
    const origin = req.headers.origin;
    if (origin && CORS_ALLOWED_ORIGINS.has(origin)) {
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
      const reqHeaders = req.headers['access-control-request-headers'];
      res.setHeader('Access-Control-Allow-Headers', reqHeaders || 'Content-Type, Authorization');
      res.setHeader('Access-Control-Max-Age', '86400');
    }
    res.writeHead(204); res.end(); return;
  }
  // Health probe for the native (Capacitor) bootstrap in mobile/webdir.
  // Returns a READABLE, CORS-enabled sentinel so the app can verify a host
  // is actually running THIS stack before redirecting to it. A bare socket
  // answering — e.g. a decommissioned host still bound to :3001, or a 404
  // — must NOT count as reachable (that's what stranded the app on a white
  // screen after a host migration). ACAO:* lets the capacitor://localhost
  // origin read the body cross-origin; a host without this endpoint fails
  // the probe and the app falls back to its URL picker.
  if (req.method === 'GET' && req.url && /^\/health(?:\?.*)?$/.test(req.url)) {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
    });
    // Sentinel for the CAP bootstrap's host probe. Installed shells
    // since the 2026-08 rename accept app:'parley' (and independently
    // match product:'parley'), so the legacy app:'sidekick' value was
    // dropped in the identity purge.
    //
    // `data_home` is a TEST-SAFETY sentinel, not a diagnostic: it lets
    // scripts/run-smoke.mjs prove a target is a sandbox before it starts
    // POSTing settings at it. Reports the classification only, never the
    // path — /health is reachable over tailscale.
    res.end(JSON.stringify({
      ok: true,
      app: 'parley',
      product: 'parley',
      data_home: isLiveDataHome() ? 'live' : 'isolated',
    }));
    return;
  }
  // WebRTC voice signaling proxy → /v1/rtc/* on hermes upstream.
  if (req.url && req.url.startsWith('/api/rtc')) return handleRtcProxy(req, res);
  // Parley agent-contract endpoints. Match before the static
  // fallback. The DELETE pattern's chat_id capture group is permissive
  // on character class to match the IDB-minted UUIDs we expect.
  if (req.url) {
    // First-run setup wizard surface (see proxy/parley/setup.ts).
    if (req.method === 'GET' && req.url === '/api/parley/setup/status') {
      return handleSetupStatus(req, res);
    }
    if (req.method === 'POST' && req.url === '/api/parley/setup') {
      return handleSetupApply(req, res);
    }
    if (req.method === 'POST' && req.url === '/api/parley/messages') {
      return parley.handleParleyMessage(req, res);
    }
    // Large-file staging (task #158) — raw-bytes upload streamed to the
    // upstream plugin; returns { upload_id } the PWA references on its
    // next message. Match before the static fallback.
    if (req.method === 'POST' && req.url === '/api/parley/upload') {
      return parley.handleParleyUpload(req, res);
    }
    // Meeting capture — proxy-owned public API (capture.ts; design doc
    // §3.3). Order matters: /control and the id-scoped subroutes match
    // before the bare /captures collection routes.
    if (req.method === 'POST' && req.url === '/api/parley/captures/control') {
      return parley.handleCaptureControl(req, res);
    }
    const capSegment = req.method === 'POST'
      && req.url.match(/^\/api\/parley\/captures\/([^/]+)\/segments\/(\d+)$/);
    if (capSegment) {
      return parley.handleCaptureSegment(req, res, capSegment[1], capSegment[2]);
    }
    // Client health ping (incident 2026-08-27): the client reports what
    // it believes about its own recorder, so "no audio arrived" can be
    // told apart from "the phone was asleep" without a forensic dig.
    const capHealth = req.method === 'POST'
      && req.url.match(/^\/api\/parley\/captures\/([^/]+)\/health$/);
    if (capHealth) {
      return parley.handleCaptureHealth(req, res, capHealth[1]);
    }
    const capStop = req.method === 'POST'
      && req.url.match(/^\/api\/parley\/captures\/([^/]+)\/stop$/);
    if (capStop) {
      return parley.handleCaptureStop(req, res, capStop[1]);
    }
    // Two-phase lifecycle (2026-08-18 postmortem): activate confirms a
    // real recorder is running (pending→recording, fires the announce);
    // abort-start fails a pending capture in place. Discard/restore/
    // purge are the recoverable deletion lane — the generic DELETE
    // below rejects anything live or segment-bearing.
    const capActivate = req.method === 'POST'
      && req.url.match(/^\/api\/parley\/captures\/([^/]+)\/activate$/);
    if (capActivate) {
      return parley.handleCaptureActivate(req, res, capActivate[1]);
    }
    const capAbortStart = req.method === 'POST'
      && req.url.match(/^\/api\/parley\/captures\/([^/]+)\/abort-start$/);
    if (capAbortStart) {
      return parley.handleCaptureAbortStart(req, res, capAbortStart[1]);
    }
    const capDiscard = req.method === 'POST'
      && req.url.match(/^\/api\/parley\/captures\/([^/]+)\/discard$/);
    if (capDiscard) {
      return parley.handleCaptureDiscard(req, res, capDiscard[1]);
    }
    const capRestore = req.method === 'POST'
      && req.url.match(/^\/api\/parley\/captures\/([^/]+)\/restore$/);
    if (capRestore) {
      return parley.handleCaptureRestore(req, res, capRestore[1]);
    }
    const capPurgeAll = req.method === 'POST'
      && req.url.match(/^\/api\/parley\/captures\/([^/]+)\/purge$/);
    if (capPurgeAll) {
      return parley.handleCapturePurge(req, res, capPurgeAll[1]);
    }
    const capMark = req.method === 'POST'
      && req.url.match(/^\/api\/parley\/captures\/([^/]+)\/marks$/);
    if (capMark) {
      return parley.handleCaptureMark(req, res, capMark[1]);
    }
    const capAudio = req.method === 'GET'
      && req.url.match(/^\/api\/parley\/captures\/([^/]+)\/audio(?:\?.*)?$/);
    if (capAudio) {
      return parley.handleCaptureAudio(req, res, capAudio[1]);
    }
    // Transcript as data, not fanout — the heal path for shelf docs
    // stuck on "(live)" because the finished doc_show envelope was a
    // one-shot SSE push no client was connected to hear ("Meeting
    // 2026-08-24 (live)" field report 2026-08-26).
    const capTranscript = req.method === 'GET'
      && req.url.match(/^\/api\/parley\/captures\/([^/]+)\/transcript(?:\?.*)?$/);
    if (capTranscript) {
      return parley.handleCaptureTranscript(req, res, capTranscript[1]);
    }
    // Agent-pushed media (proxy/parley/media.ts): any local agent
    // registers a produced file, embeds the returned url in its reply
    // as markdown, and the client renders a video/image card. Backend-
    // agnostic by design — hermes, claude-code and openclaw agents all
    // hit the same two routes.
    if (req.method === 'POST' && req.url === '/api/parley/media/register') {
      return parley.handleMediaRegister(req, res);
    }
    const mediaGet = req.method === 'GET'
      && req.url.match(/^\/api\/parley\/media\/([a-f0-9]+)(?:\.[A-Za-z0-9]+)?(?:\?.*)?$/);
    if (mediaGet) {
      return parley.handleMediaGet(req, res, mediaGet[1]);
    }
    const capPurge = req.method === 'POST'
      && req.url.match(/^\/api\/parley\/captures\/([^/]+)\/purge-audio$/);
    if (capPurge) {
      return parley.handleCapturePurgeAudio(req, res, capPurge[1]);
    }
    const capRediarize = req.method === 'POST'
      && req.url.match(/^\/api\/parley\/captures\/([^/]+)\/diarize$/);
    if (capRediarize) {
      return parley.handleCaptureRetroDiarize(req, res, capRediarize[1]);
    }
    const capPatch = req.method === 'PATCH'
      && req.url.match(/^\/api\/parley\/captures\/([^/?]+)$/);
    if (capPatch) {
      return parley.handleCapturePatch(req, res, capPatch[1]);
    }
    const capDelete = req.method === 'DELETE'
      && req.url.match(/^\/api\/parley\/captures\/([^/?]+)$/);
    if (capDelete) {
      return parley.handleCaptureDelete(req, res, capDelete[1]);
    }
    const capGet = req.method === 'GET'
      && req.url.match(/^\/api\/parley\/captures\/([^/?]+)$/);
    if (capGet) {
      return parley.handleCaptureGet(req, res, capGet[1]);
    }
    if (req.method === 'GET' && /^\/api\/parley\/captures(?:\?.*)?$/.test(req.url)) {
      return parley.handleCaptureList(req, res);
    }
    if (req.method === 'POST' && req.url === '/api/parley/captures') {
      return parley.handleCaptureCreate(req, res);
    }
    if (req.method === 'GET' && /^\/api\/parley\/stream(?:\?.*)?$/.test(req.url)) {
      return parley.handleParleyStream(req, res);
    }
    if (req.method === 'GET' && /^\/api\/parley\/sessions(?:\?.*)?$/.test(req.url)) {
      return parley.handleParleySessionsList(req, res);
    }
    // Per-chat_id transcript history. Match BEFORE the generic
    // /sessions/<id> DELETE pattern so the more-specific subroute wins.
    const parleyHistory = req.method === 'GET'
      && req.url.match(/^\/api\/parley\/sessions\/([^/?]+)\/messages(?:\?.*)?$/);
    if (parleyHistory) {
      return parley.handleParleySessionMessages(req, res, decodeURIComponent(parleyHistory[1]));
    }
    const parleyDelete = req.method === 'DELETE'
      && req.url.match(/^\/api\/parley\/sessions\/([^/?]+)(?:\?.*)?$/);
    if (parleyDelete) {
      return parley.handleParleySessionDelete(req, res, decodeURIComponent(parleyDelete[1]));
    }
    const parleyRename = req.method === 'PATCH'
      && req.url.match(/^\/api\/parley\/sessions\/([^/?]+)(?:\?.*)?$/);
    if (parleyRename) {
      return parley.handleParleySessionRename(req, res, decodeURIComponent(parleyRename[1]));
    }
    if (req.method === 'GET' && /^\/api\/parley\/settings\/schema(?:\?.*)?$/.test(req.url)) {
      return parley.handleParleySettingsSchema(req, res);
    }
    // Scheduled-jobs extension (Settings › Cron). Order matters: the
    // two-segment `/run` and `/runs` routes must match before the bare id.
    if (req.method === 'GET' && /^\/api\/parley\/jobs(?:\?.*)?$/.test(req.url)) {
      return parley.handleParleyJobsList(req, res);
    }
    const jobRun = req.method === 'POST' && req.url.match(/^\/api\/parley\/jobs\/([^/?]+)\/run(?:\?.*)?$/);
    if (jobRun) {
      return parley.handleParleyJobRun(req, res, decodeURIComponent(jobRun[1]));
    }
    const jobRuns = req.method === 'GET' && req.url.match(/^\/api\/parley\/jobs\/([^/?]+)\/runs(?:\?.*)?$/);
    if (jobRuns) {
      return parley.handleParleyJobRuns(req, res, decodeURIComponent(jobRuns[1]));
    }
    const jobDelete = req.method === 'DELETE' && req.url.match(/^\/api\/parley\/jobs\/([^/?]+)(?:\?.*)?$/);
    if (jobDelete) {
      return parley.handleParleyJobDelete(req, res, decodeURIComponent(jobDelete[1]));
    }
    const jobUpdate = req.method === 'POST' && req.url.match(/^\/api\/parley\/jobs\/([^/?]+)(?:\?.*)?$/);
    if (jobUpdate) {
      return parley.handleParleyJobUpdate(req, res, decodeURIComponent(jobUpdate[1]));
    }
    if (req.method === 'GET' && /^\/api\/parley\/commands(?:\?.*)?$/.test(req.url)) {
      return parley.handleParleyCommands(req, res);
    }
    if (req.method === 'GET' && /^\/api\/parley\/model-capabilities(?:\?.*)?$/.test(req.url)) {
      return parley.handleParleyModelCapabilities(req, res);
    }
    if (req.method === 'GET' && /^\/api\/parley\/auxiliary-models(?:\?.*)?$/.test(req.url)) {
      return parley.handleParleyAuxiliaryModels(req, res);
    }
    if (req.method === 'GET' && /^\/api\/parley\/search(?:\?.*)?$/.test(req.url)) {
      return parley.handleParleySearch(req, res);
    }
    // Web Push (Phase 3) — VAPID public-key probe + subscribe /
    // unsubscribe / test. Routes implemented in
    // proxy/parley/notifications/routes.ts; the 503-on-unconfigured
    // gate lives inside each handler so this dispatch stays uniform.
    if (req.method === 'GET' && req.url === '/api/parley/notifications/vapid-public-key') {
      return parley.handleParleyVapidPublicKey(req, res);
    }
    if (req.method === 'POST' && req.url === '/api/parley/notifications/subscribe') {
      return parley.handleParleySubscribe(req, res);
    }
    if (req.method === 'POST' && req.url === '/api/parley/notifications/unsubscribe') {
      return parley.handleParleyUnsubscribe(req, res);
    }
    if (req.method === 'POST' && req.url === '/api/parley/notifications/test') {
      return parley.handleParleyTest(req, res);
    }
    if (req.method === 'GET' && req.url === '/api/parley/notifications/mutes') {
      return parley.handleParleyListMutes(req, res);
    }
    if (req.method === 'POST' && req.url === '/api/parley/notifications/mute') {
      return parley.handleParleySetMute(req, res);
    }
    if (req.method === 'POST' && req.url === '/api/parley/notifications/visibility') {
      return parley.handleParleyVisibility(req, res);
    }
    if (req.method === 'GET' && req.url === '/api/parley/notifications/preferences') {
      return parley.handleParleyGetPreferences(req, res);
    }
    if (req.method === 'POST' && req.url === '/api/parley/notifications/preferences') {
      return parley.handleParleySetPreferences(req, res);
    }
    if (req.method === 'GET' && req.url && req.url.startsWith('/api/parley/notifications/diagnostics')) {
      return parley.handleParleyDiagnostics(req, res);
    }
    // ── Unread + pins (plugin-owned SSOT; proxy forwards). ───────────
    // The PWA's badge module + pin drawer call these; the proxy
    // delegates to the upstream plugin's /v1/unread + /v1/pins.
    {
      const delegate = await import('./proxy/parley/notifications/delegate.ts');
      if (req.method === 'GET' && req.url === '/api/parley/notifications/unread') {
        return delegate.delegateUnread(req, res);
      }
      if (req.method === 'POST' && req.url === '/api/parley/notifications/seen') {
        return delegate.delegateUnreadSeen(req, res);
      }
      if (req.method === 'POST' && req.url === '/api/parley/notifications/mark') {
        return delegate.delegateUnreadMark(req, res);
      }
      // Unified elicitation: answer a blocking agent question (clarify).
      const questionAnswer = req.method === 'POST'
        && req.url.match(/^\/api\/parley\/questions\/([^/?]+)(?:\?.*)?$/);
      if (questionAnswer) {
        return delegate.delegateQuestionAnswer(req, res, decodeURIComponent(questionAnswer[1]));
      }
      if (req.method === 'GET' && req.url && /^\/api\/parley\/pins(?:\?.*)?$/.test(req.url)) {
        return delegate.delegatePinsList(req, res);
      }
      if (req.method === 'POST' && req.url === '/api/parley/pins') {
        return delegate.delegatePinUpsert(req, res);
      }
      const pinDelete = req.method === 'DELETE'
        && req.url.match(/^\/api\/parley\/pins\/([^/]+)\/([^/?]+)(?:\?.*)?$/);
      if (pinDelete) {
        return delegate.delegatePinDelete(
          req, res, decodeURIComponent(pinDelete[1]), decodeURIComponent(pinDelete[2]),
        );
      }
      if (req.method === 'GET' && req.url && /^\/api\/parley\/activity(?:\?.*)?$/.test(req.url)) {
        return delegate.delegateActivityList(req, res);
      }
      if (req.method === 'POST' && req.url === '/api/parley/activity') {
        return delegate.delegateActivityUpsert(req, res);
      }
      if (req.method === 'POST' && req.url === '/api/parley/activity/resolve') {
        return delegate.delegateActivityResolve(req, res);
      }
      if (req.method === 'POST' && req.url === '/api/parley/activity/seen') {
        return delegate.delegateActivitySeen(req, res);
      }
      if (req.method === 'POST' && req.url === '/api/parley/activity/clear') {
        return delegate.delegateActivityClear(req, res);
      }
      const activityDelete = req.method === 'DELETE'
        && req.url.match(/^\/api\/parley\/activity\/([^/?]+)(?:\?.*)?$/);
      if (activityDelete) {
        return delegate.delegateActivityDelete(req, res, decodeURIComponent(activityDelete[1]));
      }
      // Synced user settings (parley.db user_settings): STT key-terms
      // today, more as the YAML→DB migration proceeds. Distinct from
      // /api/parley/config (YAML) and /api/parley/settings (agent).
      if (req.method === 'GET' && /^\/api\/parley\/prefs(?:\?.*)?$/.test(req.url)) {
        return delegate.delegateUserSettingsList(req, res);
      }
      const prefGet = req.method === 'GET'
        && req.url.match(/^\/api\/parley\/prefs\/([A-Za-z0-9_]+)(?:\?.*)?$/);
      if (prefGet) {
        return delegate.delegateUserSettingGet(req, res, prefGet[1]);
      }
      const prefSet = req.method === 'PUT'
        && req.url.match(/^\/api\/parley\/prefs\/([A-Za-z0-9_]+)(?:\?.*)?$/);
      if (prefSet) {
        return delegate.delegateUserSettingSet(req, res, prefSet[1]);
      }
    }
    const parleySettingsUpdate = req.method === 'POST'
      && req.url.match(/^\/api\/parley\/settings\/([^/?]+)(?:\?.*)?$/);
    if (parleySettingsUpdate) {
      return parley.handleParleySettingsUpdate(
        req, res, decodeURIComponent(parleySettingsUpdate[1]),
      );
    }
    // Frontend settings store (yaml-backed PWA settings: theme,
    // hotkeys, voice phrases, etc.).
    if (req.method === 'GET' && /^\/api\/parley\/config(?:\?.*)?$/.test(req.url)) {
      return handleParleyConfigGet(req, res);
    }
    const parleyConfigSet = req.method === 'POST'
      && req.url.match(/^\/api\/parley\/config\/([A-Za-z0-9_]+)(?:\?.*)?$/);
    if (parleyConfigSet) {
      return handleParleyConfigSet(req, res, parleyConfigSet[1]);
    }
  }
  if (req.method === 'POST' && req.url === '/api/debug/logs') return handleDebugLogs(req, res);
  // /dev: convenience redirect that flips on the dev-mode URL flags.
  // Bookmark `…/dev` instead of typing the full ?-string. URL is the
  // transparent source of truth; dev-mode flags are intentionally not
  // persisted in localStorage so they reset on every normal load.
  if (req.method === 'GET' && (req.url === '/dev' || req.url === '/dev/')) {
    res.writeHead(302, { Location: '/?debug=1&debug-relay=1&dictate-debug=1' });
    res.end();
    return;
  }
  if (req.method === 'GET' && req.url === '/config') return handleConfig(req, res);
  if (req.method === 'GET' && req.url === '/api/keyterms') return handleKeytermsGet(req, res);
  if (req.method === 'POST' && req.url.startsWith('/tts')) return handleTts(req, res);
  if (req.method === 'POST' && req.url.startsWith('/gen-image')) return handleGenImage(req, res);
  if (req.method === 'POST' && (req.url === '/transcribe' || req.url.startsWith('/transcribe?'))) return handleTranscribe(req, res);
  if (req.method === 'GET' && req.url.startsWith('/weather')) return handleWeather(req, res);
  if (req.method === 'GET' && req.url.startsWith('/link-preview')) return handleLinkPreview(req, res);
  if (req.method === 'GET' && req.url.startsWith('/spotify-check')) return handleSpotifyCheck(req, res);
  if (req.method === 'GET' && req.url.startsWith('/screenshot')) return handleScreenshot(req, res);
  if (req.method === 'GET' && req.url.startsWith('/render')) return handleRender(req, res);
  if (req.method === 'GET') return serveStatic(req, res);
  res.writeHead(405); res.end('method not allowed');
};

const server = createHttpServer(requestHandler);

// ── WebSocket servers ──────────────────────────────────────────────────────
// (Legacy /ws/deepgram STT proxy removed when classic pipeline was gut-cut;
// streaming STT now flows through the audio-bridge WebRTC path, batch STT
// through POST /transcribe → audio-bridge /v1/transcribe.)

const zcWss = new WebSocketServer({ noServer: true });

// ── ZeroClaw gateway proxy config ──────────────────────────────────────────
// The zeroclaw gateway is bound to loopback on the Pi. This server proxies
// browser WS connections on /ws/zeroclaw to the upstream gateway, so the
// gateway stays unexposed and the browser only speaks to the same origin.
const ZC_UPSTREAM = cfgVal('PARLEY_ZEROCLAW_WS', 'backend.zeroclaw.ws_url',
  'ws://127.0.0.1:42617/ws/chat') as string;
const ZC_TOKEN = readEnv('PARLEY_ZEROCLAW_TOKEN') || '';  // secret — env only

// Canvas card delivery: NOT IMPLEMENTED — see docs/CANVAS.md.
// This comment previously claimed agents emit `tool_event` envelopes
// with `kind: 'canvas.show'` over SSE. They cannot: `ParleyEnvelope`
// (proxy/parley/upstream.ts) has no such member, so the handler in
// backendEventHandlers.ts is unreachable. Cards reaching users today
// are derived from reply markdown by src/cards/fallback.ts, not pushed.
// The previous `POST /canvas/show` + `/ws/canvas` standalone-panel path
// was a leftover from openclaw's deployment model where the canvas
// rendered in its own browser window separate from the chat shell.
// Parley never wired a `/ws/canvas` subscriber, so every POST to
// that endpoint silently returned `clients: 0`. Both removed
// 2026-05-11 — one delivery path, less confusion when a skill
// reports "I emitted a canvas card." The cards/validators.ts module
// is still around for whoever wants envelope-shape validation on
// the SSE side; it's just not imported here anymore.

const upgradeHandler = (req: http.IncomingMessage, socket: any, head: Buffer) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/ws/zeroclaw') {
    // Forward an optional session id so the browser can resume across page
    // reloads by passing ?session_id=... on its own WS url.
    const params = new URLSearchParams(url.search);
    const sessionId = params.get('session_id') || '';
    const sessionName = params.get('name') || '';
    const upstreamQs = [
      sessionId && `session_id=${encodeURIComponent(sessionId)}`,
      sessionName && `name=${encodeURIComponent(sessionName)}`,
      ZC_TOKEN && `token=${encodeURIComponent(ZC_TOKEN)}`,
    ].filter(Boolean).join('&');
    const upstreamUrl = upstreamQs ? `${ZC_UPSTREAM}?${upstreamQs}` : ZC_UPSTREAM;

    zcWss.handleUpgrade(req, socket, head, (clientWs) => {
      // Forward the browser's requested subprotocol (we hard-code 'zeroclaw.v1').
      const upstream = new WebSocket(upstreamUrl, ['zeroclaw.v1']);
      let upstreamOpen = false;
      const pending: (string | Buffer)[] = [];

      upstream.on('open', () => {
        upstreamOpen = true;
        // Flush any messages the client sent while we were still connecting.
        for (const m of pending) upstream.send(m);
        pending.length = 0;
      });

      clientWs.on('message', (data, isBinary) => {
        const payload = isBinary ? data as Buffer : data.toString();
        if (!upstreamOpen) { pending.push(payload); return; }
        if (upstream.readyState === WebSocket.OPEN) upstream.send(payload);
      });

      upstream.on('message', (data) => {
        if (clientWs.readyState === WebSocket.OPEN) {
          clientWs.send(typeof data === 'string' ? data : data.toString());
        }
      });

      clientWs.on('close', () => {
        if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) {
          upstream.close();
        }
      });
      upstream.on('close', (code, reason) => {
        if (clientWs.readyState === WebSocket.OPEN) clientWs.close(code, reason);
      });
      upstream.on('error', (e) => {
        console.error('zeroclaw proxy: upstream error:', e.message);
        if (clientWs.readyState === WebSocket.OPEN) clientWs.close(1011, 'upstream error');
      });
      clientWs.on('error', () => {
        if (upstream.readyState === WebSocket.OPEN) upstream.close();
      });
    });
    return;
  }

  // Unknown WS path
  socket.destroy();
};
server.on('upgrade', upgradeHandler);

server.listen(PORT, HOST, () => {
  const protocol = HTTPS_ENABLED && !DUAL_HTTPS ? 'https' : 'http';
  console.log(`Parley server on ${protocol}://${HOST}:${PORT} (TTS: ${DEFAULT_TTS_MODEL})`);
});

// ── Auxiliary HTTPS listener (auto-HTTPS trial path) ─────────────────
// When PARLEY_HTTPS_PORT is set alongside the cert pair (start-all's
// auto-generated self-signed cert), the main server stays plain HTTP on
// localhost and this second listener serves the SAME app over HTTPS on
// all interfaces — the secure context phones need for mic/PWA/push.
// Explicit cert WITHOUT the port keeps the legacy behavior (main server
// itself is HTTPS), so existing deployments are untouched.
if (DUAL_HTTPS) {
  const httpsServer = https.createServer({
    cert: fsSync.readFileSync(HTTPS_CERT_FILE),
    key: fsSync.readFileSync(HTTPS_KEY_FILE),
  }, requestHandler);
  httpsServer.on('upgrade', upgradeHandler);
  httpsServer.listen(HTTPS_PORT, '0.0.0.0', () => {
    console.log(`Parley HTTPS on https://0.0.0.0:${HTTPS_PORT} (self-signed — phones accept the one-time warning)`);
  });
}
