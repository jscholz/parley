// Composer input latency regression (field 2026-11-17: "subtle cursor lag
// as I move around a long dictated message to edit it").
//
// What this pins, under 4x CPU throttle, in a 4.7k-char draft over a
// 400-row transcript, once the page is warm (the first ~20 s after a cold
// load are slow for every key under throttle — first-visit work — and
// told the first version of this probe a long, wrong story):
//   1. typing costs one frame per key (Event Timing keydown → next paint),
//      no worse than in a short draft;
//   2. a keystroke writes NOTHING to the transcript: no scrollTo, no
//      scrollTop, and the composer's height does not churn (autoResize
//      measures in an off-flow mirror and re-pins only on a real change);
//   3. caret moves leave the main thread idle (their paint latency is
//      unmeasurable in headless Chromium — see the note at the end).
// Chromium numbers; the Safari report is measured on the device by
// src/composerLatencyDiag.ts (dev mode, "[composer-latency]" lines).
import { waitForReady, assert, clickRow, openSidebar } from './lib.mjs';

export const NAME = 'composer-input-latency-probe';
export const DESCRIPTION = 'typing and caret moves in a long draft over a long transcript cost one frame per key and write nothing to the transcript';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT = 'parley:latency-probe';
const ROWS = 400;
const CPU_THROTTLE = 4;
const WARMUP_MS = 25_000;

export function MOCK_SETUP(mock) {
  const messages = [];
  for (let i = 0; i < ROWS; i++) {
    const role = i % 2 === 0 ? 'user' : 'assistant';
    messages.push({
      role,
      content: role === 'user'
        ? `question ${i}: what about the ${i}th thing?`
        : `### Point ${i}\n\nParagraph one about item ${i} with enough words to wrap across a couple of lines in the bubble.\n\n- bullet a\n- bullet b\n\n\`code_${i}()\``,
      parley_id: `lp-${i}`,
      timestamp: Date.now() / 1000 - (ROWS - i) * 30,
    });
  }
  mock.addChat(CHAT, { title: 'Latency probe', messages, lastActiveAt: Date.now() - 1000 });
}

const LONG = Array.from({ length: 40 }, (_, i) =>
  `Sentence ${i + 1} of a long dictated message that goes on about the raise, the investors, and what we should do next week.`).join(' ');

export default async function run({ page, log }) {
  await waitForReady(page);
  await openSidebar(page);
  await clickRow(page, CHAT);
  await page.waitForFunction(() => document.querySelectorAll('#transcript .line').length > 20, null, { timeout: 10_000 });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU_THROTTLE });

  // Event Timing reports only entries ≥16 ms: "n" below is the count of
  // SLOW keys out of the keys sent. Instrumented writes count what the
  // page did to the transcript / composer per phase.
  await page.evaluate(() => {
    window.__et = [];
    new PerformanceObserver((list) => { for (const e of list.getEntries()) window.__et.push({ name: e.name, dur: e.duration }); })
      .observe({ type: 'event', durationThreshold: 0, buffered: false });
    const t = document.getElementById('transcript');
    const el = document.getElementById('composer-input');
    window.__w = { scrollTo: 0, scrollTopSet: 0, heights: new Set() };
    const origScrollTo = t.scrollTo.bind(t);
    t.scrollTo = (...a) => { window.__w.scrollTo++; return origScrollTo(...a); };
    const d = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop');
    Object.defineProperty(t, 'scrollTop', { get() { return d.get.call(this); }, set(v) { window.__w.scrollTopSet++; d.set.call(this, v); } });
    new MutationObserver(() => { window.__w.heights.add(el.style.height); }).observe(el, { attributes: true, attributeFilter: ['style'] });
  });
  const setDraft = (text) => page.evaluate((t) => { const el = document.getElementById('composer-input'); el.focus(); el.value = t; el.dispatchEvent(new Event('input', { bubbles: true })); el.setSelectionRange(Math.floor(t.length / 2), Math.floor(t.length / 2)); }, text);
  const phase = async (label, act, keys) => {
    await page.evaluate(() => { window.__et = []; window.__w.scrollTo = 0; window.__w.scrollTopSet = 0; window.__w.heights.clear(); window.__composerLatency?.reset(); });
    await act();
    await page.waitForTimeout(400);
    const r = await page.evaluate(() => {
      const kd = window.__et.filter((e) => e.name === 'keydown').map((e) => e.dur).sort((a, b) => a - b);
      const f = window.__composerLatency?.snapshot() ?? { keys: 0, p50: 0, max: 0, inputP50: 0, inputMax: 0 };
      return { n: kd.length, p50: kd[Math.floor(kd.length / 2)] || 0, max: kd[kd.length - 1] || 0, f, w: { ...window.__w, heights: Array.from(window.__w.heights) } };
    });
    log(`${label}: event-timing slow keys ${r.n}/${keys} (p50 ${r.p50.toFixed(0)} max ${r.max.toFixed(0)} ms); rAF key→frame p50 ${r.f.p50.toFixed(0)} max ${r.f.max.toFixed(0)} ms over ${r.f.keys} keys, input handlers max ${r.f.inputMax.toFixed(1)} ms; transcript scrollTo ${r.w.scrollTo}, scrollTop sets ${r.w.scrollTopSet}, heights ${JSON.stringify(r.w.heights)}`);
    return r;
  };
  const type = (n) => async () => { for (let i = 0; i < n; i++) await page.keyboard.type('y'); };
  const arrows = (n) => async () => { for (let i = 0; i < n; i++) await page.keyboard.press('ArrowLeft'); };

  await setDraft(LONG);
  log(`draft ${LONG.length} chars over ${ROWS} rows, CPU x${CPU_THROTTLE}; warming up ${WARMUP_MS / 1000} s`);
  await page.waitForTimeout(WARMUP_MS);

  const longType = await phase('long draft, type x20', type(20), 20);
  const longArrows = await phase('long draft, ArrowLeft x20', arrows(20), 20);
  const spell = await page.evaluate(() => document.getElementById('composer-input').spellcheck);
  log(`spellcheck attribute with the long draft: ${spell} (auto-off past the length cap)`);
  await setDraft('short draft here');
  await page.waitForTimeout(1000);
  const shortType = await phase('short draft, type x20', type(20), 20);
  const spellShort = await page.evaluate(() => document.getElementById('composer-input').spellcheck);

  assert(spell === false && spellShort === true, `spellcheck must be off for a long draft and on for a short one (long=${spell}, short=${spellShort})`);
  assert(longType.n <= shortType.n + 4 && longType.max <= 48,
    `typing in a long draft must cost one frame per key like a short one: slow keys ${longType.n} vs ${shortType.n}, max ${longType.max.toFixed(0)} ms (budget 48)`);
  // Caret moves are logged, not budgeted: headless Chromium draws no caret
  // (the window is never focused), so a bare caret move paints nothing and
  // Event Timing's "next paint" is whatever unrelated frame comes next —
  // 264 ms here, 832 ms with the composer blurred. The main thread is
  // idle meanwhile (rAF key→frame ≤13 ms). Caret latency is measured on a
  // real browser by src/composerLatencyDiag.ts.
  log(`caret moves: main thread rAF key→frame max ${longArrows.f.max.toFixed(0)} ms (event-timing ${longArrows.max.toFixed(0)} ms is a headless artifact)`);
  assert(longType.w.scrollTo === 0 && longType.w.scrollTopSet === 0,
    `a keystroke must write nothing to the transcript (scrollTo ${longType.w.scrollTo}, scrollTop sets ${longType.w.scrollTopSet})`);
  assert(longType.w.heights.length === 0, `the composer height must not churn at the cap (${JSON.stringify(longType.w.heights)})`);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
}
