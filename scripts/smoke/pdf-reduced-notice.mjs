// A long PDF the agent got in REDUCED form (text + only some page images,
// parley_pdf_ingest 2026-10-20) shows a caption on the user's bubble, so
// he knows the agent didn't see every page as an image. The fenced
// extracted-text block itself stays hidden; a complete PDF shows no caption.

import { waitForReady, assert, pollUntil } from './lib.mjs';

export const NAME = 'pdf-reduced-notice';
export const DESCRIPTION = 'Reduced PDF upload: caption on the user bubble, extracted text hidden; complete PDF: no caption';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';
export const MOBILE = 'both';

const CHAT = 'parley:mock-pdf-notice';
const U_REDUCED = 'umsg_1791680364154_pdfred01';
const U_FULL = 'umsg_1791680364999_pdffull1';
const NOTE = 'tax.pdf (94 pages) was reduced for the agent — full text of every page, page images for 1-2, 47 only. Ask about specific pages if layout or signatures matter.';

export function MOCK_SETUP(mock) {
  const t0 = Date.now() / 1000 - 600;
  const reduced = 'Please review my return.\n\n'
    + '[PDF attached: tax.pdf — 94 pages. REDUCED to fit the context window: page images for page(s) 1-2, 47 only; extracted text of ALL pages below.]\n'
    + `[PDF note: ${NOTE}]\n`
    + '--- page 1 ---\nWages  12,345.00\n[end of PDF: tax.pdf]';
  const full = 'And this short one.\n\n'
    + '[PDF attached: memo.pdf — 3 pages. Complete: every page is attached as an image; extracted text of ALL pages below.]\n'
    + '--- page 1 ---\nMemo body\n[end of PDF: memo.pdf]';
  mock.addChat(CHAT, {
    title: 'Tax return',
    lastActiveAt: Date.now() - 1000,
    messages: [
      { role: 'user', content: reduced, parley_id: U_REDUCED, timestamp: t0,
        attachments: [{ idx: 0, url: `/api/parley/uploads/${U_REDUCED}/0`, mimeType: 'application/pdf', fileName: 'tax.pdf', size: 900000 }] },
      { role: 'assistant', content: 'Reviewed.', message_id: 'm-pdf-1', timestamp: t0 + 5 },
      { role: 'user', content: full, parley_id: U_FULL, timestamp: t0 + 60,
        attachments: [{ idx: 0, url: `/api/parley/uploads/${U_FULL}/0`, mimeType: 'application/pdf', fileName: 'memo.pdf', size: 20000 }] },
      { role: 'assistant', content: 'Memo read.', message_id: 'm-pdf-2', timestamp: t0 + 65 },
    ],
  });
}

export default async function run({ page, log }) {
  await waitForReady(page);
  await page.evaluate((cid) => {
    document.body.classList.add('sidebar-expanded');
    document.querySelector(`#sessions-list li[data-chat-id="${cid}"] .sess-body`)
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  }, CHAT);
  await pollUntil(page, (k) => !!document.querySelector(`#transcript .line[data-key="${k}"] .attachment-notice`), U_REDUCED,
    { timeout: 10_000, label: 'no caption on the reduced-PDF bubble' });
  const r = await page.evaluate(([a, b]) => {
    const red = document.querySelector(`#transcript .line[data-key="${a}"]`);
    const full = document.querySelector(`#transcript .line[data-key="${b}"]`);
    return {
      note: red.querySelector('.attachment-notice')?.textContent || '',
      noteAfterChip: !!red.querySelector('.line-attachments, .line-attachment-downloads')
        && (red.querySelector('.attachment-notice').compareDocumentPosition(red.querySelector('.line-attachments')) & Node.DOCUMENT_POSITION_PRECEDING) !== 0,
      redText: red.querySelector('.text')?.textContent || '',
      fullNote: !!full?.querySelector('.attachment-notice'),
      fullText: full?.querySelector('.text')?.textContent || '',
    };
  }, [U_REDUCED, U_FULL]);
  assert(r.note === NOTE, `caption text wrong: ${JSON.stringify(r.note)}`);
  assert(r.noteAfterChip, 'caption should sit below the PDF chip');
  assert(r.redText.trim() === 'Please review my return.', `extracted text leaked into the bubble: ${JSON.stringify(r.redText)}`);
  assert(!r.fullNote, 'a complete PDF must not get a caption');
  assert(r.fullText.trim() === 'And this short one.', `complete PDF block leaked: ${JSON.stringify(r.fullText)}`);
  log('reduced PDF captioned under its chip; complete PDF uncaptioned; blocks hidden ✓');
}
