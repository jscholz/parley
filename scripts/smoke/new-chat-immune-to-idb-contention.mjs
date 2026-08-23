// Latency follow-up (Jonathan field 2026-07-13: "new chat sometimes
// instant, sometimes 3s; placeholder sometimes takes seconds to
// disappear"): the new-chat critical path awaited an IDB write
// (conversations.setActive) on the SAME database the drawer's
// list-merge writes rows to. IDB transactions queue — on a
// months-old profile with churn, the mint stalls behind whatever
// else is writing. Fresh-context smokes never see it, which is why
// it reproduced on his machine and not in the lab.
//
// This smoke MANUFACTURES the contention: an in-page transaction hog
// keeps a readwrite transaction alive on parley-conversations by
// chaining puts, then clicks New chat. The shell must paint + become
// typeable without waiting for the hog (the mint's IDB persistence is
// durability-only — the chat id itself is set synchronously).

import { waitForReady, openSidebar, clickRow, waitForDrawerQuiet } from './lib.mjs';

export const NAME = 'new-chat-immune-to-idb-contention';
export const DESCRIPTION = 'New chat paints + is typeable fast even while an IDB transaction hog blocks the conversations DB';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

const CHAT_A = 'mock-idb-chat-a';

export function MOCK_SETUP(mock) {
  const t0 = Date.now() / 1000 - 120;
  mock.addChat(CHAT_A, {
    title: 'IDB A',
    messages: [{ role: 'user', content: 'IDB-A-SEED', parley_id: 'umsg_idb_a', timestamp: t0 }],
    lastActiveAt: Date.now() - 1000,
  });
}

export default async function run({ page, log, mock }) {
  await waitForReady(page);
  await openSidebar(page);
  await clickRow(page, CHAT_A);
  await page.waitForFunction(
    () => (document.getElementById('transcript')?.textContent || '').includes('IDB-A-SEED'),
    null, { timeout: 5000, polling: 50 },
  );
  await waitForDrawerQuiet(page);

  // Start the transaction hog: holds a readwrite transaction open on
  // the conversations store for ~4s by chaining puts (a transaction
  // stays alive as long as requests keep being issued from its own
  // callbacks). Any other readwrite transaction on that store queues
  // behind it.
  await page.evaluate(() => {
    window.__hogDone = false;
    const open = indexedDB.open('parley-conversations');
    open.onsuccess = () => {
      const db = open.result;
      const stop = performance.now() + 4000;
      try {
        const tx = db.transaction('conversations', 'readwrite');
        const store = tx.objectStore('conversations');
        const spin = () => {
          if (performance.now() > stop) { window.__hogDone = true; return; }
          const req = store.put({ chat_id: '__hog__', title: 'hog', last_message_at: 0 });
          req.onsuccess = spin;
          req.onerror = () => { window.__hogDone = true; };
        };
        spin();
        tx.oncomplete = () => { window.__hogDone = true; db.close(); };
      } catch { window.__hogDone = true; }
    };
  });
  await new Promise((r) => setTimeout(r, 150));   // hog armed
  log('IDB transaction hog running on parley-conversations');

  // New chat during the hog: must be typeable WELL before the hog ends.
  const ms = await page.evaluate(async () => {
    const t0 = performance.now();
    document.getElementById('sb-new-chat').click();
    for (;;) {
      const text = document.getElementById('transcript')?.textContent || '';
      const focused = document.activeElement?.id === 'composer-input';
      if (text.includes('New chat started') && focused) return performance.now() - t0;
      if (performance.now() - t0 > 6000) return -1;
      await new Promise((r) => setTimeout(r, 10));
    }
  });
  if (ms < 0) throw new Error('new chat never became typeable under IDB contention');
  log(`new chat typeable in ${ms.toFixed(0)}ms under contention`);
  if (ms > 500) {
    throw new Error(`new chat took ${ms.toFixed(0)}ms under IDB contention — the mint is waiting on the blocked DB (field bug: "sometimes instant, sometimes 3s")`);
  }

  // The sidebar's "New conversation" placeholder must APPEAR promptly
  // too — not wait for the IDB-bound refresh (field 2026-07-13 v0.628:
  // "new chat still takes 3s to create the session entry in sidebar").
  const phAppeared = await page.evaluate(async () => {
    const t0 = performance.now();
    for (;;) {
      const has = [...document.querySelectorAll('#sessions-list li')]
        .some((r) => (r.textContent || '').includes('New conversation'));
      if (has) return performance.now() - t0;
      if (performance.now() - t0 > 6000) return -1;
      await new Promise((r) => setTimeout(r, 25));
    }
  });
  if (phAppeared < 0) throw new Error('placeholder row never appeared after new chat');
  log(`placeholder appeared ${phAppeared.toFixed(0)}ms after new chat`);
  if (phAppeared > 500) {
    throw new Error(`placeholder took ${phAppeared.toFixed(0)}ms to appear under IDB contention — sidebar entry is waiting on the blocked refresh`);
  }

  // ── Slow-list + in-flight-refresh window (field v0.628: "new chat
  //    still takes 3s to create the session entry in sidebar"). The
  //    drawer refresh is SINGLE-FLIGHT: with a slow /sessions fetch in
  //    flight, new-chat's trailing refresh() returns without queuing —
  //    the placeholder must come from the local derived-view repaint,
  //    never from the network. Structural contract (Jonathan): every
  //    session operation updates locally NOW, syncs behind.
  await clickRow(page, CHAT_A);
  await new Promise((r) => setTimeout(r, 600));
  mock.setSessionsDelay(3000);
  // Kick a refresh so the single-flight lock is HELD on the slow fetch.
  await page.evaluate(async () => {
    const drawer = await import('/build/sessionDrawer.mjs');
    void drawer.refresh?.();
  });
  await new Promise((r) => setTimeout(r, 200));   // refresh in flight
  const phSlow = await page.evaluate(async () => {
    document.getElementById('sb-new-chat')?.click();
    const t0 = performance.now();
    for (;;) {
      const has = [...document.querySelectorAll('#sessions-list li')]
        .some((r) => (r.textContent || '').includes('New conversation'));
      if (has) return performance.now() - t0;
      if (performance.now() - t0 > 6000) return -1;
      await new Promise((r) => setTimeout(r, 25));
    }
  });
  mock.setSessionsDelay(0);
  if (phSlow < 0) throw new Error('placeholder never appeared with a slow list fetch in flight');
  log(`placeholder appeared ${phSlow.toFixed(0)}ms after new chat (slow list in flight)`);
  if (phSlow > 500) {
    throw new Error(`placeholder waited ${phSlow.toFixed(0)}ms on the in-flight list fetch — local update must not gate on sync (the v0.628 field bug)`);
  }

  // Placeholder must also clear promptly when switching away, without
  // waiting for IDB-bound cleanup/refresh.
  await new Promise((r) => setTimeout(r, 300));
  await clickRow(page, CHAT_A);
  const phGone = await page.evaluate(async () => {
    const t0 = performance.now();
    for (;;) {
      const has = [...document.querySelectorAll('#sessions-list li')]
        .some((r) => (r.textContent || '').includes('New conversation'));
      if (!has) return performance.now() - t0;
      if (performance.now() - t0 > 6000) return -1;
      await new Promise((r) => setTimeout(r, 25));
    }
  });
  if (phGone < 0) throw new Error('placeholder row never cleared after switching away');
  log(`placeholder cleared ${phGone.toFixed(0)}ms after switch-away`);
  if (phGone > 500) {
    throw new Error(`placeholder lingered ${phGone.toFixed(0)}ms after switch-away — repaint is waiting on IDB/refresh (field bug)`);
  }
  await page.waitForFunction(() => window.__hogDone === true, null, { timeout: 8000 });
}
