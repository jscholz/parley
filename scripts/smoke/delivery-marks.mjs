// Delivery marks on the user's own bubbles (2026-10-27, WhatsApp-style
// but following the pipeline's own states): ◷ while the POST is in
// flight → ✓ once Parley's proxy accepted it → ✓✓ once the agent echoed
// it (it has the message) → ✓✓ coloured when the agent STARTS the turn
// (turn_start = "seen") → stays after a successful turn; ✗ on failure.
import { waitForReady, openSidebar, clickRow, send, assert } from './lib.mjs';

export const NAME = 'delivery-marks';
export const DESCRIPTION = 'own send: ◷ sending → ✓ accepted by the proxy → ✓✓ received by the agent → ✓✓ seen on turn_start → ✗ on a failed turn';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT = 'parley:mock-delivery-marks';

export function MOCK_SETUP(mock) {
  mock.setTurnLifecycle(true);
  mock.setAutoReplyEnabled(false);
  mock.setSuppressUserMessageBroadcast(true);    // no echo until the scenario pushes one
  mock.addChat(CHAT, { title: 'Delivery marks', messages: [
    { role: 'user', content: 'seed question', parley_id: 'umsg_s0', timestamp: Date.now() / 1000 - 600 },
    { role: 'assistant', content: 'seed answer', parley_id: 'msg_s0', timestamp: Date.now() / 1000 - 599 },
  ], lastActiveAt: Date.now() });
}

export default async function run({ page, log, mock }) {
  await waitForReady(page);
  await openSidebar(page);
  await clickRow(page, CHAT);
  await page.waitForFunction(() => (document.getElementById('transcript')?.textContent || '').includes('seed answer'), null, { timeout: 5_000, polling: 50 });
  const markOf = (id) => page.evaluate((i) => { const m = document.querySelector(`#transcript .line.s0[data-message-id="${i}"] > .turn-ack`); return m ? { state: m.dataset.state, glyph: m.textContent, ack: m.dataset.ack || null } : null; }, id);
  const waitState = (id, st) => page.waitForFunction((i, s) => document.querySelector(`#transcript .line.s0[data-message-id="${i}"] > .turn-ack`)?.dataset.state === s, [id, st], { timeout: 4_000, polling: 50 }).catch(() => null);
  // Durable rows from history: the agent has them.
  assert((await markOf('umsg_s0'))?.state === 'seen' || (await markOf('umsg_s0'))?.state === 'delivered', `history row: ${JSON.stringify(await markOf('umsg_s0'))}`);

  await send(page, 'tick tick');
  const umid = await page.waitForFunction(() => Array.from(document.querySelectorAll('#transcript .line.s0')).find((l) => (l.textContent || '').includes('tick tick'))?.getAttribute('data-message-id') || null, null, { timeout: 3_000, polling: 50 }).then((h) => h.jsonValue());
  // The POST returns at once in the mock, so ◷ may be too brief to catch; ✓ (accepted, no echo yet) is the resting state.
  await waitState(umid, 'sent');
  const sent = await markOf(umid);
  assert(sent && sent.state === 'sent' && sent.glyph === '✓', `accepted by the proxy → one tick: ${JSON.stringify(sent)}`);
  log('✓ one tick after the proxy accepted the send (no echo yet)');

  mock.pushEnvelope({ type: 'user_message', chat_id: CHAT, message_id: umid, text: 'tick tick' });
  await waitState(umid, 'delivered');
  const delivered = await markOf(umid);
  assert(delivered && delivered.state === 'delivered' && delivered.glyph === '✓✓', `agent echo → two ticks: ${JSON.stringify(delivered)}`);
  const greyColor = await page.$eval(`#transcript .line.s0[data-message-id="${umid}"] > .turn-ack`, (m) => getComputedStyle(m).color);
  log('✓✓ two ticks once the agent has it');

  mock.pushEnvelope({ type: 'turn_start', chat_id: CHAT, turn_id: 'turn_d1', user_message_id: umid });
  await waitState(umid, 'seen');
  await page.waitForTimeout(350);          // the colour transitions over 200 ms
  const seen = await markOf(umid);
  const seenColor = await page.$eval(`#transcript .line.s0[data-message-id="${umid}"] > .turn-ack`, (m) => getComputedStyle(m).color);
  assert(seen && seen.state === 'seen' && seen.glyph === '✓✓' && seen.ack === 'processing' && seenColor !== greyColor, `turn_start → coloured ticks: ${JSON.stringify(seen)} ${greyColor} → ${seenColor}`);
  log('✓✓ coloured when the agent started the turn (seen)');

  mock.pushEnvelope({ type: 'reply_delta', chat_id: CHAT, message_id: 'msg_d1', text: 'tock' });
  mock.pushEnvelope({ type: 'reply_final', chat_id: CHAT, message_id: 'msg_d1', text: 'tock' });
  mock.pushEnvelope({ type: 'turn_end', chat_id: CHAT, turn_id: 'turn_d1', user_message_id: umid, outcome: 'success' });
  await page.waitForTimeout(400);
  const done = await markOf(umid);
  assert(done && done.state === 'seen' && done.ack === 'success', `successful turn keeps the coloured ticks: ${JSON.stringify(done)}`);
  log('successful turn keeps ✓✓ (the reply is the proof)');

  // A failed turn: ✗.
  await send(page, 'will fail');
  const umid2 = await page.waitForFunction(() => Array.from(document.querySelectorAll('#transcript .line.s0')).find((l) => (l.textContent || '').includes('will fail'))?.getAttribute('data-message-id') || null, null, { timeout: 3_000, polling: 50 }).then((h) => h.jsonValue());
  mock.pushEnvelope({ type: 'user_message', chat_id: CHAT, message_id: umid2, text: 'will fail' });
  mock.pushEnvelope({ type: 'turn_start', chat_id: CHAT, turn_id: 'turn_d2', user_message_id: umid2 });
  await waitState(umid2, 'seen');
  mock.pushEnvelope({ type: 'turn_end', chat_id: CHAT, turn_id: 'turn_d2', user_message_id: umid2, outcome: 'failure' });
  await waitState(umid2, 'failure');
  const failed = await markOf(umid2);
  assert(failed && failed.glyph === '✗' && failed.state === 'failure', `failed turn → ✗: ${JSON.stringify(failed)}`);
  log('failed turn → ✗');
}
