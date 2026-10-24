// Text uploads (field 2026-10-24: "Enable me to upload text files,
// including .md files and anything else that is a synonym for a plain
// text source. Currently, parley rejects it."). The composer accepts
// text by MIME or by extension when the browser sends none, shows an
// extension chip, needs no vision capability, and sends it as
// `type: 'file'` with a truthful MIME so the plugin inlines it.

import { waitForReady, assert } from './lib.mjs';

export const NAME = 'composer-attach-text-file';
export const DESCRIPTION = 'Composer accepts .md/.txt/source files (by MIME or extension), chips them, and sends them as file attachments with a truthful MIME';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const chips = (page) => page.evaluate(() =>
  Array.from(document.querySelectorAll('#composer-attachments .attachment-chip')).map((c) => ({
    label: c.querySelector('.chip-pdf-label')?.textContent || '', file: c.classList.contains('chip-file'),
  })));
const toastErr = (page) => page.evaluate(() => {
  const el = document.getElementById('app-toast');
  return !!(el && el.classList.contains('visible') && el.classList.contains('err'));
});
async function addFile(page, { text, type, name }) {
  await page.evaluate(async (args) => {
    const mod = await import('/build/attachments.mjs');
    const file = new File([args.text], args.name, { type: args.type });
    await mod.add(file);
  }, { text, type, name });
}

export default async function run({ page, log }) {
  await waitForReady(page);
  await addFile(page, { text: '# Notes\n\nhello', type: '', name: 'notes.md' });      // no MIME, as browsers do for .md
  await addFile(page, { text: 'plain', type: 'text/plain', name: 'readme.txt' });
  await addFile(page, { text: 'export const x = 1;', type: 'video/mp2t', name: 'recorder.ts' }); // mislabeled TypeScript
  await addFile(page, { text: '{"a":1}', type: 'application/json', name: 'data.json' });
  const c = await chips(page);
  assert(c.length === 4 && c.every((x) => x.file), `four text files must chip (got ${JSON.stringify(c)})`);
  assert(c.map((x) => x.label).join(',') === 'MD,TXT,TS,JSON', `chips carry the extension (got ${JSON.stringify(c)})`);
  assert(!(await toastErr(page)), 'no rejection toast for text files');
  log('md (no MIME), txt, mislabeled ts, json → four chips, no rejection ✓');

  // Still rejected: a real binary.
  await addFile(page, { text: 'PK\u0003\u0004', type: 'application/zip', name: 'archive.zip' });
  assert((await chips(page)).length === 4 && (await toastErr(page)), 'a zip is still rejected with a toast');
  log('zip → rejected ✓');

  // Send: the payload carries type 'file' + a truthful MIME + inline content.
  const reqP = page.waitForRequest('**/api/parley/messages', { timeout: 5_000 });
  await page.fill('#composer-input', 'here are the files');
  await page.evaluate(() => document.getElementById('composer-send')?.click());
  const body = JSON.parse((await reqP).postData() || '{}');
  assert(Array.isArray(body.attachments) && body.attachments.length === 4, `four attachments sent (got ${JSON.stringify(body.attachments?.length)})`);
  const byName = Object.fromEntries(body.attachments.map((a) => [a.fileName, a]));
  assert(byName['notes.md'].type === 'file' && byName['notes.md'].mimeType === 'text/markdown', `notes.md → file/text/markdown: ${JSON.stringify(byName['notes.md'])}`);
  assert(byName['recorder.ts'].mimeType === 'text/plain', `mislabeled .ts is sent as text/plain: ${JSON.stringify(byName['recorder.ts'])}`);
  assert(byName['data.json'].mimeType === 'application/json' && byName['data.json'].type === 'file', 'json stays application/json as a file');
  assert(body.attachments.every((a) => typeof a.content === 'string' && a.content.startsWith('data:')), 'small text files ride inline');
  log('send: type=file, truthful MIME, inline content ✓');
}
