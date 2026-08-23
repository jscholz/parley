// Backfill correctness under interaction (companion to
// huge-session-switch-no-long-task): while the time-sliced backfill of
// a huge transcript is running, the user can scroll up hard or switch
// away — none of that may produce a blank transcript, a visible anchor
// jump, cross-session bleed, or an incomplete final transcript.
//
// Four probes:
//   A. Switch into the huge chat and immediately wheel-scroll up while
//      batches land: sampled every ~50ms, the transcript must never be
//      empty and must never contain the sibling chat's marker.
//   B. After the wheel stops mid-history, the first-visible bubble
//      (key + viewport offset) must hold steady while the remaining
//      batches prepend above it (chat.prependHistory anchor contract).
//   C. Switching AWAY mid-backfill must cancel cleanly: the sibling's
//      transcript renders, and no orphan batch ever paints huge-chat
//      rows into it afterwards.
//   D. Switching back again must complete the full transcript
//      (row count == minted count).
//
// 180 messages < the 200-row first page → single page, hasMore=false,
// so row-count assertions are exact and lazy-load pagination can't
// inject extra fetches.

import { waitForReady, openSidebar, clickRow, assert } from './lib.mjs';

export const NAME = 'huge-session-backfill-correctness';
export const DESCRIPTION = 'scrolling / switching away mid-backfill: no blank, no jump, no bleed, complete transcript';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const HUGE = 'mock-backfill-huge';
const SMALL = 'mock-backfill-sibling';
const N_MSGS = 180;

function fatMarkdown(idx) {
  return [
    `## Deck section ${idx}`,
    '',
    '| metric | Q1 | Q2 | Q3 | Q4 |',
    '|---|---|---|---|---|',
    `| revenue ${idx} | 1.2 | 3.4 | 5.6 | 7.8 |`,
    '',
    '```python',
    `def projection_${idx}(base, growth):`,
    '    return [base * (1 + growth) ** q for q in range(12)]',
    '```',
    '',
    `- takeaway ${idx}.1: growth compounding beats linear hiring`,
    `- takeaway ${idx}.2: **bold claim ${idx}** needs a citation`,
    '',
    `Closing paragraph for section ${idx}: the pitch narrative connects`,
    'the wedge to the platform, and the platform to the moat.',
  ].join('\n');
}

export function MOCK_SETUP(mock) {
  const messages = [];
  for (let i = 0; i < N_MSGS - 1; i++) {
    const idx = i + 1;
    const role = i % 2 === 0 ? 'user' : 'assistant';
    messages.push({
      role,
      content: role === 'user'
        ? `Question ${idx}: how does slide ${idx} land?`
        : fatMarkdown(idx),
      parley_id: `bfc-msg-${idx}`,
      message_id: `bfc-msg-${idx}`,
      timestamp: Date.now() / 1000 - (N_MSGS - idx) * 60,
    });
  }
  messages.push({
    role: 'user',
    content: 'BFC-TAIL-MARKER final question',
    parley_id: 'bfc-msg-tail',
    message_id: 'bfc-msg-tail',
    timestamp: Date.now() / 1000 - 30,
  });
  mock.addChat(HUGE, {
    title: 'Pitch deck (backfill correctness)',
    source: 'parley',
    messages,
    lastActiveAt: Date.now() - 60_000,
  });
  mock.addChat(SMALL, {
    title: 'Small sibling',
    source: 'parley',
    messages: [
      { role: 'user', content: 'BFC-SMALL-MARKER hello', message_id: 'bfc-small-1',
        parley_id: 'bfc-small-1', timestamp: Date.now() / 1000 - 40 },
    ],
    lastActiveAt: Date.now() - 30_000,
  });
}

async function waitComplete(page, n, timeout = 20_000) {
  await page.waitForFunction(
    (want) => document.querySelectorAll('#transcript [data-key]').length >= want,
    n, { timeout, polling: 100 });
}

export default async function run({ page, log }) {
  await waitForReady(page);
  await openSidebar(page);

  // Prime: open huge fully, then park on the sibling.
  await clickRow(page, HUGE);
  await waitComplete(page, N_MSGS);
  await page.waitForTimeout(400);
  await clickRow(page, SMALL);
  await page.waitForFunction(
    () => /BFC-SMALL-MARKER/.test(document.getElementById('transcript')?.textContent || ''),
    null, { timeout: 5_000, polling: 50 });
  await page.waitForTimeout(300);

  // ── Probe A: switch back + wheel up immediately, sampling for blank /
  //    bleed the whole way.
  await page.evaluate(() => {
    const w = /** @type {any} */ (window);
    w.__bfBlank = 0;
    w.__bfBleed = 0;
    w.__bfSamples = 0;
    w.__bfTimer = setInterval(() => {
      const el = document.getElementById('transcript');
      if (!el) return;
      w.__bfSamples++;
      const text = el.textContent || '';
      if (text.trim() === '') w.__bfBlank++;
      if (/BFC-SMALL-MARKER/.test(text)) w.__bfBleed++;
    }, 50);
  });
  await clickRow(page, HUGE);
  // Wheel up hard while batches land. The transcript element sits under
  // the viewport center; wheel events target the element under the mouse.
  const box = await page.locator('#transcript').boundingBox();
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  for (let i = 0; i < 8; i++) {
    await page.mouse.wheel(0, -900);
    await page.waitForTimeout(60);
  }
  log('scrolled up hard during backfill');

  // ── Probe B: anchor stability. Record the first-visible bubble now
  //    (mid-history, wheel stopped), then let backfill finish and compare.
  const anchorBefore = await page.evaluate(() => {
    const el = document.getElementById('transcript');
    const ct = el.getBoundingClientRect().top;
    for (const line of el.querySelectorAll('.line[data-key]')) {
      const r = line.getBoundingClientRect();
      if (r.bottom > ct + 1) {
        return { key: line.getAttribute('data-key'), offset: Math.round(r.top - ct) };
      }
    }
    return null;
  });
  assert(anchorBefore && anchorBefore.key, 'no first-visible bubble found mid-backfill');
  await waitComplete(page, N_MSGS);
  await page.waitForTimeout(500); // settle window: placeholders → real heights
  const anchorAfter = await page.evaluate((key) => {
    const el = document.getElementById('transcript');
    const ct = el.getBoundingClientRect().top;
    const line = el.querySelector(`.line[data-key="${CSS.escape(key)}"]`);
    if (!line) return null;
    return { offset: Math.round(line.getBoundingClientRect().top - ct) };
  }, anchorBefore.key);
  const sampleA = await page.evaluate(() => {
    const w = /** @type {any} */ (window);
    clearInterval(w.__bfTimer);
    return { blank: w.__bfBlank, bleed: w.__bfBleed, samples: w.__bfSamples };
  });
  log(`probe A: ${sampleA.samples} samples, blank=${sampleA.blank}, bleed=${sampleA.bleed}`);
  assert(sampleA.samples > 5, 'sampler barely ran — timing assumptions broken');
  assert(sampleA.blank === 0,
    'BUG: transcript went BLANK during backfill (sampled empty textContent)');
  assert(sampleA.bleed === 0,
    'BUG: sibling-chat content bled into the huge chat during backfill');
  assert(anchorAfter != null,
    `BUG: mid-history anchor bubble ${anchorBefore.key} vanished during backfill`);
  const drift = Math.abs(anchorAfter.offset - anchorBefore.offset);
  log(`probe B: anchor ${anchorBefore.key} offset ${anchorBefore.offset}px → ${anchorAfter.offset}px (drift ${drift}px)`);
  assert(drift <= 40,
    `BUG: backfill prepends moved the reading position by ${drift}px ` +
    '(anchor must hold within a few px through prepends)');

  // ── Probe C: switch away mid-backfill must cancel cleanly.
  await clickRow(page, SMALL);   // park on sibling
  await page.waitForFunction(
    () => /BFC-SMALL-MARKER/.test(document.getElementById('transcript')?.textContent || ''),
    null, { timeout: 5_000, polling: 50 });
  await page.waitForTimeout(300);
  await clickRow(page, HUGE);    // start a fresh windowed replay + backfill
  await page.waitForTimeout(120); // let the initial window land, backfill mid-flight
  await clickRow(page, SMALL);   // bail mid-backfill
  await page.waitForFunction(
    () => /BFC-SMALL-MARKER/.test(document.getElementById('transcript')?.textContent || ''),
    null, { timeout: 5_000, polling: 50 });
  // Give any orphan batch time to (incorrectly) fire, then assert purity.
  await page.waitForTimeout(1_200);
  const afterBail = await page.evaluate(() => ({
    rows: document.querySelectorAll('#transcript [data-key]').length,
    hasHuge: /BFC-TAIL-MARKER|Deck section/.test(document.getElementById('transcript')?.textContent || ''),
    hasSmall: /BFC-SMALL-MARKER/.test(document.getElementById('transcript')?.textContent || ''),
  }));
  log(`probe C: after mid-backfill bail — rows=${afterBail.rows} hasHuge=${afterBail.hasHuge} hasSmall=${afterBail.hasSmall}`);
  assert(afterBail.hasSmall, 'sibling transcript missing after mid-backfill switch-away');
  assert(!afterBail.hasHuge,
    'BUG: an orphan backfill batch painted huge-chat rows into the sibling transcript');
  assert(afterBail.rows <= 3,
    `BUG: sibling transcript has ${afterBail.rows} keyed rows — huge-chat rows leaked through`);

  // ── Probe D: switch back once more; the interrupted backfill must not
  //    leave the transcript permanently partial.
  await clickRow(page, HUGE);
  await waitComplete(page, N_MSGS);
  const finalRows = await page.evaluate(() =>
    document.querySelectorAll('#transcript [data-key]').length);
  log(`probe D: final transcript complete (${finalRows} rows)`);
  assert(finalRows >= N_MSGS, `final transcript incomplete: ${finalRows}/${N_MSGS}`);
  log('backfill correctness under scroll + switch-away ✓');
}
