// Transcript timestamp date sub-line (date on every bubble).
//
// Each message's timestamp shows HH:MM with the short DATE sub-line below
// it on EVERY bubble — set by src/transcript/reconciler.ts's reconcile walk
// via setTimestampDateVisible(el, true). This smoke seeds a chat whose
// messages straddle THREE calendar days and asserts:
//   - every message shows a time (.line-ts-time)
//   - every message carries .line-ts.has-date with a non-empty date
// Also drops a screenshot for manual layout review (date should sit below
// the time without crowding the action buttons / message text).

import { waitForReady, openSidebar, clickRow, assert, dumpLines } from './lib.mjs';

export const NAME = 'transcript-date-day-headers';
export const DESCRIPTION =
  'short date sub-line shows under the time on every bubble';
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
      { role: 'user', content: 'first day, first message', sidekick_id: 'u_d2_1', timestamp: day2 },
      { role: 'assistant', content: 'first day reply', sidekick_id: 'a_d2_1', timestamp: day2 + 60 },
      { role: 'user', content: 'second day, first message', sidekick_id: 'u_d1_1', timestamp: day1 },
      { role: 'assistant', content: 'second day reply', sidekick_id: 'a_d1_1', timestamp: day1 + 60 },
      { role: 'user', content: 'today, first message', sidekick_id: 'u_d0_1', timestamp: day0 },
      { role: 'assistant', content: 'today reply — the most recent message', sidekick_id: 'a_d0_1', timestamp: day0 + 60 },
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
      const dateVisible = date ? getComputedStyle(date).display !== 'none' : false;
      return {
        text: (el.querySelector('.text')?.textContent || '').slice(0, 40),
        hasDateClass: ts.classList.contains('has-date'),
        timeText: (time?.textContent || '').trim(),
        dateText: (date?.textContent || '').trim(),
        dateVisible,
      };
    });
  });

  for (const p of probe) {
    log(`row time=${JSON.stringify(p.timeText)} hasDate=${p.hasDateClass} dateVisible=${p.dateVisible} date=${JSON.stringify(p.dateText)} :: ${JSON.stringify(p.text)}`);
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
  for (const p of probe) {
    assert(p.hasDateClass, `every bubble should carry .has-date: ${JSON.stringify(p)}`);
    assert(p.dateVisible, `every bubble should render its date (display!=none): ${JSON.stringify(p)}`);
    assert(p.dateText.length > 0, `date text empty: ${JSON.stringify(p)}`);
  }

  // Geometry guard: the date sub-line must not overflow its bubble's
  // bottom edge (= crowding the text/buttons) on a SHORT user bubble,
  // which is the tightest case (single text line, timestamp stacked below
  // the copy icon). Measure the first user (.line.s0) day-header row.
  const geom = await page.evaluate(() => {
    const t = document.getElementById('transcript');
    const row = Array.from(t.querySelectorAll('.line.s0')).find(
      (el) => el.querySelector('.line-ts.has-date'),
    );
    if (!row) return null;
    const date = row.querySelector('.line-ts-date');
    const rb = row.getBoundingClientRect();
    const db = date.getBoundingClientRect();
    const textEl = row.querySelector('.text');
    const tb = textEl.getBoundingClientRect();
    return {
      rowBottom: Math.round(rb.bottom),
      rowRight: Math.round(rb.right),
      dateBottom: Math.round(db.bottom),
      dateTop: Math.round(db.top),
      textBottom: Math.round(tb.bottom),
      // overflow past bubble bottom (px); <=0 means it fits inside.
      overflowPx: Math.round(db.bottom - rb.bottom),
      // does the date sub-line start below the message text? (stacked, not
      // overlapping the text vertically)
      clearsTextPx: Math.round(db.top - tb.bottom),
    };
  });
  if (geom) {
    log(`user-bubble geom: ${JSON.stringify(geom)}`);
    assert(
      geom.overflowPx <= 2,
      `date sub-line overflows the user bubble's bottom by ${geom.overflowPx}px — crowding. ` +
      `Tighten line-height / font-size or reserve more bottom padding.`,
    );
  }

  // Screenshot for manual layout review.
  try {
    const dump = await dumpLines(page, 10);
    log(`-- DOM lines --\n${dump}`);
    await page.screenshot({ path: '/tmp/transcript-date-headers.png', fullPage: false });
    log('screenshot → /tmp/transcript-date-headers.png');
  } catch (e) {
    log(`screenshot skipped: ${e.message}`);
  }

  log('OK: every bubble shows its short date below the time');
}
