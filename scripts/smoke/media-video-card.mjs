// Agent-pushed media lane (2026-08-04): an agent registers a produced
// file with POST /api/sidekick/media/register and references it in its
// reply as a markdown image; a video extension must render an inline
// VIDEO card (controls + playsInline, src resolved via apiUrl so the
// CAP capacitor:// origin fetches from the API host, not the bundle).
//
// Drives the LIVE reply path: the mock backend echoes the sent text
// into its reply_final, and handleReplyFinal's parseCardsFromText
// fallback classifies the markdown link by extension. The media GET is
// page.route-stubbed — this proves the client lane; the server route
// has its own unit coverage (proxy/sidekick/__tests__/media.test.ts).

import { waitForReady, assert } from './lib.mjs';

export const NAME = 'media-video-card';
export const DESCRIPTION = 'Markdown video link in an agent reply renders an inline video card with API-origin src';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const MEDIA_PATH = '/api/sidekick/media/00c0ffee00c0ffee.mp4';

export default async function run({ page, log }) {
  await waitForReady(page);

  // Stub the media bytes — the <video> element will probe the src.
  await page.route(/\/api\/sidekick\/media\/[a-f0-9]+\.mp4$/, (route) =>
    route.fulfill({ status: 200, contentType: 'video/mp4', body: Buffer.alloc(64) }));

  await page.evaluate((path) => {
    const ta = document.getElementById('composer-input');
    ta.value = `rough cut ready ![The X edit](${path})`;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('composer-send')?.click();
  }, MEDIA_PATH);

  await page.waitForSelector('.card-video video', { timeout: 8_000 });
  const probe = await page.evaluate(() => {
    const v = document.querySelector('.card-video video');
    return {
      src: v?.src || '',
      controls: !!v?.controls,
      playsInline: !!v?.playsInline,
      preload: v?.preload || '',
      caption: document.querySelector('.card-video .caption')?.textContent || '',
    };
  });
  assert(probe.src.includes(MEDIA_PATH),
    `video src must carry the media path; got ${probe.src}`);
  assert(/^https?:\/\//.test(probe.src),
    `video src must be absolute against the API origin (CAP contract); got ${probe.src}`);
  assert(probe.controls, 'video must render with controls');
  assert(probe.playsInline, 'video must set playsInline (iOS must not force fullscreen)');
  assert(probe.preload === 'metadata', `preload must be metadata; got ${probe.preload}`);
  assert(probe.caption === 'The X edit', `caption must come from the markdown alt; got "${probe.caption}"`);
  log('video card ✓ rendered inline with API-origin src + iOS attrs');

  log('PASS: markdown video link → inline video card');
}
