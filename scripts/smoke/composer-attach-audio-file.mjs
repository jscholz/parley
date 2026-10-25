// Audio uploads (field 2026-10-25: "I downloaded a voice note from
// WhatsApp … It's an OGG file and it was rejected."). The composer
// accepts audio by MIME or by extension (WhatsApp notes arrive as
// application/ogg, .opus with no MIME, …), chips it, needs no vision
// capability, sends `type: 'audio'` with a truthful MIME, and a bubble
// carrying an audio attachment renders a player.

import { waitForReady, assert, openSidebar, clickRow } from './lib.mjs';

export const NAME = 'composer-attach-audio-file';
export const DESCRIPTION = 'Composer accepts voice notes (.ogg/.opus/.m4a, by MIME or extension), sends them as audio attachments; bubbles render a player';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_ID = 'mock-audio-attach-chat';

export function MOCK_SETUP(mock) {
  mock.addChat(CHAT_ID, {
    title: 'Voice notes', lastActiveAt: Date.now() - 1000,
    messages: [{ role: 'user', content: 'seed', parley_id: 'umsg_va_seed', timestamp: Date.now() / 1000 - 60 }],
  });
}

const chips = (page) => page.evaluate(() =>
  Array.from(document.querySelectorAll('#composer-attachments .attachment-chip')).map((c) => ({
    label: c.querySelector('.chip-pdf-label')?.textContent || '', audio: c.classList.contains('chip-audio'),
  })));
async function addFile(page, { bytes, type, name }) {
  await page.evaluate(async (args) => {
    const mod = await import('/build/attachments.mjs');
    const file = new File([new Uint8Array(args.bytes)], args.name, { type: args.type });
    await mod.add(file);
  }, { bytes, type, name });
}

export default async function run({ page, log, mock }) {
  await waitForReady(page);
  await openSidebar(page);
  await clickRow(page, CHAT_ID);
  await addFile(page, { bytes: 4096, type: 'application/ogg', name: 'PTT-20261025-WA0001.ogg' });   // WhatsApp export, Chrome's MIME
  await addFile(page, { bytes: 4096, type: '', name: 'PTT-20261025-WA0002.opus' });                 // no MIME at all
  await addFile(page, { bytes: 4096, type: 'audio/x-m4a', name: 'memo.m4a' });
  const c = await chips(page);
  assert(c.length === 3 && c.every((x) => x.audio), `three audio files must chip (got ${JSON.stringify(c)})`);
  assert(c.map((x) => x.label).join(',') === '♪ OGG,♪ OPUS,♪ M4A', `chips carry the extension (got ${JSON.stringify(c)})`);
  const errToast = await page.evaluate(() => { const el = document.getElementById('app-toast'); return !!(el && el.classList.contains('visible') && el.classList.contains('err')); });
  assert(!errToast, 'no rejection toast for audio');
  log('ogg (application/ogg), opus (no MIME), m4a → three chips ✓');

  const reqP = page.waitForRequest('**/api/parley/messages', { timeout: 5_000 });
  await page.fill('#composer-input', 'voice notes from the chat');
  await page.evaluate(() => document.getElementById('composer-send')?.click());
  const body = JSON.parse((await reqP).postData() || '{}');
  assert(body.attachments?.length === 3, `three attachments sent (got ${body.attachments?.length})`);
  const byName = Object.fromEntries(body.attachments.map((a) => [a.fileName, a]));
  assert(byName['PTT-20261025-WA0001.ogg'].type === 'audio' && byName['PTT-20261025-WA0001.ogg'].mimeType === 'audio/ogg', `ogg → audio/audio/ogg: ${JSON.stringify(byName['PTT-20261025-WA0001.ogg'])}`);
  assert(byName['PTT-20261025-WA0002.opus'].mimeType === 'audio/ogg', 'opus with no MIME is sent as audio/ogg');
  assert(byName['memo.m4a'].mimeType === 'audio/mp4' && byName['memo.m4a'].type === 'audio', 'm4a normalised to audio/mp4');
  log('send: type=audio, truthful MIME ✓');

  // A bubble carrying an audio attachment (e.g. from another device) shows a player.
  mock.pushEnvelope({
    type: 'user_message', chat_id: CHAT_ID, message_id: 'umsg_from_phone_a', text: 'here is the voice note',
    attachments: [{ idx: 0, fileName: 'PTT-20261025-WA0009.ogg', mimeType: 'audio/ogg', size: 4096, url: '/api/parley/uploads/umsg_from_phone_a/0' }],
  });
  await page.waitForFunction(() => Array.from(document.querySelectorAll('#transcript .line.s0')).some((l) => /here is the voice note/.test(l.textContent || '') && l.querySelector('.line-audio audio')), null, { timeout: 6000, polling: 50 });
  const player = await page.evaluate(() => {
    const l = Array.from(document.querySelectorAll('#transcript .line.s0')).find((x) => /here is the voice note/.test(x.textContent || ''));
    const a = l.querySelector('.line-audio audio');
    return { src: a?.getAttribute('src') || '', controls: !!a?.controls, name: l.querySelector('.line-audio-name')?.textContent };
  });
  assert(/\/api\/parley\/uploads\/umsg_from_phone_a\/0$/.test(player.src) && player.controls && player.name === 'PTT-20261025-WA0009.ogg', `bubble renders a player on the durable copy: ${JSON.stringify(player)}`);
  log('bubble: audio attachment → player ✓');
}
