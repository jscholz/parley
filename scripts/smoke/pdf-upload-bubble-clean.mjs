// A long-PDF upload bubble shows the user's words and a working PDF chip
// (field 2026-10-15: a 94-page PDF ballooned the message with ~190
// "[Image attached at: …]" / "[screenshot]" lines, the page images were
// nowhere to be seen, and the chip opened a raw data: URL that didn't
// work). The notes are hidden; the chip opens the saved PDF in the
// in-app viewer.
import { waitForReady, pollUntil, assert } from './lib.mjs';

export const NAME = 'pdf-upload-bubble-clean';
export const DESCRIPTION = 'Upload bubble hides model-only attachment notes; the PDF chip opens the saved PDF in the in-app viewer';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';
export const MOBILE = 'both';

const CHAT = 'parley:mock-pdf-upload-clean';
const UMSG = 'umsg_1792091098520_sicbeu0u';
const URL0 = `/api/parley/uploads/${UMSG}/0`;

export function MOCK_SETUP(mock) {
  const t0 = Date.now() / 1000 - 300;
  const pages = Array.from({ length: 94 }, (_, i) => `[Image attached at: /tmp/parley-attach-oaixlbx5-${String(i + 1).padStart(2, '0')}.png]`).join('\n');
  const shots = Array.from({ length: 94 }, () => '[screenshot]').join('\n');
  mock.addChat(CHAT, { title: 'Tax return', lastActiveAt: Date.now() - 1000, messages: [
    { role: 'user', content: `Please audit the attached return.\n\n${pages}\n\n[94 images]\n${shots}`, parley_id: UMSG, timestamp: t0,
      attachments: [{ idx: 0, url: URL0, mimeType: 'application/pdf', fileName: 'Jon Scholz US 2025 Tax Return.pdf', size: 568417 }] },
    { role: 'assistant', content: 'On it.', message_id: 'msg_pdf1', timestamp: t0 + 5 },
  ]});
}

export default async function run({ page, log }) {
  await page.route('**/api/parley/uploads/**', (route) => route.fulfill({ status: 200, contentType: 'application/pdf', headers: { 'Content-Disposition': 'inline; filename="return.pdf"' }, body: '%PDF-1.4\n%%EOF' }));
  let popups = 0;
  page.context().on('page', () => { popups += 1; });
  await waitForReady(page);
  await pollUntil(page, (cid) => !!document.querySelector(`#sessions-list li[data-chat-id="${cid}"]`), CHAT, { timeout: 8000, label: 'chat not listed' });
  await page.evaluate((cid) => { document.body.classList.add('sidebar-expanded'); document.querySelector(`#sessions-list li[data-chat-id="${cid}"] .sess-body`)?.dispatchEvent(new MouseEvent('click', { bubbles: true })); }, CHAT);
  await pollUntil(page, (k) => !!document.querySelector(`#transcript .line[data-key="${k}"]`), UMSG, { timeout: 8000, label: 'upload bubble did not render' });

  const bubble = await page.evaluate((k) => {
    const line = document.querySelector(`#transcript .line[data-key="${k}"]`);
    const text = line.querySelector('.text')?.textContent || '';
    return { text, height: line.getBoundingClientRect().height, chip: line.querySelector('a.pdf-chip')?.getAttribute('href') || '' };
  }, UMSG);
  assert(/Please audit the attached return\./.test(bubble.text), `user words missing: ${bubble.text.slice(0, 80)}`);
  assert(!/screenshot|Image attached|94 images/.test(bubble.text), `model-only notes leaked into the bubble: ${bubble.text.slice(0, 200)}`);
  assert(bubble.height < 400, `bubble should be compact, got ${bubble.height}px`);
  assert(/\/api\/parley\/uploads\//.test(bubble.chip) && !bubble.chip.startsWith('data:'), `chip must point at the saved copy: ${bubble.chip}`);
  log(`bubble: words only, ${Math.round(bubble.height)}px, chip → saved copy ✓`);

  await page.evaluate((k) => document.querySelector(`#transcript .line[data-key="${k}"] a.pdf-chip`).click(), UMSG);
  await page.waitForTimeout(300);
  const v = await page.evaluate(() => {
    const lb = document.getElementById('lightbox');
    return lb ? { frame: lb.querySelector('iframe.lightbox-pdf')?.getAttribute('src') || '', dl: lb.querySelector('a[download]')?.getAttribute('download') || '' } : null;
  });
  assert(v && /\/api\/parley\/uploads\//.test(v.frame), `chip should open the viewer with the PDF framed: ${JSON.stringify(v)}`);
  assert(/Tax Return\.pdf$/.test(v.dl), `download keeps the real file name: ${JSON.stringify(v)}`);
  assert(popups === 0, 'no new window');
  // × closes. (Esc can't once Chrome's PDF frame has focus — keys go to
  // the PDF viewer, not the page; × and a backdrop tap always work.)
  await page.evaluate(() => document.querySelector('#lightbox .lightbox-close').click());
  assert(!(await page.evaluate(() => !!document.getElementById('lightbox'))), '× closes');
  log('PDF chip → in-app viewer with the saved PDF, real file name on Download, × closes ✓');
}
