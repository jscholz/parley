// Per-session identity (#146-149) — the voice half. A session can carry
// its own TTS voice; when a reply autoplays for THAT session, the /tts
// request must use the session's assigned voice, not the global default.
//
// What this proves end-to-end:
//   1. SHEET SELECT — picking a voice in the "Name & voice" sheet writes
//      it to the synced `sessionIdentities` setting.
//   2. THREADING — a Listen-turn autoplay for that session POSTs /tts with
//      the session's voice as `model` (the voiceFor() override in
//      backendEventHandlers), beating the global default.
//
// /tts is stubbed so this runs in the default suite with no Deepgram key.

import { waitForReady, openSidebar, resetServerSettings, pollUntil, assert } from './lib.mjs';

export const NAME = 'session-identity-voice';
export const DESCRIPTION = 'Per-session voice from the sheet drives the /tts model on that session\'s autoplay';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_ID = 'mock-chat-voice';
const SESSION_VOICE = 'aura-2-zeus-en';

export function MOCK_SETUP(mock) {
  const tSec = Date.now() / 1000;
  mock.addChat(CHAT_ID, {
    title: 'Voice chat',
    messages: [
      { role: 'user', content: 'marker-voice', timestamp: tSec },
      { role: 'assistant', content: 'Reply voice', timestamp: tSec + 1 },
    ],
    lastActiveAt: Date.now(),
  });
}

async function rowMenuAction(page, chatId, label) {
  await page.click(`#sessions-list li[data-chat-id="${chatId}"] .sess-menu-btn`);
  await page.locator('.sess-menu button', { hasText: label }).first().click();
}

export default async function run({ page, log, url }) {
  await waitForReady(page);
  await resetServerSettings(page, { streamingEngine: 'server', tts: true });
  await openSidebar(page);
  await page.waitForSelector(`#sessions-list li[data-chat-id="${CHAT_ID}"]`, { timeout: 5_000 });

  // ── 1. Pick a per-session voice in the sheet ───────────────────────
  await rowMenuAction(page, CHAT_ID, 'Name & voice');
  await page.waitForSelector('.session-identity-dialog .ident-voice', { timeout: 5_000 });
  await page.selectOption('.session-identity-dialog .ident-voice', SESSION_VOICE);
  await page.click('.session-identity-dialog .ident-save');

  await pollUntil(page,
    (v) => fetch('/api/parley/prefs/sessionIdentities')
      .then((r) => r.json())
      .then((b) => typeof b?.value === 'string' && b.value.includes(v)),
    SESSION_VOICE, { timeout: 3_000, polling: 100, label: 'session voice never written to sessionIdentities' },
  );
  log(`sheet ✓ voice ${SESSION_VOICE} written to sessionIdentities`);

  // ── 2. Capture /tts and drive an autoplay for the session ──────────
  const ttsModels = [];
  await page.route('**/tts', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    try { ttsModels.push(JSON.parse(route.request().postData() || '{}')?.model); } catch {}
    const wav = Buffer.from([
      0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45,
      0x66, 0x6d, 0x74, 0x20, 0x10, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00,
      0x40, 0x1f, 0x00, 0x00, 0x80, 0x3e, 0x00, 0x00, 0x02, 0x00, 0x10, 0x00,
      0x64, 0x61, 0x74, 0x61, 0x00, 0x00, 0x00, 0x00,
    ]);
    await route.fulfill({ status: 200, contentType: 'audio/wav', body: wav });
  });

  // Arm Listen and PARK in 'armed' (mock mic) — autoplay only fires when
  // a Listen turn is awaiting a reply. The reload hydrates the identity
  // map from the persisted setting, so voiceFor(CHAT_ID) is populated.
  await page.goto(`${url}/?listen=1&listen_mock_mic=1&silence_sec=60`, {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForSelector('#composer-input', { timeout: 15_000 });
  await page.waitForFunction(() => window.__listen?.state === 'armed', null, {
    timeout: 10_000, polling: 100,
  });

  await page.evaluate(async ({ chatId }) => {
    const listenReply = await import('/build/listenReplyState.mjs');
    const beh = await import('/build/backendEventHandlers.mjs');
    const settings = await import('/build/settings.mjs');
    settings.set('tts', true);
    listenReply.markAwaitingReply(chatId);
    beh.handleReplyFinal({
      replyId: `sk-reply-voice-1`,
      text: 'A short spoken reply for the voice test.',
      conversation: chatId,
      messageId: 'reply-voice-1',
      isReplay: false,
    });
  }, { chatId: CHAT_ID });

  // Wait on the /tts REQUEST, which is durable, not on
  // tts.getActiveReplyId(), which is TRANSIENT. Flake fixed 2026-09-01
  // (measured 4 failures in 6 runs, ~67% — not the "occasional" flake it
  // was assumed to be): getActiveReplyId() is set while a reply is
  // playing and cleared the moment it finishes, and against the mocked
  // /tts the whole round can begin and end well inside the 100ms poll
  // interval. The poll was sampling a value that flickers, so it caught
  // it or missed it by luck, and reported "autoplay never started" for a
  // playback that had already been and gone.
  //
  // ttsModels is pushed by the page.route interceptor above and only
  // grows — it can only become true AFTER the synthesis this test is
  // actually about, and it is the very thing the assertions below read.
  // Same defect family as the three flakes fixed 2026-08-31: waiting on a
  // proxy signal instead of the work itself.
  const ttsDeadline = Date.now() + 8_000;
  while (ttsModels.length === 0 && Date.now() < ttsDeadline) {
    await page.waitForTimeout(50);
  }
  assert(ttsModels.length > 0,
    'no /tts POST captured — autoplay did not synthesize');
  // Brief settle so a multi-chunk reply's later POSTs are counted too.
  await page.waitForTimeout(300);
  assert(ttsModels.every((m) => m === SESSION_VOICE),
    `every /tts POST should use the session voice ${SESSION_VOICE}; got ${JSON.stringify(ttsModels)}`);
  log(`threading ✓ /tts used session voice ${SESSION_VOICE} (${ttsModels.length} chunk(s))`);

  log('PASS: per-session voice from sheet drives the autoplay /tts model');
}
