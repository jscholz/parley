/**
 * @fileoverview Guard: no async / Promise-returning predicates in
 * page.waitForFunction calls inside smoke sources.
 *
 * WHY (discovered 2026-07-21, unread-badges-single-source): Playwright's
 * page.waitForFunction does NOT await async predicates. An `async`
 * pageFunction — or a sync one returning a Promise, e.g.
 * `() => fetch(...).then(...)` — hands the in-page poller a Promise
 * object, which is truthy, so the wait resolves IMMEDIATELY and
 * VACUOUSLY, regardless of what the predicate would eventually return.
 * A whole class of smokes silently stopped waiting for anything.
 * (Empirically confirmed against the vendored playwright-core:
 * `waitForFunction(async () => false)` resolves in ~30ms.)
 *
 * THE RULE: waitForFunction predicates must be synchronous. Any wait
 * whose check needs `await` inside the page (dynamic import(), fetch(),
 * IDB reads, ...) must go through `pollUntil` in scripts/smoke/lib.mjs,
 * which polls via page.evaluate — and evaluate DOES await in-page
 * promises.
 *
 * Detection is lexical but structural: for each `waitForFunction(` we
 * extract the FIRST argument via a balanced-paren scan (string- and
 * comment-aware) and reject it if it is an async function, contains
 * `await`, calls `fetch(`, chains `.then(`, or references `Promise`.
 * `.then()` on the waitForFunction RESULT (outside the argument list)
 * is fine and not flagged.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SMOKE_DIRS = [
  join(__dirname, '..', 'scripts', 'smoke'),
  join(__dirname, '..', 'scripts', 'smoke-barge'),
];

// Known offenders awaiting a fix that is out of this guard's hands.
// Each entry suppresses ONE file. Remove the entry when the file is
// fixed — an entry that no longer matches anything fails the test so
// the allowlist can only shrink.
const ALLOWLIST = new Set<string>([]);

/** Strip // and /* *\/ comments so paren-counting and keyword matching
 *  can't be thrown by prose (e.g. an unbalanced "(" in a comment).
 *  String contents are preserved verbatim. */
function stripComments(src: string): string {
  let out = '';
  let i = 0;
  let str: string | null = null; // current string delimiter or null
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (str) {
      out += c;
      if (c === '\\') { out += next ?? ''; i += 2; continue; }
      if (c === str) str = null;
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { str = c; out += c; i++; continue; }
    if (c === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] === '\n') out += '\n'; // keep line numbers stable
        i++;
      }
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

interface Finding {
  file: string;
  line: number;
  reasons: string[];
  excerpt: string;
}

/** Extract the first argument of every waitForFunction( call. */
function scanSource(file: string, raw: string): Finding[] {
  const src = stripComments(raw);
  const findings: Finding[] = [];
  const re = /waitForFunction\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const argStart = m.index + m[0].length;
    // Balanced scan over the full argument list.
    let depth = 1;
    let i = argStart;
    let str: string | null = null;
    while (i < src.length && depth > 0) {
      const c = src[i];
      if (str) {
        if (c === '\\') { i += 2; continue; }
        if (c === str) str = null;
      } else if (c === '"' || c === "'" || c === '`') str = c;
      else if (c === '(') depth++;
      else if (c === ')') depth--;
      i++;
    }
    const argsText = src.slice(argStart, i - 1);
    // First argument = up to the first top-level comma.
    let d = 0;
    let j = 0;
    str = null;
    for (; j < argsText.length; j++) {
      const c = argsText[j];
      if (str) {
        if (c === '\\') { j++; continue; }
        if (c === str) str = null;
      } else if (c === '"' || c === "'" || c === '`') str = c;
      else if (c === '(' || c === '[' || c === '{') d++;
      else if (c === ')' || c === ']' || c === '}') d--;
      else if (c === ',' && d === 0) break;
    }
    const firstArg = argsText.slice(0, j).trim();
    const reasons: string[] = [];
    if (/^async\b/.test(firstArg)) reasons.push('async predicate');
    if (/\bawait\b/.test(firstArg)) reasons.push('await inside predicate');
    if (/\bfetch\s*\(/.test(firstArg)) reasons.push('fetch() inside predicate (returns a Promise)');
    if (/\.then\s*\(/.test(firstArg)) reasons.push('.then() chain inside predicate (returns a Promise)');
    if (/\bPromise\b/.test(firstArg)) reasons.push('Promise referenced inside predicate');
    if (reasons.length > 0) {
      findings.push({
        file,
        line: src.slice(0, m.index).split('\n').length,
        reasons,
        excerpt: firstArg.replace(/\s+/g, ' ').slice(0, 120),
      });
    }
  }
  return findings;
}

test('smoke waitForFunction predicates are synchronous (async = vacuously true)', () => {
  const findings: Finding[] = [];
  const allowlistHits = new Set<string>();
  for (const dir of SMOKE_DIRS) {
    let entries: string[];
    try { entries = readdirSync(dir); } catch { continue; }
    for (const name of entries.filter((f) => f.endsWith('.mjs')).sort()) {
      const fileFindings = scanSource(name, readFileSync(join(dir, name), 'utf8'));
      if (fileFindings.length === 0) continue;
      if (ALLOWLIST.has(name)) { allowlistHits.add(name); continue; }
      findings.push(...fileFindings);
    }
  }

  const detail = findings
    .map((f) => `  ${f.file}:${f.line} — ${f.reasons.join('; ')}\n    predicate: ${f.excerpt}`)
    .join('\n');
  assert.equal(findings.length, 0,
    'Async / Promise-returning waitForFunction predicate(s) in smoke sources.\n'
    + 'Playwright does NOT await async predicates: the returned Promise is truthy,\n'
    + 'so the wait resolves immediately and the smoke asserts NOTHING.\n'
    + 'Use pollUntil() from scripts/smoke/lib.mjs instead (page.evaluate awaits\n'
    + 'in-page promises). Offending sites:\n' + detail);

  // Allowlist hygiene: stale entries must be removed, so the list can
  // only ever shrink.
  for (const name of ALLOWLIST) {
    assert.ok(allowlistHits.has(name),
      `ALLOWLIST entry "${name}" no longer matches any finding — remove it from `
      + 'test/smoke-no-async-waitforfunction.test.ts so the guard stays tight.');
  }
});
