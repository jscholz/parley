/**
 * Loopback WS client to the local openclaw gateway.
 *
 * Why WS loopback when the plugin runs IN-PROCESS:
 *   - openclaw doesn't expose an in-process `chat.send` or `chat.abort`
 *     API for plugins (only `registerGatewayMethod` to add methods).
 *   - The plugin needs to dispatch user turns into the agent runtime,
 *     and the gateway's `chat.send` handler is the documented entry.
 *
 * Wire protocol (see
 *  `src/gateway/protocol/schema/frames.ts` in the openclaw gateway):
 *
 *   Handshake (always first):
 *     send: {type:"req", id, method:"connect", params: ConnectParams}
 *     recv: {type:"res", id, ok, data: HelloOk, error?}
 *   Request/response:
 *     send: {type:"req", id, method, params}
 *     recv: {type:"res", id, ok, data?, error?}
 *   Broadcasts (event frames) arrive with type:"event" — handled
 *   separately (we ingest agent events via the in-process
 *   registerAgentEventSubscription instead).
 *
 * Single persistent connection, reconnect on failure with bounded
 * backoff.
 */
import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';

const DEFAULT_PORT = parseInt(process.env.OPENCLAW_GATEWAY_PORT ?? '8646', 10);
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 10_000;
const CONNECT_TIMEOUT_MS = 5_000;

const CLIENT_INFO = {
  id: 'gateway-client',
  displayName: 'Parley plugin',
  version: '0.0.1',
  platform: 'linux',
  mode: 'backend',
};

export class GatewayClient {
  constructor({ port = DEFAULT_PORT, logger } = {}) {
    this.port = port;
    this.logger = logger ?? console;
    this.url = `ws://127.0.0.1:${port}`;
    this.ws = null;
    this.connected = false;
    this.connecting = null;
    this.pending = new Map();          // requestId → { resolve, reject, timer }
    this.reconnectAttempts = 0;
    this.stopped = false;
  }

  /** Open WS + run connect handshake. Resolves when ready. */
  async connect() {
    if (this.connected) return;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('ws open timeout')), CONNECT_TIMEOUT_MS);
        ws.once('open', () => { clearTimeout(timer); resolve(); });
        ws.once('error', (err) => { clearTimeout(timer); reject(err); });
      });
      ws.on('message', (raw) => this._onMessage(raw));
      ws.once('close', (code, reason) => {
        this.connected = false;
        this.ws = null;
        this.logger.warn?.(`[parley] gateway WS closed (${code}): ${reason}`);
        for (const { reject, timer } of this.pending.values()) {
          clearTimeout(timer);
          reject(new Error(`gateway WS closed: ${code} ${reason}`));
        }
        this.pending.clear();
        if (!this.stopped) this._scheduleReconnect();
      });
      // Issue connect handshake. Auth omitted — parley plugin
      // connects on loopback to its own gateway, which the plugin's
      // systemd unit launches with `--auth none`. The gateway treats
      // loopback unauthenticated connections as operator scope (see
      // openclaw gateway docs).
      const helloOk = await this._sendRaw({
        method: 'connect',
        params: {
          // Gateway protocol version 4 as of openclaw v2026.5.x (see
          // openclaw-integ/src/gateway/protocol/version.ts). Pin both
          // min/max to 4 — gateway accepts ranges that bracket its
          // current version, but we lock down to one known-good value.
          minProtocol: 4,
          maxProtocol: 4,
          client: { ...CLIENT_INFO, instanceId: randomUUID() },
          // Default-deny: scopes must be explicit. Backend clients on
          // loopback with auth=none get trusted self-pairing
          // (handshake-auth-helpers.ts:shouldSkipLocalBackendSelfPairing)
          // which preserves declared scopes. Request the operator
          // scopes we need for chat.send / chat.abort.
          role: 'operator',
          // admin scope is needed for sessions.delete (and other
          // destructive ops). The plugin runs in-process with openclaw
          // and operates on auth=none loopback, so the trust boundary
          // is the systemd unit + tailscale bind. Granting admin here
          // mirrors what shouldSkipLocalBackendSelfPairing implicitly
          // trusts for backend clients.
          scopes: ['operator.read', 'operator.write', 'operator.admin'],
        },
      });
      this.logger.info?.(`[parley] gateway WS connected (proto=${helloOk?.protocol ?? '?'}, scopes=${(helloOk?.scopes ?? []).join(',')})`);
      this.connected = true;
      this.connecting = null;
      this.reconnectAttempts = 0;
    })();
    try { await this.connecting; }
    catch (err) {
      this.connecting = null;
      throw err;
    }
  }

  _scheduleReconnect() {
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** this.reconnectAttempts, RECONNECT_MAX_MS);
    this.reconnectAttempts++;
    setTimeout(() => {
      if (!this.stopped) this.connect().catch((e) => this.logger.warn?.(`[parley] reconnect failed: ${e?.message}`));
    }, delay);
  }

  _onMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw.toString()); }
    catch { return; }
    // res frames echo our `id`. Event frames carry `type:"event"` —
    // we ignore those (agent events ride the in-process bus instead).
    if (msg?.type === 'res' && this.pending.has(msg.id)) {
      const { resolve, reject, timer } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      clearTimeout(timer);
      // Response payload field is named `payload` in the gateway
      // protocol (ResponseFrameSchema in
      // openclaw-integ/src/gateway/protocol/schema/frames.ts).
      if (msg.ok === true) resolve(msg.payload);
      else reject(new Error(msg?.error?.message ?? 'gateway error'));
    }
  }

  /** Internal: send a req frame with an auto-generated id, no
   *  connection-ready check (so it's usable from inside connect()). */
  _sendRaw({ method, params }, { timeoutMs = 15_000 } = {}) {
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`gateway call ${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ type: 'req', id, method, params }));
    });
  }

  /** Public: call a gateway method (waits for connect first). */
  async call(method, params = {}, opts) {
    await this.connect();
    return this._sendRaw({ method, params }, opts);
  }

  async chatSend({ sessionKey, message, idempotencyKey, thinking, attachments }) {
    return this.call('chat.send', {
      sessionKey,
      message,
      idempotencyKey,
      ...(thinking ? { thinking } : {}),
      ...(attachments ? { attachments } : {}),
    }, { timeoutMs: 30_000 });
  }

  async chatAbort({ sessionKey, runId }) {
    return this.call('chat.abort', {
      sessionKey,
      ...(runId ? { runId } : {}),
    });
  }

  close() {
    this.stopped = true;
    if (this.ws) this.ws.close();
  }
}
