/**
 * @fileoverview Composer latency instrument (field 2026-11-17: "subtle
 * cursor lag as I move around a long dictated message"; reported several
 * times, never reproduced in Chromium — the sandbox types a 4.7k-char
 * draft over 400 rows at one frame per key once warm).
 *
 * Measures what the user feels, on the user's own browser: for every key
 * the composer receives, the time from the keydown to the frame after the
 * browser has processed it (two rAFs — the first can run before the
 * pending work, the second is the frame that painted). Works in Safari,
 * which has no Event Timing or long-task observers. Also measures the
 * synchronous handler chain for `input` (our listeners + any layout they
 * force), so a slow key can be split into "our code" vs "the browser's
 * editing/painting".
 *
 * Reports every 25 keys as one diag line, with the draft length and the
 * textarea's spellcheck state — the two variables the Safari hypothesis
 * (continuous spell/grammar checking of one huge paragraph) turns on.
 * Dev mode only (log.ts diag); the listeners themselves cost nothing
 * measurable.
 */
import { diag } from './util/log.ts';

const REPORT_EVERY = 25;

function pct(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

export function installComposerLatencyDiag(el: HTMLTextAreaElement): void {
  if (typeof window === 'undefined' || !el) return;
  let keyToFrame: number[] = [];
  let inputSync: number[] = [];
  let caretKeys = 0;
  let pendingT0 = 0;
  let pendingKey = '';

  // keydown (capture, first in line) → two frames later = painted.
  el.addEventListener('keydown', (e) => {
    pendingT0 = performance.now();
    pendingKey = e.key;
    if (e.key.startsWith('Arrow') || e.key === 'Home' || e.key === 'End') caretKeys++;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (!pendingT0) return;
      keyToFrame.push(performance.now() - pendingT0);
      pendingT0 = 0;
      if (keyToFrame.length >= REPORT_EVERY) report();
    }));
  }, { capture: true, passive: true });

  // input: capture-phase listener on the window runs before every other
  // listener; a bubble-phase one on the window runs after them all.
  let inputT0 = 0;
  window.addEventListener('input', (e) => { if (e.target === el) inputT0 = performance.now(); }, { capture: true, passive: true });
  window.addEventListener('input', (e) => {
    if (e.target !== el || !inputT0) return;
    inputSync.push(performance.now() - inputT0);
    inputT0 = 0;
  }, { passive: true });

  // Test hook (smoke composer-input-latency-probe): the same numbers the
  // dev-mode line reports, without waiting for 25 keys.
  (window as any).__composerLatency = {
    snapshot() {
      const k = keyToFrame.slice().sort((a, b) => a - b);
      const i = inputSync.slice().sort((a, b) => a - b);
      return { keys: k.length, p50: pct(k, 0.5), p90: pct(k, 0.9), max: pct(k, 1), inputP50: pct(i, 0.5), inputMax: pct(i, 1) };
    },
    reset() { keyToFrame = []; inputSync = []; caretKeys = 0; },
  };

  function report(): void {
    const k = keyToFrame.slice().sort((a, b) => a - b);
    const i = inputSync.slice().sort((a, b) => a - b);
    diag(`[composer-latency] keys=${k.length} (caret moves ${caretKeys}) key→paint p50 ${pct(k, 0.5).toFixed(0)} ms p90 ${pct(k, 0.9).toFixed(0)} ms max ${pct(k, 1).toFixed(0)} ms; input handlers p50 ${pct(i, 0.5).toFixed(1)} ms max ${pct(i, 1).toFixed(1)} ms; draft ${el.value.length} chars, ${el.value.split('\n').length} lines; spellcheck=${el.spellcheck} height=${el.style.height || 'auto'} lastKey=${pendingKey}`);
    keyToFrame = []; inputSync = []; caretKeys = 0;
  }
}
