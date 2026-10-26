/**
 * @fileoverview Drives an integration connect/add flow from the pane
 * (Settings › Integrations, phase 2): start it, open the provider's
 * sign-in in a separate browser context, poll until it settles, report.
 *
 * Browser sign-in: on the web a popup window (closable, the app stays);
 * in the native shell the OS browser via the ExternalBrowser plugin, and
 * the user comes back to the app where the poll has seen the result.
 * The proxy's callback page also posts `parley:oauth-callback` to its
 * opener so a web popup wakes the poll immediately.
 */
import * as backend from './backend.ts';
import { isNativeShell, openExternal } from './native/externalLinks.ts';
import type { IntegrationFlow } from './healthModel.ts';

const POLL_MS = 2_000;
const MAX_WAIT_MS = 6 * 60_000;

async function getAdapter(): Promise<any> {
  const mod: any = await import('./proxyClient.ts');
  return (backend as any).adapter ?? mod.proxyClientAdapter;
}

export interface FlowRunOpts {
  onUpdate?: (flow: IntegrationFlow) => void;
  /** Called with a cancel function once polling starts. */
  onCancelable?: (cancel: () => void) => void;
}

/** Open the provider's authorization URL away from the app. */
export async function openAuthorization(url: string): Promise<void> {
  if (isNativeShell()) { await openExternal(url); return; }
  const w = window.open(url, 'parley-oauth', 'popup,width=520,height=720,noopener');
  if (!w) {
    // Popup blocked: a plain new window is the fallback (never navigate the app).
    const a = document.createElement('a');
    a.href = url; a.target = '_blank'; a.rel = 'noopener';
    a.click();
  }
}

/** Cancel handle shared between the start request and the poll: a Cancel
 *  pressed before the agent has even answered the start request still
 *  takes effect (the flow is cancelled the moment its id is known). */
interface CancelCtl { cancelled: boolean; flowId: string | null; wake: (() => void) | null }

function makeCtl(adapter: any, opts: FlowRunOpts): CancelCtl {
  const ctl: CancelCtl = { cancelled: false, flowId: null, wake: null };
  opts.onCancelable?.(() => {
    ctl.cancelled = true;
    ctl.wake?.();
    if (ctl.flowId) void adapter.healthFlowCancel?.(ctl.flowId);
  });
  return ctl;
}

/** Poll a flow until it settles (or is cancelled / times out). */
export async function waitForFlow(flow: IntegrationFlow, opts: FlowRunOpts = {}, ctl?: CancelCtl): Promise<IntegrationFlow> {
  const adapter = await getAdapter();
  const c = ctl ?? makeCtl(adapter, opts);
  c.flowId = flow.flow_id;
  if (c.cancelled) {
    void adapter.healthFlowCancel?.(flow.flow_id);
    return { ...flow, status: 'cancelled', error: 'Cancelled' };
  }
  const onMsg = (e: MessageEvent) => {
    if (e?.data && typeof e.data === 'object' && e.data.type === 'parley:oauth-callback') c.wake?.();
  };
  window.addEventListener('message', onMsg);
  const started = Date.now();
  let cur = flow;
  try {
    while (!c.cancelled && !isSettled(cur) && Date.now() - started < MAX_WAIT_MS) {
      await new Promise<void>((r) => { c.wake = r; setTimeout(r, POLL_MS); });
      c.wake = null;
      if (c.cancelled) break;
      try {
        cur = await adapter.healthFlow(flow.flow_id);
        opts.onUpdate?.(cur);
      } catch (e: any) {
        cur = { ...cur, status: 'error', error: e?.message || String(e) };
      }
    }
  } finally {
    window.removeEventListener('message', onMsg);
  }
  if (c.cancelled && !isSettled(cur)) return { ...cur, status: 'cancelled', error: 'Cancelled' };
  if (!isSettled(cur)) return { ...cur, status: 'error', error: 'Timed out waiting for the sign-in to finish' };
  return cur;
}

function isSettled(f: IntegrationFlow): boolean {
  return f.status === 'done' || f.status === 'error' || f.status === 'cancelled';
}

/** Start an item action and see it through. Returns the settled flow. */
export async function runItemAction(itemId: string, actionId: string, opts: FlowRunOpts = {}): Promise<IntegrationFlow> {
  const adapter = await getAdapter();
  const ctl = makeCtl(adapter, opts);
  const flow: IntegrationFlow = await adapter.healthAction(itemId, actionId);
  opts.onUpdate?.(flow);
  if (!flow.flow_id) return flow;                 // run-type: already settled
  if (flow.kind === 'oauth' && flow.authorization_url && flow.status !== 'error' && !ctl.cancelled) {
    await openAuthorization(flow.authorization_url);
  }
  return waitForFlow(flow, opts, ctl);
}

/** Add a catalog entry and see the install through. */
export async function runCatalogAdd(provider: string, env: Record<string, string>, opts: FlowRunOpts = {}): Promise<IntegrationFlow> {
  const adapter = await getAdapter();
  const ctl = makeCtl(adapter, opts);
  const flow: IntegrationFlow = await adapter.healthCatalogAdd(provider, env);
  opts.onUpdate?.(flow);
  if (!flow.flow_id) return flow;
  return waitForFlow(flow, opts, ctl);
}
