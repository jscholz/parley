/**
 * User-set title marker (meeting-polish #25, the never-clobber rule).
 *
 * The upstream has no user-vs-auto title distinction (hermes'
 * auto-titler and a manual PATCH rename write the same sessions.title
 * column — the known shadowing backlog item). But every MANUAL rename
 * from any sidekick client flows through this proxy's
 * `PATCH /api/sidekick/sessions/<id>` — so the proxy itself is the
 * cheapest place to remember "the user named this chat". The meeting
 * titling pipeline consults this marker and never overwrites a chat
 * the user has deliberately named.
 *
 * Deliberately NOT authoritative for what the title *is* (the upstream
 * owns that) — only for the fact that the user set one. Renames done
 * inside the agent itself (rare) aren't marked; that's the documented
 * limit of the heuristic.
 *
 * Storage: one small JSON map under the sidekick data home, same
 * atomic tmp-write + rename idiom as capture.ts. Bounded by pruning to
 * the most recent MAX_ENTRIES marks.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { dataHome } from '../dataHome.mjs';

interface UserTitleMark {
  title: string;
  at: number;   // epoch ms of the rename
}

const MAX_ENTRIES = 500;

let fileOverride: string | null = null;
let cache: Map<string, UserTitleMark> | null = null;
let writeChain: Promise<void> = Promise.resolve();

/** Test seam / explicit boot config. Resets the in-memory cache so
 *  tests get isolation. */
export function initUserTitles(opts?: { file?: string }): void {
  fileOverride = opts?.file ?? null;
  cache = null;
  writeChain = Promise.resolve();
}

function storeFile(): string {
  if (fileOverride) return fileOverride;
  return path.join(dataHome(), 'user-titles.json');
}

async function load(): Promise<Map<string, UserTitleMark>> {
  if (cache) return cache;
  const next = new Map<string, UserTitleMark>();
  try {
    const raw = JSON.parse(await fs.readFile(storeFile(), 'utf8'));
    for (const [chatId, mark] of Object.entries(raw?.chats ?? {})) {
      const m = mark as UserTitleMark;
      if (m && typeof m.title === 'string') next.set(chatId, { title: m.title, at: Number(m.at) || 0 });
    }
  } catch { /* first run / torn file — empty map; marks re-accumulate */ }
  cache = next;
  return next;
}

async function persist(map: Map<string, UserTitleMark>): Promise<void> {
  // Prune oldest marks beyond the cap so the file stays bounded.
  if (map.size > MAX_ENTRIES) {
    const sorted = [...map.entries()].sort((a, b) => b[1].at - a[1].at).slice(0, MAX_ENTRIES);
    map.clear();
    for (const [k, v] of sorted) map.set(k, v);
  }
  const file = storeFile();
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, JSON.stringify({ chats: Object.fromEntries(map) }, null, 1));
  await fs.rename(tmp, file);
}

/** Record that the user manually renamed `chatId`. Fire-and-forget
 *  safe: writes are chained so concurrent renames can't tear the file. */
export async function markUserTitled(chatId: string, title: string): Promise<void> {
  const map = await load();
  map.set(chatId, { title, at: Date.now() });
  writeChain = writeChain.then(
    () => persist(map),
    () => persist(map),
  ).catch((e) => { console.warn(`[user-titles] persist failed: ${String(e)}`); });
  await writeChain;
}

/** Has the user manually named this chat (via any sidekick client)? */
export async function isUserTitled(chatId: string): Promise<boolean> {
  return (await load()).has(chatId);
}
