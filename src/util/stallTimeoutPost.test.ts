/**
 * @fileoverview The stall-bounded upload transport.
 *
 * The property under test is the one the old wall-clock transport could
 * not express: an upload that keeps MOVING BYTES must be allowed to
 * finish no matter how long that takes, while an upload that has gone
 * quiet must be abandoned promptly. That is the difference between
 * Jonathan's 400KB dictation draining and looping forever.
 *
 * Driven through a fake XMLHttpRequest so the timing is deterministic
 * (node has no XHR, so installing one also selects the browser code
 * path rather than the fetch fallback).
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { postJsonWithStallTimeout, StallTimeoutError } from './stallTimeoutPost.ts';
import { TimeoutError } from './fetchWithTimeout.ts';
import { postTranscribe, PermanentTranscribeError } from '../audio/shared/postTranscribe.ts';

// ── fake XHR ────────────────────────────────────────────────────────────
type Handlers = Record<string, ((e?: any) => void) | null>;

class FakeXHR {
  static last: FakeXHR | null = null;
  static onSend: ((xhr: FakeXHR) => void) | null = null;

  status = 0;
  responseText = '';
  upload: Handlers = { onprogress: null, onload: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  aborted = false;
  headers: Record<string, string> = {};
  url = '';
  body: any = null;
  private timers: any[] = [];

  constructor() { FakeXHR.last = this; }
  open(_m: string, u: string) { this.url = u; }
  setRequestHeader(k: string, v: string) { this.headers[k] = v; }
  send(body: any) { this.body = body; FakeXHR.onSend?.(this); }
  abort() {
    if (this.aborted) return;
    this.aborted = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
    this.onabort?.();
  }

  /** Schedule `fn` unless/until the transport aborts us. */
  at(ms: number, fn: () => void) {
    this.timers.push(setTimeout(() => { if (!this.aborted) fn(); }, ms));
  }
  progress(loaded: number, total: number) {
    this.upload.onprogress?.({ loaded, total, lengthComputable: true });
  }
  finishUpload() { this.upload.onload?.({}); }
  respond(status: number, text: string) {
    this.status = status; this.responseText = text; this.onload?.();
  }
  netError() { this.status = 0; this.onerror?.(); }
}

const BODY = { size: 400 * 1024 } as Blob;   // ~Jonathan's dictation
const OK_BODY = JSON.stringify({ ok: true, transcript: 'hello there' });

beforeEach(() => {
  FakeXHR.onSend = null;
  (globalThis as any).XMLHttpRequest = FakeXHR;
});
afterEach(() => { delete (globalThis as any).XMLHttpRequest; });

const post = (budget: any, onProgress?: any) =>
  postJsonWithStallTimeout('/transcribe', BODY, 'audio/webm', budget, onProgress);

describe('stall-bounded upload: the slow-link case', () => {
  it('completes an upload that takes FAR longer than the stall window', async () => {
    // THE REGRESSION TEST. 400KB delivered in 8 ticks over ~320ms with a
    // 120ms stall window: total elapsed is ~2.7x the window, which the
    // old wall-clock transport would have aborted. Bytes are moving, so
    // this must succeed.
    FakeXHR.onSend = (x) => {
      for (let i = 1; i <= 8; i++) x.at(i * 40, () => x.progress(i * 50 * 1024, BODY.size));
      x.at(340, () => x.finishUpload());
      x.at(360, () => x.respond(200, OK_BODY));
    };
    const t0 = Date.now();
    const res = await post({ stallMs: 120, responseMs: 200, ceilingMs: 5_000 });
    assert.equal(res.status, 200);
    assert.equal(res.data.transcript, 'hello there');
    assert.ok(Date.now() - t0 > 120,
      'the upload must genuinely have outlived the stall window');
  });

  it('reports bytes as they move, so the UI can prove it is not frozen', async () => {
    const seen: number[] = [];
    FakeXHR.onSend = (x) => {
      x.at(10, () => x.progress(100 * 1024, BODY.size));
      x.at(20, () => x.progress(300 * 1024, BODY.size));
      x.at(30, () => x.finishUpload());
      x.at(40, () => x.respond(200, OK_BODY));
    };
    await post({ stallMs: 500, responseMs: 500, ceilingMs: 5_000 }, (sent: number) => seen.push(sent));
    assert.deepEqual(seen, [100 * 1024, 300 * 1024, BODY.size]);
  });
});

describe('stall-bounded upload: the genuinely-wedged cases', () => {
  it('aborts when the upload goes quiet, reporting how far it got', async () => {
    FakeXHR.onSend = (x) => { x.at(10, () => x.progress(200 * 1024, BODY.size)); };
    await assert.rejects(
      post({ stallMs: 80, responseMs: 5_000, ceilingMs: 5_000 }),
      (e: Error) => {
        assert.ok(e instanceof StallTimeoutError, `got ${e?.constructor?.name}`);
        assert.ok(e instanceof TimeoutError, 'must keep the existing retry classification');
        assert.equal((e as StallTimeoutError).sentBytes, 200 * 1024);
        assert.match(e.message, /200KB of 400KB/);
        return true;
      },
    );
  });

  it('aborts a dead link that never emits a single progress event', async () => {
    FakeXHR.onSend = () => { /* silence */ };
    await assert.rejects(
      post({ stallMs: 60, responseMs: 5_000, ceilingMs: 5_000 }),
      (e: Error) => e instanceof StallTimeoutError && (e as StallTimeoutError).sentBytes === 0,
    );
  });

  it('after the body is out, a silent server hits the RESPONSE budget (not a stall)', async () => {
    // Nothing is observable as progress once the request is sent, so a
    // wall clock is correct for this phase — and it must not be confused
    // with a stall, which would mislabel a slow Deepgram as a slow link.
    FakeXHR.onSend = (x) => {
      x.at(10, () => { x.progress(BODY.size, BODY.size); x.finishUpload(); });
    };
    await assert.rejects(
      post({ stallMs: 5_000, responseMs: 60, ceilingMs: 5_000 }),
      (e: Error) => {
        assert.ok(e instanceof TimeoutError);
        assert.ok(!(e instanceof StallTimeoutError), 'a slow server is not a stalled upload');
        assert.match(e.message, /no response 60ms after upload completed/);
        return true;
      },
    );
  });

  it('falls back to a plain wall clock when upload progress is never reported', async () => {
    // Some transports report nothing at all about the request body
    // (Playwright's route.fulfill is one, empirically). With only the
    // stall instrument armed, such a request would be governed by the
    // long stall window — strictly worse than the wall clock we
    // replaced. So the wall clock stays armed until an upload event
    // proves progress is observable.
    FakeXHR.onSend = (x) => { x.at(400, () => x.respond(200, OK_BODY)); };
    await assert.rejects(
      post({ stallMs: 5_000, responseMs: 60, ceilingMs: 5_000 }),
      (e: Error) => {
        assert.ok(e instanceof TimeoutError);
        assert.match(e.message, /no upload progress reported/);
        return true;
      },
    );
  });

  it('the wall-clock fallback is disarmed by the FIRST progress tick', async () => {
    // The field case in miniature: a 60ms response budget would have
    // killed this, but one progress tick at 20ms hands the request over
    // to the stall instrument and it runs to completion at ~300ms.
    FakeXHR.onSend = (x) => {
      x.at(20, () => x.progress(10 * 1024, BODY.size));
      x.at(150, () => x.progress(300 * 1024, BODY.size));
      x.at(280, () => { x.progress(BODY.size, BODY.size); x.finishUpload(); });
      x.at(300, () => x.respond(200, OK_BODY));
    };
    const res = await post({ stallMs: 400, responseMs: 60, ceilingMs: 5_000 });
    assert.equal(res.data.transcript, 'hello there');
  });

  it('a trickle that never technically stalls still terminates at the ceiling', async () => {
    FakeXHR.onSend = (x) => {
      let loaded = 0;
      const tick = () => { loaded += 1024; x.progress(loaded, BODY.size); x.at(20, tick); };
      x.at(20, tick);
    };
    await assert.rejects(
      post({ stallMs: 5_000, responseMs: 5_000, ceilingMs: 150 }),
      (e: Error) => {
        assert.ok(e instanceof TimeoutError);
        assert.match(e.message, /exceeded 150ms ceiling/);
        return true;
      },
    );
  });

  it('a stall abort must not leave the request running', async () => {
    FakeXHR.onSend = () => {};
    await assert.rejects(post({ stallMs: 40, responseMs: 5_000, ceilingMs: 5_000 }));
    assert.equal(FakeXHR.last!.aborted, true);
  });
});

describe('stall-bounded upload: transport failures stay transient', () => {
  it('a network error surfaces as a plain Error, never a permanent one', async () => {
    FakeXHR.onSend = (x) => { x.at(10, () => x.netError()); };
    await assert.rejects(
      post({ stallMs: 5_000, responseMs: 5_000, ceilingMs: 5_000 }),
      (e: Error) => !(e instanceof TimeoutError) && /network error/.test(e.message),
    );
  });

  it('a non-JSON body names the status instead of throwing a bare SyntaxError', async () => {
    FakeXHR.onSend = (x) => { x.at(10, () => { x.finishUpload(); x.respond(502, '<html>nope</html>'); }); };
    await assert.rejects(
      post({ stallMs: 5_000, responseMs: 5_000, ceilingMs: 5_000 }),
      (e: Error) => /unparseable response \(HTTP 502\)/.test(e.message),
    );
  });

  it('sends the caller mime type as Content-Type', async () => {
    FakeXHR.onSend = (x) => { x.at(5, () => { x.finishUpload(); x.respond(200, OK_BODY); }); };
    await post({ stallMs: 500, responseMs: 500, ceilingMs: 5_000 });
    assert.equal(FakeXHR.last!.headers['Content-Type'], 'audio/webm');
  });
});

describe('postTranscribe over the XHR transport', () => {
  // The permanent-vs-transient matrix is pinned in postTranscribe.test.ts
  // against the fetch fallback. These re-check the two decisions that
  // cost real data if the transport swap moved them: a corrupt blob must
  // still DROP, and a 5xx must still be RETRIED.
  const run = (budget: any) => postTranscribe('/transcribe', BODY, 'audio/webm', budget);

  it('still drops an unprocessable blob (PermanentTranscribeError)', async () => {
    FakeXHR.onSend = (x) => x.at(5, () => {
      x.finishUpload();
      x.respond(200, JSON.stringify({ ok: false, error: 'deepgram 400 corrupt or unsupported data' }));
    });
    await assert.rejects(run({ stallMs: 500, responseMs: 500, ceilingMs: 5_000 }),
      (e: Error) => e instanceof PermanentTranscribeError);
  });

  it('still retries a 5xx (transient)', async () => {
    FakeXHR.onSend = (x) => x.at(5, () => {
      x.finishUpload();
      x.respond(200, JSON.stringify({ ok: false, error: 'HTTP 502 bad gateway' }));
    });
    await assert.rejects(run({ stallMs: 500, responseMs: 500, ceilingMs: 5_000 }),
      (e: Error) => !(e instanceof PermanentTranscribeError));
  });

  it('accepts a bare number budget (all three phases share it)', async () => {
    FakeXHR.onSend = (x) => x.at(5, () => { x.finishUpload(); x.respond(200, OK_BODY); });
    assert.equal(await run(400), 'hello there');
  });

  it('returns the trimmed transcript on success', async () => {
    FakeXHR.onSend = (x) => x.at(5, () => {
      x.finishUpload();
      x.respond(200, JSON.stringify({ ok: true, transcript: '  spaced  ' }));
    });
    assert.equal(await run({ stallMs: 500, responseMs: 500, ceilingMs: 5_000 }), 'spaced');
  });
});
