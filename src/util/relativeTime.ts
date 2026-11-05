/**
 * @fileoverview Message stamps (2026-11-04/05). Relative for the last
 * hour, then the clock time, with the day in front once it is not today:
 *
 *   just now · 8 minutes ago · 14:32 · yesterday 14:32 · 15 Oct 14:32 ·
 *   15 Oct 2025 14:32
 *
 * Field 2026-11-05: "if I'm scrolling back in time through messages, it'd
 * be nice to be able to see when they land without having to hover each
 * one" — so the hour is never hidden behind the tooltip (which keeps the
 * full locale date-time).
 */
export function formatRelative(ts: number, now: number = Date.now()): string {
  const diff = Math.max(0, now - ts);
  const s = Math.round(diff / 1000);
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return m === 1 ? '1 minute ago' : `${m} minutes ago`;
  const d = new Date(ts); const today = new Date(now);
  const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const dayStart = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((dayStart(today) - dayStart(d)) / 86_400_000);
  if (days <= 0) return hhmm;
  if (days === 1) return `yesterday ${hhmm}`;
  const sameYear = d.getFullYear() === today.getFullYear();
  const date = d.toLocaleDateString(undefined, sameYear ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' });
  return `${date} ${hhmm}`;
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
