/**
 * @fileoverview Render-loop guard (2026-10-13: the laptop app hung —
 * "Aw, Snap! RESULT_CODE_HUNG" — on a click in a long chat, and nothing
 * could say why). Counts renders per chat in a sliding second. Past the
 * threshold it (1) reports once, with the stack of the offending render,
 * to /api/parley/diag/client, and (2) tells the caller to stop rendering
 * synchronously so a store→render→store cycle becomes once-per-frame
 * instead of a hung renderer. Pure bookkeeping; the caller does the
 * deferral.
 */
import { apiUrl } from '../apiBase.ts';

export const LOOP_RENDERS_PER_SEC = 100;
const WINDOW_MS = 1000;

const hits = new Map<string, number[]>();
const reported = new Set<string>();

/** Record a render of `chatId`. Returns true when the caller should NOT
 *  render synchronously (a loop is in progress). */
export function noteRender(chatId: string, now: number = Date.now()): boolean {
  const arr = hits.get(chatId) ?? [];
  arr.push(now);
  while (arr.length && now - arr[0] > WINDOW_MS) arr.shift();
  hits.set(chatId, arr);
  if (arr.length <= LOOP_RENDERS_PER_SEC) return false;
  if (!reported.has(chatId)) {
    reported.add(chatId);
    report(chatId, arr.length);
  }
  return true;
}

export function _resetForTests(): void { hits.clear(); reported.clear(); }

function report(chatId: string, count: number): void {
  try {
    const stack = (new Error('render loop')).stack || '';
    const body = JSON.stringify({
      kind: 'render-loop', chatId, count, windowMs: WINDOW_MS, stack,
      detail: 'transcript re-rendered the same chat more than ' + LOOP_RENDERS_PER_SEC + ' times in 1s',
      ua: typeof navigator !== 'undefined' ? navigator.userAgent.slice(0, 160) : '',
      visibility: typeof document !== 'undefined' ? document.visibilityState : '',
      clientTs: new Date().toISOString(),
    });
    if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
      navigator.sendBeacon(apiUrl('/api/parley/diag/client'), new Blob([body], { type: 'application/json' }));
    } else {
      void fetch(apiUrl('/api/parley/diag/client'), { method: 'POST', keepalive: true, headers: { 'content-type': 'application/json' }, body }).catch(() => {});
    }
    console.error('[render-loop-guard]', chatId, count, stack);
  } catch { /* diagnostics must never throw */ }
}
