// Agent-pushed ATTACHMENT lane (2026-10-08): a markdown link into
// /api/parley/attachments/<id>/<name> in a reply must render as an
// attachment card — file name, size, and a Download button whose href is
// absolute against the API origin (CAP contract) and carries the
// `download` attribute (browser saves; the server answers
// Content-Disposition: attachment). Drives the live reply path like
// media-video-card: the mock backend echoes the sent text as reply_final
// and the card fallback parser does the rest.

import { waitForReady, assert } from './lib.mjs';

export const NAME = 'attachment-card-download';
export const DESCRIPTION = 'Markdown link into the attachment lane renders a card with the file name, size and an API-origin Download button';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const URL_PATH = '/api/parley/attachments/a1b2c3d4e5f60718/R2%20deck%20v3.pptx';

export default async function run({ page, log }) {
  await waitForReady(page);

  await page.evaluate((p) => {
    const ta = document.getElementById('composer-input');
    ta.value = `Corrected deck attached: 📎 [R2 deck v3.pptx (1.2 MB)](${p})`;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('composer-send')?.click();
  }, URL_PATH);

  await page.waitForSelector('.card-attachment .attachment-download', { timeout: 8_000 });
  const probe = await page.evaluate(() => {
    const card = document.querySelector('.card-attachment');
    const a = card?.querySelector('a.attachment-download');
    return {
      name: card?.querySelector('.attachment-name')?.textContent || '',
      size: card?.querySelector('.attachment-size')?.textContent || '',
      href: a?.getAttribute('href') || '',
      download: a?.hasAttribute('download'),
      label: a?.textContent || '',
      linksCards: document.querySelectorAll('.card-links').length,
    };
  });
  assert(probe.name === 'R2 deck v3.pptx', `card name should be the file name; got "${probe.name}"`);
  assert(probe.size === '1.2 MB', `card should show the size; got "${probe.size}"`);
  assert(probe.href.includes(URL_PATH) && /^https?:\/\//.test(probe.href),
    `Download href must be absolute against the API origin; got ${probe.href}`);
  assert(probe.download, 'Download button must carry the download attribute');
  assert(/download/i.test(probe.label), `button should say Download; got "${probe.label}"`);
  assert(probe.linksCards === 0, 'the attachment link must not ALSO render as a generic links card');
  log('attachment card ✓ name, size, absolute Download href');
}
