// Session-switch feedback ordering (field 2026-08-02, laptop PWA +
// CAP): switching BACK to a huge session took seconds before the drawer
// row highlight appeared — and it appeared in the SAME frame as the
// transcript paint. Root cause: the row click handler flips `.active`
// synchronously, but then calls resume() synchronously, and resume()'s
// switch-back fast path (#242) replays the ENTIRE in-memory transcript
// synchronously in that same task — project() + reconcile() of every
// durable row. For a huge chat that blocks the main thread for seconds,
// so the browser never gets a frame between the class flip and the
// transcript swap: the highlight lands visually only when the heavy
// render finishes. On CAP the same block ate the tap's visual ack →
// the habitual double-tap.
//
// Contract under test: the click's optimistic feedback (row highlight)
// must reach the SCREEN before the heavy transcript replay runs. We
// register a rAF before dispatching the click; in the first painted
// frame after the click the row must be `.active` AND the transcript
// must still show the OLD chat (the swap comes later). The click
// dispatch itself must return fast (no multi-hundred-ms synchronous
// work inside the handler).
//
// The huge chat is 200 messages of fat markdown (headings, tables,
// fenced code) so the mem replay is measurably heavy; the smoke logs
// the measured render cost so regressions show up in the numbers.

import { waitForReady, openSidebar, clickRow, assert } from './lib.mjs';

export const NAME = 'huge-session-switch-instant-highlight';
export const DESCRIPTION = 'switch-back to a huge session paints the row highlight before the heavy transcript replay';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const HUGE = 'mock-huge-switch';
const SMALL = 'mock-huge-switch-sibling';
const N_MSGS = 200;

function fatMarkdown(idx) {
  // ~2.5KB of markdown per bubble: heading + table + fenced code +
  // list. Enough structure that project+reconcile of 200 rows costs
  // real main-thread time in headless chromium.
  return [
    `## Deck section ${idx}`,
    '',
    '| metric | Q1 | Q2 | Q3 | Q4 |',
    '|---|---|---|---|---|',
    `| revenue ${idx} | 1.2 | 3.4 | 5.6 | 7.8 |`,
    `| burn ${idx} | 0.4 | 0.5 | 0.6 | 0.7 |`,
    `| runway ${idx} | 18 | 17 | 16 | 15 |`,
    '',
    '```python',
    `def projection_${idx}(base, growth):`,
    '    series = [base]',
    '    for quarter in range(12):',
    '        series.append(series[-1] * (1 + growth))',
    '    return series',
    '',
    `print(projection_${idx}(100, 0.14))`,
    '```',
    '',
    `- takeaway ${idx}.1: growth compounding beats linear hiring`,
    `- takeaway ${idx}.2: gross margin expands after platform migration`,
    `- takeaway ${idx}.3: **bold claim ${idx}** needs a citation`,
    '',
    `Closing paragraph for section ${idx}: the pitch narrative connects the`,
    'wedge to the platform, and the platform to the moat. Repeat until the',
    'partner meeting nods along and the term sheet materializes.',
  ].join('\n');
}

export function MOCK_SETUP(mock) {
  const messages = [];
  for (let i = 0; i < N_MSGS; i++) {
    const idx = i + 1;
    const role = i % 2 === 0 ? 'user' : 'assistant';
    messages.push({
      role,
      content: role === 'user'
        ? `Question ${idx}: how does slide ${idx} land?`
        : fatMarkdown(idx),
      parley_id: `huge-msg-${idx}`,
      message_id: `huge-msg-${idx}`,
      timestamp: Date.now() / 1000 - (N_MSGS - idx) * 60,
    });
  }
  // Last row is a user message with a unique marker (loop ends on even
  // count → last idx is even → assistant; append one more user marker).
  messages.push({
    role: 'user',
    content: 'HUGE-TAIL-MARKER final question',
    parley_id: 'huge-msg-tail',
    message_id: 'huge-msg-tail',
    timestamp: Date.now() / 1000 - 30,
  });
  mock.addChat(HUGE, {
    title: 'Pitch deck (huge)',
    source: 'parley',
    messages,
    lastActiveAt: Date.now() - 60_000,
  });
  mock.addChat(SMALL, {
    title: 'Small sibling',
    source: 'parley',
    messages: [
      { role: 'user', content: 'SMALL-MARKER hello', message_id: 'small-1',
        parley_id: 'small-1', timestamp: Date.now() / 1000 - 40 },
    ],
    lastActiveAt: Date.now() - 30_000,
  });
}

export default async function run({ page, log }) {
  await waitForReady(page);
  await openSidebar(page);

  // 1. Open the huge chat — populates transcriptStore (in-memory) so the
  //    switch-back below takes the #242 mem fast path. Measure the first
  //    open's render latency as a rough render-cost yardstick.
  const t0 = Date.now();
  await clickRow(page, HUGE);
  await page.waitForFunction(
    () => /HUGE-TAIL-MARKER/.test(document.getElementById('transcript')?.textContent || ''),
    null, { timeout: 15_000, polling: 50 });
  log(`huge chat first open rendered in ~${Date.now() - t0}ms (${N_MSGS + 1} fat rows)`);
  await page.waitForTimeout(400); // let snapshot persist + store settle

  // 2. Switch to the small sibling.
  await clickRow(page, SMALL);
  await page.waitForFunction(
    () => /SMALL-MARKER/.test(document.getElementById('transcript')?.textContent || ''),
    null, { timeout: 5_000, polling: 50 });
  log('switched to small sibling');
  await page.waitForTimeout(300);

  // 3. Instrument + switch BACK to the huge chat in a single evaluate so
  //    the timing isn't skewed by protocol round trips. The rAF is
  //    registered BEFORE the click dispatch: it fires at the first frame
  //    the browser paints after the click. In that frame the row must
  //    already be highlighted and the transcript must still be the OLD
  //    chat — proof the feedback painted before the heavy replay.
  const res = await page.evaluate((hugeId) => new Promise((resolve, reject) => {
    const li = document.querySelector(`#sessions-list li[data-chat-id="${hugeId}"]`);
    const body = li?.querySelector('.sess-body');
    if (!li || !body) { reject(new Error('huge row not found in drawer')); return; }
    const transcriptEl = document.getElementById('transcript');
    const swapped = () => /HUGE-TAIL-MARKER/.test(transcriptEl?.textContent || '');
    const start = performance.now();
    const out = {};
    requestAnimationFrame(() => {
      out.framePaintAt = Math.round(performance.now() - start);
      out.activeAtFrame = li.classList.contains('active');
      out.transcriptSwappedAtFrame = swapped();
      const poll = () => {
        if (swapped()) {
          out.swapAt = Math.round(performance.now() - start);
          resolve(out);
        } else if (performance.now() - start > 20_000) {
          reject(new Error('huge transcript never swapped in'));
        } else {
          setTimeout(poll, 25);
        }
      };
      poll();
    });
    body.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    out.clickReturnMs = Math.round(performance.now() - start);
  }), HUGE);

  log(`click dispatch returned in ${res.clickReturnMs}ms; first frame at ` +
      `${res.framePaintAt}ms (active=${res.activeAtFrame}, ` +
      `transcriptSwapped=${res.transcriptSwappedAtFrame}); transcript swap at ${res.swapAt}ms`);

  assert(res.activeAtFrame === true,
    'BUG: the huge row is not `.active` in the first painted frame after the click — ' +
    'optimistic highlight must be applied synchronously in the click handler.');
  assert(res.clickReturnMs < 250,
    `BUG: the click handler blocked for ${res.clickReturnMs}ms — the heavy transcript ` +
    'replay is running SYNCHRONOUSLY inside the click task, so nothing (highlight, ' +
    'spinner, touch ack) can paint until it finishes.');
  assert(res.framePaintAt < 400,
    `BUG: first frame after the click painted at +${res.framePaintAt}ms — the click ` +
    'task must yield to the compositor before the heavy mem replay runs.');
  assert(res.transcriptSwappedAtFrame === false,
    'BUG: the transcript had ALREADY swapped to the huge chat in the first painted ' +
    'frame — highlight and transcript landed in the same frame, i.e. the user got ' +
    'zero feedback for the whole load. The highlight frame must precede the replay.');
  log('row highlight painted before the heavy transcript replay ✓');
}
