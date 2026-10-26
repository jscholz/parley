import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { worstTone, reportLines, agoText, isStale, splitStatus, kindLabel, connectedText, attentionOrder, integrationSummary } from './healthModel.ts';

test('worstTone maps statuses', () => {
  assert.equal(worstTone('OK'), 'ok'); assert.equal(worstTone('warn'), 'warn');
  assert.equal(worstTone('FAIL'), 'bad'); assert.equal(worstTone('CRASHED'), 'bad'); assert.equal(worstTone('UNKNOWN'), 'muted');
});

test('reportLines classifies digest rows and keeps the header', () => {
  const lines = reportLines('🔴 hermes health — x\nFAIL a — b\nWARN c — d\nOK   e — f\n\n');
  assert.deepEqual(lines.map((l) => l.kind), ['text', 'fail', 'warn', 'ok']);
});

test('agoText + isStale', () => {
  const now = Date.parse('2026-09-05T12:00:00Z');
  assert.equal(agoText('2026-09-05T11:48:00Z', now), '12m ago');
  assert.equal(agoText('2026-09-05T09:00:00Z', now), '3h ago');
  assert.equal(agoText('2026-09-03T12:00:00Z', now), '2d ago');
  assert.equal(agoText(null, now), 'never');
  assert.equal(isStale('2026-09-05T09:00:00Z', now), false);
  assert.equal(isStale('2026-09-03T12:00:00Z', now), true);
  assert.equal(isStale(null, now), true);
});

test('splitStatus / summary / ordering for the Integrations pane', () => {
  const mk = (id: string, worst: string, integration?: any) => ({ id, name: id, worst, last_run_at: null, report: '', can_run: false, counts: { fail: 0, warn: 0, ok: 0 }, integration });
  const list = [mk('hermes', 'OK'), mk('int-mcp-a', 'OK', { kind: 'mcp', provider: 'a', connected: true }),
                mk('int-mcp-b', 'FAIL', { kind: 'mcp', provider: 'b', connected: false }), mk('int-custom-c', 'UNKNOWN', { kind: 'custom', provider: 'c', connected: null }),
                mk('int-x', 'WARN', { kind: 'platform', provider: 'x', connected: false })];
  const { integrations, system } = splitStatus(list);
  assert.deepEqual(system.map((c) => c.id), ['hermes']);
  assert.deepEqual([...integrations].sort(attentionOrder).map((c) => c.id), ['int-mcp-b', 'int-x', 'int-custom-c', 'int-mcp-a']);
  assert.deepEqual(integrationSummary(integrations), { total: 4, attention: 2, ok: 1, unknown: 1 });
  assert.equal(kindLabel('mcp'), 'MCP server'); assert.equal(kindLabel('model-provider'), 'Model provider'); assert.equal(kindLabel(undefined), 'Integration');
  assert.equal(connectedText(integrations[0]), 'connected'); assert.equal(connectedText(integrations[1]), 'not connected'); assert.equal(connectedText(integrations[2]), 'unknown');
});
