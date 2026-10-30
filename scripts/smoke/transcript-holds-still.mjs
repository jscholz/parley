// FIELD GUARD, Jonathan 2026-10-30 (laptop, desktop PWA):
//
//   "the transcript viewer is wiggling … jumping up and down a few pixels
//    at 3 or 4 hertz. And when I scroll, it jumps on me again."
//
// What the reader is looking at must not move unless he moves it. This
// smoke holds a long chat at rest in every layout the transcript lives in
// and samples the reading position EVERY FRAME (not a before/after pair —
// a wobble returns to where it started, so endpoints prove nothing):
//
//   S1  live edge, sidebar closed
//   S2  sidebar open
//   S3  Docs panel open beside it
//   S4  an agent turn running (the pulsing turn-status row at the bottom)
//   S5  mid-chat after a wheel scroll up, at rest
//
// Then the field instrument itself (util/jitterWatch.ts), which runs on
// his laptop to catch the wobble where it happens:
//
//   W1  it stayed silent through all of the above (no false alarm)
//   W2  a staged 3–4 Hz wobble IS caught, and the report reaches the
//       server's debug relay with per-frame geometry and layout context

import { waitForReady, openSidebar, clickRow, assert } from './lib.mjs';

export const NAME = 'transcript-holds-still';
export const DESCRIPTION = 'Reading position never moves on its own (live edge, sidebar, docs panel, running turn, mid-chat); the jitter watch stays silent at rest and reports a real wobble';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT = 'parley:holds-still';

function seedMessages() {
  const now = Date.now() / 1000;
  const out = [];
  for (let i = 0; i < 70; i++) {
    const long = i % 5 === 0
      ? `Paragraph ${i}: ${'the raise materials need a tighter narrative and cleaner numbers. '.repeat(6)}\n\n- point one for ${i}\n- point two with **bold** and \`code\`\n- point three`
      : i % 3 === 0 ? `Short note ${i}.` : `Message ${i}: ${'a few sentences of ordinary chat to wrap across lines. '.repeat(2 + (i % 4))}`;
    out.push({ role: i % 2 ? 'assistant' : 'user', content: long, parley_id: `${i % 2 ? 'msg' : 'umsg'}_hs${i}`, timestamp: now - (70 - i) * 60 });
  }
  return out;
}

/** Per-frame reading position for `ms`: the first row under the
 *  transcript's top edge, its top, and the scroll box. */
async function sampleStill(page, ms = 2000) {
  return page.evaluate(async (ms) => {
    const tr = document.getElementById('transcript');
    const top = tr.getBoundingClientRect().top;
    let anchor = null;
    for (const l of tr.querySelectorAll('.line')) { if (l.getBoundingClientRect().bottom > top + 4) { anchor = l; break; } }
    if (!anchor) return { error: 'no anchor row' };
    const tops = []; const t0 = performance.now();
    await new Promise((done) => {
      const tick = () => {
        tops.push(Math.round(anchor.getBoundingClientRect().top * 100) / 100);
        if (performance.now() - t0 < ms) requestAnimationFrame(tick); else done();
      };
      requestAnimationFrame(tick);
    });
    let moves = 0; for (let i = 1; i < tops.length; i++) if (Math.abs(tops[i] - tops[i - 1]) >= 0.5) moves++;
    return { frames: tops.length, moves, min: Math.min(...tops), max: Math.max(...tops), key: anchor.getAttribute('data-key') };
  }, ms);
}

export default async function run({ page, log, mock }) {
  mock.addChat(CHAT, { title: 'Holds still', messages: seedMessages(), lastActiveAt: Date.now() });
  const relayPosts = [];
  await page.route('**/api/debug/logs', async (route) => {
    try { relayPosts.push(JSON.parse(route.request().postData() || '{}')); } catch { /* ignore */ }
    await route.fulfill({ status: 204, body: '' });
  });

  await waitForReady(page);
  await openSidebar(page);
  await clickRow(page, CHAT);
  await page.waitForFunction(() => document.querySelectorAll('#transcript .line').length > 20, null, { timeout: 8_000 });
  await page.waitForTimeout(1_200);
  // Park the pointer over the transcript the way a reader's mouse sits.
  const box = await page.evaluate(() => { const r = document.getElementById('transcript').getBoundingClientRect(); return { x: r.left + r.width * 0.6, y: r.top + r.height * 0.5 }; });
  await page.mouse.move(box.x, box.y);

  const failures = [];
  const check = async (label) => {
    const s = await sampleStill(page);
    log(`${label}: ${s.frames} frames, anchor moved ${s.moves}× (${s.min}…${s.max}px)`);
    if (s.error) failures.push(`${label}: ${s.error}`);
    else if (s.moves > 0) failures.push(`${label}: the reading position moved ${s.moves} times at rest (${s.min}…${s.max}px) — "jumping up and down a few pixels"`);
  };

  // S1/S2 — the sidebar is open after clickRow on desktop; close it for S1.
  await page.evaluate(() => document.getElementById('sb-toggle')?.click());
  await page.waitForTimeout(700);
  await page.mouse.move(box.x, box.y);
  await check('S1 live edge, sidebar closed');
  await openSidebar(page);
  await page.waitForTimeout(700);
  await page.mouse.move(box.x, box.y);
  await check('S2 sidebar open');

  // S3 — Docs panel beside the transcript.
  mock.pushEnvelope({ type: 'doc_show', chat_id: CHAT, title: 'Raise deck notes', content: '# Notes\n\n' + 'Body line.\n\n'.repeat(30), format: 'markdown', path: '/w/raise-notes.md' });
  await page.waitForTimeout(1_200);
  await page.mouse.move(box.x, box.y);
  await check('S3 docs panel open');

  // S4 — an agent turn in flight: the turn-status row pulses at the bottom.
  mock.pushEnvelope({ type: 'turn_start', chat_id: CHAT, turn_id: 'turn_hs1', user_message_id: 'umsg_hs68' });
  await page.waitForTimeout(800);
  await check('S4 turn running');

  // S5 — mid-chat, at rest after the reader scrolls up.
  await page.mouse.move(box.x, box.y);
  await page.mouse.wheel(0, -1500);
  await page.waitForTimeout(900);
  await check('S5 mid-chat after a scroll');

  // W1 — no false alarm through all of that.
  const quiet = await page.evaluate(() => (window.__parleyJitterReports || []).length);
  log(`W1 jitter reports at rest: ${quiet}`);
  if (quiet !== 0) failures.push(`W1: the jitter watch fired ${quiet}× with nothing wobbling — it would cry wolf on his laptop`);

  // W2 — stage a real 3–4 Hz wobble (the page shifts 3px every 140 ms,
  // the shape he described) and require a report on the relay.
  await page.evaluate(() => {
    const main = document.querySelector('.main');
    let up = false;
    window.__wobble = setInterval(() => { up = !up; main.style.paddingTop = up ? '3px' : '0px'; }, 140);
  });
  const deadline = Date.now() + 6_000;
  // Other relay traffic shares the endpoint; wait for the jitter report.
  const isJitter = (p) => String(p.sid || '').startsWith('jitter-');
  while (Date.now() < deadline && !relayPosts.some(isJitter)) await page.waitForTimeout(200);
  await page.evaluate(() => { clearInterval(window.__wobble); document.querySelector('.main').style.paddingTop = ''; });
  const post = relayPosts.find(isJitter);
  if (!post) {
    failures.push('W2: a 3–4 Hz wobble went unreported — the field instrument is blind');
  } else {
    let report = null; try { report = JSON.parse(post.lines[0]); } catch { /* bad body */ }
    log(`W2 report: ${post.sid} — ${report?.verdict?.reversals} reversals, ${report?.verdict?.amplitude}px, ${report?.frames?.length} frames`);
    assert(report && report.verdict?.jitter === true, `W2: report verdict ${JSON.stringify(report?.verdict)}`);
    assert(Array.isArray(report.frames) && report.frames.length > 10 && Array.isArray(report.frames[0].rows), 'W2: report lacks per-frame geometry');
    assert(report.context && report.context.vw > 0 && 'localStorage' in report.context, 'W2: report lacks layout context');
  }

  if (failures.length) throw new Error(failures.join('\n'));
}
