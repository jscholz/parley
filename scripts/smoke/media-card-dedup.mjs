// Media lane round 2, deliverable 1 (dedup): the live attach path and the
// historical re-derive path can BOTH fire on the same bubble — the live
// handleReplyFinal parse when the reply lands, then ensureHistoricalCards
// on a later virt remount (the reconciler runs createAssistant on every
// mount). They must not double-render: attachCard's per-replyId hash set
// drops a card the live path already stored.
//
// This drives the live path (mock echoes the sent media markdown → 1
// video card), then invokes ensureHistoricalCards on the SAME live bubble
// with its own body text — the exact overlap — and asserts the card count
// stays at exactly one.

import { waitForReady, assert } from './lib.mjs';

export const NAME = 'media-card-dedup';
export const DESCRIPTION = 'Live-attached media card + historical re-derive on the same bubble render exactly one card';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const MEDIA_PATH = '/api/sidekick/media/00c0ffee00c0ffee.mp4';

export default async function run({ page, log }) {
  await waitForReady(page);

  await page.route(/\/api\/sidekick\/media\/[a-f0-9]+\.mp4$/, (route) =>
    route.fulfill({ status: 200, contentType: 'video/mp4', body: Buffer.alloc(64) }));

  // Live path: send a media markdown link; the mock echoes it into
  // reply_final and handleReplyFinal attaches the video card.
  await page.evaluate((path) => {
    const ta = document.getElementById('composer-input');
    ta.value = `rough cut ready ![The X edit](${path})`;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('composer-send')?.click();
  }, MEDIA_PATH);

  await page.waitForSelector('.card-video video', { timeout: 8_000 });
  const before = await page.evaluate(() => document.querySelectorAll('.card-video video').length);
  assert(before === 1, `live path should attach exactly 1 video card; got ${before}`);
  log('live path: 1 video card ✓');

  // Now force the historical re-derive path over the SAME live bubble's
  // body — the live+historical overlap. Must be deduped to one card.
  const result = await page.evaluate(async () => {
    const mod = await import('/build/cards/attach.mjs');
    const bubble = document.querySelector('.card-video video')?.closest('.line.agent[data-reply-id]');
    if (!bubble) return { ok: false, reason: 'no media bubble' };
    const replyId = bubble.dataset.replyId;
    const text = bubble.dataset.text || bubble.querySelector('.text')?.textContent || '';
    mod.ensureHistoricalCards(bubble, replyId, text);
    return {
      ok: true,
      replyId,
      hasMarkdown: /\/api\/sidekick\/media\//.test(text),
      count: document.querySelectorAll('.card-video video').length,
    };
  });
  assert(result.ok, `dedup step failed: ${result.reason}`);
  assert(result.hasMarkdown, `bubble body must still carry the media markdown for a real overlap; text had none`);
  assert(result.count === 1,
    `BUG (dedup): live + historical parse on the same bubble must stay at 1 card, got ${result.count}`);
  log('overlap: live + historical parse deduped to exactly 1 card ✓');

  log('PASS: no double media card when live + historical parse overlap');
}
