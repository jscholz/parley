/**
 * @fileoverview Capability discovery (2026-10-26 audit, phase 2).
 *
 * `GET /v1/capabilities` lets an upstream say which route families it
 * implements instead of the proxy and the PWA finding out by 404/502 per
 * feature. The vocabulary is the `family` names of contract/routes.ts —
 * one list for the catalogue, the plugin's answer and the PWA's gates.
 * Absent endpoint (legacy upstream) → `null` → every layer falls back to
 * probing, exactly as before.
 */
import { UPSTREAM_ROUTES } from './routes.ts';

export interface AgentCapabilities {
  /** Route families the upstream serves (names from contract/routes.ts). */
  extensions: string[];
  /** Emits turn_start / turn_end (the PWA stops inferring liveness). */
  turn_lifecycle?: boolean;
  /** Units of `created_at` / `timestamp` on items. */
  timestamp_units?: 's' | 'ms';
  agent?: { name?: string; version?: string; plugin_version?: string };
}

export const CAPABILITY_FAMILIES: readonly string[] = UPSTREAM_ROUTES.map((f) => f.family);

export function isKnownFamily(name: string): boolean {
  return CAPABILITY_FAMILIES.includes(name);
}
