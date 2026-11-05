// FIELD, Jonathan 2026-11-05: "expanding and collapsing the sidebar is
// slow and clunky — a property of heavy sessions." Measured: the slide
// was a width transition, so every one of its ~18 frames laid out and
// painted the page (Raise Materials: Layout 72 ms + Paint 53 ms per
// open). Decision: "make it flat, so it's smooth everywhere."
//
// This guard counts LAYOUTS per toggle over the devtools protocol — a
// count, not a timing, so it holds under full-suite load:
//   S1  opening the sidebar costs at most a few layouts (was ~18–20),
//       lands on the right geometry, and leaves no slide residue
//   S2  closing it likewise; the session list stays visible while the
//       panel is covered and is gone once it has landed
//   S3  the right (Docs/Pins) drawer, same budget both ways
//   S4  a heavy transcript (300 rows in the DOM) changes none of it

import { waitForReady, openSidebar, clickRow, assert } from './lib.mjs';

export const NAME = 'drawer-slide-flat';
export const DESCRIPTION = 'Drawer open/close is a flat slide: a handful of layouts per toggle (not one per frame), correct end geometry, no residue, independent of transcript size';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT = 'parley:slide-flat';
// A width transition laid out once per frame (18–20 per toggle); the flat
// slide pays the forced reads of the reveal + the glide's FLIP measure —
// a handful. The budget separates the two regimes; S4 pins that the count
// does not grow with the transcript.
const LAYOUT_BUDGET = 10;

export function MOCK_SETUP(mock) {
  const t0 = Date.now() / 1000 - 36_000;
  const messages = [];
  for (let i = 0; i < 300; i++) {
    messages.push({ role: i % 2 ? 'assistant' : 'user', content: `Row ${i}: ${'a reasonably long line of chat that wraps across the column. '.repeat(1 + (i % 4))}`, parley_id: `${i % 2 ? 'msg' : 'umsg'}_sf${i}`, timestamp: t0 + i * 60 });
  }
  mock.addChat(CHAT, { title: 'Slide flat', messages, lastActiveAt: Date.now() });
}

export default async function run({ page, log }) {
  await waitForReady(page);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  const layouts = async () => { const { metrics } = await cdp.send('Performance.getMetrics'); return metrics.find((m) => m.name === 'LayoutCount')?.value ?? 0; };

  const toggle = async (btn, label) => {
    await page.waitForTimeout(400);                 // let any prior work settle
    const before = await layouts();
    await page.evaluate((id) => document.getElementById(id)?.click(), btn);
    await page.waitForTimeout(500);                 // slide (180 ms) + glide (180 ms) + margin
    const n = (await layouts()) - before;
    const state = await page.evaluate(() => ({
      sbOpen: document.getElementById('sidebar')?.classList.contains('expanded'),
      sbClip: document.getElementById('sidebar')?.style.clipPath || '',
      pdOpen: !document.getElementById('pin-drawer')?.classList.contains('collapsed'),
      pdClip: document.getElementById('pin-drawer')?.style.clipPath || '',
      bodyPadL: parseFloat(getComputedStyle(document.body).paddingLeft), bodyPadR: parseFloat(getComputedStyle(document.body).paddingRight),
      sbW: document.getElementById('sidebar')?.getBoundingClientRect().width,
      listVisible: !!document.querySelector('#sessions-list') && getComputedStyle(document.querySelector('#sessions-list')).display !== 'none',
      glideResidue: Array.from(document.querySelectorAll('.header > *, .toolbar > *, .main > .chat-column')).some((el) => el.style.transform),
    }));
    log(`${label}: ${n} layouts ${JSON.stringify(state)}`);
    assert(n <= LAYOUT_BUDGET, `${label}: ${n} layouts during the toggle — the slide is animating layout again (budget ${LAYOUT_BUDGET})`);
    assert(!state.sbClip && !state.pdClip && !state.glideResidue, `${label}: slide residue left behind: ${JSON.stringify(state)}`);
    return { ...state, layouts: n };
  };

  // ── S1 / S2 — sidebar open, then close ──────────────────────────────
  const startOpen = await page.evaluate(() => document.getElementById('sidebar')?.classList.contains('expanded'));
  if (startOpen) await toggle('sb-toggle', 'pre: close');
  const o = await toggle('sb-toggle', 'S1 sidebar open');
  assert(o.sbOpen && o.sbW > 200 && o.bodyPadL >= 200, `S1: sidebar did not land open with the page shifted: ${JSON.stringify(o)}`);
  // Mid-close the list must still be there (the panel keeps its width
  // while covered); after landing it is gone with the rail.
  const midBefore = await layouts();
  await page.evaluate(() => document.getElementById('sb-toggle')?.click());
  await page.waitForTimeout(60);
  const mid = await page.evaluate(() => ({ list: getComputedStyle(document.querySelector('#sessions-list')).display !== 'none', w: document.getElementById('sidebar').getBoundingClientRect().width, clip: document.getElementById('sidebar').style.clipPath }));
  assert(mid.list && mid.w > 200 && /inset/.test(mid.clip), `S2: mid-close the panel should still be wide and clipping: ${JSON.stringify(mid)}`);
  await page.waitForTimeout(500);
  const c = await page.evaluate(() => ({ open: document.getElementById('sidebar').classList.contains('expanded'), w: document.getElementById('sidebar').getBoundingClientRect().width, list: getComputedStyle(document.querySelector('#sessions-list')).display !== 'none', clip: document.getElementById('sidebar').style.clipPath }));
  const nClose = (await layouts()) - midBefore;
  log(`S2 sidebar close: ${nClose} layouts, landed ${JSON.stringify(c)}`);
  assert(!c.open && c.w <= 60 && !c.list && !c.clip, `S2: sidebar did not land collapsed on the rail: ${JSON.stringify(c)}`);
  assert(nClose <= LAYOUT_BUDGET, `S2: ${nClose} layouts during close (budget ${LAYOUT_BUDGET})`);

  // ── S3 — the right drawer ───────────────────────────────────────────
  const pdWasOpen = await page.evaluate(() => !document.getElementById('pin-drawer')?.classList.contains('collapsed'));
  if (pdWasOpen) await toggle('btn-pin-drawer-rail', 'pre: close right');
  const r1 = await toggle('btn-pin-drawer-rail', 'S3 right drawer open');
  assert(r1.pdOpen && r1.bodyPadR >= 200, `S3: right drawer did not open with the page shifted: ${JSON.stringify(r1)}`);
  await toggle('btn-pin-drawer-rail', 'S3 right drawer close');

  // ── S4 — a heavy transcript changes nothing ─────────────────────────
  await openSidebar(page);
  await clickRow(page, CHAT);
  await page.waitForFunction(() => document.querySelectorAll('#transcript .line').length >= 100, null, { timeout: 8_000 });
  for (let i = 0; i < 6; i++) { await page.evaluate(() => { document.getElementById('transcript').scrollTop = 0; }); await page.waitForTimeout(300); }
  const rows = await page.evaluate(() => document.querySelectorAll('#transcript .line').length);
  const h1 = await toggle('sb-toggle', `S4 heavy (${rows} rows) sidebar close`);
  const h2 = await toggle('sb-toggle', `S4 heavy (${rows} rows) sidebar open`);
  assert(h2.layouts <= o.layouts + 3 && h1.layouts <= LAYOUT_BUDGET, `S4: the heavy transcript raised the toggle's layout count (${o.layouts} → ${h2.layouts})`);
  log('flat slide: a handful of layouts per toggle, regardless of the transcript ✓');
}
