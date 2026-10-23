// Status-note matcher (2026-10-23): the agent-side notes hermes persists
// as assistant messages must never be offered for playback.
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { isStatusNoteText, isProgressHeartbeatText } from './progressHeartbeat.ts';

test('hindsight recall / retain indicators are status notes', () => {
  assert.equal(isStatusNoteText('👁️ Hindsight — recalled 44 memories'), true);
  assert.equal(isStatusNoteText('👁️ Hindsight — saving to memory…'), true);
  assert.equal(isStatusNoteText('Hindsight — recalled 1 memory'), true, 'emoji stripped upstream');
  assert.equal(isStatusNoteText('  👁️ Hindsight — recalled 7 memories  '), true);
});

test('heartbeat and inactivity warning are status notes', () => {
  assert.equal(isStatusNoteText('⏳ Working — 3 min — iteration 4/60, terminal'), true);
  assert.equal(isProgressHeartbeatText('⏳ Working — 3 min — iteration 4/60, terminal'), true);
  assert.equal(isStatusNoteText('⚠️ No activity for 5 min — the agent may be stuck'), true);
});

test('real replies, even ones that mention memories, are not status notes', () => {
  assert.equal(isStatusNoteText('I recalled 44 memories about the dinner; here is the summary.'), false);
  assert.equal(isStatusNoteText('Hindsight is the memory plugin — it recalled things earlier.'), false);
  assert.equal(isStatusNoteText('Sure. Let me make that change now.'), false);
  assert.equal(isStatusNoteText(''), false);
});
