// Web Push (VAPID) module facade — Phase 3 of the notifications work.
//
// Owns the application-server identity (VAPID keypair), the subscription
// store, the route handlers, and (in Phase 3c) the dispatch path that
// sends pushes from SSE envelopes flagged should_push.
//
// init() is called once from server.ts at boot. Env-derived config:
//
//   VAPID_PUBLIC_KEY     base64url-encoded public half (sent to client)
//   VAPID_PRIVATE_KEY    base64url-encoded private half (NEVER exposed)
//   VAPID_SUBJECT        RFC 8292 contact (mailto: or https:)
//
// All three are required to enable push. Missing any one disables the
// feature gracefully — subscribe/unsubscribe return 503, the client UI
// presents the toggle as "configure VAPID keys on the server first".
//
// Storage: JSON file at `<dataDir>/push-subscriptions.json`. Default
// dataDir is `~/.parley/notifications/` (XDG-ish; host-scoped, not in
// cwd). Override via PARLEY_NOTIFICATIONS_DIR env var if needed.
//
// Not in this file:
//   - Routes themselves (see routes.ts — kept separate so server.ts
//     imports the same way it does for sessions / search / etc.).
//   - Dispatch (see dispatch.ts — lands in Phase 3c).

import * as path from 'node:path';
import * as os from 'node:os';
import { readEnv } from '../../env.mjs';
import { dataHome } from '../../dataHome.mjs';
import { initStorage } from './storage.ts';
import { initMutes, __resetMutesForTest } from './mutes.ts';
import { initPrefs, __resetPrefsForTest } from './prefs.ts';

interface VapidConfig {
  publicKey: string;
  privateKey: string;
  subject: string;
}

let vapid: VapidConfig | null = null;
let ready = false;

/** Resolve VAPID config from env + initialize storage. Idempotent.
 *  Returns true if the module is fully configured + ready to accept
 *  subscriptions, false if VAPID env is missing (silently disabled). */
export async function init(opts?: {
  publicKey?: string;
  privateKey?: string;
  subject?: string;
  dataDir?: string;
}): Promise<boolean> {
  if (ready) return vapid !== null;
  const publicKey = opts?.publicKey || process.env.VAPID_PUBLIC_KEY || '';
  const privateKey = opts?.privateKey || process.env.VAPID_PRIVATE_KEY || '';
  const subject = opts?.subject || process.env.VAPID_SUBJECT || '';

  const dataDir = opts?.dataDir
    || readEnv('PARLEY_NOTIFICATIONS_DIR')
    || path.join(dataHome(), 'notifications');
  await initStorage({ dataDir });
  await initMutes({ dataDir });
  await initPrefs({ dataDir });

  if (!publicKey || !privateKey || !subject) {
    console.log('[notifications] VAPID config incomplete — push disabled');
    ready = true;
    return false;
  }
  vapid = { publicKey, privateKey, subject };
  ready = true;
  console.log(`[notifications] ready (subject=${subject}, storage=${dataDir})`);
  return true;
}

/** Read accessors for the routes / dispatch modules. Return null when
 *  not configured — handlers gate on this for the configured-vs-not 503. */
export function getVapidConfig(): VapidConfig | null {
  return vapid;
}

export function isConfigured(): boolean {
  return vapid !== null;
}

/** Test-only seam: reset the module so init() runs fresh. Production
 *  never calls this. Mirrors stream.ts's __resetForTest — needed
 *  because init() is idempotent (the `ready` flag short-circuits on
 *  the second call) and tests want to set up the module with a
 *  different VAPID + dataDir per case. */
export function __resetForTest(): void {
  vapid = null;
  ready = false;
  __resetMutesForTest();
  __resetPrefsForTest();
}
