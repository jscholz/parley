/**
 * @fileoverview Ambient clock + weather widget — floats in the lower-
 * right of the desktop viewport. Two states:
 *   - compact  (default): thin pill with time + current temp/icon
 *   - expanded (on click): rounded card with big clock, current weather
 *     detail, and a 3-day forecast strip. Click the card itself to
 *     collapse. Stays expanded otherwise — lets the HUD persist while
 *     the user chats.
 *
 * Hidden on mobile via CSS media query. Weather fetches the gateway's
 * /weather passthrough (Open-Meteo) with 15-min caching.
 */

import { escapeHtml } from './util/dom.ts';
import { log } from './util/log.ts';
import { apiUrl } from './apiBase.ts';

const WEATHER_TTL_MS = 15 * 60 * 1000;

/** Browser IANA timezone (e.g. "Europe/London"). Sent to /weather so the
 *  gateway geocodes it to coords — same auto-detection the clock already
 *  relies on, no geolocation permission prompt. */
const BROWSER_TZ = (() => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch { return ''; }
})();

/** Short timezone label for the clock (e.g. "BST", "EDT", "GMT+1").
 *  Recomputed per render so DST transitions are reflected. */
function tzAbbrev(now: Date): string {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZoneName: 'short' }).formatToParts(now);
    return parts.find((p) => p.type === 'timeZoneName')?.value || '';
  } catch { return ''; }
}

/** WMO → [emoji, description]. Used in both compact + expanded states. */
const WMO = {
  0: ['☀️', 'clear'],
  1: ['🌤', 'mainly clear'], 2: ['⛅', 'partly cloudy'], 3: ['☁️', 'overcast'],
  45: ['🌫', 'fog'], 48: ['🌫', 'rime fog'],
  51: ['🌦', 'light drizzle'], 53: ['🌦', 'drizzle'], 55: ['🌧', 'heavy drizzle'],
  56: ['🌧', 'freezing drizzle'], 57: ['🌧', 'freezing drizzle'],
  61: ['🌦', 'light rain'], 63: ['🌧', 'rain'], 65: ['🌧', 'heavy rain'],
  66: ['🌧', 'freezing rain'], 67: ['🌧', 'freezing rain'],
  71: ['🌨', 'light snow'], 73: ['🌨', 'snow'], 75: ['❄️', 'heavy snow'],
  77: ['🌨', 'snow grains'],
  80: ['🌦', 'rain showers'], 81: ['🌦', 'rain showers'], 82: ['🌧', 'violent showers'],
  85: ['🌨', 'snow showers'], 86: ['🌨', 'heavy snow showers'],
  95: ['⛈', 'thunderstorm'], 96: ['⛈', 'thunder + hail'], 99: ['⛈', 'thunder + hail'],
};

let weatherCache = null;
let weatherFetchedAt = 0;
/** @type {HTMLElement|null} */
let rootEl = null;
let tickTimer = null;

/** External callbacks injected at init time. When `isExpandedRef` is
 *  supplied the widget reads expand state from there (instead of its
 *  own localStorage var) and clicks call `onClick` instead of mutating
 *  local state. This is how the right-side pin drawer integrates the
 *  widget — clicking the clock expands the DRAWER, not just the widget.
 *  Both refs are optional so the legacy floating-pill mode keeps
 *  working for hosts that don't supply them. */
let isExpandedRef: (() => boolean) | null = null;
let onClickRef: (() => void) | null = null;

/** Expanded state persisted to localStorage — used only when no
 *  external isExpandedRef is supplied (legacy floating-widget mode).
 *  Same pattern the sidebar uses for its own collapsed-pref. */
const AMBIENT_PREF_KEY = 'parley.ambient.expanded';
let localExpanded = (() => {
  try { return localStorage.getItem(AMBIENT_PREF_KEY) === '1'; } catch { return false; }
})();
function isExpanded(): boolean {
  return isExpandedRef ? isExpandedRef() : localExpanded;
}

async function loadWeather() {
  const now = Date.now();
  if (weatherCache && (now - weatherFetchedAt) < WEATHER_TTL_MS) return weatherCache;
  try {
    const { fetchWithTimeout } = await import('./util/fetchWithTimeout.ts');
    const qs = BROWSER_TZ ? `?tz=${encodeURIComponent(BROWSER_TZ)}` : '';
    const r = await fetchWithTimeout(apiUrl(`/weather${qs}`), { timeoutMs: 10_000 });
    weatherCache = await r.json();
    weatherFetchedAt = now;
  } catch (e) {
    log('ambient weather fetch failed:', e.message);
    weatherCache = null;
  }
  return weatherCache;
}

/** Initialize the ambient HUD.
 *
 *  Two modes (controlled by `opts`):
 *    - Legacy floating pill: omit opts. The widget mounts as a fixed
 *      element on document.body and owns its own expand state.
 *    - In-drawer: pass `mount` + `isExpanded` + `onClick`. The widget
 *      renders into `mount`, reads expand state from `isExpanded()`
 *      (so the parent drawer's open/closed state drives the visual),
 *      and clicks invoke `onClick()` (so the parent drawer can
 *      toggle itself). */
export function init(opts?: {
  mount?: HTMLElement;
  isExpanded?: () => boolean;
  onClick?: () => void;
}) {
  if (rootEl) return;
  rootEl = document.createElement('div');
  rootEl.className = 'ambient-widget';
  if (opts?.mount) rootEl.classList.add('ambient-in-drawer');
  isExpandedRef = opts?.isExpanded || null;
  onClickRef = opts?.onClick || null;
  rootEl.addEventListener('click', () => {
    // Expanded (drawer-open) state: clicking the forecast opens the
    // platform weather page in a new tab. Closing the drawer is the
    // X button's job; the widget click opens the forecast for deeper
    // reading. Google search "weather" is the
    // most-portable universal weather page (it auto-detects location,
    // works in every locale, no Apple/Microsoft account lock-in).
    if (isExpanded()) {
      window.open('https://www.google.com/search?q=weather', '_blank', 'noopener');
      return;
    }
    // Compact (rail) state: click toggles the parent drawer — opening
    // it reveals the full forecast widget.
    if (onClickRef) {
      onClickRef();
    } else {
      localExpanded = !localExpanded;
      try { localStorage.setItem(AMBIENT_PREF_KEY, localExpanded ? '1' : '0'); } catch {}
    }
    void render();
  });
  (opts?.mount || document.body).appendChild(rootEl);
  void render();
  tickTimer = setInterval(render, 60_000);
  // In-drawer mode reads `isExpanded()` from the parent drawer's
  // body class (e.g. `pin-drawer-open`). When the user toggles the
  // drawer the body class flips immediately but the widget's render
  // doesn't refire until the next 1-minute tick — leaving the
  // compact (48px rail) layout visible inside the now-expanded
  // 360px drawer column. Watch the body's class attribute and
  // re-render on every change so the widget swaps to its expanded
  // 3-day-forecast layout the moment the drawer opens (and back to
  // compact the moment it closes). Cheap: the observer fires only
  // on class mutations, not every attribute change.
  if (opts?.mount && typeof MutationObserver !== 'undefined') {
    const bodyObserver = new MutationObserver(() => { void render(); });
    bodyObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] });
  }
}

/** Re-render on demand — used by the parent drawer when its open/close
 *  state changes so the widget can switch between compact + expanded
 *  layouts without waiting for the 1-minute tick. */
export function repaint(): void {
  void render();
}

async function render() {
  if (!rootEl) return;
  const exp = isExpanded();
  rootEl.classList.toggle('expanded', exp);
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const w = await loadWeather();
  if (!rootEl) return;  // disposed during fetch
  rootEl.innerHTML = exp
    ? renderExpanded(hh, mm, now, w)
    : renderCompact(hh, mm, now, w);
}

function renderCompact(hh, mm, now, w) {
  const code = w?.current?.weather_code;
  const [icon] = code != null ? (WMO[code] || ['', '']) : ['', ''];
  const temp = w?.current?.temperature_2m;
  const tempStr = temp != null ? `${Math.round(temp)}°` : '';
  const weatherHtml = icon || tempStr
    ? `<span class="ambient-weather">${icon}<span class="ambient-temp">${escapeHtml(tempStr)}</span></span>`
    : '';
  const tz = tzAbbrev(now);
  const tzHtml = tz ? `<span class="ambient-tz">${escapeHtml(tz)}</span>` : '';
  return `<span class="ambient-time">${hh}:${mm}</span>${tzHtml}${weatherHtml}`;
}

function renderExpanded(hh, mm, dateObj, w) {
  const dateStr = dateObj.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  const daily = w?.daily;

  // Forecast strip: today's column gets the EXPANDED treatment (live
  // "now" temperature + condition word + hi/lo); future-day columns
  // stay compact (weekday, icon, hi, lo). The all-compact layout
  // (5 uniform cols) was readable but hid the "now" temperature in
  // the rail-form pill only — once the user opened the drawer to see
  // the full HUD, the most-frequently-glanced piece (current temp)
  // disappeared.
  //
  // Mismatch caveat: the daily.temperature_2m_max for today is the
  // *forecasted* high; current.temperature_2m is the live observation.
  // They can disagree by a degree mid-afternoon. We render both so
  // the user can see "now is 13° but today peaks at 18°" — that's
  // useful, not confusing.
  let forecastHtml = '';
  if (daily?.time?.length > 0) {
    const cols = [];
    const todayLocal = new Date();
    const todayKey = todayLocal.toISOString().slice(0, 10);
    const currentTemp = w?.current?.temperature_2m;
    const currentCode = w?.current?.weather_code;
    const [, currentDesc] = currentCode != null ? (WMO[currentCode] || ['', '']) : ['', ''];
    for (let i = 0; i < Math.min(daily.time.length, 5); i++) {
      const dayKey = daily.time[i];
      const d = new Date(dayKey + 'T00:00');
      const isToday = dayKey === todayKey;
      const [fi] = WMO[daily.weather_code?.[i]] || ['❔', ''];
      const fhi = daily.temperature_2m_max?.[i] != null
        ? Math.round(daily.temperature_2m_max[i]) : '—';
      const flo = daily.temperature_2m_min?.[i] != null
        ? Math.round(daily.temperature_2m_min[i]) : '—';
      if (isToday) {
        // Expanded today column: big NOW temp + icon + condition word
        // + hi/lo pair. The hi/lo are the daily forecast aggregate
        // (same as other columns) so the visual structure stays
        // comparable across the strip.
        const nowStr = currentTemp != null ? `${Math.round(currentTemp)}°` : '—';
        cols.push(`
          <div class="amb-forecast-col is-today">
            <span class="amb-fc-day">NOW</span>
            <span class="amb-fc-now">${escapeHtml(nowStr)}</span>
            <span class="amb-fc-icon">${fi}</span>
            ${currentDesc ? `<span class="amb-fc-desc">${escapeHtml(currentDesc)}</span>` : ''}
            <span class="amb-fc-hilo">${fhi}° / ${flo}°</span>
          </div>`);
      } else {
        const wd = d.toLocaleDateString(undefined, { weekday: 'short' });
        cols.push(`
          <div class="amb-forecast-col">
            <span class="amb-fc-day">${escapeHtml(wd)}</span>
            <span class="amb-fc-icon">${fi}</span>
            <span class="amb-fc-hi">${fhi}°</span>
            <span class="amb-fc-lo">${flo}°</span>
          </div>`);
      }
    }
    forecastHtml = `<div class="amb-forecast">${cols.join('')}</div>`;
  }

  return `
    <div class="amb-clock">${hh}:${mm}</div>
    <div class="amb-date">${escapeHtml(dateStr)}</div>
    ${forecastHtml}
  `;
}

export function dispose() {
  if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
  if (rootEl) { rootEl.remove(); rootEl = null; }
}
