/**
 * @fileoverview What the upstream agent says it implements (audit phase 2).
 *
 * The proxy probes `GET /v1/capabilities` and hands the answer to the PWA
 * on `/config` (`agent.capabilities`). Features consult `supports()`
 * before their first fetch: `false` → skip the surface quietly (no 404
 * probe, no 502 toast), `true` → go, `undefined` → the agent did not say
 * (legacy upstream) → probe as before. Family names come from
 * proxy/parley/contract/routes.ts.
 */
import { peekConfig } from './config.ts';
import { markTurnLifecycleBackend } from './transcript/store.ts';
import type { AgentCapabilities } from '../proxy/parley/contract/capabilities.ts';

export type { AgentCapabilities };

export function agentCapabilities(): AgentCapabilities | null {
  try {
    const c = peekConfig()?.agent?.capabilities;
    return c && Array.isArray(c.extensions) ? c : null;
  } catch {
    return null;
  }
}

/** true / false when the agent declared itself; undefined when unknown. */
export function supports(family: string): boolean | undefined {
  const c = agentCapabilities();
  if (!c) return undefined;
  return c.extensions.includes(family);
}

/** Apply what can be decided at boot: a backend that declares
 *  turn_start/turn_end stops the PWA inferring liveness from replies. */
export function applyCapabilitiesAtBoot(): void {
  const c = agentCapabilities();
  if (c?.turn_lifecycle === true) markTurnLifecycleBackend();
}
