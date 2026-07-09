// Sidekick proxy module — server-side half of the sidekick agent
// contract (the OpenAI-Responses-shaped HTTP+SSE talk-to-an-agent
// surface).
//
// Wraps an UpstreamAgent (HTTPAgentUpstream by default) and exposes
// the /api/sidekick/* HTTP routes the PWA + audio-bridge consume.
//
// Usage from server.ts:
//   import * as sidekick from './proxy/sidekick/index.ts';
//   sidekick.init({ token: SIDEKICK_PLATFORM_TOKEN, url: SIDEKICK_PLATFORM_URL });
//   // route handlers:
//   if (req.method === 'POST' && url === '/api/sidekick/messages')
//     return sidekick.handleSidekickMessage(req, res);
//   if (req.method === 'GET' && url === '/api/sidekick/stream')
//     return sidekick.handleSidekickStream(req, res);
//   if (req.method === 'GET' && url === '/api/sidekick/sessions')
//     return sidekick.handleSidekickSessionsList(req, res);
//   if (req.method === 'DELETE' && url.match(/^\/api\/sidekick\/sessions\/.+/))
//     return sidekick.handleSidekickSessionDelete(req, res, chatId);

import { init as initStream } from './stream.ts';
import { init as initNotifications } from './notifications/index.ts';
import { HTTPAgentUpstream, type UpstreamAgent } from './upstream.ts';

export { handleSidekickMessage } from './messages.ts';
export { handleSidekickUpload } from './upload.ts';
export {
  handleCaptureCreate,
  handleCaptureSegment,
  handleCaptureStop,
  handleCapturePatch,
  handleCaptureMark,
  handleCaptureList,
  handleCaptureGet,
  handleCaptureDelete,
  handleCapturePurgeAudio,
  handleCaptureControl,
  listCaptures,
} from './capture.ts';
export {
  initCaptureTranscription,
  recoverPendingTranscriptions,
  handleCaptureRetroDiarize,
} from './captureTranscribe.ts';
export { handleCaptureAudio } from './captureAudio.ts';
export {
  handleSidekickModelCapabilities,
  handleSidekickAuxiliaryModels,
} from './modelModalities.ts';
export {
  handleSidekickSessionsList,
  handleSidekickSessionDelete,
  handleSidekickSessionRename,
} from './sessions.ts';
export { handleSidekickSessionMessages } from './history.ts';
export { handleSidekickStream } from './stream.ts';
export {
  handleSidekickSettingsSchema,
  handleSidekickSettingsUpdate,
} from './settings.ts';
export { handleSidekickCommands } from './commands.ts';
export { handleSidekickSearch } from './search.ts';
export {
  handleSidekickVapidPublicKey,
  handleSidekickSubscribe,
  handleSidekickUnsubscribe,
  handleSidekickTest,
  handleSidekickListMutes,
  handleSidekickSetMute,
  handleSidekickVisibility,
  handleSidekickGetPreferences,
  handleSidekickSetPreferences,
  handleSidekickDiagnostics,
} from './notifications/routes.ts';

let upstream: UpstreamAgent | null = null;

/** Wire env-derived config and construct the upstream singleton.
 *  Called once from server.ts at startup. The bearer token is OPTIONAL —
 *  the bundled stub agent and any upstream that doesn't require auth
 *  work without one. Hermes (and other auth-gated upstreams) will reject
 *  unauthenticated calls and the user sees an upstream 401 in the UI. */
export function init(opts: { token: string; url: string }): void {
  // Tolerate legacy SIDEKICK_PLATFORM_URL values that include the
  // ws://…/ws form (the WS path is gone but old configs may still
  // carry it). Normalize to the HTTP root.
  const httpUrl = opts.url
    .replace(/^ws:/, 'http:').replace(/^wss:/, 'https:')
    .replace(/\/ws\/?$/, '');
  upstream = new HTTPAgentUpstream({ url: httpUrl, token: opts.token });
  console.log(`[sidekick] upstream ready (${httpUrl}${opts.token ? '' : ', no auth'})`);
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
      console.warn('[sidekick] notifications init failed:', e?.message ?? e);
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

/** Returns the upstream singleton, or null if SIDEKICK_PLATFORM_TOKEN
 *  was unset. Handlers gate on this for the configured-vs-not 503. */
export function getUpstream(): UpstreamAgent | null {
  return upstream;
}

/** Status helper — used by health-check tooling. */
export function isReady(): boolean {
  return upstream !== null;
}
