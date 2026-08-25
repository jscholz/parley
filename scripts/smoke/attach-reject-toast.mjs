// Pins the attachment-rejection UX (src/attachments.ts add()). Regression
// guard for the "no error, no nothing" bug: a 57 MB PDF was rejected by the
// client size cap, but the rejection used the header status line — which the
// memoOutbox network-status refresher (2s) overwrites — so the notice flashed
// and vanished and the user saw nothing happen.
//
// The fix routes rejections through a TOAST (#app-toast) that owns its own
// timer and is never clobbered by the status refresher.
//
// Two rejection cases, both must surface a visible toast AND add no chip:
//   A. oversized (> MAX_BYTES 100 MB) → "File too large" toast.
//   B. unsupported type (text/plain) → "Only image, video, and PDF" toast.
//
// And one accept case (sanity): a small image is accepted (chip rendered,
// no error toast) — proves the reject path isn't rejecting everything.

import { waitForReady, assert } from './lib.mjs';

export const NAME = 'attach-reject-toast';
export const DESCRIPTION = 'attachments.add: oversized / wrong-type rejections show a persistent toast (not clobbered status), add no chip';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const chipCount = (page) =>
  page.evaluate(() => document.querySelectorAll('#composer-attachments .attachment-chip').length);

const toastState = (page) =>
  page.evaluate(() => {
    const el = document.getElementById('app-toast');
    if (!el) return { present: false };
    return {
      present: true,
      visible: el.classList.contains('visible'),
      err: el.classList.contains('err'),
      text: el.textContent || '',
    };
  });

// Drive attachments.add directly with a synthetic File so we don't depend on
// the model vision-gate (which disables the + button). The onchange handler
// in main.ts calls attachments.add per file; we import the module and call it.
async function addFile(page, { bytes, type, name }) {
  await page.evaluate(async (args) => {
    const mod = await import('/build/attachments.mjs');
    const buf = new Uint8Array(args.bytes);
    const file = new File([buf], args.name, { type: args.type });
    await mod.add(file);
  }, { bytes, type, name });
}

export default async function run({ page, log }) {
  await waitForReady(page);

  // ── A: oversized → toast + no chip ──────────────────────────────────
  // Over the 100 MB cap (task #158 raised MAX_BYTES from 20 → 100 MB).
  //
  // Deliberately an IMAGE even though the original incident was a 57 MB
  // PDF. add() gates on PDF capability BEFORE size (attachments.ts:209),
  // and canAttachPdf() resolves through a per-model capability lookup —
  // so with a PDF this case silently tests whichever model the target
  // server happens to have configured. On a sandbox with no model it
  // returned "Current model can't accept PDF attachments" and the case
  // failed for a reason that had nothing to do with the size cap
  // (2026-08-25). An image reaches the size branch on any server, which
  // is what this case is actually about. Don't "restore fidelity" by
  // putting the PDF back without also stubbing the capability tier.
  await addFile(page, { bytes: 101 * 1000 * 1000, type: 'image/png', name: 'huge.png' });
  let t = await toastState(page);
  assert(t.present && t.visible, 'A: oversized rejection must show a visible toast');
  assert(t.err, 'A: rejection toast must use the err variant');
  assert(/too large/i.test(t.text), `A: toast should say "too large" (got ${JSON.stringify(t.text)})`);
  assert((await chipCount(page)) === 0, 'A: oversized file must NOT add a chip');
  log('A ✓ oversized image → persistent error toast, no chip');

  // ── B: unsupported type → toast + no chip ───────────────────────────
  await addFile(page, { bytes: 1024, type: 'text/plain', name: 'notes.txt' });
  t = await toastState(page);
  assert(t.visible && t.err, 'B: unsupported-type rejection must show a visible err toast');
  assert(/image, video, and pdf/i.test(t.text), `B: toast should name the supported types (got ${JSON.stringify(t.text)})`);
  assert((await chipCount(page)) === 0, 'B: unsupported file must NOT add a chip');
  log('B ✓ wrong type → persistent error toast, no chip');

  // ── C: small image accepted (chip rendered) ─────────────────────────
  // 1x1 transparent PNG bytes are unnecessary — add() reads via FileReader
  // which accepts any bytes; only mime + size gate acceptance.
  await addFile(page, { bytes: 2048, type: 'image/png', name: 'tiny.png' });
  await page.waitForFunction(
    () => document.querySelectorAll('#composer-attachments .attachment-chip').length === 1,
    null, { timeout: 3_000 },
  );
  assert((await chipCount(page)) === 1, 'C: a small image under the cap must be accepted (chip rendered)');
  log('C ✓ small image accepted → chip rendered');

  log('PASS: attachment rejections surface a persistent toast; valid files still attach');
}
