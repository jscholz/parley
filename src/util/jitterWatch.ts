/**
 * @fileoverview Transcript jitter watch: notices when what the user is
 * READING moves on its own, back and forth, and reports it once.
 *
 * Field 2026-10-30 (laptop, desktop PWA): "the transcript viewer is
 * wiggling … jumping up and down a few pixels at 3 or 4 hertz. And when I
 * scroll, it jumps on me again." Headless probes of the same chats (every
 * width, Retina scale, sidebar and panels open or closed, overlay
 * scrollbars, pointer parked over every row, mid-chat and live edge, a
 * running turn) held perfectly still. So the trigger lives in something
 * only his machine has, and this watch exists to capture it there.
 *
 * Mechanism (cheap, always on while the page is visible):
 *   - Every 100 ms, read the top of ONE anchor row (the first row under the
 *     transcript's top edge). 10 Hz resolves a 3–4 Hz wobble.
 *   - Any wheel / touch / key / pointer input re-picks the anchor and
 *     starts a grace window, so the user's own scrolling never counts.
 *   - Movement outside the grace window is "uncommanded". Several
 *     uncommanded moves with direction reversals in a few seconds = jitter.
 *   - On jitter: capture ~1 s of geometry at 30 fps (header, every
 *     .chat-column child, composer, transcript scroll box, every visible
 *     row's height) plus layout context, keep it on
 *     window.__parleyJitterReports, write it to the debug relay
 *     (/api/debug/logs, under a `jitter-…` session id) and diag() it.
 *     Once per page load — a report, not a stream.
 *
 * Pure detection lives in detectJitter() so the rule is unit-testable.
 */
import { diag } from './log.ts';

export interface Sample { t: number; top: number; commanded: boolean }

export const SAMPLE_MS = 100;
export const GRACE_MS = 600;
export const WINDOW_MS = 3000;
/** Moves smaller than this are sub-pixel layout noise, not a wiggle. */
export const MIN_MOVE_PX = 0.75;
export const MIN_REVERSALS = 3;
export const MIN_MOVES = 5;

/** Jitter = within WINDOW_MS, at least MIN_MOVES uncommanded moves of at
 *  least MIN_MOVE_PX, changing direction at least MIN_REVERSALS times. A
 *  one-off settle (history prepend, image decode) moves once and stops; a
 *  user scroll is commanded; only a wobble reverses repeatedly. */
export function detectJitter(samples: readonly Sample[], now: number): { jitter: boolean; moves: number; reversals: number; amplitude: number } {
  let moves = 0; let reversals = 0; let lastSign = 0; let lo = Infinity; let hi = -Infinity;
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1]; const b = samples[i];
    if (now - b.t > WINDOW_MS) continue;
    if (b.commanded || a.commanded) { lastSign = 0; continue; }
    const d = b.top - a.top;
    if (Math.abs(d) < MIN_MOVE_PX) continue;
    moves++;
    lo = Math.min(lo, a.top, b.top); hi = Math.max(hi, a.top, b.top);
    const sign = d > 0 ? 1 : -1;
    if (lastSign !== 0 && sign !== lastSign) reversals++;
    lastSign = sign;
  }
  const amplitude = Number.isFinite(hi - lo) ? Math.round((hi - lo) * 100) / 100 : 0;
  return { jitter: moves >= MIN_MOVES && reversals >= MIN_REVERSALS, moves, reversals, amplitude };
}

const r1 = (n: number) => Math.round(n * 10) / 10;

function boxOf(el: Element | null): string {
  if (!el) return '-';
  const r = el.getBoundingClientRect();
  return `${r1(r.top)}+${r1(r.height)}x${r1(r.width)}`;
}

function describe(el: Element): string {
  const id = el.id ? `#${el.id}` : '';
  const cls = typeof el.className === 'string' && el.className ? `.${el.className.trim().split(/\s+/).slice(0, 3).join('.')}` : '';
  return `${el.tagName.toLowerCase()}${id}${cls}`;
}

/** One frame of everything that can move the reading position. */
function frame(tr: HTMLElement): Record<string, unknown> {
  const out: Record<string, unknown> = {
    st: r1(tr.scrollTop), sh: tr.scrollHeight, ch: tr.clientHeight, cw: tr.clientWidth,
    header: boxOf(document.querySelector('.header')),
    composer: boxOf(document.querySelector('.composer')),
  };
  const col = tr.closest('.chat-column');
  if (col) for (const c of Array.from(col.children)) if (c !== tr) out[describe(c)] = boxOf(c);
  const top = tr.getBoundingClientRect().top; const bottom = top + tr.clientHeight;
  const rows: string[] = [];
  for (const l of Array.from(tr.querySelectorAll<HTMLElement>('.line'))) {
    const r = l.getBoundingClientRect();
    if (r.bottom < top || r.top > bottom) continue;
    rows.push(`${(l.getAttribute('data-key') || describe(l)).slice(-14)}:${r1(r.top)}+${r1(r.height)}`);
  }
  out.rows = rows;
  return out;
}

function context(tr: HTMLElement): Record<string, unknown> {
  const ls: Record<string, string> = {};
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i) || '';
      if (/width|sidebar|drawer|panel|theme|gutter|size|dev_mode|parley_debug/i.test(k)) ls[k] = String(localStorage.getItem(k)).slice(0, 120);
    }
  } catch { /* storage blocked */ }
  return {
    ua: navigator.userAgent, vw: innerWidth, vh: innerHeight, dpr: devicePixelRatio,
    zoom: (window as any).visualViewport?.scale ?? 1,
    standalone: matchMedia('(display-mode: standalone)').matches,
    hover: matchMedia('(hover: hover)').matches,
    bodyClass: document.body.className.slice(0, 300),
    chat: location.hash.slice(0, 80),
    overflowAnchor: getComputedStyle(tr).getPropertyValue('overflow-anchor'),
    scrollBehavior: getComputedStyle(tr).getPropertyValue('scroll-behavior'),
    scrollbarW: tr.offsetWidth - tr.clientWidth,
    localStorage: ls,
  };
}

let installed = false;

export function installJitterWatch(): void {
  if (installed || typeof window === 'undefined' || typeof document === 'undefined') return;
  installed = true;
  const reports: unknown[] = [];
  (window as any).__parleyJitterReports = reports;
  let reported = false;
  let lastInput = -Infinity;
  let anchor: HTMLElement | null = null;
  let samples: Sample[] = [];

  const onInput = () => { lastInput = performance.now(); anchor = null; };
  for (const ev of ['wheel', 'touchstart', 'touchmove', 'keydown', 'pointerdown']) {
    document.addEventListener(ev, onInput, { capture: true, passive: true });
  }

  const pickAnchor = (tr: HTMLElement): HTMLElement | null => {
    const top = tr.getBoundingClientRect().top;
    for (const l of Array.from(tr.querySelectorAll<HTMLElement>('.line'))) {
      if (l.getBoundingClientRect().bottom > top + 4) return l;
    }
    return null;
  };

  const capture = (tr: HTMLElement, verdict: ReturnType<typeof detectJitter>) => {
    reported = true;
    const frames: Record<string, unknown>[] = [];
    const t0 = performance.now();
    // Timer-driven, not rAF: animation frames stop for hidden tabs and
    // can stall in a headless page; 30 fps resolves a 3–4 Hz wobble.
    const tick = () => {
      try { frames.push({ t: Math.round(performance.now() - t0), ...frame(tr) }); } catch { /* keep what we have */ }
      if (performance.now() - t0 < 1000 && frames.length < 40) { setTimeout(tick, 33); return; }
      let report: Record<string, unknown>;
      try { report = { at: new Date().toISOString(), verdict, samples: samples.slice(-30), context: context(tr), frames }; }
      catch (e) { report = { at: new Date().toISOString(), verdict, samples: samples.slice(-30), frames, contextError: String(e) }; }
      reports.push(report);
      diag(`[jitter] transcript wobbled ${verdict.reversals} reversals, ${verdict.amplitude}px — report captured (window.__parleyJitterReports)`);
      try {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const sid = `jitter-${stamp}-${Math.random().toString(36).slice(2, 8)}`;
        const body = JSON.stringify({ sid, lines: [JSON.stringify(report, null, 1) + '\n'] });
        void fetch('/api/debug/logs', { method: 'POST', headers: { 'content-type': 'application/json' }, body, keepalive: body.length < 60_000 });
      } catch { /* best effort */ }
    };
    setTimeout(tick, 0);
  };

  setInterval(() => {
    if (reported || document.hidden) return;
    const tr = document.getElementById('transcript');
    if (!tr || !tr.isConnected || tr.clientHeight === 0) return;
    const now = performance.now();
    if (!anchor || !anchor.isConnected || !tr.contains(anchor)) { anchor = pickAnchor(tr); samples = []; if (!anchor) return; }
    samples.push({ t: now, top: anchor.getBoundingClientRect().top, commanded: now - lastInput < GRACE_MS });
    if (samples.length > 40) samples.shift();
    const verdict = detectJitter(samples, now);
    if (verdict.jitter) capture(tr, verdict);
  }, SAMPLE_MS);
}
