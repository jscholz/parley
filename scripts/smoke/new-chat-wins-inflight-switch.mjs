// New-chat must WIN against an in-flight session switch (field bug
// 2026-07-12, CAP walking test: "new chat… started new session, then
// some lag, then left me in current session; second attempt was
// correct"). On a slow link (phone), the previous switch's resume
// fetch is still in flight when New chat is pressed; its continuation
// must NOT land afterwards and repaint the old session over the fresh
// shell — the exact "left me in the current session" symptom.
//
// Repro shape: switch to a chat whose /messages response is DELAYED,
// press New chat mid-flight, then let the delayed response land.

import { waitForReady, openSidebar, clickRow } from './lib.mjs';

export const NAME = 'new-chat-wins-inflight-switch';
export const DESCRIPTION = 'New chat pressed during a slow in-flight switch: the fresh shell survives the late resume continuation';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_A = 'mock-ncw-chat-a';
const CHAT_B = 'mock-ncw-chat-b';

export function MOCK_SETUP(mock) {
  const t0 = Date.now() / 1000 - 300;
  mock.addChat(CHAT_A, {
    title: 'Chat A',
    messages: [{ role: 'user', content: 'NCW-A-SEED', parley_id: 'umsg_ncw_a', timestamp: t0 }],
    lastActiveAt: Date.now() - 2000,
  });
  mock.addChat(CHAT_B, {
    title: 'Chat B',
    messages: [{ role: 'user', content: 'NCW-B-SEED', parley_id: 'umsg_ncw_b', timestamp: t0 + 10 }],
    lastActiveAt: Date.now() - 1000,
  });
}

export default async function run({ page, log, mock }) {
  await waitForReady(page);
  await openSidebar(page);

  // Land on A first so B is a genuine cold switch.
  await clickRow(page, CHAT_A);
  await page.waitForFunction(
    () => (document.getElementById('transcript')?.textContent || '').includes('NCW-A-SEED'),
    null, { timeout: 5000, polling: 50 },
  );
  log('viewing chat A');

  // B's history is SLOW — the switch will still be in flight when New
  // chat is pressed.
  mock.setMessageDelay(CHAT_B, 2500);
  await clickRow(page, CHAT_B);
  await new Promise((r) => setTimeout(r, 250));   // switch armed, fetch pending

  await page.click('#sb-new-chat');
  await page.waitForFunction(
    () => (document.getElementById('transcript')?.textContent || '').includes('New chat started'),
    null, { timeout: 5000, polling: 50 },
  );
  log('new chat shell painted while B fetch still pending');

  // Let B's delayed response land — its continuation must bail.
  await new Promise((r) => setTimeout(r, 3200));

  const after = await page.evaluate(() => {
    const text = document.getElementById('transcript')?.textContent || '';
    return {
      hasNewChatLine: text.includes('New chat started'),
      leakedB: text.includes('NCW-B-SEED'),
      leakedA: text.includes('NCW-A-SEED'),
      loading: document.getElementById('transcript')?.classList.contains('transcript-loading') ?? false,
    };
  });
  if (after.leakedB || after.leakedA) {
    throw new Error(`late resume continuation repainted the OLD session over the fresh chat (A=${after.leakedA} B=${after.leakedB}) — the field bug`);
  }
  if (!after.hasNewChatLine) {
    throw new Error('fresh-chat shell vanished after the delayed response landed');
  }
  if (after.loading) {
    throw new Error('stale switch spinner left armed over the fresh chat');
  }
  log('fresh chat survived the late continuation — no repaint, no spinner');

  // Composer must target the NEW chat: send and verify the message
  // does not land in A or B.
  await page.fill('#composer-input', 'hello fresh chat');
  await page.click('#composer-send');
  await new Promise((r) => setTimeout(r, 600));
  const misrouted = await page.evaluate(() => null);   // server-side check below
  void misrouted;
  const sentChats = mock.sentMessages ? mock.sentMessages() : null;
  if (sentChats) {
    const last = sentChats[sentChats.length - 1];
    if (last && (last.chat_id === CHAT_A || last.chat_id === CHAT_B)) {
      throw new Error(`composer send routed to the OLD session (${last.chat_id}) — pointer not flipped`);
    }
  }
  log('composer send routed to the fresh chat');

  // ── Variant 2: the CAP walking-test shape — FOREGROUND reconcile in
  //    flight when New chat is pressed. Foregrounding fires
  //    online/visibility → forceReconnect → a reconcile fetch of the
  //    VIEWED chat; on a slow phone link that fetch is still pending
  //    when the user taps New chat, and its continuation repainting
  //    the old chat is exactly "left me in the current session".
  await openSidebar(page);
  mock.setMessageDelay(CHAT_A, 0);
  await clickRow(page, CHAT_A);
  await page.waitForFunction(
    () => (document.getElementById('transcript')?.textContent || '').includes('NCW-A-SEED'),
    null, { timeout: 5000, polling: 50 },
  );
  // Seed lastReconnectAt (first forceReconnect computes gap=0).
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await new Promise((r) => setTimeout(r, 700));
  // Slow A's history, then fabricate a big-gap foreground → reconcile
  // fetch of A goes in flight.
  mock.setMessageDelay(CHAT_A, 2500);
  await page.evaluate(() => {
    window.dispatchEvent(new Event('online'));
  });
  await new Promise((r) => setTimeout(r, 700));   // debounce drains, fetch pending
  await page.click('#sb-new-chat');
  await page.waitForFunction(
    () => (document.getElementById('transcript')?.textContent || '').includes('New chat started'),
    null, { timeout: 5000, polling: 50 },
  );
  await new Promise((r) => setTimeout(r, 3200));  // delayed reconcile lands
  const after2 = await page.evaluate(() => {
    const text = document.getElementById('transcript')?.textContent || '';
    return {
      hasNewChatLine: text.includes('New chat started'),
      leakedA: text.includes('NCW-A-SEED'),
      loading: document.getElementById('transcript')?.classList.contains('transcript-loading') ?? false,
    };
  });
  if (after2.leakedA) {
    throw new Error('foreground-reconcile continuation repainted the OLD session over the fresh chat (CAP walking-test shape)');
  }
  if (!after2.hasNewChatLine) throw new Error('fresh-chat shell vanished after the delayed reconcile landed');
  if (after2.loading) throw new Error('stale reconcile spinner left armed over the fresh chat');
  log('fresh chat survived the late FOREGROUND-RECONCILE continuation');
}
