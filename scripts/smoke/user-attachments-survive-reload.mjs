// A user's uploaded images must still be on their bubble after the
// transcript is rebuilt from history, with a way to download them.
//
// Field 2026-10-11: three images attached to a message showed in the live
// bubble only; the first rebuild (a memory-context injection) dropped
// them — history rows carried no attachment data. Now the plugin keeps a
// durable copy per attachment and the items read joins
// {url, mimeType, fileName, size} onto the user row; the proxy serves the
// file on the user-upload lane; the bubble renders the thumbnail from the
// URL and a ⤓ download link.
//
// Mocked: the chat's user row carries `attachments` with a lane URL; the
// smoke serves a real PNG at that URL. Asserts after a cold open AND after
// a reload (history → projection → bubble) on desktop and mobile.

import { waitForReady, assert, pollUntil } from './lib.mjs';

export const NAME = 'user-attachments-survive-reload';
export const DESCRIPTION = 'User-uploaded images rebuilt from history render on the bubble with a download link (user-upload lane)';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';
export const MOBILE = 'both';

const CHAT = 'parley:mock-user-uploads';
const UMSG = 'umsg_1791680364154_wi4w0qxu';
const URL0 = `/api/parley/uploads/${UMSG}/0`;
const URL1 = `/api/parley/uploads/${UMSG}/1`;
// 1×1 PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

export function MOCK_SETUP(mock) {
  const t0 = Date.now() / 1000 - 300;
  mock.addChat(CHAT, {
    title: 'Illustrate gripper concept',
    source: 'parley',
    lastActiveAt: Date.now() - 1000,
    messages: [
      { role: 'user', content: 'Here are the reference photos.', parley_id: UMSG, timestamp: t0,
        attachments: [
          { idx: 0, url: URL0, mimeType: 'image/png', fileName: 'wrist-1.png', size: 1516679 },
          { idx: 1, url: URL1, mimeType: 'image/png', fileName: 'wrist-2.png', size: 155716 },
        ] },
      { role: 'assistant', content: 'Got them.', message_id: 'm-up-1', timestamp: t0 + 5 },
    ],
  });
}

async function check(page, label, log) {
  await pollUntil(page, (k) => !!document.querySelector(`#transcript .line[data-key="${k}"] .line-attachments img`), UMSG,
    { timeout: 10_000, label: `${label}: no thumbnail on the rebuilt user bubble` });
  const r = await page.evaluate((k) => {
    const line = document.querySelector(`#transcript .line[data-key="${k}"]`);
    const imgs = [...line.querySelectorAll('.line-attachments img')].map((i) => ({ src: i.getAttribute('src'), w: i.naturalWidth }));
    const dls = [...line.querySelectorAll('.attachment-dl')].map((a) => ({ href: a.getAttribute('href'), download: a.hasAttribute('download'), text: a.textContent }));
    return { imgs, dls };
  }, UMSG);
  assert(r.imgs.length === 2, `${label}: expected 2 thumbnails, got ${JSON.stringify(r.imgs)}`);
  assert(r.imgs.every((i) => /\/api\/parley\/uploads\/umsg_/.test(i.src || '') && /^https?:\/\//.test(i.src || '')), `${label}: thumbnail src must be the absolute lane URL: ${JSON.stringify(r.imgs)}`);
  assert(r.imgs.every((i) => i.w === 1), `${label}: thumbnails did not load from the lane: ${JSON.stringify(r.imgs)}`);
  assert(r.dls.length === 2 && r.dls.every((d) => d.download) && /wrist-1\.png/.test(r.dls[0].text) && /1\.4 MB/.test(r.dls[0].text),
    `${label}: download links wrong: ${JSON.stringify(r.dls)}`);
  log(`${label}: 2 thumbnails from the lane + ⤓ download links ✓`);
}

export default async function run({ page, log }) {
  await page.route('**/api/parley/uploads/**', async (route) => {
    await route.fulfill({ status: 200, contentType: 'image/png', headers: { 'Content-Disposition': 'inline; filename="wrist.png"' }, body: PNG });
  });
  await waitForReady(page);
  await page.evaluate((cid) => {
    document.body.classList.add('sidebar-expanded');
    document.querySelector(`#sessions-list li[data-chat-id="${cid}"] .sess-body`)
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  }, CHAT);
  await check(page, 'cold open', log);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#composer-input', { timeout: 15_000 });
  await page.waitForFunction(() => /Connected/.test(document.body.innerText), null, { timeout: 15_000 });
  await check(page, 'after reload', log);
}
