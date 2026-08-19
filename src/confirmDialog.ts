/**
 * In-app confirmation dialog — replaces window.confirm for destructive
 * actions (2026-08-18 meeting-capture incident: the last gate in front
 * of 20 minutes of audio was a window.confirm, which in an iOS
 * standalone PWA / WKWebView is unreliable — it can auto-return, and a
 * tap queued on a frozen phone can replay straight onto its OK as the
 * UI thaws).
 *
 * Safety properties the native dialog lacks:
 *   - The CANCEL button holds default focus — a queued Enter/tap
 *     replaying as the page thaws lands on "keep", not "destroy".
 *   - Backdrop click and Escape both cancel.
 *   - The confirm button carries an explicit action label ("Discard to
 *     Recently Deleted"), never a bare OK.
 *
 * The dialog is deliberately UX, not the safety boundary — destructive
 * server verbs behind it must themselves be recoverable (soft discard).
 */

export interface ConfirmDialogOpts {
  title: string;
  body?: string;
  /** Explicit action label — say what the button DOES, never "OK". */
  confirmLabel: string;
  cancelLabel?: string;
  /** Style the confirm button as destructive (red). */
  danger?: boolean;
}

export function confirmDialog(opts: ConfirmDialogOpts): Promise<boolean> {
  return new Promise((resolve) => {
    document.querySelector('.sk-confirm-overlay')?.remove();   // one at a time

    const overlay = document.createElement('div');
    overlay.className = 'sk-confirm-overlay';
    const box = document.createElement('div');
    box.className = 'sk-confirm';
    box.setAttribute('role', 'alertdialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-label', opts.title);

    const title = document.createElement('div');
    title.className = 'sk-confirm-title';
    title.textContent = opts.title;
    box.appendChild(title);
    if (opts.body) {
      const body = document.createElement('div');
      body.className = 'sk-confirm-body';
      body.textContent = opts.body;
      box.appendChild(body);
    }

    const actions = document.createElement('div');
    actions.className = 'sk-confirm-actions';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'sk-confirm-cancel';
    cancel.textContent = opts.cancelLabel || 'Cancel';
    const accept = document.createElement('button');
    accept.type = 'button';
    accept.className = 'sk-confirm-accept' + (opts.danger ? ' danger' : '');
    accept.textContent = opts.confirmLabel;
    actions.appendChild(cancel);
    actions.appendChild(accept);
    box.appendChild(actions);
    overlay.appendChild(box);

    const done = (ok: boolean) => {
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      resolve(ok);
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); done(false); }
    };
    document.addEventListener('keydown', onKey, true);
    overlay.addEventListener('click', (ev) => { if (ev.target === overlay) done(false); });
    cancel.addEventListener('click', () => done(false));
    accept.addEventListener('click', () => done(true));

    document.body.appendChild(overlay);
    cancel.focus();   // default focus = the SAFE option
  });
}
