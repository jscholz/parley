// Hands-free dictation must not summon the soft keyboard (his 2026-10-08
// report on the CAP app: the keyboard popped up over the composer while
// dictation filled it; he tapped ✓ to drop the keyboard, then the text
// area to see what had been dictated, every time).
//
// Root cause: every dictation/quote insert called textarea.focus() so
// execCommand('insertText') could keep the undo stack — and on a phone,
// focus() IS "show the keyboard". composer.mayStealFocus now only focuses
// on touch-primary devices when the textarea already has focus (the user
// is editing); otherwise the insert lands without focus.
//
// Runs as both variants: desktop keeps the focusing (undo-preserving)
// path; mobile (touch emulation → pointer: coarse) must insert the text
// WITHOUT focusing the textarea, and must still focus-insert when the
// user had the textarea focused already.

import { waitForReady } from './lib.mjs';

export const NAME = 'dictation-append-keeps-keyboard-down';
export const DESCRIPTION = 'composer.appendText: on touch devices a dictation insert lands without focusing the textarea (no soft keyboard); desktop keeps the undo-preserving focus path';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';
export const MOBILE = 'both';

export default async function run({ page, log }) {
  await waitForReady(page);

  const touch = await page.evaluate(() => window.matchMedia('(pointer: coarse)').matches);
  log(`pointer: ${touch ? 'coarse (mobile variant)' : 'fine (desktop variant)'}`);

  // Make sure nothing is focused, then dictate into an idle composer.
  const r1 = await page.evaluate(async () => {
    const ta = document.getElementById('composer-input') || document.querySelector('textarea');
    if (!ta) return { error: 'no composer textarea' };
    ta.value = '';
    ta.blur();
    document.body.focus?.();
    const mod = await import('/build/composer.mjs');
    mod.appendText('hello from dictation');
    return { value: ta.value, focused: document.activeElement === ta };
  });
  if (r1.error) throw new Error(r1.error);
  if (!/hello from dictation/.test(r1.value)) throw new Error(`dictated text did not land: ${JSON.stringify(r1)}`);
  if (touch && r1.focused) throw new Error('mobile: dictation insert focused the textarea (keyboard would pop up)');
  if (!touch && !r1.focused) throw new Error('desktop: dictation insert should take the focusing (undo-preserving) path');
  log(`idle composer: text landed, focused=${r1.focused} ✓`);

  // A user who IS editing (textarea focused) keeps the caret-aware path on
  // every device — dictating into an open keyboard is their choice.
  const r2 = await page.evaluate(async () => {
    const ta = document.getElementById('composer-input') || document.querySelector('textarea');
    ta.focus();
    const mod = await import('/build/composer.mjs');
    mod.appendText('and more');
    return { value: ta.value, focused: document.activeElement === ta };
  });
  if (!/and more/.test(r2.value)) throw new Error(`second insert did not land: ${JSON.stringify(r2)}`);
  if (!r2.focused) throw new Error('an already-focused textarea must stay focused across a dictation insert');
  log(`editing composer: text landed, focus kept ✓ (value="${r2.value.trim()}")`);
}
