// Regression guard: a reply landing in a background session was not
// visible on the first switch into it; subsequent switches away and
// back showed the content.
//
// Repro shape:
//   1. User sends a message in chat A.
//   2. Before the reply lands, user switches to chat B.
//   3. Reply for chat A streams in (reply_delta + reply_final) while
//      the user is on B. PWA's badge for A flips to unread.
//   4. User clicks chat A in the drawer.
//   5. EXPECTED: the new reply is in A's transcript immediately.
//   6. ACTUAL: the reply is NOT in the transcript. Switching to B and
//      back makes it appear.
//
// Architecture context: post-Crack-A, SSE envelopes for any chat
// (including background) are funneled through handleReplyDelta /
// handleReplyFinal → transcriptStore.appendInflight(chatId, env)
// unconditionally (main.ts:4090, 4133). So the store DOES accumulate
// the reply for A while we're on B. The question is why the first
// switch back to A doesn't render it. Suspects:
//   * replaySessionMessages → setDurable() overwrites with stale
//     server view (server hasn't persisted the reply yet)
//   * setInflight(server_inflight) clobbers the locally-accumulated
//     inflight when server returns a non-empty inflight slice
//   * Projection dedup is dropping the inflight envelope as a dup
//     of a durable row that doesn't have the same content yet

import {
  waitForReady, openSidebar, send, captureNextChatId,
  clickNewChat, clickRow, assert, attachConsoleCapture,
} from './lib.mjs';

export const NAME = 'background-reply-first-switch-shows-content';
export const DESCRIPTION = 'Reply that lands while user is on another chat must be visible on first switch back, not require a second round-trip';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_B_ID = 'mock-chat-B-bgreply-anchor';
const USER_MARKER = `user-A-${Math.random().toString(36).slice(2, 8)}`;
const BG_REPLY_MARKER = `BACKGROUND_REPLY_${Math.random().toString(36).slice(2, 8)}`;
const BG_REPLY_MSG_ID = `msg_bg_${Math.random().toString(36).slice(2, 8)}`;

export function MOCK_SETUP(mock) {
  // Chat B — somewhere to switch TO while the bg reply lands.
  mock.addChat(CHAT_B_ID, {
    title: 'Anchor chat for bg-reply repro',
    source: 'parley',
    messages: [
      { role: 'user', content: 'anchor-user',
        parley_id: 'umsg_anchor_b_bg', timestamp: Date.now() / 1000 - 30 },
      { role: 'assistant', content: 'anchor-reply',
        parley_id: 'msg_anchor_b_bg', timestamp: Date.now() / 1000 - 29 },
    ],
    lastActiveAt: Date.now() - 5000,
  });
  // Suppress auto-reply globally so we can drive the reply timing
  // manually — the bug is about WHEN the reply lands relative to the
  // user's chat switch.
  mock.setAutoReplyEnabled(false);
}

async function transcriptText(page) {
  return page.evaluate(() =>
    (document.getElementById('transcript')?.textContent || '').replace(/\s+/g, ' ').trim(),
  );
}

async function lineDump(page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('#transcript .line, #transcript [data-key]')).map(l => ({
      key: l.getAttribute('data-key') || null,
      msgId: l.getAttribute('data-message-id') || null,
      cls: l.className,
      text: (l.textContent || '').slice(0, 60).replace(/\s+/g, ' ').trim(),
    })),
  );
}

export default async function run({ page, log, mock }) {
  // Local console capture so we can grep the [bubble-diag] lines that
  // prove (or disprove) handleReplyDelta / handleReplyFinal saw the
  // background envelopes.
  const getConsoleLog = attachConsoleCapture(page, 5000);

  await waitForReady(page);
  await openSidebar(page);

  // ── Step 1: send user message in fresh chat A (no auto-reply yet) ──
  const idP = captureNextChatId(page);
  await clickNewChat(page);
  const chatA = await idP;
  log(`minted chat A: ${chatA}`);

  await send(page, USER_MARKER);
  // The user_message envelope still echoes (autoReply off; mock keeps
  // the broadcast for cross-device dedup). Wait until A's transcript
  // shows the user bubble.
  await page.waitForFunction(
    (marker) => (document.getElementById('transcript')?.textContent || '').includes(marker),
    USER_MARKER,
    { timeout: 5_000, polling: 100 },
  );
  log(`chat A: user bubble visible (no auto-reply by design)`);

  // ── Step 2: switch to chat B ────────────────────────────────────────
  await clickRow(page, CHAT_B_ID);
  await page.waitForFunction(
    () => /anchor-reply/.test(document.getElementById('transcript')?.textContent || ''),
    null,
    { timeout: 4_000, polling: 50 },
  );
  const onB = await transcriptText(page);
  assert(
    !onB.includes(USER_MARKER),
    `chat A's user marker must NOT appear in chat B's transcript, got: ${onB.slice(0, 200)}`,
  );
  log('switched to chat B; chat A marker absent ✓');

  // ── Step 3: while on B, fire background reply envelopes for chat A
  // Mirrors the real proxy's SSE shape: typing → reply_delta → reply_final.
  // No durable mock update — this isolates the inflight-render path. If
  // the bug reproduces here, the regression is purely client-side (the
  // locally-accumulated inflight envelopes aren't projected on
  // first switch-in).
  mock.pushEnvelope({ type: 'typing', chat_id: chatA });
  mock.pushEnvelope({
    type: 'reply_delta',
    chat_id: chatA,
    message_id: BG_REPLY_MSG_ID,
    text: BG_REPLY_MARKER,
  });
  mock.pushEnvelope({
    type: 'reply_final',
    chat_id: chatA,
    message_id: BG_REPLY_MSG_ID,
    text: BG_REPLY_MARKER,
  });
  log(`fired bg envelopes for chat A while user is on B (msg ${BG_REPLY_MSG_ID})`);

  // Give the PWA a beat to consume the SSE envelopes. handleReplyFinal
  // does an unconditional appendInflight(chatA, env), so by the time
  // this resolves, chat A's store has the reply as inflight.
  await page.waitForTimeout(400);

  // Sanity: confirm the PWA's bubble-diag logged that it saw the
  // background envelopes. If these lines are missing, the SSE path
  // didn't deliver and the bug is on the proxy/mock side.
  const log1 = getConsoleLog(2000);
  const sawBgDelta = log1.some(l =>
    l.includes('[bubble-diag] reply_delta') && l.includes(chatA),
  );
  const sawBgFinal = log1.some(l =>
    l.includes('[bubble-diag] reply_final') && l.includes(chatA),
  );
  log(`bg envelopes seen by PWA while on B: delta=${sawBgDelta} final=${sawBgFinal}`);
  assert(
    sawBgDelta && sawBgFinal,
    `bg envelopes for chat A NOT seen by PWA while on B `
    + `(delta=${sawBgDelta}, final=${sawBgFinal}). SSE not delivering background envelopes.`,
  );

  // ── Step 4: switch BACK to chat A — the failing leg ─────────────────
  await clickRow(page, chatA);
  // Poll up to 3s for the bg reply to be visible. The bug shape is that
  // it never appears on FIRST switch; subsequent switches do show it.
  let firstSwitchVisible = false;
  try {
    await page.waitForFunction(
      (marker) => (document.getElementById('transcript')?.textContent || '').includes(marker),
      BG_REPLY_MARKER,
      { timeout: 3_000, polling: 100 },
    );
    firstSwitchVisible = true;
  } catch {
    firstSwitchVisible = false;
  }
  const txAfterFirstSwitch = await transcriptText(page);
  const dumpAfterFirstSwitch = await lineDump(page);
  log(`first switch to A: bg reply visible = ${firstSwitchVisible}`);
  log(`  transcript: ${txAfterFirstSwitch.slice(0, 200)}`);
  log(`  dump (last 4): ${JSON.stringify(dumpAfterFirstSwitch.slice(-4))}`);

  // ── Final assert: the reply must be visible on the first switch back. ─
  // The reply MUST be visible on the FIRST switch back to chat A,
  // without requiring a second switch-away-and-back round-trip.
  assert(
    firstSwitchVisible,
    `bg reply NOT visible on FIRST switch back to chat A. `
    + `transcript: ${txAfterFirstSwitch.slice(0, 200)} | `
    + `last 4 lines: ${JSON.stringify(dumpAfterFirstSwitch.slice(-4))}`,
  );
}
