/**
 * @fileoverview Runtime config, loaded from server /config endpoint.
 * Replaces hardcoded keys in the HTML.
 */

/**
 * @typedef {Object} RuntimeConfig
 * @property {string} gwToken
 * @property {string} [mapsEmbedKey]
 * @property {string} [appName]
 * @property {string} [agentLabel] - Prefix the agent uses (e.g. "Clawdian").
 * @property {string} [backend] - Which BackendAdapter to load ('openclaw', 'openai-compat', ...).
 * @property {string} [openaiCompatModel] - Model string for the openai-compat backend.
 */
import { apiUrl, apiHost } from './apiBase.ts';

/** @type {RuntimeConfig | null} */
let cfg = null;

/** localStorage key for the last-good /config snapshot. Lets the app boot
 *  from cache when the backend is unreachable (CAP local-asset shell), so
 *  the user can still interact locally while deciding whether to reconnect
 *  or re-point at a new host. */
const CONFIG_CACHE_KEY = 'parley_config_cache'; // migrated from sidekick_config_cache

/** Optional hook fired when the live /config fetch fails. Lets the shell
 *  surface a reconnect affordance without config.ts importing UI code. */
let unreachableHandler: ((err: Error) => void) | null = null;
export function onConfigUnreachable(fn: (err: Error) => void) {
  unreachableHandler = fn;
}

function readCachedConfig() {
  try {
    const raw = localStorage.getItem(CONFIG_CACHE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

/**
 * Load runtime config. Cache-first: if a prior snapshot exists, the app can
 * boot from it immediately and the network result refreshes it. The network
 * fetch still gates the FIRST cold boot (no cache yet). On failure with a
 * cache present, we keep serving the cache and fire `onConfigUnreachable` so
 * the shell can offer to reconnect — boot proceeds instead of dying.
 */
export async function loadConfig() {
  const { fetchWithTimeout } = await import('./util/fetchWithTimeout.ts');
  try {
    // 8s — /config is a file read on the server, should return instantly.
    // Longer stalls mean the gateway isn't running; better to bail fast.
    const r = await fetchWithTimeout(apiUrl('/config'), { timeoutMs: 8_000 });
    cfg = await r.json();
    try { localStorage.setItem(CONFIG_CACHE_KEY, JSON.stringify(cfg)); } catch { /* private mode etc */ }
    return cfg;
  } catch (err) {
    const cached = readCachedConfig();
    if (cached) {
      cfg = cached;
      // Notify the shell the backend is down so it can prompt a reconnect,
      // but let boot continue from the cached snapshot.
      try { unreachableHandler?.(err instanceof Error ? err : new Error(String(err))); } catch { /* noop */ }
      return cfg;
    }
    // Truly cold (first launch offline / no cache) — can't proceed.
    throw err;
  }
}

export function getConfig() {
  if (!cfg) throw new Error('config not loaded — call loadConfig() first');
  return cfg;
}

/** Gateway WS URL derived from the API host (the remote host in the CAP
 *  local-asset shell; the page hostname in a browser PWA). */
export function gwWsUrl() {
  return `wss://${apiHost()}:18789/ws`;
}

/** Agent's display name (shown in bubble speaker, MediaSession metadata,
 *  and used to strip the matching [bracket] prefix the agent emits). Falls
 *  back to a generic label when config isn't loaded yet. */
export function getAgentLabel() {
  return cfg?.agentLabel || 'Agent';
}

/** App name (title bar, MediaSession app name, browser tab title). */
export function getAppName() {
  return cfg?.appName || 'SideKick';
}

/** Header tagline shown beneath the app name. */
export function getAppSubtitle() {
  return cfg?.appSubtitle || 'Agent Portal';
}

/** Optional theme primary color. Empty string = don't override stylesheet. */
export function getThemePrimary() {
  return cfg?.themePrimary || '';
}

/** Apply skinning config to the DOM — brand text, document title, info
 *  panel heading, and the --primary CSS variable. Called once on boot
 *  after loadConfig() resolves. Everything user-visible that embeds the
 *  app name should flow through here so deployments with a different
 *  SIDEKICK_APP_NAME rebrand end-to-end. */
export function applySkinning() {
  const name = getAppName();
  const subtitle = getAppSubtitle();

  document.title = name;

  // Wordmark layout: header has a logo-as-S + "idekick" split, specifically
  // tuned for the "SideKick" wordmark. If the deployment sets a different
  // SIDEKICK_APP_NAME, render the full name as plain text and shrink the
  // logo to a leading icon so the split isn't lexically wrong (e.g.
  // "[S]idekick" becoming "[S]randdesk" for a Brandesk fork).
  const wmRest = document.querySelector('.header .wm-rest');
  const wmS = document.querySelector('.header .wm-s');
  if (wmRest && wmS) {
    const defaultName = 'SideKick';
    if (name.toLowerCase() === defaultName.toLowerCase()) {
      // Default branding — keep the [S]idekick split. Preserve case
      // from the config (e.g. "Sidekick" lowercases "idekick").
      wmRest.textContent = name.slice(1);
    } else {
      // Custom branding — show full name and present the logo as a
      // preceding icon (narrower, not oversized-as-cap-height).
      wmRest.textContent = name;
      (wmS as HTMLElement).style.width = '1em';
      (wmS as HTMLElement).style.height = '1em';
      (wmS as HTMLElement).style.marginRight = '6px';
      (wmS as HTMLElement).style.marginBottom = '0';
      // Hide the chevron layer — it was designed as a typographic accent
      // inside the letter S, not as part of a standalone icon.
      const chevron = wmS.querySelector('.wm-chevron') as HTMLElement | null;
      if (chevron) chevron.style.display = 'none';
    }
  }
  const subtitleEl = document.querySelector('.header .subtitle');
  if (subtitleEl) subtitleEl.textContent = subtitle;

  // Info panel / sidebar labels that reference the app by name.
  const infoH2 = document.querySelector('#info-panel h2');
  if (infoH2) infoH2.textContent = name;
  const sbInfo = document.getElementById('sb-info');
  if (sbInfo) {
    sbInfo.title = `About ${name}`;
    const label = sbInfo.querySelector('.sb-label');
    if (label) label.textContent = `About ${name}`;
  }

  const primary = getThemePrimary();
  if (primary) document.documentElement.style.setProperty('--primary', primary);
}
