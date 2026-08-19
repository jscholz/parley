// Shared helpers for parley PWA perf measurement scripts.
//
// Distinct from scripts/smoke/: smoke verifies behavior (binary pass/fail),
// perf measures latency (numbers). Each scenario captures one or more
// timing samples across N iterations and reports p50/p95/min/max.
//
// Reuses scripts/smoke/lib.mjs for browser launch + UI helpers so the
// page driving is identical to the smoke harness.

import { performance } from 'node:perf_hooks';

export function median(arr) { return percentile(arr, 50); }

// Linear-interpolated percentile over a numeric array. Returns NaN for [].
export function percentile(arr, p) {
  if (!arr.length) return NaN;
  const sorted = [...arr].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0];
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

// Run `fn` N times, collecting whatever object it returns. fn is given
// the iteration index (0..N-1). Bails on the first throw so we don't
// report medians over partial data.
export async function runN(N, fn, { onIter } = {}) {
  const samples = [];
  for (let i = 0; i < N; i++) {
    const t0 = performance.now();
    const sample = await fn(i);
    const dt = performance.now() - t0;
    if (onIter) onIter(i, sample, dt);
    samples.push(sample);
  }
  return samples;
}

// Format a number of ms as a column-friendly string. Negative or NaN → '—'.
export function fmtMs(n) {
  if (n == null || !Number.isFinite(n) || n < 0) return '   —';
  if (n < 10) return `${n.toFixed(1)}ms`;
  if (n < 10_000) return `${Math.round(n)}ms`;
  return `${(n / 1000).toFixed(1)}s`;
}

// Print a perf summary table to stdout.
//   rows: [{ label, samples: { metric: [ms,...] } }, ...]
// Each scenario can expose multiple metrics (e.g. send→first-bubble +
// send→reply-final). Columns: metric | p50 | p95 | min | max | N.
export function printTable(rows) {
  const lines = [];
  const colHeaders = ['metric', 'p50', 'p95', 'min', 'max', 'N'];
  const widths = colHeaders.map((h) => h.length);
  const allRows = [];
  for (const r of rows) {
    for (const [metric, values] of Object.entries(r.samples)) {
      if (!values.length) continue;
      const row = [
        `${r.label} · ${metric}`,
        fmtMs(percentile(values, 50)),
        fmtMs(percentile(values, 95)),
        fmtMs(Math.min(...values)),
        fmtMs(Math.max(...values)),
        String(values.length),
      ];
      row.forEach((v, i) => { widths[i] = Math.max(widths[i], v.length); });
      allRows.push(row);
    }
  }
  const pad = (s, w, align = 'left') =>
    align === 'right' ? s.padStart(w) : s.padEnd(w);
  const sep = '─'.repeat(widths.reduce((a, b) => a + b + 3, -1));
  lines.push(colHeaders.map((h, i) => pad(h, widths[i], i === 0 ? 'left' : 'right')).join(' │ '));
  lines.push(sep);
  for (const r of allRows) {
    lines.push(r.map((v, i) => pad(v, widths[i], i === 0 ? 'left' : 'right')).join(' │ '));
  }
  console.log(lines.join('\n'));
}

// Tap HTTP traffic to/from the page. Returns { entries, stop } —
// entries is a live array of { url, method, status, durationMs,
// requestStart, responseEnd } objects, filtered by `match` (regex or
// predicate). Useful for capturing /items, /messages, SSE timings.
export function tapHttp(page, match) {
  const pred = match instanceof RegExp
    ? (req) => match.test(req.url())
    : (typeof match === 'function' ? match : () => true);
  const entries = [];
  const inflight = new Map(); // request → { url, method, requestStart }
  const onReq = (req) => {
    if (!pred(req)) return;
    inflight.set(req, {
      url: req.url(),
      method: req.method(),
      requestStart: performance.now(),
    });
  };
  const onRes = (res) => {
    const req = res.request();
    const meta = inflight.get(req);
    if (!meta) return;
    inflight.delete(req);
    const now = performance.now();
    entries.push({
      ...meta,
      status: res.status(),
      responseEnd: now,
      durationMs: now - meta.requestStart,
    });
  };
  page.on('request', onReq);
  page.on('response', onRes);
  const stop = () => {
    page.off('request', onReq);
    page.off('response', onRes);
  };
  return { entries, stop };
}

// Wait for a DOM condition by polling page.evaluate(), recording the
// elapsed wall-clock ms when it first becomes true. Throws on timeout.
// `args` is forwarded to page.evaluate so closure-captured values from
// node (chat ids, markers) reach the browser context.
export async function waitMs(page, predEvalFn, { timeoutMs = 60_000, pollMs = 50, label = 'predicate', args = undefined } = {}) {
  const start = performance.now();
  const deadline = start + timeoutMs;
  while (performance.now() < deadline) {
    let ok = false;
    try {
      ok = args !== undefined
        ? await page.evaluate(predEvalFn, args)
        : await page.evaluate(predEvalFn);
    } catch (e) {
      // "Execution context was destroyed" fires when the page navigates
      // mid-poll (SW takeover, hash redirect, history.replaceState).
      // Treat as "not yet" and retry on the new context.
      const msg = e && e.message ? e.message : '';
      if (!/Execution context was destroyed|context.*destroyed/i.test(msg)) {
        throw e;
      }
    }
    if (ok) return performance.now() - start;
    await page.waitForTimeout(pollMs);
  }
  throw new Error(`waitMs(${label}): not satisfied within ${timeoutMs}ms`);
}

// Best-effort: delete a chat via the proxy API. Mirrors smoke/lib's
// deleteChat but doesn't require a `page` (uses fetch from node).
export async function deleteChatByApi(baseUrl, chatId) {
  try {
    await fetch(`${baseUrl}/api/parley/sessions/${encodeURIComponent(chatId)}`, {
      method: 'DELETE',
    });
  } catch { /* ignore */ }
}
