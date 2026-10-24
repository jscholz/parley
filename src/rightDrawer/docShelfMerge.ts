// Pure decision for reconciling this device's Docs shelf with the shared
// one (2026-10-24, field: "my expectation is for these to merge open
// documents rather than intersect them" — the first build closed every
// doc the phone had that the laptop's shelf lacked, on first contact).
//
// The rule: a doc is closed here ONLY when this device has previously
// SEEN it on the shared shelf and the shelf no longer has it — that is an
// explicit close somewhere. A doc the shared shelf never knew about is
// ours to contribute: it stays open and goes up. Knowledge, not version
// numbers, decides; a device with no knowledge (first contact, cleared
// storage) can only ever merge.

export interface InboundPlan {
  /** Remote ids we do not hold — open them (content fetched by the caller). */
  toOpen: string[];
  /** Local ids to close: known to the shelf before, absent from it now. */
  toClose: string[];
  /** Local ids the shelf never knew — keep, and push up. */
  toContribute: string[];
}

export function planInbound(
  localIds: Iterable<string>,
  remoteIds: Iterable<string>,
  knownRemoteIds: Iterable<string>,
): InboundPlan {
  const local = new Set(localIds);
  const remote = new Set(remoteIds);
  const known = new Set(knownRemoteIds);
  const toOpen: string[] = [];
  for (const id of remote) if (!local.has(id)) toOpen.push(id);
  const toClose: string[] = [];
  const toContribute: string[] = [];
  for (const id of local) {
    if (remote.has(id)) continue;
    if (known.has(id)) toClose.push(id);
    else toContribute.push(id);
  }
  return { toOpen, toClose, toContribute };
}
