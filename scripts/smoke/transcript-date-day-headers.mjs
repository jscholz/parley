// Transcript timestamp: every bubble carries its date.
//
// Since 2026-11-04 the stamp shown in the message footer is RELATIVE
// ("8 minutes ago", "yesterday", "15 Oct" — Claude's layout); the HH:MM
// and short-date spans stay in the DOM, stamped by src/transcript/
// reconciler.ts's reconcile walk (setTimestampDateVisible(el, true)), for
// day logic and for this guard. The chat straddles THREE calendar days:
//   - every message carries HH:MM (.line-ts-time) and .line-ts.has-date
//     with a non-empty date in the DOM
//   - every message SHOWS a non-empty relative stamp (.line-ts-rel), and
//     a message from another day shows a day word or a date, not a bare
//     clock time

import { waitForReady, openSidebar, clickRow, assert, dumpLines } from './lib.mjs';

export const NAME = 'transcript-date-day-headers';
export const DESCRIPTION =
  'every bubble carries its date: HH:MM + short date in the DOM, a relative stamp shown that names the day for older messages';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_ID = 'mock-chat-date-headers';

// Three calendar days. Anchor each at local-noon so timezone offsets can't
// nudge a message across a midnight boundary and change the count.
function noonNDaysAgo(n) {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() - n);
  return d.getTime() / 1000; // mock seeds in unix-seconds (hermes shape)
}

export function MOCK_SETUP(mock) {
  const day2 = noonNDaysAgo(2); // oldest day — 2 msgs
  const day1 = noonNDaysAgo(1); // middle day — 2 msgs
  const day0 = noonNDaysAgo(0); // today     — 2 msgs
  mock.addChat(CHAT_ID, {
    title: 'Date headers',
    messages: [
      { role: 'user', content: 'first day, first message', parley_id: 'u_d2_1', timestamp: day2 },
      { role: 'assistant', content: 'first day reply', parley_id: 'a_d2_1', timestamp: day2 + 60 },
      { role: 'user', content: 'second day, first message', parley_id: 'u_d1_1', timestamp: day1 },
      { role: 'assistant', content: 'second day reply', parley_id: 'a_d1_1', timestamp: day1 + 60 },
      { role: 'user', content: 'today, first message', parley_id: 'u_d0_1', timestamp: day0 },
      { role: 'assistant', content: 'today reply — the most recent message', parley_id: 'a_d0_1', timestamp: day0 + 60 },
    ],
    lastActiveAt: Date.now(),
  });
}

export default async function run({ page, log }) {
  await waitForReady(page);
  await openSidebar(page);
  await clickRow(page, CHAT_ID);

  // Wait for the full history batch to land.
  await page.waitForFunction(
    () => /the most recent message/.test(document.getElementById('transcript')?.textContent || ''),
    null,
    { timeout: 8_000, polling: 80 },
  );
  log('chat opened — history replay complete');

  const probe = await page.evaluate(() => {
    const t = document.getElementById('transcript');
    const lines = Array.from(t.querySelectorAll('.line')).filter(
      (el) => el.querySelector('.line-ts'),
    );
    return lines.map((el) => {
      const ts = el.querySelector('.line-ts');
      const time = ts.querySelector('.line-ts-time');
      const date = ts.querySelector('.line-ts-date');
      const rel = ts.querySelector('.line-ts-rel');
      const relVisible = rel ? getComputedStyle(rel).display !== 'none' && parseFloat(getComputedStyle(rel).opacity) > 0 : false;
      return {
        text: (el.querySelector('.text')?.textContent || '').slice(0, 40),
        hasDateClass: ts.classList.contains('has-date'),
        timeText: (time?.textContent || '').trim(),
        dateText: (date?.textContent || '').trim(),
        relText: (rel?.textContent || '').trim(),
        relVisible,
        stamp: Number(ts.dataset.ts) || 0,
      };
    });
  });

  for (const p of probe) {
    log(`row time=${JSON.stringify(p.timeText)} hasDate=${p.hasDateClass} date=${JSON.stringify(p.dateText)} shown=${JSON.stringify(p.relText)} :: ${JSON.stringify(p.text)}`);
  }

  // Every dated row must show a time.
  for (const p of probe) {
    assert(/^\d{2}:\d{2}$/.test(p.timeText), `expected HH:MM time, got ${JSON.stringify(p.timeText)} on ${JSON.stringify(p.text)}`);
  }

  // Date on EVERY bubble: all 6 dated rows carry .has-date with a visible,
  // non-empty date sub-line.
  assert(
    probe.length === 6,
    `expected 6 dated rows, got ${probe.length}. rows=${JSON.stringify(probe, null, 2)}`,
  );
  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
  for (const p of probe) {
    assert(p.hasDateClass, `every bubble should carry .has-date: ${JSON.stringify(p)}`);
    assert(p.dateText.length > 0, `date text empty: ${JSON.stringify(p)}`);
    assert(p.relVisible && p.relText.length > 0, `every bubble should show its relative stamp: ${JSON.stringify(p)}`);
    if (p.stamp && p.stamp < todayStart.getTime()) {
      assert(!/^\d{2}:\d{2}$/.test(p.relText) && !/ago$/.test(p.relText) || /days ago$/.test(p.relText),
        `a message from another day must name the day, got ${JSON.stringify(p.relText)}: ${JSON.stringify(p)}`);
    }
  }

  // (The old in-bubble geometry guard went with the corner stamp: the
  // footer smoke pins the row's placement below the bubble.)

  // Screenshot for manual layout review.
  try {
    const dump = await dumpLines(page, 10);
    log(`-- DOM lines --\n${dump}`);
    await page.screenshot({ path: '/tmp/transcript-date-headers.png', fullPage: false });
    log('screenshot → /tmp/transcript-date-headers.png');
  } catch (e) {
    log(`screenshot skipped: ${e.message}`);
  }

  log('OK: every bubble carries its date; older messages name the day in the stamp');
}
