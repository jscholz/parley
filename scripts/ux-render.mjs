// One-off UX render harness (not a smoke). Boots parley against the
// mock backend, seeds a realistic transcript (prose + markdown + code +
// list), and screenshots desktop+mobile × dark+light into a label dir.
//   node scripts/ux-render.mjs <label>
import { launchSharedBrowser, launchBrowser, waitForReady, DEFAULT_URL } from './smoke/lib.mjs';
import { installMockBackend } from './smoke/mock-backend.mjs';

const LABEL = process.argv[2] || 'render';
const OUT = `/tmp/ux-renders/${LABEL}`;
import { mkdirSync } from 'node:fs';
mkdirSync(OUT, { recursive: true });

const CHAT = 'ux-demo';
const tSec = Date.now() / 1000;
const MESSAGES = [
  { role: 'user', content: 'Can you summarize the plan for the launch and flag anything risky?', message_id: 'm1', parley_id: 'm1', timestamp: tSec - 600 },
  { role: 'assistant', content: `Here's the shape of it.

**Launch plan — three phases**

1. **Soft launch** to the invite list (~20 people). Watch for signup friction.
2. **Show HN** timed to the next hermes news beat, with the demo video up top.
3. **Awesome-list PRs** the same week so the placement compounds.

The one risky dependency is the hosted demo instance — voice needs HTTPS + mic permission, so if that slips, the whole funnel stalls. I'd gate the HN post on it being live.

\`\`\`ts
const funnel = ['video', 'demo', 'show-hn'];
funnel.forEach(step => track(step));
\`\`\`

Want me to draft the Show HN copy?`, message_id: 'm2', parley_id: 'm2', timestamp: tSec - 580 },
  { role: 'user', content: 'Yes — keep it short and honest.', message_id: 'm3', parley_id: 'm3', timestamp: tSec - 120 },
  { role: 'assistant', content: `Draft:

> **Show HN: A voice-first phone client for self-hosted agents (Hermes, OpenClaw, Claude Code)**
>
> I got tired of only reaching my agent from a terminal, so I built a client I can talk to from my pocket — streaming dictation, real calls with barge-in, meeting capture. Backend-agnostic. Demo you can call from your phone in the link.

Short, leads with the wedge, names the backends. I can tune the tone if it reads too casual.`, message_id: 'm4', parley_id: 'm4', timestamp: tSec - 100 },
];

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

// Session list spanning the time buckets a drawer divider would group by
// (today / yesterday / this week / last week / older). The pass's first
// point is those dividers, and you cannot judge grouping — or the row
// idiom, or the active-row highlight — against three sessions that all
// land in the same bucket.
const SESSIONS = [
  ['ux-2', 'Investor pitch intro refinement', 2 * HOUR],
  ['ux-3', 'Dust exposure health concerns', 5 * HOUR],
  ['ux-4', 'Deepgram keyterm tuning', DAY + 3 * HOUR],
  ['ux-5', 'Barge-in threshold field notes', DAY + 7 * HOUR],
  ['ux-6', 'Hermes plugin: unread reconcile', 3 * DAY],
  ['ux-7', 'Capture lifecycle post-mortem', 4 * DAY],
  ['ux-8', 'R2 bucket + CDN pricing', 9 * DAY],
  ['ux-9', 'Apple developer enrolment', 12 * DAY],
  ['ux-10', 'Voice model A/B: aura vs eleven', 23 * DAY],
];

function seed(mock) {
  mock.addChat(CHAT, { title: 'Launch plan', source: 'parley', messages: MESSAGES, lastActiveAt: Date.now() });
  for (const [id, title, ago] of SESSIONS) {
    mock.addChat(id, {
      title,
      source: 'parley',
      messages: [{ role: 'user', content: 'hi', message_id: `seed-${id}`, timestamp: tSec - ago / 1000 }],
      lastActiveAt: Date.now() - ago,
    });
  }
}

async function shoot(browser, { mobile, theme }) {
  const { page, cleanup } = await launchBrowser(browser, { mobile });
  const mock = await installMockBackend(page);
  seed(mock);
  await waitForReady(page);
  await page.evaluate((t) => { document.documentElement.setAttribute('data-theme', t); }, theme);
  // Pin two sessions so the drawer's Pinned region — and its header —
  // are in frame. Pins ride the synced `pinnedSessions` setting, so
  // seed it server-side and reload rather than driving the row menu.
  await page.evaluate(async () => {
    await fetch('/api/parley/prefs/pinnedSessions', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: JSON.stringify(['ux-6', 'ux-3']) }),
    });
  });
  await page.reload();
  await waitForReady(page);
  await page.evaluate((t) => { document.documentElement.setAttribute('data-theme', t); }, theme);
  await page.click(`#sessions-list li[data-chat-id="${CHAT}"]`).catch(() => {});
  await page.waitForTimeout(1200);
  const variant = `${mobile ? 'mobile' : 'desktop'}-${theme}`;
  await page.screenshot({ path: `${OUT}/${variant}-chat.png`, fullPage: false });
  console.log('shot', `${variant}-chat.png`);

  // Second frame with the session drawer open. It used to be nudged open
  // by stripping the `collapsed` class, which silently did nothing — the
  // drawer also needs `expanded` + `body.sidebar-expanded`, so every
  // render came out with it shut and the surfaces this pass is actually
  // about (dividers, row idiom, active highlight, pinned panel) were
  // never in frame. Drive the real toggle instead of guessing at classes.
  const opened = await page.evaluate(() => {
    const btn = document.getElementById('sb-toggle')
      || document.getElementById('sb-toggle-mobile');
    if (!btn) return false;
    btn.click();
    return true;
  });
  if (!opened) throw new Error('no sidebar toggle found — markup changed, fix the harness');
  await page.waitForTimeout(700);
  const isOpen = await page.evaluate(() =>
    !!document.querySelector('#sidebar.expanded, body.sidebar-expanded'));
  if (!isOpen) throw new Error('sidebar did not expand — do not ship renders that silently omit it');
  await page.screenshot({ path: `${OUT}/${variant}-drawer.png`, fullPage: false });
  console.log('shot', `${variant}-drawer.png`);

  // Third frame: the Pinned panel. Points 2 and 7 of the pass are about
  // its "Clear" button and its density, and neither can be judged from a
  // panel with nothing in it. Pins go in through the same POST the app
  // uses (the mock owns /api/parley/pins), rather than by driving the
  // per-bubble pin control, so the seed doesn't depend on hover
  // affordances that differ between desktop and mobile.
  await page.evaluate(async (chat) => {
    const pins = [
      { role: 'assistant', text: 'The one risky dependency is the hosted demo instance — voice needs HTTPS + mic permission.', ago: 600 },
      { role: 'user', text: 'Gate the HN post on the demo being live.', ago: 5400 },
      { role: 'assistant', text: 'Show HN: A voice-first phone client for self-hosted agents (Hermes, OpenClaw, Claude Code)', ago: 90_000 },
    ];
    for (const [i, p] of pins.entries()) {
      await fetch('/api/parley/pins', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chat, msg_id: `pin-${i}`, role: p.role, text: p.text,
          timestamp: Date.now() / 1000 - p.ago,
        }),
      });
    }
  }, CHAT);
  // Reload so the client refetches pins. The pin store is populated at
  // boot and opening the panel does not re-request, so seeding after boot
  // renders an empty "No pinned messages" panel — which is exactly the
  // frame this is trying not to produce. Playwright's routes are
  // node-side and survive the navigation, so the mock keeps the pins.
  await page.reload();
  await waitForReady(page);
  await page.evaluate((t) => { document.documentElement.setAttribute('data-theme', t); }, theme);
  await page.click(`#sessions-list li[data-chat-id="${CHAT}"]`).catch(() => {});
  await page.waitForTimeout(900);
  const pinOpened = await page.evaluate(() => {
    const btn = document.getElementById('btn-pin-drawer-rail')
      || document.getElementById('btn-pin-drawer');
    if (!btn) return false;
    btn.click();
    return true;
  });
  if (!pinOpened) throw new Error('no pin-drawer toggle found — markup changed, fix the harness');
  await page.waitForTimeout(900);
  const pinCount = await page.evaluate(() =>
    document.querySelectorAll('#pin-drawer-list .pin-drawer-item').length);
  if (pinCount === 0) throw new Error('pinned panel rendered empty — seed did not reach the client');
  await page.screenshot({ path: `${OUT}/${variant}-pinned.png`, fullPage: false });
  console.log('shot', `${variant}-pinned.png`);

  // Fourth frame: the Docs panel READER on a meeting transcript — the
  // "doesn't feel professional yet" surface (pass points 4 + 5). The doc
  // is capture-shaped (source:'capture' + capture_id → the reader's
  // player strip renders; its /audio fetch 404s against the mock, which
  // only costs the duration readout) and its body opens with the literal
  // `_Recorded …_` line captureTranscribe.ts mints, because point 5 IS
  // that line rendering raw.
  await mock.pushEnvelope({
    type: 'doc_show', chat_id: CHAT,
    title: 'Meeting: Launch planning sync',
    format: 'markdown', path: '/captures/launch-sync.md',
    source: 'capture', capture_id: 'cap-ux-demo',
    displayed_at: Date.now() - 25 * 60_000,
    content: [
      '_Recorded 2026-08-25 10:35 · 1:34:39 · diarized_',
      '',
      '**Jonathan:** Walk me through where the demo instance stands.',
      '',
      '**Sam:** HTTPS cert is live; mic permission prompt tested on iOS and desktop Safari. The only open risk is Deepgram quota on the shared key.',
      '',
      '**Jonathan:** Gate the HN post on that. What does the fallback look like if quota trips mid-demo?',
      '',
      '**Sam:** Web Speech path degrades gracefully — worse accuracy, but the call stays up.',
    ].join('\n'),
  });
  // A fresh (non-replay) doc_show AUTO-OPENS the docs panel, so clicking
  // the rail tab unconditionally toggles it straight back shut — and a
  // `.doc-drawer-content` existence check still passes then, because the
  // panel hides via [hidden] with its DOM intact. Click only when the
  // panel isn't already showing, and assert VISIBILITY, not existence.
  const docVisible = () => page.evaluate(() => {
    const panel = document.getElementById('doc-drawer-panel');
    return !!panel && !panel.hidden && panel.getClientRects().length > 0
      && !!document.querySelector('#doc-drawer-body .doc-drawer-content');
  });
  if (!(await docVisible())) {
    const clicked = await page.evaluate(() => {
      const btn = document.getElementById('btn-doc-drawer-rail');
      if (!btn) return false;
      btn.click();
      return true;
    });
    if (!clicked) throw new Error('no doc-drawer toggle found — markup changed, fix the harness');
    await page.waitForTimeout(700);
  }
  if (!(await docVisible())) throw new Error('doc reader not visible — do not ship a frame without the subject');
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${OUT}/${variant}-doc.png`, fullPage: false });
  console.log('shot', `${variant}-doc.png`);
  await mock.close?.().catch?.(() => {});
  await cleanup();
}

const { browser, closeShared } = await launchSharedBrowser({});
for (const mobile of [false, true]) {
  for (const theme of ['dark', 'light']) {
    await shoot(browser, { mobile, theme });
  }
}
await closeShared();
console.log('DONE ->', OUT);
