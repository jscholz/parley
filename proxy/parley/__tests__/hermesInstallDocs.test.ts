// Guard for the hermes install docs (2026-11-10). A clean-install
// report from a new user: "stale renames, looking in the wrong places,
// broken links". Two causes, both docs: the hermes guide never said a
// user plugin must be opted in under `plugins.enabled` (hermes skips it
// silently otherwise), and the plugin README still told people to apply
// a patch file that had been deleted. Strip-only TS.
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../../..');
const read = (p: string) => readFileSync(path.join(ROOT, p), 'utf8');

test('the hermes guide tells a new install to opt the plugin in, and no doc points at the deleted patch', () => {
  const guide = read('backends/hermes/README.md');
  const plugin = read('backends/hermes/plugin/README.md');
  for (const [name, txt] of [['backends/hermes/README.md', guide], ['backends/hermes/plugin/README.md', plugin]] as const) {
    assert.match(txt, /hermes plugins enable parley/, `${name}: must give the opt-in command`);
    assert.match(txt, /plugins\.enabled/, `${name}: must name the config key hermes gates on`);
    assert.doesNotMatch(txt, /0001-add-parley-platform\.patch/, `${name}: the patch file is gone — do not reference it`);
    assert.doesNotMatch(txt, /patch -p1/, `${name}: no patching step`);
  }
  assert.doesNotMatch(read('backends/hermes/plugin/__init__.py').slice(0, 6000), /0001-add-parley-platform\.patch/);
});

test('every file the hermes guide\'s layout table names exists', () => {
  const guide = read('backends/hermes/README.md');
  const rows = guide.split('\n').filter((l) => /^\|\s*`[^`]+`\s*\|/.test(l));
  assert.ok(rows.length >= 3, 'layout table present');
  for (const row of rows) {
    const m = /^\|\s*`([^`]+)`/.exec(row);
    if (!m) continue;
    const rel = m[1];
    if (!/\.(py|yaml|yml|md|ts|mjs|json|sh|patch)$/.test(rel)) continue;   // other tables name DB tables, not files
    const candidates = [path.join('backends/hermes', rel), path.join('backends/hermes/plugin', rel)];
    assert.ok(candidates.some((c) => existsSync(path.join(ROOT, c))), `layout table names a missing file: ${rel}`);
  }
});

test('local markdown links in the install docs resolve', () => {
  for (const f of ['README.md', 'backends/hermes/README.md', 'backends/hermes/plugin/README.md', 'backends/README.md']) {
    if (!existsSync(path.join(ROOT, f))) continue;
    const txt = read(f);
    for (const m of txt.matchAll(/\]\(([^)\s#]+)(?:#[^)]*)?\)/g)) {
      const target = m[1];
      if (/^(https?:|mailto:)/.test(target)) continue;
      const resolved = path.normalize(path.join(path.dirname(f), target));
      assert.ok(existsSync(path.join(ROOT, resolved)), `${f}: broken link → ${target}`);
    }
  }
});
