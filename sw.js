/**
 * Service worker — caches the app shell so iOS PWA survives app switches.
 * Strategy: cache-first for app shell assets, network-first for /build/*.
 *
 * Install resilience (2026-05-01): switched cache-add from `addAll` (atomic
 * — ANY 404 fails the entire install, leaves the new SW redundant, leaves
 * the OLD SW in control indefinitely) to `Promise.allSettled` over
 * individual `cache.add` calls. A drifted APP_SHELL list (e.g. a refactor
 * renames a module) no longer locks PWAs on the old version. The cost is
 * we may pre-cache fewer modules than intended — but `/build/*` is
 * network-first, so first-load pulls anything missed and caches on the
 * way through.
 */
const CACHE_NAME = 'v0.614';

// Dedicated cache for VAD assets. Key insight: VAD assets are 14.7 MB
// and don't change with every app deploy — the Silero model is
// versioned by filename, the ORT runtime is from a pinned npm package.
// Bumping CACHE_NAME ABOVE used to evict them every release, forcing a
// 14.7 MB re-download per refresh. They now live in this separate cache
// that survives app version bumps; only invalidate when the VAD lib
// version itself changes (bump VAD_CACHE).
//
// Update protocol: when @ricky0123/vad-web is upgraded OR the Silero
// model changes, bump VAD_CACHE — the activate handler then prunes
// the old VAD cache and the next call re-fetches. This is rare;
// ~once per quarter at most.
const VAD_CACHE = 'vad-assets-v4';

// Dedicated cache for content-hashed build modules (#182 / Path C2).
// build.mjs renames each compiled module foo.mjs → foo.<sha10>.mjs and
// the generated build/index.html maps bare /build/*.mjs specifiers to
// the hashed names via an import map. A hashed URL's content can never
// change (new content ⇒ new name), so these are safe to serve
// CACHE-FIRST forever — that's what makes cold boot on a spotty link
// skip the network for every unchanged module. Like VAD_CACHE, this
// cache survives CACHE_NAME bumps: a deploy only re-fetches the files
// whose hashes actually changed (+ index.html). Eviction is handled by
// the page, not activate: after boot it posts 'prune-build-cache' with
// the current import map's URLs and we drop everything else.
const BUILD_CACHE = 'build-hashed-v1';
const HASHED_BUILD_RE = /^\/build\/.+\.[0-9a-f]{10}\.mjs$/;

// Drop every cached copy of the navigation document (index.html) across
// ALL caches so the next navigation falls through to the network for a
// fresh index. Used by the stale-index self-heal below: a cached index
// can advance (background revalidate) to a "phantom" generation whose
// hashed modules were never cached and have since been purged from the
// server — purging the stale shell lets the heal reload pull a fresh one.
async function purgeCachedAppShell() {
  const names = await caches.keys();
  await Promise.all(names.map(async (n) => {
    const c = await caches.open(n);
    await Promise.all([
      c.delete('/'),
      c.delete('/index.html'),
      c.delete(new Request(self.location.origin + '/')),
    ]);
  }));
}

// Timestamp of the last time we served a CACHED navigation document. The
// stale-index brick only happens at boot: a cache-first index references a
// purged generation, so its ENTRY <script type=module> 404s before the app
// runs. That 404 lands within a beat of the cached-nav serve, so a short
// window after it is the only time a 404-heal RELOAD is safe.
//
// Why this gate (field regression 2026-06-14): the heal originally reloaded
// on ANY hashed-module 404. But the app code-splits — it lazily import()s
// hashed /build chunks mid-session (e.g. speechVad when a dictation starts).
// A routine deploy rm's + re-hashes every module, so an already-running
// client that lazy-loads a chunk from the now-purged generation gets a 404.
// Reloading on THAT is catastrophic: it refreshes the page out from under
// an active user (data loss mid-dictation) and the post-reload boot can
// mis-land on the most-recent session. Outside the boot window we instead
// let the import reject so the running session survives untouched.
let lastCachedNavServedAt = 0;
const BOOT_HEAL_WINDOW_MS = 8000;

// Minimum viable shell for offline boot. Bundle JS modules used to be
// listed here too — that was the source of the 2026-05-01 cache.addAll
// failure (refactor renamed /build/canvas → /build/cards, removed
// /build/backends/*, removed /build/gateway.mjs; addAll on the stale
// list 404'd every install). With network-first on /build/*, listing
// JS here is redundant: a first online load primes the cache for every
// module the page actually imports. Keep this list narrow + load-bearing.
const APP_SHELL = [
  '/',
  '/index.html',
  '/styles/app.css',
  '/manifest.json',
  '/assets/icon.png',
  '/assets/icon.svg',
  '/assets/icon-chevron.svg',
  // Audio worklet — loaded out-of-band by the AudioContext, not via
  // import; pre-cache so the talk-mode pipeline boots offline.
  '/build/audio/shared/audio-processor.js',
  // Silero VAD WASM assets are NOT in APP_SHELL — they're 14.7 MB
  // total (12.8 MB ORT WASM + 1.8 MB Silero model + 24 KB ESM loader +
  // 3 KB worklet). Pre-caching blocked SW install/activate by 15-20s
  // on every version bump. Lazy-cache instead: the existing /assets/*
  // fetch handler caches on first hit, so the
  // first call after a version bump pays the one-time download cost
  // and warms the cache for everything after. main.ts kicks off a
  // background prefetch ~5s after page ready so the cost is hidden
  // during idle instead of blocking the first call.
];

self.addEventListener('install', (e) => {
  // Per-entry add with Promise.allSettled so a single 404 doesn't fail
  // the whole install. The network-first /build/* handler will fill in
  // any module misses on first request.
  //
  // NO skipWaiting here (#225): install used to auto-activate, so a
  // PASSIVE update check (visibilitychange / 5-min interval in
  // index.html) yanked live sessions through controllerchange → reload
  // with zero user action — mid-text-selection in the field. An updated
  // SW now parks in `waiting` ("· update ready" on the version label)
  // until the page's explicit Refresh flow posts SKIP_WAITING below, or
  // the next app launch activates it. Code delivery doesn't wait on
  // this: hashed /build/* modules and the revalidating app shell flow
  // through the OLD worker.
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then(async cache => {
        const results = await Promise.allSettled(
          APP_SHELL.map(url => cache.add(url)),
        );
        for (let i = 0; i < results.length; i++) {
          const r = results[i];
          if (r.status === 'rejected') {
            console.warn(`[sw] install: skipping ${APP_SHELL[i]}: ${r.reason}`);
          }
        }
      }),
  );
});

self.addEventListener('activate', (e) => {
  // Prune old caches BUT preserve VAD_CACHE + BUILD_CACHE — both survive
  // app version bumps (see their docstrings; BUILD_CACHE entries are
  // content-addressed so they can't go stale, and the page prunes
  // orphans via 'prune-build-cache'). Everything else gets evicted.
  const keep = new Set([CACHE_NAME, VAD_CACHE, BUILD_CACHE]);
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => !keep.has(k)).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  // API calls, WebSocket upgrades, and external URLs — always network
  if (e.request.method !== 'GET') return;
  if (url.pathname.startsWith('/ws/')) return;
  // /api/* covers hermes proxy routes (models-catalog, model, sessions, …)
  // and keyterms. Caching these silently stales dynamic server state —
  // e.g. the model picker would read a cached model ref after a /set.
  if (url.pathname.startsWith('/api/')) return;
  if (['/config', '/tts', '/gen-image', '/weather', '/link-preview',
       '/spotify-check', '/screenshot', '/canvas/show', '/transcribe'].includes(url.pathname)) return;
  if (url.origin !== self.location.origin) return;

  // /assets/vad/* — CACHE-FIRST against the dedicated VAD_CACHE.
  // Survives app version bumps (see VAD_CACHE comment above) so the
  // 14.7 MB download happens once per VAD lib upgrade, not once per
  // app deploy.
  if (url.pathname.startsWith('/assets/vad/')) {
    e.respondWith(
      caches.open(VAD_CACHE).then(cache =>
        cache.match(e.request).then(cached => {
          if (cached) return cached;
          return fetch(e.request).then(response => {
            if (response.ok) cache.put(e.request, response.clone());
            return response;
          });
        }),
      ),
    );
    return;
  }

  // /build/* — NETWORK-FIRST. Compiled JS bundle modules. Every code
  // change rebuilds these; cache-first served stale modules across SW
  // updates (new SW activates, page header shows new CACHE_NAME, but
  // the in-memory JS is from the OLD cached bundle until a SECOND
  // reload). Network-first guarantees fresh code on reload while
  // still falling back to cache when offline.
  //
  // Exception: /build/vendor/vad-web.mjs lives in VAD_CACHE alongside
  // the wasm/onnx assets so the VAD lib bundle ALSO survives app
  // version bumps. Same upgrade cadence (bump VAD_CACHE when @ricky0123/
  // vad-web upgrades).
  if (url.pathname === '/build/vendor/vad-web.mjs') {
    e.respondWith(
      caches.open(VAD_CACHE).then(cache =>
        cache.match(e.request).then(cached => {
          if (cached) return cached;
          return fetch(e.request).then(response => {
            if (response.ok) cache.put(e.request, response.clone());
            return response;
          });
        }),
      ),
    );
    return;
  }
  // Content-hashed build modules — CACHE-FIRST against BUILD_CACHE,
  // immutable by construction (see BUILD_CACHE docstring). The stale-
  // module hazard that forced /build/* to network-first can't occur
  // here: a deploy changes the hash, which changes the URL.
  if (HASHED_BUILD_RE.test(url.pathname)) {
    e.respondWith(
      caches.open(BUILD_CACHE).then(cache =>
        cache.match(e.request).then(cached => {
          if (cached) return cached;
          return fetch(e.request).then(async response => {
            if (response.ok) {
              cache.put(e.request, response.clone());
              return response;
            }
            // A hashed module that is neither cached NOR on the server is
            // a PURGED GENERATION: the cache-first index.html references a
            // deploy whose /build modules build.mjs has since rm'd. Serving
            // this 404 to a <script type=module> bricks boot ("stuck not
            // loading", field 2026-06-14) and relaunching can't recover —
            // the stale index just 404s the same module again. Self-heal:
            // drop the stale cached navigation documents so the NEXT
            // navigation pulls a FRESH index (whose hashed modules the
            // server actually has), and hand back a tiny module that fires
            // exactly one reload to get there. The sessionStorage guard
            // makes it one-shot so a genuinely-broken deploy can't loop.
            if (response.status === 404) {
              // Always drop the stale shell so the NEXT navigation pulls a
              // fresh index — this alone breaks the reinstall-only trap.
              await purgeCachedAppShell();
              // Only auto-reload when this 404 is the boot entry module of a
              // just-served cached index (the brick). A mid-session lazy
              // import 404 (routine deploy purged the running generation)
              // must NOT reload — let it reject so the live session survives.
              const inBootWindow =
                Date.now() - lastCachedNavServedAt < BOOT_HEAL_WINDOW_MS;
              if (inBootWindow) {
                return new Response(
                  'if(!sessionStorage.getItem("sk-stale-heal")){' +
                  'sessionStorage.setItem("sk-stale-heal","1");' +
                  'location.reload();}',
                  { headers: { 'Content-Type': 'text/javascript' } },
                );
              }
            }
            return response;
          }).catch(async (err) => {
            // Offline (fetch rejected, not a 404) — serve the cached copy
            // if we have one. A purge-heal would be wrong here: the module
            // isn't gone, the link is just down.
            if (navigator.onLine === false) {
              const c = await caches.match(e.request);
              if (c) return c;
            }
            throw err;
          });
        }),
      ),
    );
    return;
  }
  if (url.pathname.startsWith('/build/')) {
    e.respondWith(
      fetch(e.request).then(response => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone));
        }
        return response;
      }).catch(async (err) => {
        // A rejected /build/* fetch falls back to the cached bundle ONLY
        // when genuinely offline. When online, a rejection is transient
        // (flaky link, dropped connection) and serving the previous
        // deploy's cached module silently boots STALE JS under a
        // freshly-activated SW — the "header shows new version but old
        // code runs until a manual cache-bust" symptom. Re-throw so the
        // load fails loudly and the next reload pulls fresh, instead of
        // pinning the app to an old bundle.
        if (navigator.onLine === false) {
          const cached = await caches.match(e.request);
          if (cached) return cached;
        }
        throw err;
      })
    );
    return;
  }

  // /styles/* — NETWORK-FIRST. The stylesheet changes every deploy just
  // like /build/* JS, so cache-first stale-while-revalidate guaranteed one
  // stale paint after each deploy: the new SW activates, the header shows
  // the new CACHE_NAME, but app.css was served from the old cache bucket
  // until a SECOND reload (the "I deployed but it looks unchanged" symptom).
  // Network-first pulls fresh CSS on every reload, falling back to cache
  // only when genuinely offline.
  if (url.pathname.startsWith('/styles/')) {
    e.respondWith(
      fetch(e.request).then(response => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone));
        }
        return response;
      }).catch(async () => {
        const cached = await caches.match(e.request);
        if (cached) return cached;
        throw new Error('styles fetch failed and no cache');
      })
    );
    return;
  }

  // App shell (HTML, icons, manifest) — cache-first, fall back to
  // network. These rarely change relative to JS modules so the offline
  // benefit outweighs staleness risk.
  e.respondWith(
    caches.match(e.request).then(cached => {
      // Record cache-first navigation serves: a hashed-module 404 right
      // after one is the boot-entry-module brick the heal targets (see
      // BOOT_HEAL_WINDOW_MS). A network-fresh index can't reference a
      // purged generation, so only the cached path arms the heal.
      if (cached && e.request.mode === 'navigate') {
        lastCachedNavServedAt = Date.now();
      }
      const fetchPromise = fetch(e.request).then(response => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone));
        }
        return response;
      }).catch(() => cached);

      return cached || fetchPromise;
    })
  );
});

// Allow the page to query the active cache version (shown in the header).
self.addEventListener('message', (e) => {
  if (e.data?.type === 'get-version') {
    e.source?.postMessage({ type: 'version', version: CACHE_NAME });
  }
  // The ONLY activation path for an updated SW while the app stays open
  // (#225): the page's Refresh flow postMessages this after reg.update()
  // finds a new SW in 'waiting'. User-initiated by construction — the
  // controllerchange → reload that follows never fires spontaneously.
  if (e.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  // BUILD_CACHE garbage collection. The page (index.html SW bootstrap)
  // posts the current import map's hashed URLs ~15s after boot; every
  // cached module NOT in that set belongs to a previous deploy and is
  // dropped. Keeps the cache bounded at exactly one deploy's worth of
  // modules without coupling eviction to CACHE_NAME bumps.
  if (e.data?.type === 'prune-build-cache' && Array.isArray(e.data.keep)) {
    const keep = new Set(e.data.keep.map(u => new URL(u, self.location.origin).href));
    e.waitUntil?.(
      caches.open(BUILD_CACHE).then(async cache => {
        const reqs = await cache.keys();
        await Promise.all(reqs.filter(r => !keep.has(r.url)).map(r => cache.delete(r)));
      }),
    );
  }
});

// ─── Web Push (Phase 3) ──────────────────────────────────────────────────
// Display incoming push payloads as system notifications + focus the
// matching chat on click. Payload shape (set server-side by
// proxy/sidekick/notifications/dispatch.ts in Phase 3c):
//   { title, body, chat_id?, tag?, icon?, url? }
// chat_id + tag both default to a synthetic id so coalescing still works
// when the dispatcher hasn't supplied them. Bodies that fail to parse
// fall back to "Sidekick" / payload-text so we never silently drop a
// delivery.
self.addEventListener('push', (e) => {
  let payload = {};
  if (e.data) {
    try { payload = e.data.json(); }
    catch { payload = { title: 'Sidekick', body: e.data.text() || 'New message' }; }
  }
  const title = payload.title || 'Sidekick';
  const body = payload.body || '';
  const chatId = payload.chat_id || '';
  // tag coalesces per-thread: same tag replaces the prior notification
  // instead of stacking. Fall back to chat_id, then a stable per-payload
  // synthetic so unrelated pushes don't accidentally overwrite each other.
  const tag = payload.tag || (chatId ? `chat:${chatId}` : `push:${Date.now()}`);
  const url = payload.url || (chatId ? `/?chat=${encodeURIComponent(chatId)}` : '/');
  const tasks = [
    self.registration.showNotification(title, {
      body,
      tag,
      icon: payload.icon || '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      data: { chatId, url },
      // Renotify=true means a same-tag replacement still vibrates / sounds
      // on platforms that respect the flag. iOS PWA honors it; helps the
      // user notice an update vs a silent overwrite.
      renotify: true,
    }),
  ];
  // OS app-icon badge from the SAME clock the sidebar uses: the plugin
  // computes the unread total at dispatch and ships it as payload.badge.
  // Without this the badge went stale-low whenever pushes arrived with
  // no page open — nothing updated it until the next foreground
  // reconcile (badge.ts syncBadge, which remains the authority whenever
  // a page IS open and overwrites this on its next refresh).
  if (typeof payload.badge === 'number' && typeof navigator.setAppBadge === 'function') {
    tasks.push(navigator.setAppBadge(payload.badge).catch(() => {}));
  }
  e.waitUntil(Promise.all(tasks));
});

// Notification click: focus an existing tab on the target URL if one
// exists, else open a new tab. Falls back gracefully if clients.openWindow
// isn't available (some older WebKit builds).
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const target = e.notification.data?.url || '/';
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    // Prefer an already-focused or same-origin tab — reuse it via
    // navigate() so we don't accumulate orphan PWA windows.
    for (const c of all) {
      try {
        await c.focus();
        if ('navigate' in c) {
          try { await c.navigate(target); } catch { /* cross-origin or unsupported */ }
        }
        return;
      } catch { /* tab vanished mid-loop — try the next */ }
    }
    if (self.clients.openWindow) {
      await self.clients.openWindow(target);
    }
  })());
});
