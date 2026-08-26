// Lazy SortableJS loader shared by the doc rail tabs and the doc list
// view. Same vendored bundle the pinned-session reorder uses
// (sessionDrawer.ts) — bundled separately at build time so the drag
// library never rides in the boot-critical chunk.

import { log } from '../util/log.ts';

const SORTABLE_BUNDLE_URL = '/build/vendor/sortable.mjs';

let lib: typeof import('sortablejs') | null = null;
let inflight: Promise<typeof import('sortablejs') | null> | null = null;

export async function loadSortable(): Promise<typeof import('sortablejs') | null> {
  if (lib) return lib;
  if (!inflight) {
    inflight = import(/* webpackIgnore: true */ SORTABLE_BUNDLE_URL)
      .then((mod: any) => {
        lib = (mod?.default ?? mod) as typeof import('sortablejs');
        return lib;
      })
      .catch((err: any) => {
        // Reorder is an enhancement — tabs/list stay fully usable
        // without it. Null (not throw) so callers degrade in one line;
        // clearing inflight lets a later render retry the load.
        log(`[doc-tabs] Sortable load failed; drag-reorder disabled: ${err?.message || err}`);
        inflight = null;
        return null;
      });
  }
  return inflight;
}
