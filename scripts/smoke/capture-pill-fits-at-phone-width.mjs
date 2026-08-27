// The capture pill must contain its own controls — every phase, phone
// width, long recordings included.
//
// His report 2026-08-27, from ending a real meeting: "this stop button
// was misaligned with the bubble that it sat in" — the Stop button was
// hanging outside the pill's right edge at 1:22:15 / Uploading.
//
// Why it happened, and why an assertion is the right guard: nothing in
// that row can shrink. Chip, timer and the four >=44px B1 hit targets
// are all flex:none by deliberate decision, and on phones the flexible
// title is hidden. So the row has a fixed width budget, and anything
// that widens the content pushes the LAST child — Stop, the primary
// action — straight out of the container. Measured at 390px with an
// hour-plus timer (7 glyphs, not 5): recording -9px, paused -6px,
// UPLOADING +26px, RECONNECTING +47px. Two of four phases were broken
// and only one had been noticed.
//
// The budget is invisible in code review and invisible in any test that
// asserts text or classes, which is why the existing
// capture-pill-state-labels smoke passed throughout. This asserts
// GEOMETRY: no child's right edge may exceed the pill's, in any phase.
//
// Boundary-adversarial (the #223 rule — stage past the window, not up to
// it): the timer is driven to 1:22:15 to match the field report AND to
// 10:00:00, which is one glyph wider than any case the layout was ever
// designed against. If a future change buys headroom by assuming a
// 5-glyph timer, the 10-hour case is what fails.
import { waitForReady, assert } from './lib.mjs';

export const NAME = 'capture-pill-fits-at-phone-width';
export const DESCRIPTION = 'capture pill contains its controls in every phase at phone width, incl. hour-plus timers';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';
export const MOBILE = true;

const PHASES = ['starting', 'recording', 'paused', 'interrupted', 'finishing', 'failed'];
// 1:22:15 is his field case; 10:00:00 is one glyph wider than anything
// the layout was designed for.
const DURATIONS = [
  { label: '1:22:15', ms: 4_935_000 },
  { label: '10:00:00', ms: 36_000_000 },
];

async function measure(page, phase, elapsedMs) {
  return page.evaluate(({ ph, ms }) => {
    window.dispatchEvent(new CustomEvent('parley:capture-state', {
      detail: {
        active: ph !== 'finishing' && ph !== 'starting' && ph !== 'failed',
        captureId: 'cap_fits_test',
        title: 'Board sync with finance and ops',
        chatId: 'c1',
        startedAt: Date.now() - ms,
        phase: ph,
        uploaderPending: ph === 'finishing' ? 2 : 0,
        sealedSegments: 3, marks: 1,
        stalledTotalMs: 0, stalledSince: null,
        failedReason: 'The server stopped receiving audio and ended this recording.',
      },
    }));
    const pill = document.getElementById('capture-pill');
    if (!pill || pill.hidden) return { hidden: true };
    const pr = pill.getBoundingClientRect();
    const kids = [...pill.children].filter(el =>
      !el.hidden && getComputedStyle(el).display !== 'none');
    const rows = kids.map(el => {
      const r = el.getBoundingClientRect();
      return {
        id: el.id || el.className,
        w: Math.round(r.width),
        overRight: Math.round(r.right - pr.right),
        overLeft: Math.round(pr.left - r.left),
        offscreen: r.right > window.innerWidth + 0.5,
      };
    });
    return {
      hidden: false,
      timer: document.getElementById('capture-pill-timer')?.textContent || '',
      // scrollWidth > clientWidth is the container's own overflow report —
      // independent of the per-child arithmetic, so a rounding quirk in
      // one can't mask the other.
      scrollOverflow: pill.scrollWidth - pill.clientWidth,
      worstRight: Math.max(...rows.map(r => r.overRight)),
      worstLeft: Math.max(...rows.map(r => r.overLeft)),
      offscreen: rows.filter(r => r.offscreen).map(r => r.id),
      visibleIds: rows.map(r => r.id),
      rows,
    };
  }, { ph: phase, ms: elapsedMs });
}

export default async function run({ page, log }) {
  await waitForReady(page);
  const vw = await page.evaluate(() => window.innerWidth);
  assert(vw <= 699, `fixture must run at phone width for the max-width:699px rules to apply, got ${vw}`);

  for (const { label, ms } of DURATIONS) {
    for (const phase of PHASES) {
      const m = await measure(page, phase, ms);
      assert(!m.hidden, `pill should be visible in phase ${phase}`);
      // 'failed' hides the timer on purpose — the reason is the message.
      assert(m.timer.length > 0 || phase === 'starting' || phase === 'failed',
        `phase ${phase} should render a timer`);
      assert(m.worstRight <= 0,
        `[${label}/${phase}] a control escapes the pill's right edge by ${m.worstRight}px `
        + `(${JSON.stringify(m.rows.filter(r => r.overRight > 0))})`);
      assert(m.worstLeft <= 0,
        `[${label}/${phase}] a control escapes the pill's left edge by ${m.worstLeft}px`);
      assert(m.scrollOverflow <= 0,
        `[${label}/${phase}] pill content overflows its box by ${m.scrollOverflow}px`);
      assert(m.offscreen.length === 0,
        `[${label}/${phase}] control(s) rendered off-screen: ${m.offscreen.join(', ')}`);
      log(`${label} ${phase}: ${m.visibleIds.length} controls, all inside (worst ${m.worstRight}px) ✓`);
    }
  }

  // The controls that remain must be the ones that can ACT. Hiding dead
  // buttons is what bought the space back, so assert the intent, not just
  // the geometry — otherwise a future "fix" could satisfy the overflow
  // assertions by hiding a LIVE control (e.g. Stop while recording).
  const live = await measure(page, 'recording', 4_935_000);
  for (const id of ['capture-pill-flag', 'capture-pill-pause', 'capture-pill-more', 'capture-pill-stop']) {
    assert(live.visibleIds.includes(id), `recording must keep ${id} — it is a live control`);
  }
  const up = await measure(page, 'finishing', 4_935_000);
  for (const id of ['capture-pill-flag', 'capture-pill-pause', 'capture-pill-stop']) {
    assert(!up.visibleIds.includes(id),
      `${id} is a no-op while uploading (its handler early-returns on !active) — it should not render`);
  }
  assert(up.visibleIds.includes('capture-pill-more'),
    'uploading keeps the ··· sheet — rename/discard still act there');
  const intr = await measure(page, 'interrupted', 4_935_000);
  assert(!intr.visibleIds.includes('capture-pill-pause'),
    'pause is a no-op while interrupted (pauseMeetingCapture requires phase === recording)');
  assert(intr.visibleIds.includes('capture-pill-stop')
    && intr.visibleIds.includes('capture-pill-flag'),
    'interrupted keeps stop AND flag — both still act (state.active is true)');
  log('per-phase controls match what can actually act ✓');
}
