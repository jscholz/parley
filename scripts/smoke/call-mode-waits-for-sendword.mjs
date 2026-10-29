// FIELD GUARD, Jonathan 2026-10-29 (on a walk, call mode):
//
//   "the instant I stop talking, it sends … without hitting a send word
//    or anything." And, days earlier: "the send word delay for over
//    wasn't working, and I couldn't use the word over in a sentence
//    without it automatically sending."
//
// ROOT CAUSE: not the dictation state machine. A smoke run on
// 2026-10-27 loaded `/?listen=1&silence_sec=1`. main.ts applied that
// test flag through settings.set(), which PUTs to the ACCOUNT's synced
// prefs, and the "isolated" smoke server forwarded the PUT to the real
// plugin. His account then carried silenceSec=1: every one-second
// breath was an end of turn, and a mid-sentence "over" (1.5 s confirm
// window) lost the race to that one-second silence timer.
//
// So this replays the WHOLE chain against one simulated account (the
// mock backend's prefs store persists across page loads):
//
//   P1  a page loads with the test flag. It must not write the synced
//       pref, and the flag must still work in-page (the listen smokes
//       depend on it).
//   P2  a FRESH load of the app — the phone after the damage — with his
//       real settings (sendword "over", 1.5 s confirm, silence default).
//       Nothing here calls settings.set: the call runs on whatever the
//       account holds, which is exactly what bit him.
//   R1  he pauses mid-thought for 4 s → nothing sends.
//   R2  he says "over" mid-sentence, breathes for 0.9 s, and keeps
//       talking (his words arrive as an interim inside the 1.5 s
//       confirm window) → nothing sends.
//   R3  he ends with "over" → it sends, promptly, with all his words.
//
// Pre-fix, P1 fails (the PUT lands) and R1/R2 fail (dispatch on pause).

import { waitForReady, pollUntil } from './lib.mjs';
import {
  installFakePeer, openConnectedCall, dcRecv, upstream, hangUp,
} from './lib-callround.mjs';

export const NAME = 'call-mode-waits-for-sendword';
export const DESCRIPTION = 'Test URL flags never write synced prefs; with his settings a call never sends on a pause or a mid-sentence "over", only on a trailing "over"';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

/** His account as it stood before the damage (prefs on 2026-10-29). */
const HIS_PREFS = { commitPhrase: 'over', commitDelaySec: 1.5, silenceSec: 30 };

export default async function run({ page, log, url, mock }) {
  for (const [k, v] of Object.entries(HIS_PREFS)) mock.seedUserSetting(k, v);
  await installFakePeer(page);
  const failures = [];

  // ── P1 — the test flag stays on the page ────────────────────────────
  const prefsPuts = [];
  page.on('request', (req) => {
    if (req.method() === 'PUT' && /\/api\/parley\/prefs\//.test(req.url())) {
      prefsPuts.push(decodeURIComponent(req.url().split('/prefs/')[1] || ''));
    }
  });
  await page.goto(`${url}/?debug=1&listen=1&silence_sec=1`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#composer-input', { timeout: 15_000 });
  await page.waitForTimeout(1_500);   // past the flag handler + background revalidate
  const inPage = await page.evaluate(async () => {
    const s = await import('/build/settings.mjs');
    return s.get().silenceSec;
  });
  const stored = mock.getUserSetting('silenceSec');
  log(`P1 in-page silenceSec=${inPage}; account silenceSec=${stored}; prefs PUTs: ${JSON.stringify(prefsPuts)}`);
  if (prefsPuts.includes('silenceSec') || stored !== HIS_PREFS.silenceSec) {
    failures.push(`P1: the ?silence_sec test flag wrote the account's synced silenceSec (now ${stored}) — every later call inherits it`);
  }
  if (inPage !== 1) {
    failures.push(`P1: the ?silence_sec flag no longer applies in-page (got ${inPage}); the listen smokes rely on it`);
  }

  // ── P2 — a fresh load runs on the account's settings ───────────────
  await waitForReady(page, url);
  await pollUntil(
    page,
    (want) => import('/build/settings.mjs').then((s) => s.get().commitDelaySec === want),
    HIS_PREFS.commitDelaySec,
    { timeout: 8_000, label: 'P2: synced prefs never loaded' },
  );
  const live = await page.evaluate(async () => {
    const s = (await import('/build/settings.mjs')).get();
    return { silenceSec: s.silenceSec, commitPhrase: s.commitPhrase, commitDelaySec: s.commitDelaySec };
  });
  log(`P2 call runs with ${JSON.stringify(live)}`);

  await page.evaluate(async () => {
    (window).__TEST_MIC_PEAK__ = 0;
    const tg = await import('/build/audio/realtime/turnGuard.mjs');
    tg.setPeakOverrideForTests(() => (window).__TEST_MIC_PEAK__);
  });
  const setPeak = (v) => page.evaluate((x) => { (window).__TEST_MIC_PEAK__ = x; }, v);
  const dispatches = async () => (await upstream(page, 'dispatch')).length;
  /** He says `text`, shaped like the bridge's stream: voice on the mic,
   *  an interim ~300 ms later (STT latency), then the final. The interim
   *  matters — it is what tells a pending "over" that he kept talking. */
  const say = async (text) => {
    await setPeak(0.6);
    await page.waitForTimeout(300);
    const head = text.split(' ').slice(0, 2).join(' ');
    await dcRecv(page, { type: 'transcript', role: 'user', text: head, is_final: false });
    await page.waitForTimeout(200);
    await dcRecv(page, { type: 'transcript', role: 'user', text, is_final: true });
    await page.waitForTimeout(100);
    await setPeak(0);
  };

  await openConnectedCall(page, 'talk');
  await dcRecv(page, { type: 'tts-playing', active: false });
  await dcRecv(page, { type: 'listening' });

  // ── R1 — a pause to think is not an end of turn ────────────────────
  const d0 = await dispatches();
  await say('so I was thinking about the trip');
  await page.waitForTimeout(4_000);
  const d1 = await dispatches();
  log(`R1 dispatches after a 4 s pause: ${d1 - d0}`);
  if (d1 !== d0) {
    failures.push(`R1: a 4 s pause sent the message (silenceSec=${live.silenceSec}) — "the instant I stop talking, it sends"`);
  }

  // ── R2 — "over" mid-sentence, then a breath, then more words ───────
  // A 0.9 s breath on a quiet mic. His resumed words reach the client
  // as an interim ~300 ms after he starts, inside his 1.5 s confirm
  // window, and must cancel the pending send.
  await say('and we should go over');
  await page.waitForTimeout(900);
  await say('the budget numbers first');
  await page.waitForTimeout(2_500);
  const d2 = await dispatches();
  log(`R2 dispatches after a mid-sentence "over" + 0.9 s breath: ${d2 - d1}`);
  if (d2 !== d1) {
    failures.push('R2: a mid-sentence "over" followed by a breath sent the message — "I couldn\'t use the word over in a sentence"');
  }

  // ── R3 — a trailing "over" sends, promptly, with every word ─────────
  const t0 = Date.now();
  await say('that is everything over');
  const sent = await pollUntil(
    page,
    (n) => ((window).__TEST_DC_SENDS__ || [])
      .map((s) => { try { return JSON.parse(s); } catch { return null; } })
      .filter((o) => o && o.type === 'dispatch').length > n,
    d2,
    { timeout: HIS_PREFS.commitDelaySec * 1000 + 3_000, label: 'R3: a trailing "over" never sent' },
  ).catch((e) => { failures.push(e.message); return false; });
  if (sent) {
    const all = await upstream(page, 'dispatch');
    const text = String(all[all.length - 1]?.text ?? '');
    log(`R3 sent after ${Date.now() - t0} ms: ${JSON.stringify(text)}`);
    for (const words of ['thinking about the trip', 'go over the budget numbers', 'that is everything']) {
      if (!text.includes(words)) failures.push(`R3: the sent turn lost "${words}" — got ${JSON.stringify(text)}`);
    }
    if (/\bover\s*$/i.test(text)) failures.push(`R3: the trailing sendword was not stripped — got ${JSON.stringify(text)}`);
  }

  await hangUp(page);
  if (failures.length) throw new Error(failures.join('\n'));
}
