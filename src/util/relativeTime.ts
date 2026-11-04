/**
 * @fileoverview "8 minutes ago" stamps for the message footer (Claude's
 * layout, 2026-11-04). The absolute time stays in the stamp's tooltip and
 * in the hidden HH:MM / date spans that day headers and tests read.
 */
export function formatRelative(ts: number, now: number = Date.now()): string {
  const diff = Math.max(0, now - ts);
  const s = Math.round(diff / 1000);
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return m === 1 ? '1 minute ago' : `${m} minutes ago`;
  const h = Math.round(m / 60);
  if (h < 24) return h === 1 ? '1 hour ago' : `${h} hours ago`;
  const d = new Date(ts); const today = new Date(now);
  const dayStart = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((dayStart(today) - dayStart(d)) / 86_400_000);
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  const sameYear = d.getFullYear() === today.getFullYear();
  return d.toLocaleDateString(undefined, sameYear ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' });
}

let ticker: number | null = null;

/** Re-stamp every relative span under `root` on a cadence; cheap text
 *  writes, and a hidden tab pauses them. */
export function startRelativeStampTicker(root: () => HTMLElement | null, intervalMs = 30_000): void {
  if (ticker !== null || typeof window === 'undefined') return;
  const tick = () => {
    if (document.hidden) return;
    const el = root();
    if (!el) return;
    const now = Date.now();
    for (const ts of Array.from(el.querySelectorAll<HTMLElement>('.line-ts[data-ts]'))) {
      const rel = ts.querySelector<HTMLElement>('.line-ts-rel');
      if (!rel) continue;
      const text = formatRelative(Number(ts.dataset.ts), now);
      if (rel.textContent !== text) rel.textContent = text;
    }
  };
  ticker = window.setInterval(tick, intervalMs);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
}
