// Own-send half of turn-lifecycle-authoritative (field 2026-09-23). With a
// lifecycle backend the PWA no longer guesses "a turn is running" from a
// committed send — it waits for hermes' turn_start. The gap between the
// two must still show the indicator (the young, not-yet-acked send
// carries it), then 👀 → ✓ follows the message the user actually typed,
// and nothing is left behind once turn_end lands.
//
// Also drops /tmp/turn-lifecycle-ack.png for a visual check of the mark.

import { waitForReady, openSidebar, clickRow, send, assert } from './lib.mjs';

export const NAME = 'turn-lifecycle-own-send';
export const DESCRIPTION = 'lifecycle backend: own send shows the indicator before turn_start, 👀 → ✓ on the typed message, nothing left after turn_end';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT = 'parley:mock-turn-lifecycle-send';

export function MOCK_SETUP(mock) {
  const t0 = Date.now() / 1000 - 600;
  mock.setTurnLifecycle(true);
  mock.setAutoReplyEnabled(false);
  mock.addChat(CHAT, {
    title: 'Lifecycle send',
    messages: [
      { role: 'user', content: 'seed question', parley_id: 'umsg_s0', timestamp: t0 },
      { role: 'assistant', content: 'seed answer', parley_id: 'msg_s0', timestamp: t0 + 1 },
    ],
    lastActiveAt: Date.now(),
  });
}

const INDICATOR = '#transcript .line.turn-status, #transcript .line.agent.streaming';

export default async function run({ page, log, mock }) {
  await waitForReady(page);
  await openSidebar(page);
  await clickRow(page, CHAT);
  await page.waitForFunction(() => (document.getElementById('transcript')?.textContent || '').includes('seed answer'),
    null, { timeout: 5_000, polling: 50 });

  await send(page, 'does the eye show up');
  const umid = await page.waitForFunction(() => {
    const el = Array.from(document.querySelectorAll('#transcript .line.s0'))
      .find((l) => (l.textContent || '').includes('does the eye show up'));
    return el?.getAttribute('data-message-id') || null;
  }, null, { timeout: 3_000, polling: 50 }).then((h) => h.jsonValue());
  log(`sent; bubble id ${umid}`);

  // Before turn_start: the committed send alone carries the indicator.
  await page.waitForFunction((sel) => document.querySelectorAll(sel).length > 0, INDICATOR, { timeout: 3_000, polling: 50 });
  log('indicator up before turn_start ✓');

  mock.pushEnvelope({ type: 'turn_start', chat_id: CHAT, turn_id: 'turn_s1', user_message_id: umid });
  await page.waitForFunction((id) => document.querySelector(`#transcript .line.s0[data-message-id="${id}"] > .turn-ack`)?.dataset.ack === 'processing',
    umid, { timeout: 3_000, polling: 50 });
  await page.screenshot({ path: '/tmp/turn-lifecycle-ack.png' });
  log('turn_start → 👀 on the typed message ✓ (screenshot /tmp/turn-lifecycle-ack.png)');

  mock.pushEnvelope({ type: 'reply_delta', chat_id: CHAT, message_id: 'msg_s1', text: 'yes it does' });
  mock.pushEnvelope({ type: 'reply_final', chat_id: CHAT, message_id: 'msg_s1' });
  mock.pushEnvelope({ type: 'turn_end', chat_id: CHAT, turn_id: 'turn_s1', user_message_id: umid, outcome: 'success', replied: true, active_turns: 0 });
  await page.waitForFunction((id) => document.querySelector(`#transcript .line.s0[data-message-id="${id}"] > .turn-ack`)?.dataset.ack === 'success',
    umid, { timeout: 3_000, polling: 50 });
  await page.waitForFunction((sel) => document.querySelectorAll(sel).length === 0, INDICATOR, { timeout: 3_000, polling: 50 });
  await page.screenshot({ path: '/tmp/turn-lifecycle-done.png' });
  await page.hover(`#transcript .line.s0[data-message-id="${umid}"]`);
  await page.screenshot({ path: '/tmp/turn-lifecycle-hover.png' });

  // A straggler typing must not bring it back.
  mock.pushEnvelope({ type: 'typing', chat_id: CHAT });
  await page.waitForTimeout(800);
  const left = await page.evaluate((sel) => document.querySelectorAll(sel).length, INDICATOR);
  assert(left === 0, `straggler typing after turn_end resurrected the indicator (${left})`);
  log('turn_end → ✓, indicator gone and stays gone ✓');
}
