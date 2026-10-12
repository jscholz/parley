/**
 * @fileoverview Tests for the sendword detector — covers fail-soft on
 * unsupported SR, phrase matching against synthetic interim results,
 * auto-restart on `onend`, and clean teardown via stop().
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

// Stub the global window before importing the module — sendwordDetector
// reads `window.SpeechRecognition` at start() time.
function ensureWindow() {
  if (!(globalThis as any).window) (globalThis as any).window = {};
}
ensureWindow();

let lastInstance: any = null;
class StubSR {
  continuous = false;
  interimResults = false;
  lang = 'en-US';
  onresult: any = null;
  onend: any = null;
  onerror: any = null;
  onstart: any = null;
  startCalls = 0;
  abortCalls = 0;
  constructor() {
    lastInstance = this;
  }
  start() { this.startCalls++; if (this.onstart) this.onstart({}); }
  stop() { if (this.onend) this.onend({}); }
  abort() { this.abortCalls++; }
}

import * as sendword from '../src/audio/turn-based/sendwordDetector.ts';

describe('sendword detector', () => {
  beforeEach(() => {
    (globalThis as any).window.SpeechRecognition = StubSR;
    (globalThis as any).window.webkitSpeechRecognition = StubSR;
    lastInstance = null;
  });
  afterEach(() => {
    sendword.stop();
    delete (globalThis as any).window.SpeechRecognition;
    delete (globalThis as any).window.webkitSpeechRecognition;
  });

  it('isSupported returns false when SR ctor missing', () => {
    delete (globalThis as any).window.SpeechRecognition;
    delete (globalThis as any).window.webkitSpeechRecognition;
    assert.equal(sendword.isSupported(), false);
  });

  it('isSupported returns true when stub SR is wired', () => {
    assert.equal(sendword.isSupported(), true);
  });

  it('start returns false when SR is unavailable (fail-soft)', () => {
    delete (globalThis as any).window.SpeechRecognition;
    delete (globalThis as any).window.webkitSpeechRecognition;
    let matched = false;
    const ok = sendword.start({
      phrase: 'over',
      onMatch: () => { matched = true; },
    });
    assert.equal(ok, false);
    assert.equal(matched, false);
  });

  it('matches phrase at end of interim result', () => {
    let matched = false;
    sendword.start({ phrase: 'over', onMatch: () => { matched = true; } });
    assert.ok(lastInstance);
    lastInstance.onresult({
      resultIndex: 0,
      results: [
        Object.assign(
          [{ transcript: 'hello over', confidence: 0.9 }],
          { isFinal: false },
        ),
      ],
    });
    assert.equal(matched, true);
  });

  it('does NOT match mid-sentence phrase', () => {
    let matched = false;
    sendword.start({ phrase: 'over', onMatch: () => { matched = true; } });
    assert.ok(lastInstance);
    lastInstance.onresult({
      resultIndex: 0,
      results: [
        Object.assign(
          [{ transcript: 'i went over to the store and grabbed milk', confidence: 0.9 }],
          { isFinal: false },
        ),
      ],
    });
    assert.equal(matched, false);
  });

  it('matches at end with trailing punctuation', () => {
    let matched = false;
    sendword.start({ phrase: 'over', onMatch: () => { matched = true; } });
    assert.ok(lastInstance);
    lastInstance.onresult({
      resultIndex: 0,
      results: [
        Object.assign(
          [{ transcript: 'all done. Over.', confidence: 0.9 }],
          { isFinal: false },
        ),
      ],
    });
    assert.equal(matched, true);
  });

  it('respects the configured phrase (custom word)', () => {
    let matched = false;
    sendword.start({ phrase: 'send', onMatch: () => { matched = true; } });
    assert.ok(lastInstance);
    lastInstance.onresult({
      resultIndex: 0,
      results: [
        Object.assign(
          [{ transcript: 'reply to mom send', confidence: 0.9 }],
          { isFinal: false },
        ),
      ],
    });
    assert.equal(matched, true);
  });

  it('stop() prevents auto-restart', () => {
    sendword.start({ phrase: 'over', onMatch: () => {} });
    const inst = lastInstance;
    assert.ok(inst);
    sendword.stop();
    // Simulate onend firing AFTER stop — should NOT build a new instance.
    inst.stop();
    // Wait one microtask + small delay for the restart timer.
    return new Promise((resolve) => {
      setTimeout(() => {
        // No new instance should have been created.
        assert.equal(lastInstance, inst);
        resolve(undefined);
      }, 250);
    });
  });
});

// ── External-source path (v0.403) ────────────────────────────────────
//
// When the caller already runs an STTProvider (Listen mode +
// streamingEngine=local — body transcription via Web Speech), the
// detector subscribes to its transcript events instead of opening a
// second SR session. These tests verify:
//
//   1. start() with `source` does NOT construct an SR instance.
//   2. transcript events from the source drive phrase matching.
//   3. assistant-role events are ignored.
//   4. stop() detaches the listener and does NOT call source.stop()
//      (the caller owns the provider's lifecycle).

class MockSttProvider {
  startCalls = 0;
  stopCalls = 0;
  unsubCalls = 0;
  listener: ((ev: any) => void) | null = null;
  async start() { this.startCalls++; }
  async stop() { this.stopCalls++; }
  onTranscript(cb: (ev: any) => void) {
    this.listener = cb;
    return () => { this.unsubCalls++; if (this.listener === cb) this.listener = null; };
  }
  emit(ev: any) { if (this.listener) this.listener(ev); }
}

describe('sendword detector — fed mode (caller-driven matching)', () => {
  beforeEach(() => {
    (globalThis as any).window.SpeechRecognition = StubSR;
    (globalThis as any).window.webkitSpeechRecognition = StubSR;
    lastInstance = null;
  });
  afterEach(() => {
    sendword.stop();
    delete (globalThis as any).window.SpeechRecognition;
    delete (globalThis as any).window.webkitSpeechRecognition;
  });

  it('does NOT construct a standalone SR when feed is true', () => {
    const ok = sendword.start({ phrase: 'over', onMatch: () => {}, feed: true });
    assert.equal(ok, true);
    // No fresh SR instance — the constructor was never invoked.
    assert.equal(lastInstance, null);
  });

  it('matches phrase from fed interim transcript events', () => {
    let matched = false;
    sendword.start({ phrase: 'over', onMatch: () => { matched = true; }, feed: true });
    sendword.feedTranscript({ type: 'transcript', text: 'hello over', is_final: false, role: 'user' });
    assert.equal(matched, true);
  });

  it('matches phrase on fed final transcript event', () => {
    let matched = false;
    sendword.start({ phrase: 'over', onMatch: () => { matched = true; }, feed: true });
    sendword.feedTranscript({ type: 'transcript', text: 'all done over', is_final: true, role: 'user' });
    assert.equal(matched, true);
  });

  it('ignores assistant-role events (TTS captions must not trigger sendword)', () => {
    let matched = false;
    sendword.start({ phrase: 'over', onMatch: () => { matched = true; }, feed: true });
    sendword.feedTranscript({ type: 'transcript', text: 'sure, sending it over', is_final: false, role: 'assistant' });
    assert.equal(matched, false);
  });

  it('ignores empty-text final (utterance-end sentinel)', () => {
    let matched = false;
    sendword.start({ phrase: 'over', onMatch: () => { matched = true; }, feed: true });
    sendword.feedTranscript({ type: 'transcript', text: '', is_final: true, role: 'user' });
    assert.equal(matched, false);
  });

  it('feedTranscript is a no-op before start() / after stop()', () => {
    let matched = false;
    sendword.feedTranscript({ type: 'transcript', text: 'hello over', is_final: false, role: 'user' });
    assert.equal(matched, false);  // no opts → ignored
    sendword.start({ phrase: 'over', onMatch: () => { matched = true; }, feed: true });
    sendword.stop();
    sendword.feedTranscript({ type: 'transcript', text: 'hello over', is_final: false, role: 'user' });
    assert.equal(matched, false);  // post-stop → ignored
  });

  it('does not match mid-segment phrase', () => {
    let matched = false;
    sendword.start({ phrase: 'over', onMatch: () => { matched = true; }, feed: true });
    sendword.feedTranscript({ type: 'transcript', text: 'i went over to the store', is_final: false, role: 'user' });
    assert.equal(matched, false);
  });
});

// ── mid-sentence "over" (field 2026-10-12) ──────────────────────────────
// A match is a candidate; speech continuing past the phrase fires
// onUnmatch so the caller cancels the pending commit.
describe('sendword detector — continued speech cancels a candidate', () => {
  const ev = (text: string, is_final = false) => ({ type: 'transcript', text, is_final, role: 'user' } as any);
  afterEach(() => { sendword.stop(); });

  it('fed: interim "fell over" matches, the next interim "fell over because" un-matches', () => {
    const log: string[] = [];
    sendword.start({ phrase: 'over', onMatch: () => log.push('match'), onUnmatch: () => log.push('unmatch'), feed: true });
    sendword.feedTranscript(ev('and it fell over'));
    sendword.feedTranscript(ev('and it fell over because'));
    assert.deepEqual(log, ['match', 'unmatch']);
  });

  it('fed: a final that only TRUNCATES the matched interim is not continued speech', () => {
    const log: string[] = [];
    sendword.start({ phrase: 'over', onMatch: () => log.push('match'), onUnmatch: () => log.push('unmatch'), feed: true });
    sendword.feedTranscript(ev('thanks that is it over'));
    sendword.feedTranscript(ev('thanks that is it', true));   // Web Speech final dropped the last word
    assert.deepEqual(log, ['match']);
  });

  it('fed: new speech after the matched segment\'s final un-matches', () => {
    const log: string[] = [];
    sendword.start({ phrase: 'over', onMatch: () => log.push('match'), onUnmatch: () => log.push('unmatch'), feed: true });
    sendword.feedTranscript(ev('I want to go over', true));
    sendword.feedTranscript(ev('', true));                    // utterance-end sentinel: ignored
    assert.deepEqual(log, ['match']);
    sendword.feedTranscript(ev('the plan'));
    assert.deepEqual(log, ['match', 'unmatch']);
  });

  it('fed: after an un-match, a real sendword later matches again', () => {
    const log: string[] = [];
    sendword.start({ phrase: 'over', onMatch: () => log.push('match'), onUnmatch: () => log.push('unmatch'), feed: true });
    sendword.feedTranscript(ev('go over'));
    sendword.feedTranscript(ev('go over the plan'));
    sendword.feedTranscript(ev('go over the plan please over'));
    assert.deepEqual(log, ['match', 'unmatch', 'match']);
  });

  it('fed: repeated revisions still ending in the phrase do not re-fire', () => {
    let n = 0;
    sendword.start({ phrase: 'over', onMatch: () => { n += 1; }, feed: true });
    sendword.feedTranscript(ev('done over'));
    sendword.feedTranscript(ev('done, over.'));
    sendword.feedTranscript(ev('done over', true));
    assert.equal(n, 1);
  });

  it('standalone SR: a later result index with words un-matches', () => {
    (globalThis as any).window.SpeechRecognition = StubSR;
    const log: string[] = [];
    sendword.start({ phrase: 'over', onMatch: () => log.push('match'), onUnmatch: () => log.push('unmatch') });
    const res = (texts: string[], resultIndex: number) => ({ resultIndex, results: texts.map((t) => [{ transcript: t }]) });
    lastInstance.onresult(res(['it fell over'], 0));
    lastInstance.onresult(res(['it fell over', ' because people'], 1));
    assert.deepEqual(log, ['match', 'unmatch']);
    delete (globalThis as any).window.SpeechRecognition;
  });
});
