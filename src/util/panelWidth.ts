/**
 * @fileoverview Panel widths persisted as a FRACTION of the viewport, not
 * pixels (field 2026-10-26: "when I unplug the screen and resize, preserve
 * the ratios"). A width saved on a 2560-wide monitor re-applies as the
 * same share of a 1440-wide laptop, clamped to the panel's limits. Legacy
 * pixel-only values still parse.
 */
export interface PersistedWidth { px: number; frac: number }

export function encodeWidth(px: number, viewportWidth: number): string {
  const vw = viewportWidth > 0 ? viewportWidth : px;
  return JSON.stringify({ px: Math.round(px), frac: Math.round((px / vw) * 10_000) / 10_000 });
}

/** Resolve a stored value against the CURRENT viewport. null = nothing usable. */
export function decodeWidth(raw: string | null, viewportWidth: number): number | null {
  if (!raw) return null;
  const n = Number.parseInt(raw, 10);
  if (raw.trim().startsWith('{')) {
    try {
      const v = JSON.parse(raw) as Partial<PersistedWidth>;
      if (typeof v.frac === 'number' && Number.isFinite(v.frac) && v.frac > 0 && viewportWidth > 0) return Math.round(v.frac * viewportWidth);
      if (typeof v.px === 'number' && Number.isFinite(v.px)) return Math.round(v.px);
    } catch { /* fall through */ }
    return null;
  }
  return Number.isFinite(n) ? n : null;
}
