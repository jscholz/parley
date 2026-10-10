#!/usr/bin/env node
/**
 * Canvas CLI tool — emit a card to Parley's canvas pane.
 *
 * Usage:
 *   canvas show <json>         — show a card (JSON string or stdin)
 *   canvas show --kind image --url <url> [--caption <text>] [--title <title>]
 *   canvas show --kind links --url <url1> [--url <url2> ...]
 *   canvas show --kind markdown --text <markdown>
 *   canvas show --kind youtube --video-id <id> --url <url>
 *   canvas dismiss             — return to ambient
 *
 * The tool POSTs to the Parley proxy (PARLEY_PROXY_ORIGIN) at /canvas/show.
 * Server validates the payload and returns {ok, errors} — errors are
 * printed so the agent can see what went wrong and retry.
 */

import { readFileSync } from 'node:fs';

// The proxy this agent's Parley runs on. Two tenants on one box use two
// ports, so the origin comes from the environment (the plugin states it in
// the agent's Parley prompt section): PARLEY_PROXY_ORIGIN, legacy SIDECLAW_URL,
// else PORT, else the single-tenant default.
const SIDECLAW_URL = (process.env.PARLEY_PROXY_ORIGIN || process.env.SIDECLAW_URL
  || `http://127.0.0.1:${process.env.PORT || '3001'}`).replace(/\/+$/, '');

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];

  if (!cmd || cmd === '--help' || cmd === '-h') {
    printUsage();
    process.exit(0);
  }

  if (cmd === 'show') {
    const card = parseShowArgs(args.slice(1));
    if (!card) {
      console.error('Error: could not parse card. Run "canvas --help" for usage.');
      process.exit(1);
    }
    const result = await postCard(card);
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.ok ? 0 : 1);
  }

  if (cmd === 'dismiss') {
    // Dismiss is a special "return to ambient" broadcast
    const result = await postCard({ v: 1, kind: '_dismiss', payload: {}, meta: { source: 'agent' } });
    console.log(JSON.stringify(result, null, 2));
    process.exit(0);
  }

  console.error(`Unknown command: ${cmd}`);
  process.exit(1);
}

function parseShowArgs(args) {
  // If first arg looks like JSON, use it directly
  if (args.length === 1 && args[0].startsWith('{')) {
    try { return JSON.parse(args[0]); } catch { return null; }
  }

  // If no args, try reading from stdin
  if (args.length === 0) {
    return readStdin();
  }

  // Flag-based construction
  const flags = parseFlags(args);
  const kind = flags.kind;
  if (!kind) return null;

  const meta = { source: 'agent' };
  if (flags.title) meta.title = flags.title;

  switch (kind) {
    case 'image':
      return { v: 1, kind, payload: { url: flags.url, caption: flags.caption }, meta };
    case 'youtube':
      return { v: 1, kind, payload: { video_id: flags['video-id'], url: flags.url }, meta };
    case 'links': {
      const urls = Array.isArray(flags.url) ? flags.url : [flags.url];
      return { v: 1, kind, payload: { links: urls.filter(Boolean).map(u => ({ url: u })) }, meta };
    }
    case 'markdown':
      return { v: 1, kind, payload: { text: flags.text }, meta };
    case 'spotify':
      return { v: 1, kind, payload: { url: flags.url, embed_url: flags['embed-url'] || makeSpotifyEmbed(flags.url) }, meta };
    default:
      // Pass through for any kind — let server validate
      return { v: 1, kind, payload: flags, meta };
  }
}

function makeSpotifyEmbed(url) {
  if (!url) return '';
  const m = url.match(/open\.spotify\.com\/(track|album|playlist|episode|show|artist)\/([A-Za-z0-9]+)/);
  return m ? `https://open.spotify.com/embed/${m[1]}/${m[2]}?utm_source=generator` : '';
}

function parseFlags(args) {
  const result = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--') && i + 1 < args.length) {
      const key = args[i].slice(2);
      const val = args[i + 1];
      // Support repeated flags (--url a --url b)
      if (result[key] !== undefined) {
        if (!Array.isArray(result[key])) result[key] = [result[key]];
        result[key].push(val);
      } else {
        result[key] = val;
      }
      i++;
    }
  }
  return result;
}

function readStdin() {
  try {
    const data = readFileSync(0, 'utf-8');
    return JSON.parse(data);
  } catch {
    return null;
  }
}

async function postCard(card) {
  try {
    const res = await fetch(`${SIDECLAW_URL}/canvas/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(card),
    });
    return await res.json();
  } catch (e) {
    return { ok: false, errors: [`network error: ${e.message}`] };
  }
}

function printUsage() {
  console.log(`canvas — emit a card to Parley's canvas pane

Usage:
  canvas show '{"v":1,"kind":"image","payload":{"url":"..."}}'
  canvas show --kind image --url <url> [--caption <text>]
  canvas show --kind links --url <url1> --url <url2>
  canvas show --kind markdown --text "# Hello"
  canvas show --kind youtube --video-id <id> --url <url>
  canvas dismiss

Card kinds: image, youtube, spotify, links, markdown, loading
Full protocol spec: see agent/CANVAS.md`);
}

main();
