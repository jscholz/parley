/**
 * Playback audit — every reply-audio START the client makes, with the
 * trigger that caused it, appended to `<dataHome>/logs/playback-audit.log`.
 *
 * Why (2026-10-11, the fourth "it spoke by itself" report): the client has
 * five ways to start reply speech (a tap, a Listen-turn autoplay, a Media
 * Session / headset skip, a remote 'play', a replay), the debug relay is
 * off on real devices, and the proxy never logged `/tts`. Each report
 * ended as a theory. One JSON line per start — trigger, gate reason,
 * reply id, chat, tts state, call state, page visibility — turns the
 * next report into a grep. Always on, tiny, per data home (per tenant).
 *
 * Append-only; truncated to the newest MAX_LINES when it grows past
 * 2 × MAX_LINES. Body size capped; unknown fields dropped.
 */
import http from 'node:http';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { dataHome } from '../dataHome.mjs';

const MAX_BODY = 8 * 1024;
const MAX_LINES = 1000;
const FIELDS = ['trigger', 'reason', 'replyId', 'chatId', 'ttsState', 'callOpen', 'visibility', 'ua', 'clientTs'] as const;

let resolver: () => string = () => path.join(dataHome(), 'logs', 'playback-audit.log');
export function setPlaybackAuditPathForTests(fn: () => string): void { resolver = fn; }
export function playbackAuditPath(): string { return resolver(); }

let chain: Promise<void> = Promise.resolve();

export async function recordPlaybackStart(entry: Record<string, unknown>): Promise<void> {
  const clean: Record<string, unknown> = { ts: new Date().toISOString() };
  for (const k of FIELDS) {
    const v = entry[k];
    if (v === undefined || v === null) continue;
    clean[k] = typeof v === 'string' ? v.slice(0, 200) : (typeof v === 'boolean' ? v : String(v).slice(0, 200));
  }
  const file = playbackAuditPath();
  chain = chain.then(async () => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.appendFile(file, JSON.stringify(clean) + '\n');
    try {
      const text = await fs.readFile(file, 'utf8');
      const lines = text.split('\n').filter(Boolean);
      if (lines.length > MAX_LINES * 2) {
        await fs.writeFile(file, lines.slice(-MAX_LINES).join('\n') + '\n');
      }
    } catch { /* best effort */ }
  }).catch(() => { /* never fail the request path */ });
  return chain;
}

export async function handlePlaybackAudit(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (req.method !== 'POST') { res.writeHead(405); res.end('method not allowed'); return; }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const c of req) {
    total += (c as Buffer).length;
    if (total > MAX_BODY) { res.writeHead(413); res.end('too large'); return; }
    chunks.push(c as Buffer);
  }
  let body: Record<string, unknown>;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
  catch { res.writeHead(400); res.end('bad json'); return; }
  if (!body || typeof body !== 'object' || typeof body.trigger !== 'string') { res.writeHead(400); res.end('trigger required'); return; }
  await recordPlaybackStart(body);
  res.writeHead(204); res.end();
}

/** Newest entries, for `/api/parley/diag/playback` GET (ops) and tests. */
export async function readPlaybackAudit(limit = 50): Promise<Record<string, unknown>[]> {
  try {
    const text = await fs.readFile(playbackAuditPath(), 'utf8');
    return text.split('\n').filter(Boolean).slice(-limit).map((l) => { try { return JSON.parse(l); } catch { return { raw: l }; } });
  } catch { return []; }
}
