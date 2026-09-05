/**
 * HTTP-shaped proxy test harness.
 *
 * Stands up a FakeAgent that implements just enough of the abstract
 * agent contract to drive the parley proxy under test:
 *
 *   - GET    /health
 *   - GET    /v1/conversations            (channel — returns set list)
 *   - GET    /v1/gateway/conversations    (gateway — optional via setMode)
 *   - GET    /v1/conversations/{id}/items
 *   - DELETE /v1/conversations/{id}
 *   - POST   /v1/responses                (streaming SSE)
 *   - GET    /v1/events                   (persistent SSE)
 *
 * The fixture is intentionally minimal: it doesn't simulate hermes's
 * full state.db behavior. Tests configure exactly the rows + replies
 * they need via setSessions / setGatewaySessions / setItems /
 * enqueueTurnEvents / pushOutOfTurnEvent.
 *
 * Replaces the WS-shaped `proxy-harness.ts` deleted in step 6a.
 */
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

// ────────────────────────────────────────────────────────────────────
// FakeAgent — configurable HTTP server for tests.
// ────────────────────────────────────────────────────────────────────

export interface FakeConversationSummary {
  id: string;
  metadata: {
    title: string;
    message_count: number;
    /** User-role count ("N turns"). Optional; newer plugins emit it. */
    turn_count?: number;
    /** Tool-role count. Pairs with turn_count for "N turns · M tools"
     *  rendering in the drawer. */
    tool_count?: number;
    last_active_at: number;
    first_user_message: string | null;
    source?: string;       // gateway-only
    chat_type?: string;    // gateway-only
  };
  created_at: number;
}

export interface FakeMessage {
  id: number;
  role: string;
  content: string;
  created_at: number;
  tool_name?: string;
}

export type FakeOAIEvent =
  | { event: 'response.in_progress'; data: any }
  | { event: 'response.output_text.delta'; data: { delta: string; item_id?: string; output_index?: number; content_index?: number } }
  | { event: 'response.completed'; data: any }
  | { event: 'response.error'; data: { error: { message: string } } };

export interface FakeOutOfTurnEnvelope {
  id: number;
  envelope: { type: string; chat_id: string; [k: string]: unknown };
}

export type FakeMode = 'gateway' | 'channel-only';

export interface SettingDef {
  id: string;
  label: string;
  description?: string;
  category?: string;
  type: 'enum' | 'slider' | 'toggle' | 'text';
  value: string | number | boolean;
  options?: Array<{ value: string; label: string; description?: string }>;
  min?: number;
  max?: number;
  step?: number;
  placeholder?: string;
}

export class FakeAgent {
  private server: http.Server | null = null;
  private port = 0;
  private mode: FakeMode = 'gateway';
  private channelSessions: FakeConversationSummary[] = [];
  private gatewaySessions: FakeConversationSummary[] = [];
  private itemsByChat: Map<string, FakeMessage[]> = new Map();
  private deletedChats: Set<string> = new Set();
  private turnEvents: FakeOAIEvent[] = [];
  /** Connected /v1/events subscribers (test side pushes envelopes
   *  via pushOutOfTurnEvent; we fan them out to active subscribers). */
  private eventClients: Set<http.ServerResponse> = new Set();
  private nextEventId = 0;
  /** When set, /v1/responses POST records the conversation id seen so
   *  tests can assert on it. */
  public lastResponsesConversation: string | null = null;
  public lastResponsesAttachments: unknown[] | null = null;

  /** Settings extension — null means the agent doesn't implement
   *  /v1/settings/* (the harness returns 404, matching the contract
   *  for opt-out agents). Populated array means the agent declares
   *  those settings. */
  private settingsSchema: SettingDef[] | null = [];
  /** Most-recent /v1/settings/{id} POST observed — tests assert the
   *  proxy forwarded the right body. */
  public lastSettingsPost: { id: string; body: unknown } | null = null;

  /** Scheduled-jobs extension — null = agent has no scheduler (404). */
  private jobs: any[] | null = [];
  public lastJobPost: { id: string; action: 'update' | 'run' | 'delete'; body: unknown } | null = null;

  setMode(mode: FakeMode): void { this.mode = mode; }

  setSessions(rows: FakeConversationSummary[]): void {
    this.channelSessions = rows;
  }

  setGatewaySessions(rows: FakeConversationSummary[]): void {
    this.gatewaySessions = rows;
  }

  setItems(chatId: string, items: FakeMessage[]): void {
    this.itemsByChat.set(chatId, items);
  }

  /** Queue the SSE events the next /v1/responses POST will replay. */
  enqueueTurnEvents(events: FakeOAIEvent[]): void {
    this.turnEvents = [...events];
  }

  /** Push an envelope to all current /v1/events subscribers. */
  pushOutOfTurnEvent(envelope: { type: string; chat_id: string; [k: string]: unknown }): number {
    this.nextEventId += 1;
    const id = this.nextEventId;
    const frame = `id: ${id}\ndata: ${JSON.stringify(envelope)}\n\n`;
    for (const res of this.eventClients) {
      try { res.write(frame); } catch {}
    }
    return id;
  }

  hasDeleted(chatId: string): boolean { return this.deletedChats.has(chatId); }

  /** Configure the settings schema served at GET /v1/settings/schema.
   *  Pass `null` to declare that the agent doesn't implement the
   *  optional settings extension (route returns 404). */
  setSettingsSchema(schema: SettingDef[] | null): void {
    this.settingsSchema = schema;
    this.lastSettingsPost = null;
  }

  /** Configure the jobs served at GET /v1/jobs; `null` = 404 (no scheduler). */
  setJobs(jobs: any[] | null): void {
    this.jobs = jobs;
    this.lastJobPost = null;
  }

  /** Number of /v1/events SSE subscribers currently attached. Tests
   *  use this to wait for the proxy's `subscribeEvents` loop to
   *  connect before they start pushing — otherwise pushes hit an
   *  empty fan-out and silently drop. */
  get eventClientCount(): number { return this.eventClients.size; }

  get url(): string { return `http://127.0.0.1:${this.port}`; }

  async start(): Promise<void> {
    const server = http.createServer((req, res) => this.dispatch(req, res));
    this.server = server;
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });
    this.port = (server.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    for (const res of this.eventClients) {
      try { res.end(); } catch {}
    }
    this.eventClients.clear();
    if (!this.server) return;
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = null;
  }

  // ── route dispatcher ──

  private dispatch(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url || '/', 'http://x');
    const method = req.method || 'GET';

    if (method === 'GET' && url.pathname === '/health') {
      this.json(res, 200, { status: 'ok' });
      return;
    }
    if (method === 'GET' && url.pathname === '/v1/conversations') {
      this.json(res, 200, { object: 'list', data: this.channelSessions });
      return;
    }
    if (method === 'GET' && url.pathname === '/v1/gateway/conversations') {
      if (this.mode === 'channel-only') {
        this.json(res, 404, { error: 'gateway not implemented' });
        return;
      }
      this.json(res, 200, { object: 'list', data: this.gatewaySessions });
      return;
    }
    const itemsMatch = url.pathname.match(/^\/v1\/conversations\/([^/]+)\/items$/);
    if (method === 'GET' && itemsMatch) {
      const chatId = decodeURIComponent(itemsMatch[1]);
      const items = this.itemsByChat.get(chatId);
      if (items === undefined) {
        this.json(res, 404, { error: 'not found' });
        return;
      }
      const data = items.map((m) => ({
        id: m.id, object: 'message', role: m.role,
        content: m.content, created_at: m.created_at,
        ...(m.tool_name ? { tool_name: m.tool_name } : {}),
      }));
      this.json(res, 200, {
        object: 'list', data,
        first_id: data[0]?.id ?? null,
        has_more: false,
      });
      return;
    }
    const deleteMatch = url.pathname.match(/^\/v1\/conversations\/([^/]+)$/);
    if (method === 'DELETE' && deleteMatch) {
      this.deletedChats.add(decodeURIComponent(deleteMatch[1]));
      this.json(res, 200, { ok: true });
      return;
    }
    if (method === 'POST' && url.pathname === '/v1/responses') {
      void this.handleResponses(req, res);
      return;
    }
    if (method === 'GET' && url.pathname === '/v1/events') {
      this.handleEvents(req, res);
      return;
    }
    if (method === 'GET' && url.pathname === '/v1/settings/schema') {
      if (this.settingsSchema === null) {
        this.json(res, 404, { error: { message: 'settings not supported' } });
        return;
      }
      this.json(res, 200, { object: 'list', data: this.settingsSchema });
      return;
    }
    const settingsPostMatch = url.pathname.match(/^\/v1\/settings\/([^/]+)$/);
    if (method === 'POST' && settingsPostMatch) {
      void this.handleSettingsUpdate(req, res, settingsPostMatch[1]);
      return;
    }
    if (url.pathname === '/v1/jobs' && method === 'GET') {
      if (this.jobs === null) { this.json(res, 404, { error: { message: 'no scheduler' } }); return; }
      this.json(res, 200, {
        object: 'list', data: this.jobs,
        options: { deliver: [{ value: 'origin', label: 'Origin', group: 'Routing' }], model: [{ value: '', label: 'Follow default (x)', group: 'Default' }] },
        default_model: 'x',
      });
      return;
    }
    const jobMatch = url.pathname.match(/^\/v1\/jobs\/([^/]+)(\/run|\/runs)?$/);
    if (jobMatch) {
      void this.handleJob(req, res, method, jobMatch[1], jobMatch[2] || '');
      return;
    }
    this.json(res, 404, { error: 'no route' });
  }

  private async handleJob(
    req: http.IncomingMessage, res: http.ServerResponse, method: string | undefined, id: string, tail: string,
  ): Promise<void> {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    let body: any;
    try { body = raw ? JSON.parse(raw) : {}; } catch { body = {}; }
    if (this.jobs === null) { this.json(res, 404, { error: { message: 'no scheduler' } }); return; }
    const job = this.jobs.find((j) => j.id === id);
    if (tail === '/runs' && method === 'GET') {
      this.json(res, 200, { object: 'list', data: job ? [{ id: 'e1', status: 'completed', source: 'scheduler' }] : [] });
      return;
    }
    if (method === 'DELETE' && !tail) {
      if (!job) { this.json(res, 404, { error: { type: 'not_found', message: 'no such job' } }); return; }
      this.jobs = this.jobs.filter((j) => j.id !== id);
      this.lastJobPost = { id, action: 'delete', body: null };
      this.json(res, 200, { deleted: true, id });
      return;
    }
    if (method !== 'POST') { this.json(res, 405, { error: { message: 'method' } }); return; }
    this.lastJobPost = { id, action: tail === '/run' ? 'run' : 'update', body };
    if (!job) { this.json(res, 404, { error: { type: 'not_found', message: 'no such job' } }); return; }
    if (tail === '/run') { job.state = 'scheduled'; job.enabled = true; this.json(res, 200, job); return; }
    if (body && typeof body.deliver === 'string' && body.deliver.includes('!')) {
      this.json(res, 400, { error: { type: 'invalid_request_error', message: 'deliver target not understood' } });
      return;
    }
    Object.assign(job, body);
    if (typeof body.enabled === 'boolean') job.state = body.enabled ? 'scheduled' : 'paused';
    this.json(res, 200, job);
  }

  private async handleSettingsUpdate(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    id: string,
  ): Promise<void> {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    let body: any;
    try { body = JSON.parse(raw); } catch { body = {}; }
    this.lastSettingsPost = { id, body };
    if (this.settingsSchema === null) {
      this.json(res, 404, { error: { message: 'settings not supported' } });
      return;
    }
    const def = this.settingsSchema.find((s) => s.id === id);
    if (!def) {
      this.json(res, 404, { error: { message: `unknown setting: ${id}` } });
      return;
    }
    const v = body?.value;
    // Minimal validation that mirrors what real agents are expected
    // to do. The proxy passes through verbatim; the agent is the
    // source of truth for "is this value acceptable?".
    if (def.type === 'enum') {
      const ok = (def.options ?? []).some((o) => o.value === v);
      if (!ok) {
        this.json(res, 400, {
          error: { message: `value not in options[]: ${JSON.stringify(v)}` },
        });
        return;
      }
    }
    if (def.type === 'string-list') {
      if (!Array.isArray(v) || !v.every((e) => typeof e === 'string')) {
        this.json(res, 400, {
          error: { message: `value must be string[]; got ${JSON.stringify(v)}` },
        });
        return;
      }
    }
    def.value = v;
    this.json(res, 200, def);
  }

  private async handleResponses(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    let body: any;
    try { body = JSON.parse(raw); } catch { body = {}; }
    this.lastResponsesConversation = typeof body?.conversation === 'string' ? body.conversation : null;
    this.lastResponsesAttachments = Array.isArray(body?.attachments) ? body.attachments : null;
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
    });
    for (const ev of this.turnEvents) {
      res.write(`event: ${ev.event}\ndata: ${JSON.stringify(ev.data)}\n\n`);
    }
    res.end();
  }

  private handleEvents(req: http.IncomingMessage, res: http.ServerResponse): void {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
    });
    res.write(': ka\n\n');
    this.eventClients.add(res);
    req.on('close', () => this.eventClients.delete(res));
  }

  private json(res: http.ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  }
}

// ────────────────────────────────────────────────────────────────────
// Proxy rig — spins up the proxy's HTTP routes against a FakeAgent.
// ────────────────────────────────────────────────────────────────────

export interface ProxyRig {
  fakeAgent: FakeAgent;
  proxyServer: http.Server;
  proxyUrl: string;
  stop(): Promise<void>;
}

export async function startRig(opts: { mode?: FakeMode } = {}): Promise<ProxyRig> {
  const fakeAgent = new FakeAgent();
  if (opts.mode) fakeAgent.setMode(opts.mode);
  await fakeAgent.start();

  const parley = await import('../index.ts');
  const stream = await import('../stream.ts');
  // Reset the SSE multiplexer's `wired` flag so init() picks up the
  // new upstream's /v1/events subscription. Production never calls
  // this — it's the test-isolation seam.
  stream.__resetForTest();
  parley.init({ token: 'test-token', url: fakeAgent.url });
  // parley.init fires an env-based notifications init without awaiting
  // it. Wait for it to settle BEFORE returning the rig: a test's
  // notifications __resetForTest + explicit init({testKeys}) sequence
  // racing that in-flight init gets silently short-circuited (ready=true,
  // vapid=null) and every push the test makes skips as vapid_unconfigured.
  // Flaked under full-suite CPU contention (digest per-chat test,
  // 2026-06-09).
  await parley.whenNotificationsInitSettled();

  const proxyServer = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://x');
    const path = url.pathname;
    const method = req.method || 'GET';

    if (method === 'POST' && path === '/api/parley/messages') {
      return parley.handleParleyMessage(req, res);
    }
    if (method === 'GET' && path === '/api/parley/stream') {
      return parley.handleParleyStream(req, res);
    }
    if (method === 'GET' && /^\/api\/parley\/sessions\/?$/.test(path)) {
      return parley.handleParleySessionsList(req, res);
    }
    const histMatch = method === 'GET'
      && path.match(/^\/api\/parley\/sessions\/([^/]+)\/messages$/);
    if (histMatch) {
      return parley.handleParleySessionMessages(
        req, res, decodeURIComponent(histMatch[1]),
      );
    }
    const delMatch = method === 'DELETE'
      && path.match(/^\/api\/parley\/sessions\/([^/]+)$/);
    if (delMatch) {
      return parley.handleParleySessionDelete(
        req, res, decodeURIComponent(delMatch[1]),
      );
    }
    if (method === 'GET' && path === '/api/parley/settings/schema') {
      return parley.handleParleySettingsSchema(req, res);
    }
    // Scheduled-jobs extension — mirrors server.ts ordering (run/runs before bare id).
    if (method === 'GET' && path === '/api/parley/jobs') {
      return parley.handleParleyJobsList(req, res);
    }
    const jobRun = method === 'POST' && path.match(/^\/api\/parley\/jobs\/([^/]+)\/run$/);
    if (jobRun) return parley.handleParleyJobRun(req, res, decodeURIComponent(jobRun[1]));
    const jobRuns = method === 'GET' && path.match(/^\/api\/parley\/jobs\/([^/]+)\/runs$/);
    if (jobRuns) return parley.handleParleyJobRuns(req, res, decodeURIComponent(jobRuns[1]));
    const jobDel = method === 'DELETE' && path.match(/^\/api\/parley\/jobs\/([^/]+)$/);
    if (jobDel) return parley.handleParleyJobDelete(req, res, decodeURIComponent(jobDel[1]));
    const jobUpd = method === 'POST' && path.match(/^\/api\/parley\/jobs\/([^/]+)$/);
    if (jobUpd) return parley.handleParleyJobUpdate(req, res, decodeURIComponent(jobUpd[1]));
    const setMatch = method === 'POST'
      && path.match(/^\/api\/parley\/settings\/([^/]+)$/);
    if (setMatch) {
      return parley.handleParleySettingsUpdate(
        req, res, decodeURIComponent(setMatch[1]),
      );
    }
    // Notifications routes — tests opt in by calling notifications.init()
    // explicitly; routes return 503 until then (matching production
    // VAPID-unconfigured behaviour).
    if (method === 'GET' && path === '/api/parley/notifications/vapid-public-key') {
      const r = await import('../notifications/routes.ts');
      return r.handleParleyVapidPublicKey(req, res);
    }
    if (method === 'POST' && path === '/api/parley/notifications/subscribe') {
      const r = await import('../notifications/routes.ts');
      return r.handleParleySubscribe(req, res);
    }
    if (method === 'POST' && path === '/api/parley/notifications/unsubscribe') {
      const r = await import('../notifications/routes.ts');
      return r.handleParleyUnsubscribe(req, res);
    }
    if (method === 'POST' && path === '/api/parley/notifications/test') {
      const r = await import('../notifications/routes.ts');
      return r.handleParleyTest(req, res);
    }
    if (method === 'GET' && path === '/api/parley/notifications/mutes') {
      const r = await import('../notifications/routes.ts');
      return r.handleParleyListMutes(req, res);
    }
    if (method === 'POST' && path === '/api/parley/notifications/mute') {
      const r = await import('../notifications/routes.ts');
      return r.handleParleySetMute(req, res);
    }
    if (method === 'POST' && path === '/api/parley/notifications/visibility') {
      const r = await import('../notifications/routes.ts');
      return r.handleParleyVisibility(req, res);
    }
    if (method === 'GET' && path === '/api/parley/notifications/preferences') {
      const r = await import('../notifications/routes.ts');
      return r.handleParleyGetPreferences(req, res);
    }
    if (method === 'POST' && path === '/api/parley/notifications/preferences') {
      const r = await import('../notifications/routes.ts');
      return r.handleParleySetPreferences(req, res);
    }
    if (method === 'GET' && path === '/api/parley/notifications/diagnostics') {
      const r = await import('../notifications/routes.ts');
      return r.handleParleyDiagnostics(req, res);
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'no route' }));
  });
  await new Promise<void>((resolve) => {
    proxyServer.listen(0, '127.0.0.1', () => resolve());
  });
  const proxyAddr = proxyServer.address() as AddressInfo;

  // Wait for the proxy's `subscribeEvents` loop to attach as a /v1/events
  // SSE subscriber on the FakeAgent. Otherwise tests that push out-of-turn
  // envelopes immediately after startRig() returns hit an empty fan-out
  // and silently drop. Bounded so a test doesn't hang on a misconfigured
  // rig — failure surfaces as the test's own assertion timing out.
  const deadline = Date.now() + 2000;
  while (fakeAgent.eventClientCount === 0 && Date.now() < deadline) {
    await new Promise<void>((rs) => setTimeout(rs, 20));
  }

  return {
    fakeAgent,
    proxyServer,
    proxyUrl: `http://127.0.0.1:${proxyAddr.port}`,
    async stop() {
      stream.__resetForTest();
      // Reset notifications too in case a test in this rig initialized
      // them — leaving the singleton primed would leak state into the
      // next rig (same process, fresh harness).
      try {
        const n = await import('../notifications/index.ts');
        n.__resetForTest();
      } catch { /* notifications module not loaded in this rig — fine */ }
      try {
        const d = await import('../notifications/dispatch.ts');
        d.__resetDispatchForTest();
      } catch { /* dispatch module not loaded in this rig — fine */ }
      try {
        const v = await import('../notifications/visibility.ts');
        v.__resetVisibilityForTest();
      } catch { /* visibility module not loaded — fine */ }
      try {
        const dg = await import('../notifications/digest.ts');
        dg.__resetDigestForTest();
      } catch { /* digest module not loaded — fine */ }
      try {
        const di = await import('../notifications/diagnostics.ts');
        di.__resetDiagnosticsForTest();
      } catch { /* diagnostics module not loaded — fine */ }
      await new Promise<void>((resolve) => proxyServer.close(() => resolve()));
      await fakeAgent.stop();
    },
  };
}

/** Read a JSON response body. */
export async function readJson(res: Response): Promise<any> {
  return await res.json();
}

/** Subscribe to an SSE endpoint and return an async iterator yielding
 *  raw frames as `{event, data, id}`. The signal aborts the underlying
 *  fetch when the test is done. */
export async function* readSseFrames(
  url: string,
  signal: AbortSignal,
): AsyncIterable<{ event: string; data: string; id: string | null }> {
  const r = await fetch(url, { signal });
  if (!r.ok || !r.body) throw new Error(`SSE fetch failed: ${r.status}`);
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return;
      buf += dec.decode(value, { stream: true });
      let sep = buf.indexOf('\n\n');
      while (sep !== -1) {
        const frame = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        sep = buf.indexOf('\n\n');
        let event = 'message';
        let data = '';
        let id: string | null = null;
        for (const line of frame.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) data += line.slice(5).trim();
          else if (line.startsWith('id:')) id = line.slice(3).trim();
        }
        if (data) yield { event, data, id };
      }
    }
  } finally {
    try { reader.releaseLock(); } catch {}
  }
}
