// Parley proxy module — server-side half of the parley agent
// contract (the OpenAI-Responses-shaped HTTP+SSE talk-to-an-agent
// surface).
//
// Wraps an UpstreamAgent (HTTPAgentUpstream by default) and exposes
// the /api/parley/* HTTP routes the PWA + audio-bridge consume.
//
// Usage from server.ts:
//   import * as parley from './proxy/parley/index.ts';
//   parley.init({ token: PARLEY_PLATFORM_TOKEN, url: PARLEY_PLATFORM_URL });
//   // route handlers:
//   if (req.method === 'POST' && url === '/api/parley/messages')
//     return parley.handleParleyMessage(req, res);
//   if (req.method === 'GET' && url === '/api/parley/stream')
//     return parley.handleParleyStream(req, res);
//   if (req.method === 'GET' && url === '/api/parley/sessions')
//     return parley.handleParleySessionsList(req, res);
//   if (req.method === 'DELETE' && url.match(/^\/api\/parley\/sessions\/.+/))
//     return parley.handleParleySessionDelete(req, res, chatId);

import { init as initStream } from './stream.ts';
import { init as initNotifications } from './notifications/index.ts';
import { HTTPAgentUpstream, type UpstreamAgent } from './upstream.ts';
import { readEnv } from '../env.mjs';

export { handleParleyMessage } from './messages.ts';
export { handleParleyUpload } from './upload.ts';
export {
  handleCaptureCreate,
  handleCaptureActivate,
  handleCaptureAbortStart,
  handleCaptureSegment,
  handleCaptureStop,
  handleCapturePatch,
  handleCaptureMark,
  handleCaptureHealth,
  handleCaptureList,
  handleCaptureGet,
  handleCaptureTranscript,
  handleCaptureDelete,
  handleCaptureDiscard,
  handleCaptureRestore,
  handleCapturePurge,
  handleCapturePurgeAudio,
  handleCaptureControl,
  listCaptures,
  sweepCaptures,
} from './capture.ts';
export {
  initCaptureTranscription,
  recoverPendingTranscriptions,
  handleCaptureRetroDiarize,
} from './captureTranscribe.ts';
export { handleCaptureAudio } from './captureAudio.ts';
export { handleMediaGet, handleMediaRegister } from './media.ts';
export {
  handleParleyModelCapabilities,
  handleParleyAuxiliaryModels,
} from './modelModalities.ts';
export {
  handleParleySessionsList,
  handleParleySessionDelete,
  handleParleySessionRename,
} from './sessions.ts';
export { handleParleySessionMessages } from './history.ts';
export { handleParleyStream } from './stream.ts';
export {
  handleParleySettingsSchema,
  handleParleySettingsUpdate,
} from './settings.ts';
export {
  handleParleyJobsList,
  handleParleyJobUpdate,
  handleParleyJobRun,
  handleParleyJobRuns,
  handleParleyJobDelete,
} from './jobs.ts';
export { handleParleyCommands } from './commands.ts';
export { handleParleySearch } from './search.ts';
export {
  handleParleyVapidPublicKey,
  handleParleySubscribe,
  handleParleyUnsubscribe,
  handleParleyTest,
  handleParleyListMutes,
  handleParleySetMute,
  handleParleyVisibility,
  handleParleyGetPreferences,
  handleParleySetPreferences,
  handleParleyDiagnostics,
} from './notifications/routes.ts';

let upstream: UpstreamAgent | null = null;

/** Wire env-derived config and construct the upstream singleton.
 *  Called once from server.ts at startup. The bearer token is OPTIONAL —
 *  the bundled stub agent and any upstream that doesn't require auth
 *  work without one. Hermes (and other auth-gated upstreams) will reject
 *  unauthenticated calls and the user sees an upstream 401 in the UI. */
export function init(opts: { token: string; url: string; backend?: string; claudeCode?: Record<string, unknown> }): void {
  // Backend switch (claude-code wiring, 2026-07-14). Selection:
  // PARLEY_BACKEND env wins, then the config `backend:` key, default
  // 'http' (hermes/stub over /v1). The claude-code upstream is
  // in-process (no HTTP hop) — constructed lazily via dynamic import so
  // installs that never select it don't pay the SDK load.
  const backend = (readEnv('PARLEY_BACKEND') || opts.backend || 'http').trim().toLowerCase();
  if (backend === 'claude-code' || backend === 'claude_code') {
    void (async () => {
      try {
        const [{ ClaudeCodeUpstream }, sdk] = await Promise.all([
          import('../../backends/claude-code/adapter.ts'),
          import('@anthropic-ai/claude-agent-sdk'),
        ]);
        // YAML block is snake_case; the adapter config is camelCase.
        const raw: any = opts.claudeCode ?? {};
        const config: any = {
          cwd: raw.cwd,
          cwdAllowlist: raw.cwdAllowlist ?? raw.cwd_allowlist,
          model: raw.model,
          approvals: raw.approvals,
          permissionMode: raw.permissionMode ?? raw.permission_mode,
          persistPath: raw.persistPath ?? raw.persist_path,
          maxTurns: raw.maxTurns ?? raw.max_turns,
        };
        const cc = new ClaudeCodeUpstream({ sdk: sdk as any, config });
        upstream = cc.asUpstreamAgent();
        console.log(`[parley] upstream ready (claude-code, cwd=${(opts.claudeCode as any)?.cwd ?? process.cwd()})`);
      } catch (e: any) {
        console.error(`[parley] claude-code backend failed to init: ${e?.message ?? e} — falling back to HTTP upstream`);
        upstream = new HTTPAgentUpstream({ url: opts.url, token: opts.token });
      }
    })();
    initStream();
    notificationsInitSettled = initNotifications().then(
      () => {},
      (e) => { console.warn('[parley] notifications init failed:', e?.message ?? e); },
    );
    return;
  }
  // Tolerate legacy PARLEY_PLATFORM_URL values that include the
  // ws://…/ws form (the WS path is gone but old configs may still
  // carry it). Normalize to the HTTP root.
  const httpUrl = opts.url
    .replace(/^ws:/, 'http:').replace(/^wss:/, 'https:')
    .replace(/\/ws\/?$/, '');
  upstream = new HTTPAgentUpstream({ url: httpUrl, token: opts.token });
  console.log(`[parley] upstream ready (${httpUrl}${opts.token ? '' : ', no auth'})`);
  // Wire the stream fan-out so the /v1/events subscription is in place
  // BEFORE the first PWA tab attaches — we'd otherwise miss any
  // envelope that arrives during the startup window.
  initStream();
  // Web Push (Phase 3). Async init — fire-and-forget; the routes gate
  // on configured-ness via getVapidConfig() returning null, so
  // subscribe calls during the (sub-millisecond) init window get a
  // clean 503 rather than crashing. Storage init is what makes this
  // async (mkdir + cache prime); VAPID env-read is sync.
  notificationsInitSettled = initNotifications().then(
    () => {},
    (e) => {
      console.warn('[parley] notifications init failed:', e?.message ?? e);
    },
  );
}

// Settled-handle for the fire-and-forget notifications init above. The
// test harness awaits this before handing a rig to a test: the env-based
// init sets the module's `ready` flag, and a test's __resetForTest +
// explicit init({testKeys}) racing it could be silently short-circuited
// (init saw ready=true, kept vapid=null → every push skipped as
// vapid_unconfigured; flaked under full-suite CPU contention 2026-06-09).
// Production never needs to await it.
let notificationsInitSettled: Promise<void> = Promise.resolve();

export function whenNotificationsInitSettled(): Promise<void> {
  return notificationsInitSettled;
}

/** Returns the upstream singleton, or null if PARLEY_PLATFORM_TOKEN
 *  was unset. Handlers gate on this for the configured-vs-not 503. */
export function getUpstream(): UpstreamAgent | null {
  return upstream;
}

/** Status helper — used by health-check tooling. */
export function isReady(): boolean {
  return upstream !== null;
}
