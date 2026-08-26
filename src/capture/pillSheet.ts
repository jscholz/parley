// Pill overflow sheet — the recording's non-primary verbs (B1
// destructive-action pass). The 2026-08-18 incident put a 15px discard
// ✕ 10px from an near-identical stop ■ and a real meeting died to a
// mis-tap; the fix is structural: the live pill carries only
// mark / pause / stop, and anything destructive lives HERE, one
// deliberate hop away, still behind confirmDialog, with a post-discard
// Undo backed by the server's Recently-Deleted tombstone. This is the
// "pill sheet" recorder.ts's rename/diarize comments point at — those
// rows land here when they ship.

import { confirmDialog } from '../confirmDialog.ts';
import {
  cancelMeetingCapture, restoreDiscardedCapture, getCaptureState,
} from './recorder.ts';
import { toast, toastAction } from '../toast.ts';

/** Open the sheet for the CURRENT capture (··· button on the pill).
 *  Bottom sheet on mobile, centered card on desktop — CSS owns the
 *  shape (.capture-sheet). */
export function openPillSheet(): void {
  document.querySelector('.capture-sheet-overlay')?.remove();   // one at a time
  const st = getCaptureState();
  // The pill (and its ··· trigger) only exists while a capture is live
  // or starting; a stale click after stop has nothing to act on.
  if (!st.active && st.phase !== 'starting') return;

  const overlay = document.createElement('div');
  overlay.className = 'capture-sheet-overlay';
  const sheet = document.createElement('div');
  sheet.className = 'capture-sheet';
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-modal', 'true');
  sheet.setAttribute('aria-label', 'Recording options');

  const title = document.createElement('div');
  title.className = 'capture-sheet-title';
  title.textContent = st.title || 'Recording';
  sheet.appendChild(title);

  const discard = document.createElement('button');
  discard.type = 'button';
  discard.className = 'capture-sheet-row capture-sheet-discard';
  const discardLabel = document.createElement('span');
  discardLabel.textContent = 'Discard recording…';
  const discardSub = document.createElement('span');
  discardSub.className = 'capture-sheet-sub';
  discardSub.textContent = 'Moves to Recently Deleted — recoverable for ~7 days';
  discard.append(discardLabel, discardSub);
  sheet.appendChild(discard);

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'capture-sheet-row capture-sheet-close';
  close.textContent = 'Close';
  sheet.appendChild(close);

  overlay.appendChild(sheet);

  const dismiss = () => {
    document.removeEventListener('keydown', onKey, true);
    overlay.remove();
  };
  const onKey = (ev: KeyboardEvent) => {
    if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); dismiss(); }
  };
  document.addEventListener('keydown', onKey, true);
  overlay.addEventListener('click', (ev) => { if (ev.target === overlay) dismiss(); });
  close.addEventListener('click', dismiss);
  discard.addEventListener('click', () => { dismiss(); void discardFlow(); });

  document.body.appendChild(overlay);
  close.focus();   // default focus = the safe option, same rule as confirmDialog
}

/** Sheet → confirm → soft discard → Undo toast. IN-APP dialog, not
 *  window.confirm (2026-08-18 incident: native confirm in an iOS
 *  standalone PWA is unreliable, and a tap queued on a frozen phone can
 *  replay onto its OK — confirmDialog default-focuses CANCEL and names
 *  the action explicitly). The dialog and the toast are UX; the safety
 *  boundary is the server's soft discard underneath. */
async function discardFlow(): Promise<void> {
  const ok = await confirmDialog({
    title: 'Discard this recording?',
    body: 'It moves to Recently Deleted on the server (recoverable for ~7 days). Nothing is saved to the chat or sent to the agent.',
    confirmLabel: 'Discard to Recently Deleted',
    cancelLabel: 'Keep recording',
    danger: true,
  });
  if (!ok) return;
  const discardedId = await cancelMeetingCapture();
  // null = a start still coming up was stood down — nothing was
  // tombstoned, so there is nothing to undo (and nothing was lost).
  if (!discardedId) return;
  toastAction('Recording discarded', {
    actionLabel: 'Undo',
    onAction: () => {
      void restoreDiscardedCapture(discardedId)
        .then(() => {
          // Restore is data recovery, not resume: the capture comes
          // back finished on the meetings shelf, mic stays off.
          toast('Recording restored — find it in the meetings shelf.');
        })
        .catch(() => {
          toast('Could not restore — the recording is still in Recently Deleted on the server.', 'err');
        });
    },
  });
}
