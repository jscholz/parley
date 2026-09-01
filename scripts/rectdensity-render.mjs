// B3 rect-density render harness (not a smoke).
//
// scripts/ux-render.mjs covers the session drawer / pins / doc reader,
// but B3's named subjects also include the capture pill, the docs LIST
// view, the settings panel and the composer's attachment chips — none of
// which that harness ever puts in frame. Rather than bend it (its frames
// are the reference set for pass points 1-7 and must stay stable), this
// is a sibling that shoots the rect-density surfaces specifically.
//
//   node scripts/rectdensity-render-isolated.mjs <label>
//
// Shoots desktop+mobile x dark+light into /tmp/ux-renders/<label>.
// Run it once from a clean worktree at HEAD (label `b3-before`) and once
// from the working tree (`b3-after`) so the pairs are directly
// comparable — and go through the -isolated wrapper both times, because
// lib.mjs's DEFAULT_URL is the LIVE :3001 and a "before" run served by
// the working tree's own dev server renders the after state.
import { launchSharedBrowser, launchBrowser, waitForReady } from './smoke/lib.mjs';
import { installMockBackend } from './smoke/mock-backend.mjs';
import { mkdirSync } from 'node:fs';

const LABEL = process.argv[2] || 'rectdensity';
const OUT = `/tmp/ux-renders/${LABEL}`;
mkdirSync(OUT, { recursive: true });

const CHAT = 'ux-demo';
const tSec = Date.now() / 1000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const MESSAGES = [
  { role: 'user', content: 'Can you summarize the plan for the launch and flag anything risky?', message_id: 'm1', parley_id: 'm1', timestamp: tSec - 600 },
  { role: 'assistant', content: `Here's the shape of it.

**Launch plan — three phases**

1. **Soft launch** to the invite list (~20 people). Watch for signup friction.
2. **Show HN** timed to the next hermes news beat, with the demo video up top.
3. **Awesome-list PRs** the same week so the placement compounds.

The one risky dependency is the hosted demo instance — voice needs HTTPS + mic permission, so if that slips, the whole funnel stalls.

\`\`\`ts
const funnel = ['video', 'demo', 'show-hn'];
funnel.forEach(step => track(step));
\`\`\`

Want me to draft the Show HN copy?`, message_id: 'm2', parley_id: 'm2', timestamp: tSec - 580 },
  { role: 'user', content: 'Yes — keep it short and honest.', message_id: 'm3', parley_id: 'm3', timestamp: tSec - 120 },
  { role: 'assistant', content: `Draft:

> **Show HN: A voice-first phone client for self-hosted agents**
>
> I got tired of only reaching my agent from a terminal, so I built a client I can talk to from my pocket — streaming dictation, real calls with barge-in, meeting capture.

Short, leads with the wedge, names the backends.`, message_id: 'm4', parley_id: 'm4', timestamp: tSec - 100 },
];

const SESSIONS = [
  ['ux-2', 'Investor pitch intro refinement', 2 * HOUR],
  ['ux-3', 'Dust exposure health concerns', 5 * HOUR],
  ['ux-4', 'Deepgram keyterm tuning', DAY + 3 * HOUR],
  ['ux-5', 'Barge-in threshold field notes', DAY + 7 * HOUR],
  ['ux-6', 'Hermes plugin: unread reconcile', 3 * DAY],
  ['ux-7', 'Capture lifecycle post-mortem', 4 * DAY],
  ['ux-8', 'R2 bucket + CDN pricing', 9 * DAY],
];

// Tool-call round trip in the transcript, so the .activity-row →
// .tool-args-block / .tool-result-block nest is actually in frame.
// Changing chrome you never render is how a "cleanup" ships a surface
// nobody looked at — and it's what caught .tool-result-copy being dead
// CSS no code path emits.
const toolCallJson = (callId, name, args) => JSON.stringify([{
  id: callId, call_id: callId, type: 'function',
  function: { name, arguments: JSON.stringify(args || {}) },
}]);

function toolMessages() {
  const t0 = tSec - 90;
  const out = [{ role: 'user', content: 'Check the demo host before I post.', message_id: 'tm0', parley_id: 'tm0', timestamp: t0 }];
  const calls = [
    ['call_b3_0', 'run_command', { cmd: 'curl -sI https://demo.parley.app | head -1' }, 'HTTP/2 200'],
    ['call_b3_1', 'read_file', { path: '/etc/nginx/sites-enabled/demo' }, 'ssl_certificate /etc/letsencrypt/live/demo/fullchain.pem;'],
  ];
  calls.forEach(([id, name, args, output], i) => {
    out.push({ role: 'assistant', content: '', tool_calls: toolCallJson(id, name, args), timestamp: t0 + 1 + i });
    out.push({ role: 'tool', content: JSON.stringify({ output, exit_code: 0 }), tool_call_id: id, timestamp: t0 + 1.5 + i });
  });
  out.push({ role: 'assistant', content: 'Cert is live and the host answers 200 — the demo gate is clear.', message_id: 'tm9', parley_id: 'tm9', timestamp: t0 + 10 });
  return out;
}

function seed(mock) {
  mock.addChat(CHAT, { title: 'Launch plan', source: 'parley', messages: MESSAGES, lastActiveAt: Date.now() });
  mock.addChat('ux-tools', {
    title: 'Demo host preflight', source: 'parley',
    messages: toolMessages(), lastActiveAt: Date.now() - 60_000,
  });
  // Two tombstones so the Docs panel's Recently Deleted section is
  // populated (it self-hides when empty — the reason its rows and its
  // Restore button had never been rendered).
  mock.addCapture(CHAT, { id: 'cap-del-1', title: 'Board sync (discarded)', status: 'discarded', discardedAt: Date.now() - 2 * HOUR });
  mock.addCapture(CHAT, { id: 'cap-del-2', title: 'Standup 2026-08-24', status: 'discarded', discardedAt: Date.now() - 26 * HOUR });
  for (const [id, title, ago] of SESSIONS) {
    mock.addChat(id, {
      title, source: 'parley',
      messages: [{ role: 'user', content: 'hi', message_id: `seed-${id}`, timestamp: tSec - ago / 1000 }],
      lastActiveAt: Date.now() - ago,
    });
  }
}

// Drive the capture pill through the same CustomEvent the
// capture-pill-* smokes use, so the rendered pill is the real component
// in a real phase — not a hand-built mock of it.
const pushPill = (page, phase, elapsedMs, extra = {}) => page.evaluate(({ ph, ms, ex }) => {
  window.dispatchEvent(new CustomEvent('parley:capture-state', {
    detail: {
      active: ph !== 'finishing' && ph !== 'starting' && ph !== 'failed',
      captureId: 'cap_b3_render',
      title: 'Launch planning sync with finance and ops',
      chatId: 'ux-demo',
      startedAt: Date.now() - ms,
      phase: ph,
      uploaderPending: ph === 'finishing' ? 2 : 0,
      sealedSegments: 3, marks: 1,
      stalledTotalMs: 0, stalledSince: null,
      failedReason: 'The server stopped receiving audio and ended this recording.',
      ...ex,
    },
  }));
}, { ph: phase, ms: elapsedMs, ex: extra });

// render() in src/capture/pill.ts reads state.active first, so a null
// detail throws inside the listener and the pill stays on screen —
// which is how the first run of this harness put a "NOT RECORDED" pill
// in every non-pill frame. Send a real idle state instead.
const hidePill = (page) => page.evaluate(() => {
  window.dispatchEvent(new CustomEvent('parley:capture-state', {
    detail: { active: false, phase: 'idle', captureId: null, chatId: null,
      title: '', startedAt: 0, uploaderPending: 0, sealedSegments: 0,
      marks: 0, stalledTotalMs: 0, stalledSince: null },
  }));
});

// Attachment chips live in module-private state in src/attachments.ts
// with no seam to push a File through headlessly. This is a presentation
// audit, so the chips are built from the exact markup renderChips()
// emits (attachment-chip > img | .chip-pdf-label, plus .chip-remove) —
// verified against that function, and asserted non-empty below.
const seedChips = (page) => page.evaluate(() => {
  const box = document.getElementById('composer-attachments');
  if (!box) return 0;
  const png = 'data:image/svg+xml;utf8,' + encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96">
       <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
         <stop offset="0" stop-color="#6b8f6b"/><stop offset="1" stop-color="#2b4a3f"/>
       </linearGradient></defs>
       <rect width="96" height="96" fill="url(#g)"/>
       <circle cx="30" cy="30" r="12" fill="#e8e4d8"/>
       <path d="M0 78 L34 44 L60 70 L78 56 L96 74 L96 96 L0 96 Z" fill="#22362e"/>
     </svg>`);
  box.style.display = 'flex';
  box.innerHTML = '';
  for (const kind of ['img', 'img', 'pdf']) {
    const chip = document.createElement('div');
    chip.className = 'attachment-chip' + (kind === 'pdf' ? ' chip-pdf' : '');
    if (kind === 'pdf') {
      const ph = document.createElement('div');
      ph.className = 'chip-pdf-label';
      ph.textContent = 'PDF';
      chip.appendChild(ph);
    } else {
      const img = document.createElement('img');
      img.src = png;
      chip.appendChild(img);
    }
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'chip-remove';
    btn.textContent = '×';
    chip.appendChild(btn);
    box.appendChild(chip);
  }
  const ta = document.querySelector('.composer textarea');
  if (ta) ta.value = 'Here are the three assets for the launch page — the hero still, the alt crop, and the spec PDF.';
  return box.children.length;
});

const clearChips = (page) => page.evaluate(() => {
  const box = document.getElementById('composer-attachments');
  if (box) { box.innerHTML = ''; box.style.display = 'none'; }
  const ta = document.querySelector('.composer textarea');
  if (ta) ta.value = '';
});

async function shoot(browser, { mobile, theme }) {
  const { page, cleanup } = await launchBrowser(browser, { mobile });
  const mock = await installMockBackend(page);
  seed(mock);
  await waitForReady(page);

  const setTheme = () => page.evaluate((t) => {
    document.documentElement.setAttribute('data-theme', t);
  }, theme);
  await setTheme();

  // Pins + activity are boot-time fetches, so seed them server-side and
  // reload once rather than after the panels are open (the ux-render
  // harness learned this the hard way — a post-boot seed renders an
  // empty panel).
  await page.evaluate(async (chat) => {
    await fetch('/api/parley/prefs/pinnedSessions', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: JSON.stringify(['ux-6', 'ux-3']) }),
    });
    const pins = [
      { role: 'assistant', text: 'The one risky dependency is the hosted demo instance — voice needs HTTPS + mic permission.', ago: 600 },
      { role: 'user', text: 'Gate the HN post on the demo being live.', ago: 5400 },
      { role: 'assistant', text: 'Show HN: A voice-first phone client for self-hosted agents (Hermes, OpenClaw, Claude Code)', ago: 90_000 },
    ];
    for (const [i, p] of pins.entries()) {
      await fetch('/api/parley/pins', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chat, msg_id: `pin-${i}`, role: p.role, text: p.text,
          timestamp: Date.now() / 1000 - p.ago,
        }),
      });
    }
    const acts = [
      { id: 'a1', kind: 'approval', title: 'Run `rm -rf build/` in ~/code/parley?', body: 'The agent wants to clear the build directory before rebuilding.', urgent: true },
      { id: 'a2', kind: 'notification', title: 'Deploy finished', body: 'parley@master is live on galatea.', read: false },
      { id: 'a3', kind: 'notification', title: 'Deepgram quota at 71%', body: 'Shared key. Consider a per-project key before the demo.', read: true },
    ];
    for (const [i, a] of acts.entries()) {
      await fetch('/api/parley/activity', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...a, chatId: chat, createdAt: Date.now() / 1000 - 300 * (i + 1) }),
      });
    }
  }, CHAT);
  // On a phone the sidebar is off-canvas at boot, so a bare click on a
  // session row is "not visible" and times out — the original
  // `.catch(() => {})` swallowed that and the mobile frames only ever
  // showed whatever chat auto-selected. Open the mobile drawer first,
  // and assert afterwards that the intended chat is the one on screen.
  const toggleSidebar = () => page.evaluate(() => {
    // Same evaluate-click the session-drawer frame below uses. A
    // Playwright .click() on #sb-toggle is unreliable across form
    // factors: on a phone it resolves to the desktop button, which is
    // "visible" but scrolled outside the viewport and retries for 30s.
    const btn = document.getElementById('sb-toggle')
      || document.getElementById('sb-toggle-mobile');
    btn?.click();
    return !!btn;
  });
  const sidebarOpen = () => page.evaluate(() =>
    !!document.querySelector('#sidebar.expanded, body.sidebar-expanded'));

  const selectChat = async (chatId) => {
    // The sidebar is rail-collapsed at boot on BOTH form factors, so the
    // row's .sess-body has no box and a click on it times out. The
    // original code hid this behind `.catch(() => {})`, which meant the
    // frames only ever showed whichever chat auto-selected — true for
    // ux-demo by luck of being newest, false for anything else.
    if (!(await sidebarOpen())) {
      if (!(await toggleSidebar())) throw new Error('no sidebar toggle found — markup changed');
      await page.waitForFunction(
        () => !!document.querySelector('#sidebar.expanded, body.sidebar-expanded'),
        null, { timeout: 6000, polling: 50 });
      await page.waitForTimeout(400);
    }
    await page.click(`#sessions-list li[data-chat-id="${chatId}"] .sess-body`);
    await page.waitForTimeout(1100);
    if (await sidebarOpen()) {
      await toggleSidebar();
      await page.waitForTimeout(500);
    }
    const active = await page.evaluate(() =>
      document.querySelector('#sessions-list li.active')?.dataset.chatId || null);
    if (active !== chatId) throw new Error(`chat select failed: wanted ${chatId}, active is ${active}`);
  };

  await page.reload();
  await waitForReady(page);
  await setTheme();
  await selectChat(CHAT);

  const variant = `${mobile ? 'mobile' : 'desktop'}-${theme}`;
  const shot = async (name) => {
    await page.screenshot({ path: `${OUT}/${variant}-${name}.png`, fullPage: false });
    console.log('shot', `${variant}-${name}.png`);
  };

  // ── 1. Transcript + capture pill, the named B3 subject. Recording is
  // the everyday phase; interrupted and failed are the two whose colour
  // IS the message and must not be flattened.
  await pushPill(page, 'recording', 22 * 60_000);
  await page.waitForTimeout(400);
  const pillVisible = await page.evaluate(() => {
    const p = document.getElementById('capture-pill');
    return !!p && !p.hidden && p.getClientRects().length > 0;
  });
  if (!pillVisible) throw new Error('capture pill not visible — do not ship a B3 frame without its subject');
  await shot('pill-recording');

  await pushPill(page, 'interrupted', 22 * 60_000);
  await page.waitForTimeout(300);
  await shot('pill-interrupted');

  await pushPill(page, 'paused', 22 * 60_000);
  await page.waitForTimeout(300);
  await shot('pill-paused');

  await pushPill(page, 'failed', 22 * 60_000);
  await page.waitForTimeout(300);
  await shot('pill-failed');
  await hidePill(page);
  await page.waitForTimeout(400);
  if (await page.evaluate(() => {
    const p = document.getElementById('capture-pill');
    return !!p && !p.hidden;
  })) throw new Error('pill did not stand down — it would photobomb every later frame');

  // ── 2. Composer + attachment chips.
  const chips = await seedChips(page);
  if (chips !== 3) throw new Error(`expected 3 attachment chips, got ${chips}`);
  await page.waitForTimeout(350);
  await shot('composer-chips');
  await clearChips(page);

  // ── 3. Settings panel.
  await page.evaluate(() => document.getElementById('sb-settings')?.click());
  await page.waitForTimeout(600);
  const settingsOpen = await page.evaluate(() =>
    !!document.querySelector('#settings.on'));
  if (!settingsOpen) throw new Error('settings did not open — markup changed, fix the harness');
  await shot('settings');
  // Second settings frame on desktop: a group with text inputs + action
  // buttons, where the form-control border density actually shows.
  if (!mobile) {
    await page.evaluate(() => {
      const btn = [...document.querySelectorAll('#settings .settings-nav-btn')]
        .find(b => b.dataset.target === 'agent');
      btn?.click();
    });
    await page.waitForTimeout(400);
    await shot('settings-agent');
  }
  await page.evaluate(() => document.getElementById('settings-close')?.click());
  await page.waitForTimeout(400);

  // ── 4. Session drawer (the approved reference idiom — included so a
  // regression here is visible, not to be changed).
  const opened = await page.evaluate(() => {
    const btn = document.getElementById('sb-toggle') || document.getElementById('sb-toggle-mobile');
    if (!btn) return false;
    btn.click();
    return true;
  });
  if (!opened) throw new Error('no sidebar toggle found — markup changed, fix the harness');
  await page.waitForTimeout(700);
  if (!await page.evaluate(() => !!document.querySelector('#sidebar.expanded, body.sidebar-expanded')))
    throw new Error('sidebar did not expand');
  await shot('session-drawer');
  await page.evaluate(() => {
    const btn = document.getElementById('sb-toggle') || document.getElementById('sb-toggle-mobile');
    btn?.click();
  });
  await page.waitForTimeout(500);

  // ── 5. Pins panel.
  await page.evaluate(() => {
    (document.getElementById('btn-pin-drawer-rail') || document.getElementById('btn-pin-drawer'))?.click();
  });
  await page.waitForTimeout(800);
  const pinCount = await page.evaluate(() =>
    document.querySelectorAll('#pin-drawer-list .pin-drawer-item').length);
  if (pinCount === 0) throw new Error('pinned panel rendered empty — seed did not reach the client');
  await shot('pins');

  // ── 6. Activity panel.
  await page.evaluate(() => document.getElementById('btn-activity-drawer-rail')?.click());
  await page.waitForTimeout(800);
  const actCount = await page.evaluate(() =>
    document.querySelectorAll('#activity-drawer-list .activity-drawer-item').length);
  if (actCount === 0) throw new Error('activity panel rendered empty — seed did not reach the client');
  await shot('activity');

  // ── 7. Docs: reader (capture doc, so the player strip is in frame)
  // then the LIST view.
  await mock.pushEnvelope({
    type: 'doc_show', chat_id: CHAT,
    title: 'Launch plan draft', format: 'markdown', path: '/w/launch-plan.md',
    content: '# Launch plan\n\nPhases, owners, and the demo-instance gate.',
  });
  await mock.pushEnvelope({
    type: 'doc_show', chat_id: CHAT,
    title: 'Funnel dashboard', format: 'html', path: '/w/funnel.html',
    content: '<h1>Funnel</h1><p>video → demo → show-hn</p>',
  });
  await mock.pushEnvelope({
    type: 'doc_show', chat_id: CHAT,
    title: 'Server log excerpt', format: 'text', path: '/w/server.log.txt',
    content: 'boot ok\nssl ok\nquota warn: deepgram shared key at 71%',
  });
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
  const docVisible = () => page.evaluate(() => {
    const panel = document.getElementById('doc-drawer-panel');
    return !!panel && !panel.hidden && panel.getClientRects().length > 0
      && !!document.querySelector('#doc-drawer-body .doc-drawer-content');
  });
  if (!(await docVisible())) {
    await page.evaluate(() => document.getElementById('btn-doc-drawer-rail')?.click());
    await page.waitForTimeout(700);
  }
  if (!(await docVisible())) throw new Error('doc reader not visible — do not ship a frame without the subject');
  await page.waitForTimeout(500);
  await shot('doc-reader');

  // LIST view: the +N overflow chip is the entry point, so overflow the
  // rail strip first (7 tabs + chip past 8 docs).
  for (let i = 1; i <= 6; i++) {
    await mock.pushEnvelope({
      type: 'doc_show', chat_id: CHAT,
      title: `Overflow doc ${i}`, format: 'markdown', path: `/w/overflow-${i}.md`,
      content: `# Overflow ${i}\n\nFiller to overflow the rail tab strip.`,
    });
  }
  await page.waitForFunction(
    () => document.querySelector('#doc-rail-tabs .doc-rail-more')?.textContent === '+3',
    null, { timeout: 6000, polling: 50 });
  await page.evaluate(() => document.querySelector('#doc-rail-tabs .doc-rail-more')?.click());
  await page.waitForTimeout(700);
  const shelfRows = await page.evaluate(() =>
    document.querySelectorAll('#doc-drawer-body .doc-shelf-item').length);
  if (shelfRows === 0) throw new Error('docs LIST view rendered empty — the +N chip did not switch views');
  await shot('docs-list');

  // ── 8. Recently Deleted, expanded. Lives at the bottom of the LIST
  // view and self-hides when empty, which is why its rows and its
  // Restore button had never appeared in any render.
  const rdOpened = await page.evaluate(() => {
    const t = document.querySelector('.recently-deleted-toggle');
    if (!t) return false;
    if (t.getAttribute('aria-expanded') !== 'true') t.click();
    return true;
  });
  if (!rdOpened) throw new Error('no Recently Deleted toggle — tombstone seed did not reach the client');
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    const el = document.querySelector('.recently-deleted');
    el?.scrollIntoView({ block: 'end' });
  });
  await page.waitForTimeout(400);
  const rdRows = await page.evaluate(() =>
    document.querySelectorAll('.recently-deleted-item').length);
  if (rdRows === 0) throw new Error('Recently Deleted rendered empty — do not ship a frame without the subject');
  await shot('recently-deleted');

  // ── 9. Tool activity row in the transcript (.activity-row →
  // .tool-args-block / .tool-result-block). Reload first so the right
  // drawer and its overflowed doc tabs are out of the way, then use the
  // same asserted selectChat as everywhere else.
  await page.reload();
  await waitForReady(page);
  await setTheme();
  await selectChat('ux-tools');
  await page.waitForSelector('#transcript .activity-row', { timeout: 8000 });
  // Completed tool lists render collapsed; open the activity row, then
  // each <details> tool row (the args/result bodies hydrate lazily on
  // the details' own toggle event, so set .open rather than clicking —
  // clicking a summary AND its ancestors double-toggles back shut).
  await page.click('#transcript .activity-row .activity-row-summary').catch(() => {});
  await page.waitForTimeout(400);
  const bodies = await page.evaluate(() => {
    const ds = [...document.querySelectorAll('#transcript .tool-row-details')];
    ds.forEach(d => { d.open = true; });
    return ds.length;
  });
  if (bodies === 0) throw new Error('no tool rows in frame — tool seed did not reach the transcript');
  await page.waitForTimeout(700);
  const blocks = await page.evaluate(() =>
    [...document.querySelectorAll('#transcript .tool-result-block')]
      .filter(el => getComputedStyle(el).display !== 'none').length);
  if (blocks === 0) throw new Error('tool result blocks never hydrated — the frame would omit its subject');
  await shot('tool-activity');

  await mock.close?.().catch?.(() => {});
  await cleanup();
}

// RENDER_VARIANTS=desktop-light[,mobile-dark…] narrows the matrix while
// iterating on the harness itself; unset = the full four.
const WANT = (process.env.RENDER_VARIANTS || '').split(',').map(s => s.trim()).filter(Boolean);
const { browser, closeShared } = await launchSharedBrowser({});
for (const mobile of [false, true]) {
  for (const theme of ['dark', 'light']) {
    const name = `${mobile ? 'mobile' : 'desktop'}-${theme}`;
    if (WANT.length && !WANT.includes(name)) continue;
    await shoot(browser, { mobile, theme });
  }
}
await closeShared();
console.log('DONE ->', OUT);
