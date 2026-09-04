// Images inside an agent-authored HTML doc must actually LOAD in the
// Docs panel.
//
// Field 2026-09-04: the ITAD mosaic mockup rendered six broken-image
// icons even though all six files were present on disk under exactly
// the referenced names. The panel renders HTML in
// `<iframe sandbox=… srcdoc=…>`, and an EMPTY sandbox gives the frame an
// opaque origin where the browser refuses every subresource load —
// measured in the real frame that day:
//
//   sandbox=""                   every subresource → no request at all
//   sandbox="allow-same-origin"  same-origin image URL → 200 ✓
//   sandbox="allow-popups"       → still nothing
//
// So `allow-same-origin` is load-bearing, and it looks exactly like the
// kind of attribute a security pass would "harden" back to ''. That
// would silently re-break every image in every HTML doc, which is why
// this scenario exists.
//
// TWO things are asserted, and the second is the one that matters:
//
//  1. the sandbox token is present (fast, names the regression), and
//  2. the image genuinely loaded — naturalWidth > 0 inside the frame.
//
// The image MUST be a same-origin URL, never a data: URI. data: URIs
// load fine even under sandbox="" (they are the one form that always
// worked), so a data-URI fixture would pass against the very bug this
// guards and the scenario would be worthless.
//
// Scope note: this covers the CLIENT half. The plugin half — rewriting
// local <img src> / CSS url() refs to /api/parley/media URLs before the
// content ships — is unit-tested in
// backends/hermes/plugin/tests/test_doc_asset_rewrite.py. Here the
// content arrives already-rewritten, which is what the panel sees.

import { waitForReady } from './lib.mjs';

export const NAME = 'doc-html-images-render';
export const DESCRIPTION =
  'images in an HTML doc load in the Docs panel (sandbox allows same-origin subresources)';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_ID = 'mock-doc-html-img-chat';
// Same-origin static asset the smoke server serves. Deliberately NOT a
// data: URI — see the header.
const IMG_URL = '/assets/icon.png';

export function MOCK_SETUP(mock) {
  const t0 = Date.now() / 1000 - 60;
  mock.addChat(CHAT_ID, {
    title: 'HTML doc chat',
    messages: [{ role: 'user', content: 'seed', parley_id: 'umsg_html_img_seed', timestamp: t0 }],
    lastActiveAt: Date.now() - 1000,
  });
}

export default async function run({ page, log, mock }) {
  await waitForReady(page);

  mock.pushEnvelope({
    type: 'doc_show',
    chat_id: CHAT_ID,
    title: 'Slide mockup',
    content:
      `<html><body style="margin:0;background:#111">` +
      `<img id="tile" src="${IMG_URL}" width="120">` +
      `<div class="bg" style="height:60px;background:url(${IMG_URL}) center/cover"></div>` +
      `</body></html>`,
    format: 'html',
    path: '/home/user/decks/slide-mockup.html',
  });

  // The frame mounts once the Docs panel opens.
  await page.waitForFunction(
    () => {
      const drawer = document.getElementById('pin-drawer');
      if (!drawer || drawer.classList.contains('collapsed')) return false;
      const panel = document.getElementById('doc-drawer-panel');
      if (!panel || panel.hidden) return false;
      return !!document.querySelector('#doc-drawer-body iframe.doc-drawer-frame');
    },
    null, { timeout: 6_000, polling: 50 },
  );
  log('html doc opened the Docs panel and mounted the frame');

  // 1. The sandbox token — names the regression directly.
  const sandbox = await page.evaluate(
    () => document.querySelector('#doc-drawer-body iframe.doc-drawer-frame')
      ?.getAttribute('sandbox'),
  );
  if (sandbox === null || sandbox === undefined) {
    throw new Error('doc frame has no sandbox attribute — it must stay sandboxed');
  }
  const tokens = sandbox.split(/\s+/).filter(Boolean);
  if (!tokens.includes('allow-same-origin')) {
    throw new Error(
      `doc frame sandbox="${sandbox}" lacks allow-same-origin — every image in ` +
      'every HTML doc will silently fail to load (see header)',
    );
  }
  // Scripts must stay blocked: `allow-scripts allow-same-origin` together
  // is the combination that lets framed script reach the parent origin.
  if (tokens.includes('allow-scripts')) {
    throw new Error(
      `doc frame sandbox="${sandbox}" allows BOTH scripts and same-origin — ` +
      'agent-authored HTML could then reach the parent origin',
    );
  }
  log(`frame sandbox="${sandbox}" (same-origin allowed, scripts blocked)`);

  // 2. The image actually loaded. allow-same-origin is what makes
  // contentDocument readable at all, so this assertion doubles as proof
  // the token took effect.
  await page.waitForFunction(
    () => {
      const f = document.querySelector('#doc-drawer-body iframe.doc-drawer-frame');
      const img = f?.contentDocument?.getElementById('tile');
      return !!img && img.complete && img.naturalWidth > 0;
    },
    null, { timeout: 8_000, polling: 100 },
  );

  const dims = await page.evaluate(() => {
    const f = document.querySelector('#doc-drawer-body iframe.doc-drawer-frame');
    const img = f?.contentDocument?.getElementById('tile');
    return { w: img?.naturalWidth ?? 0, h: img?.naturalHeight ?? 0 };
  });
  if (!dims.w || !dims.h) {
    throw new Error(`image did not decode (naturalWidth=${dims.w} naturalHeight=${dims.h})`);
  }
  log(`image loaded inside the doc frame (${dims.w}x${dims.h})`);
}
