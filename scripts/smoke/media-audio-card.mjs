// Agent-pushed media lane round 2 — audio: an agent registers a produced
// audio file (POST /api/sidekick/media/register) and references it in its
// reply as a markdown image; an audio extension (m4a/mp3/wav/ogg — the
// set the media route serves with Range) must render an inline AUDIO card
// (native controls, src resolved via apiUrl so the CAP capacitor:// origin
// fetches from the API host, not the local bundle).
//
// Drives the LIVE reply path: the mock backend echoes the sent text into
// its reply_final, and handleReplyFinal's parseCardsFromText fallback
// classifies the markdown link by extension. The media GET is
// page.route-stubbed — this proves the client lane; the server route has
// its own unit coverage (proxy/sidekick/__tests__/media.test.ts).

import { waitForReady, assert } from './lib.mjs';

export const NAME = 'media-audio-card';
export const DESCRIPTION = 'Markdown audio link in an agent reply renders an inline audio card with API-origin src';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const MEDIA_PATH = '/api/sidekick/media/00c0ffee00c0ffee.mp3';

export default async function run({ page, log }) {
  await waitForReady(page);

  // Stub the media bytes — the <audio> element will probe the src.
  await page.route(/\/api\/sidekick\/media\/[a-f0-9]+\.mp3$/, (route) =>
    route.fulfill({ status: 200, contentType: 'audio/mpeg', body: Buffer.alloc(64) }));

  await page.evaluate((path) => {
    const ta = document.getElementById('composer-input');
    ta.value = `master ready ![Final master](${path})`;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('composer-send')?.click();
  }, MEDIA_PATH);

  await page.waitForSelector('.card-audio audio', { timeout: 8_000 });
  const probe = await page.evaluate(() => {
    const a = document.querySelector('.card-audio audio');
    return {
      src: a?.src || '',
      controls: !!a?.controls,
      preload: a?.preload || '',
      caption: document.querySelector('.card-audio .caption')?.textContent || '',
    };
  });
  assert(probe.src.includes(MEDIA_PATH),
    `audio src must carry the media path; got ${probe.src}`);
  assert(/^https?:\/\//.test(probe.src),
    `audio src must be absolute against the API origin (CAP contract); got ${probe.src}`);
  assert(probe.controls, 'audio must render with controls');
  assert(probe.preload === 'metadata', `preload must be metadata; got ${probe.preload}`);
  assert(probe.caption === 'Final master', `caption must come from the markdown alt; got "${probe.caption}"`);
  log('audio card ✓ rendered inline with API-origin src + controls');

  log('PASS: markdown audio link → inline audio card');
}
