/**
 * @fileoverview Generic transient toast. Use for messages that MUST stay
 * visible regardless of the header status line — which is a shared surface
 * that background pollers (memoOutbox network-status refresher, 2s) clobber
 * within seconds. Attachment rejections route here so a "file too large"
 * notice doesn't vanish before the user reads it.
 *
 * Visual reuses the session-announce-toast bubble (.toast clones its CSS);
 * `err` variant tints it red.
 */

let toastEl: HTMLElement | null = null;
let toastTimer: ReturnType<typeof setTimeout> | null = null;

const DEFAULT_MS = 5000;

// Warning triangle (heroicons-style): round-capped strokes so it reads
// crisp at 15px. Colour is inherited (currentColor) so CSS owns the accent.
const ERR_ICON =
  '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" ' +
  'stroke="currentColor" stroke-width="1.5" stroke-linecap="round" ' +
  'stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M8 2.2 14.6 13.3H1.4Z"/><path d="M8 6.4v3"/><path d="M8 11.6h.01"/>' +
  '</svg>';

export function toast(msg: string, kind?: 'err', durationMs = DEFAULT_MS): void {
  ensureToast();
  if (!toastEl) return;
  const isErr = kind === 'err';
  // Rebuild content each call: an optional accent icon carries the "error"
  // semantic so the body text can stay high-contrast (readable) instead of
  // being dyed the accent colour.
  toastEl.replaceChildren();
  if (isErr) {
    const icon = document.createElement('span');
    icon.className = 'toast-icon';
    icon.innerHTML = ERR_ICON;
    toastEl.appendChild(icon);
  }
  const text = document.createElement('span');
  text.className = 'toast-text';
  text.textContent = msg;
  toastEl.appendChild(text);
  toastEl.classList.toggle('err', isErr);
  toastEl.classList.remove('has-action');   // plain toast is not clickable
  toastEl.classList.add('visible');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl?.classList.remove('visible'), durationMs);
}

/** PERSISTENT action toast ("Recording discarded · Undo", B1 pass).
 *  No auto-dismiss: an undo on a countdown the user doesn't know
 *  they're on is barely an undo — it stays up until the action is
 *  taken, the ✕ dismisses it, or a later toast replaces it. The
 *  action itself is one tap (the confirm already happened on the
 *  destructive side; making the RECOVERY path ask again would invert
 *  the safety asymmetry). */
export function toastAction(
  msg: string,
  opts: { actionLabel: string; onAction: () => void },
): void {
  ensureToast();
  if (!toastEl) return;
  toastEl.replaceChildren();
  const text = document.createElement('span');
  text.className = 'toast-text';
  text.textContent = msg;
  toastEl.appendChild(text);
  const action = document.createElement('button');
  action.type = 'button';
  action.className = 'toast-action';
  action.textContent = opts.actionLabel;
  action.addEventListener('click', () => {
    toastEl?.classList.remove('visible', 'has-action');
    opts.onAction();
  });
  toastEl.appendChild(action);
  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  dismiss.className = 'toast-dismiss';
  dismiss.setAttribute('aria-label', 'Dismiss');
  dismiss.textContent = '✕';
  dismiss.addEventListener('click', () => toastEl?.classList.remove('visible', 'has-action'));
  toastEl.appendChild(dismiss);
  toastEl.classList.remove('err');
  toastEl.classList.add('has-action', 'visible');   // has-action re-enables pointer events
  if (toastTimer) { clearTimeout(toastTimer); toastTimer = null; }
}

function ensureToast(): void {
  if (toastEl) return;
  if (typeof document === 'undefined') return;
  toastEl = document.getElementById('app-toast');
  if (toastEl) return;
  toastEl = document.createElement('div');
  toastEl.id = 'app-toast';
  toastEl.className = 'toast';
  toastEl.setAttribute('role', 'status');
  toastEl.setAttribute('aria-live', 'polite');
  document.body.appendChild(toastEl);
}
