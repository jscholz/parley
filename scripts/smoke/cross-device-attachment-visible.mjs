// Field 2026-10-24: "I uploaded a PDF on my mobile from the CAP and then
// looked at it from my desktop, and I didn't see any evidence that the
// PDF was attached." The cross-device user_message broadcast carried
// only the text. It now carries the files' durable metadata, and the
// bubble another device paints from it shows the chips and download
// links — the same as the sender's own bubble.

import { waitForReady, assert, openSidebar, clickRow } from './lib.mjs';

export const NAME = 'cross-device-attachment-visible';
export const DESCRIPTION = 'A user message sent from another device renders its attachments (PDF/file chips + downloads) from the broadcast metadata';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_ID = 'mock-xdev-attach-chat';

export function MOCK_SETUP(mock) {
  mock.addChat(CHAT_ID, {
    title: 'Bank statements', lastActiveAt: Date.now() - 1000,
    messages: [{ role: 'user', content: 'seed', parley_id: 'umsg_xd_seed', timestamp: Date.now() / 1000 - 60 }],
  });
}

export default async function run({ page, log, mock }) {
  await waitForReady(page);
  await openSidebar(page);
  await clickRow(page, CHAT_ID);
  await page.waitForFunction(() => document.querySelector('#transcript .line.s0'), null, { timeout: 6000 });

  // The phone sent a PDF and a markdown file; this device only sees the broadcast.
  mock.pushEnvelope({
    type: 'user_message', chat_id: CHAT_ID, message_id: 'umsg_from_phone_1',
    text: "Here's the previous bank statement.",
    attachments: [
      { idx: 0, fileName: 'Statement 18-SEP-26.pdf', mimeType: 'application/pdf', size: 303079, url: '/api/parley/uploads/umsg_from_phone_1/0' },
      { idx: 1, fileName: 'notes.md', mimeType: 'text/markdown', size: 1200, url: '/api/parley/uploads/umsg_from_phone_1/1' },
    ],
  });
  await page.waitForFunction(() => Array.from(document.querySelectorAll('#transcript .line.s0'))
    .some((l) => /previous bank statement/.test(l.textContent || '')), null, { timeout: 6000, polling: 50 });
  const seen = await page.evaluate(() => {
    const l = Array.from(document.querySelectorAll('#transcript .line.s0')).find((x) => /previous bank statement/.test(x.textContent || ''));
    return {
      pdfChip: l.querySelector('.pdf-chip:not(.file-chip)')?.textContent?.trim() || '',
      fileChip: l.querySelector('.file-chip')?.textContent?.trim() || '',
      downloads: Array.from(l.querySelectorAll('.attachment-dl')).map((a) => a.getAttribute('href')),
    };
  });
  assert(/Statement 18-SEP-26\.pdf/.test(seen.pdfChip), `PDF chip must show on the other device: ${JSON.stringify(seen)}`);
  assert(/notes\.md/.test(seen.fileChip), `text-file chip must show on the other device: ${JSON.stringify(seen)}`);
  assert(seen.downloads.length === 2 && seen.downloads.every((h) => /\/api\/parley\/uploads\/umsg_from_phone_1\/[01]$/.test(h || '')),
    `download links point at the durable copies: ${JSON.stringify(seen.downloads)}`);
  log('other device: PDF chip, file chip, two download links ✓');
}
