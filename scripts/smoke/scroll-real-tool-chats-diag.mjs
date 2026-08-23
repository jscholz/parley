// Regression guard: A→B→A round-trip with mid-history scroll on real
// chats containing tool calls / images loses scroll position. The mocked
// smoke `scroll-mid-history-survives-switch.mjs` couldn't catch it
// because the mocked transcript fully renders on first load. The real
// path:
//
//   1. user wheel-scrolls long chat A to mid-history → saveScrollPosition(A, N, atBottom=false)
//   2. switches to B, switches back to A
//   3. cache-render path paints initial N messages → maxTop is PARTIAL
//      (e.g. 6958 for a chat that finally measures 12836)
//   4. pre-fix restore heuristic: "saved >= maxTop - 300" treats it as
//      at-edge → forceScrollToBottom + scheduleAtBottomRepin
//   5. tool rows + images render → maxTop grows → repin drags viewport
//      to the new bottom → drift ~5000px from the user's actual position
//
// Fix history:
//   - a2fe0d6: atBottom flag set at save time; restore branches on the
//     flag instead of a maxTop heuristic.
//   - virt-default + anchor-restore (2026-05-25): scroll-restore lands
//     on the SAME bubble at the SAME offset, not within a scrollTop
//     tolerance. The hardening pass below uses message-identity instead
//     of pixel drift — different bubbles ending up at viewport top IS
//     the user-visible bug, and a 300px scrollTop tolerance lets that
//     through silently.
//
// Read-only — no message sends. Uses two long real chats
// ([pitch deck] 335 msgs + 160 tools; [JOAM] 99 msgs). Install-only
// so it doesn't run in the default suite — but drift assertion gives
// it teeth when explicitly invoked.
//
// Run:
//   node scripts/run-smoke.mjs scroll-real-tool-chats-diag --real-backend

import { waitForReady, openSidebar, clickRow, assert } from './lib.mjs';

export const NAME = 'scroll-real-tool-chats-diag';
export const DESCRIPTION = 'Real backend A↔B↔A on Jonathan\'s tool-heavy chats — anchor message identity + ≤50px offset (regression guard for partial-render at-edge bug)';
export const STATUS = 'install-only';
export const BACKEND = 'real';
const OFFSET_TOLERANCE_PX = 50;

const CHAT_PITCH = 'parley:ae6435b5-53aa-4819-b594-d21652c89397';  // [pitch deck], 335 msgs, 160 tools
const CHAT_JOAM = 'parley:4a26d7f6-1902-42af-a348-649e9c5a0bc4';   // [JOAM], 99 msgs

async function snap(page) {
  return page.evaluate(() => {
    const t = document.getElementById('transcript');
    if (!t) return null;
    // First visible message bubble — used as a deterministic identity
    // for "this is where the viewport landed" comparisons (instead of
    // raw scrollTop, which differs across renders if maxTop drifts).
    // Walks `.line` descendants so it works under virt (bubbles live
    // inside .transcript-slot) and default (direct children).
    const lines = Array.from(t.querySelectorAll('.line'));
    const viewTop = t.getBoundingClientRect().top;
    let firstVisible = null;
    for (const el of lines) {
      const r = el.getBoundingClientRect();
      if (r.bottom > viewTop + 8) {
        firstVisible = {
          key: el.getAttribute('data-key'),
          text: (el.textContent || '').replace(/\s+/g, ' ').slice(0, 120),
          topRelToViewport: Math.round(r.top - viewTop),
        };
        break;
      }
    }
    return {
      scrollTop: Math.round(t.scrollTop),
      scrollHeight: t.scrollHeight,
      clientHeight: t.clientHeight,
      maxTop: t.scrollHeight - t.clientHeight,
      firstVisible,
    };
  });
}

async function wheelToFraction(page, fromTopFraction) {
  const box = await page.locator('#transcript').boundingBox();
  if (!box) throw new Error('transcript bounding box missing');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const before = await snap(page);
  const targetTop = Math.round(before.maxTop * fromTopFraction);
  const delta = before.scrollTop - targetTop;
  const stepPx = 500;
  const steps = Math.max(1, Math.ceil(Math.abs(delta) / stepPx));
  const sign = delta > 0 ? -1 : 1;
  for (let i = 0; i < steps; i++) {
    await page.mouse.wheel(0, sign * stepPx);
    await page.waitForTimeout(15);
  }
}

export default async function run({ page, log }) {
  const scrollLogs = [];
  page.on('console', (msg) => {
    const t = msg.text();
    if (t.includes('[chat-scroll]') || t.includes('[chat-resume]')) {
      scrollLogs.push(t);
    }
  });

  await waitForReady(page);
  await openSidebar(page);

  // Long settle on first paint — real chat with 335 msgs takes a beat
  // to render bubbles + tool rows + images.
  log('opening [pitch deck]…');
  await clickRow(page, CHAT_PITCH);
  await page.waitForTimeout(3000);

  let s = await snap(page);
  log(`pitch loaded: scrollTop=${s.scrollTop} maxTop=${s.maxTop} firstVisible=${JSON.stringify(s.firstVisible)}`);

  // Scroll to mid-history.
  await wheelToFraction(page, 0.5);
  await page.waitForTimeout(800);  // generous; let layout settle + IDB debounce
  const pitchMid = await snap(page);
  log(`pitch mid: scrollTop=${pitchMid.scrollTop} maxTop=${pitchMid.maxTop} firstVisible=${JSON.stringify(pitchMid.firstVisible)}`);

  // Switch to [JOAM].
  log('switching to [JOAM]…');
  await clickRow(page, CHAT_JOAM);
  await page.waitForTimeout(2500);
  const joamLoaded = await snap(page);
  log(`joam loaded: scrollTop=${joamLoaded.scrollTop} maxTop=${joamLoaded.maxTop}`);

  // Scroll JOAM around so saves fire for it too.
  await wheelToFraction(page, 0.4);
  await page.waitForTimeout(600);
  const joamMid = await snap(page);
  log(`joam mid: scrollTop=${joamMid.scrollTop} firstVisible=${JSON.stringify(joamMid.firstVisible)}`);

  // Switch back to [pitch deck].
  log('switching back to [pitch deck]…');
  await clickRow(page, CHAT_PITCH);
  // Long wait to let tool rows / images finish rendering. The
  // hypothesis is that a SECOND wave of layout shift fires AFTER the
  // initial restore, dragging the viewport off the saved position.
  await page.waitForTimeout(4000);
  const pitchRestored = await snap(page);
  log(`pitch restored: scrollTop=${pitchRestored.scrollTop} maxTop=${pitchRestored.maxTop} firstVisible=${JSON.stringify(pitchRestored.firstVisible)}`);

  // Diagnostic summary.
  log('');
  log('=== summary ===');
  log(`pitch saved scrollTop: ${pitchMid.scrollTop}`);
  log(`pitch restored scrollTop: ${pitchRestored.scrollTop}`);
  log(`drift (px): ${pitchRestored.scrollTop - pitchMid.scrollTop}`);
  log(`first-visible BEFORE: key=${pitchMid.firstVisible?.key} "${pitchMid.firstVisible?.text}"`);
  log(`first-visible AFTER:  key=${pitchRestored.firstVisible?.key} "${pitchRestored.firstVisible?.text}"`);
  log('');
  log('=== scroll-related log lines (browser console) ===');
  for (const line of scrollLogs) log('  ' + line);

  // Message-identity invariant: the SAME bubble must be at viewport top
  // before and after the round-trip. scrollTop alone is fragile under
  // virt — cache-driven height estimates for offscreen specs leave the
  // scrollTop computed at restore time several hundred pixels off the
  // measured maxTop, even when the user's view is exactly the same.
  assert(pitchMid.firstVisible?.key && pitchRestored.firstVisible?.key,
    `must capture firstVisible at both points (before=${JSON.stringify(pitchMid.firstVisible)} after=${JSON.stringify(pitchRestored.firstVisible)})`);
  assert(pitchMid.firstVisible.key === pitchRestored.firstVisible.key,
    `[pitch deck] anchor bubble must match across switch: ` +
    `before=${pitchMid.firstVisible.key} after=${pitchRestored.firstVisible.key}`);
  const offsetDrift = Math.abs(
    (pitchRestored.firstVisible.topRelToViewport ?? 0) - (pitchMid.firstVisible.topRelToViewport ?? 0)
  );
  assert(offsetDrift <= OFFSET_TOLERANCE_PX,
    `[pitch deck] anchored bubble offset drifted ${offsetDrift}px ` +
    `(want ≤${OFFSET_TOLERANCE_PX}). ` +
    `before=${pitchMid.firstVisible.topRelToViewport} after=${pitchRestored.firstVisible.topRelToViewport}`);
}
