/**
 * @fileoverview Resolves the origin that server API calls target.
 *
 * Historically the app was always served from the same origin as its API
 * (https://<host>:3001), so every call used a relative URL or
 * location.origin. To let the Capacitor iOS shell serve the app's ASSETS
 * locally (capacitor://localhost) for a native-fast cold boot while still
 * reaching the remote agent, server calls must point at an explicit origin
 * instead of "wherever the page was loaded from".
 *
 * The split that matters:
 *   - ASSETS (/build, /styles, /assets, icons, /manifest.json) stay RELATIVE
 *     — in the CAP shell they're bundled and served locally.
 *   - SERVER endpoints (/api, /config, /tts, /transcribe) flow through
 *     apiUrl() / apiOrigin() so they hit the remote host.
 *
 * In a browser PWA / desktop the page scheme is http(s): apiOrigin() returns
 * location.origin and behavior is byte-identical to before. Inside the CAP
 * local-asset shell the page scheme is capacitor: (or file:), so we read the
 * remote host the config flow saved in localStorage under SERVER_URL_KEY
 * (the same key the legacy bootstrap used).
 */

/** localStorage key holding the saved remote server URL (e.g.
 *  "https://host:3001"). Shared with the CAP bootstrap. */
export const SERVER_URL_KEY = 'parley_server_url';

/** True when the page is served by the local CAP shell rather than over the
 *  network. In that case relative URLs resolve to the local bundle, so API
 *  calls need an explicit remote origin. */
export function isLocalShell(): boolean {
  try {
    const p = location.protocol;
    return p === 'capacitor:' || p === 'file:';
  } catch {
    return false;
  }
}

/** Origin that hosts the server API. location.origin in a browser PWA /
 *  desktop; the saved remote host inside the CAP local-asset shell. */
export function apiOrigin(): string {
  if (isLocalShell()) {
    const saved = localStorage.getItem(SERVER_URL_KEY);
    if (saved) return saved.replace(/\/+$/, '');
  }
  try {
    return location.origin;
  } catch {
    return '';
  }
}

/** Build an absolute server URL from an app-absolute path (must start with
 *  '/'). Asset paths (/build, /styles, /assets) must NOT go through here —
 *  they stay relative so the CAP shell serves them locally. */
export function apiUrl(path: string): string {
  return apiOrigin() + path;
}

/** Hostname of the API origin — used to derive the gateway WS URL. Falls
 *  back to location.hostname if the origin can't be parsed. */
export function apiHost(): string {
  try { return new URL(apiOrigin()).hostname; }
  catch { return location.hostname; }
}
