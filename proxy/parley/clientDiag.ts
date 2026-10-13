/**
 * Client diagnostics log — POST /api/parley/diag/client, GET to read.
 *
 * Why (2026-10-13): his laptop app hung ("Aw, Snap! RESULT_CODE_HUNG")
 * on a click and nothing could say why — the debug relay is off on real
 * devices and a hung renderer logs nothing after the fact. Watchdogs in
 * the client post ONE line here when they catch a pathology (a render
 * loop), with a stack, BEFORE it can take the page down.
 *
 * Bounded (newest 500 lines kept), fields whitelisted, body capped.
 * Per data home (per tenant): <dataHome>/logs/client-diag.log.
 */
import http from 'node:http';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { dataHome } from '../dataHome.mjs';

const MAX_BODY = 16 * 1024;
const MAX_LINES = 500;
const FIELDS = ['kind', 'detail', 'chatId', 'count', 'windowMs', 'stack', 'ua', 'build', 'clientTs', 'visibility'] as const;

let resolver: () => string = () => path.join(dataHome(), 'logs', 'client-diag.log');
export function setClientDiagPathForTests(fn: () => string): void { resolver = fn; }

let chain: Promise<void> = Promise.resolve();

export async function recordClientDiag(entry: Record<string, unknown>): Promise<void> {
  const clean: Record<string, unknown> = { ts: new Date().toISOString() };
  for (const k of FIELDS) {
    const v = entry[k];
    if (v === undefined || v === null) continue;
    clean[k] = typeof v === 'number' || typeof v === 'boolean' ? v : String(v).slice(0, k === 'stack' ? 4000 : 400);
  }
  const file = resolver();
  chain = chain.then(async () => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.appendFile(file, JSON.stringify(clean) + '\n');
    const lines = (await fs.readFile(file, 'utf8')).split('\n').filter(Boolean);
    if (lines.length > MAX_LINES * 2) await fs.writeFile(file, lines.slice(-MAX_LINES).join('\n') + '\n');
  }).catch(() => { /* never fail the request path */ });
  return chain;
}

export async function handleClientDiag(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (req.method === 'GET') {
    const text = await fs.readFile(resolver(), 'utf8').catch(() => '');
    const rows = text.split('\n').filter(Boolean).slice(-100).map((l) => { try { return JSON.parse(l); } catch { return { raw: l }; } });
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ entries: rows }));
    return;
  }
  if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
  const chunks: Buffer[] = []; let total = 0;
  for await (const c of req) { total += (c as Buffer).length; if (total > MAX_BODY) { res.writeHead(413); res.end(); return; } chunks.push(c as Buffer); }
  let body: any;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { res.writeHead(400); res.end(); return; }
  if (!body || typeof body.kind !== 'string') { res.writeHead(400); res.end(); return; }
  await recordClientDiag(body);
  res.writeHead(204); res.end();
}
