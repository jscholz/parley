// Parley proxy — slash-command catalog.
//
// One route:
//
//   GET /api/parley/commands     → list of CommandDef
//
// Forwards to the upstream's /v1/commands contract (slash-command
// registry surfaced by hermes_cli.commands.COMMAND_REGISTRY).
//
// 404 from the upstream propagates as 404 to the PWA — agents that
// don't implement the extension simply have the autocomplete popover
// stay disabled. Other errors collapse to 502.
//
// Cached client-side in src/slashCommands.ts for the lifetime of a
// backend connection (refetched on reconnect). The catalog is small
// (~50 entries) and quasi-static — no need to revalidate per turn.

import { getUpstream } from './index.ts';

/** GET /api/parley/commands */
export async function handleParleyCommands(_req, res) {
  const upstream = getUpstream();
  if (!upstream) {
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'sidekick_platform_unconfigured' }));
    return;
  }
  let commands;
  try {
    commands = await upstream.listCommands();
  } catch (e: any) {
    console.warn('[parley] commands fetch failed:', e?.message);
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: e?.message || 'upstream error' }));
    return;
  }
  if (commands === null) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      error: { message: 'agent does not implement /v1/commands' },
    }));
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ object: 'list', data: commands }));
}
