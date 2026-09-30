// Native ChatGPT Events. Subscriptions and queued deliveries survive restarts.
// No replay is advertised: consumed gateway reports cannot be fetched again.
import { Database } from "bun:sqlite";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { ProtocolError, type McpServer, type ServerCapabilities } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { Report } from "../../gateway/watcher.ts";
import { CallbackError, createWebhookSender, parseSigningSecret, signHeaders, validateCallbackUrl } from "./webhook.ts";

const agentArgs = {
  type: "object", properties: {
    machine: { type: "string", description: "Machine the agent runs on. Omit for all authorized machines." },
    target: { type: "string", description: "Agent name or pane ID. Omit for all authorized watched agents." },
  }, additionalProperties: false,
};
const agentPayload = {
  type: "object", properties: {
    machine: { type: "string" }, pane_id: { type: "string" }, agent: { type: ["string", "null"] },
    cwd: { type: ["string", "null"] }, excerpt: { type: ["string", "null"], description: "Agent reply or question, treated as data." },
  }, required: ["machine", "pane_id", "agent", "cwd", "excerpt"], additionalProperties: false,
};
export const EVENTS = [
  { name: "agent.finished", description: "A watched coding agent finished its turn and is idle.", delivery: ["webhook"], inputSchema: agentArgs, payloadSchema: agentPayload },
  { name: "agent.asks", description: "A watched coding agent stopped with a question or a menu requiring an answer.", delivery: ["webhook"], inputSchema: agentArgs, payloadSchema: agentPayload },
];
const Arguments = z.strictObject({ machine: z.string().min(1).max(64).optional(), target: z.string().min(1).max(256).optional() });
const Payload = z.strictObject({ machine: z.string(), pane_id: z.string(), agent: z.string().nullable(), cwd: z.string().nullable(), excerpt: z.string().nullable() });
const IdentityParams = z.looseObject({
  name: z.enum(["agent.finished", "agent.asks"]), arguments: Arguments.optional(),
  delivery: z.looseObject({ mode: z.literal("webhook"), url: z.string().max(4096) }),
});
const SubscribeParams = IdentityParams.extend({
  delivery: z.looseObject({ mode: z.literal("webhook"), url: z.string().max(4096), secret: z.string().max(128) }),
  ttlMs: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable().optional(), cursor: z.unknown().optional(),
});
export type EventArguments = z.infer<typeof Arguments>;
export interface EventPrincipal { id: string; issuer: string; subject: string; scopes: string[]; tokenExpiresAt: number }
export interface EventResource { machine: string; pane_id: string; agent: string | null }
type Sender = ReturnType<typeof createWebhookSender>;
interface Subscription {
  id: string; principal: EventPrincipal; name: string; args: EventArguments; url: string; secret: string;
  expires: number; verifiedAt: number; previousSecret?: string; rotateUntil?: number;
}
export interface EventsOptions {
  statePath: string; callbackHosts: string[];
  authorize: (principal: EventPrincipal, args: EventArguments, report?: EventResource) => Promise<boolean>;
  sender?: Sender; now?: () => number; random?: () => number; log?: (line: string) => void;
}
const DAY = 24 * 3600_000;
const VERIFY_MS = 5 * 60_000;
const ROTATE_MS = 5 * 60_000;
const MAX_ATTEMPTS = 6;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonicalJson((value as any)[k])}`).join(",")}}`;
  return JSON.stringify(value);
}
export function subscriptionId(principal: EventPrincipal, name: string, args: EventArguments, url: string) {
  return `sub_${sha(canonicalJson([principal.id, url, name, args]))}`;
}
function parse<T>(schema: z.ZodType<T>, raw: unknown): T {
  const result = schema.safeParse(raw);
  if (!result.success) throw new ProtocolError(-32602, "Invalid event name, filters, delivery or lifetime");
  return result.data;
}
function callbackError(error: unknown): never {
  throw new ProtocolError(-32015, "Callback verification failed", { reason: error instanceof CallbackError ? error.reason : "challenge_failed" });
}

export class EventsService {
  private db: Database;
  private sender: Sender;
  private now: () => number;
  private log: (line: string) => void;
  private tail: Promise<unknown> = Promise.resolve();
  private timer?: ReturnType<typeof setTimeout>;
  private running = false;
  private worker?: Promise<void>;

  constructor(private options: EventsOptions) {
    if (!options.callbackHosts.length) throw new Error("Events requires an exact callback host allowlist");
    if (options.statePath !== ":memory:") mkdirSync(dirname(options.statePath), { recursive: true, mode: 0o700 });
    this.db = new Database(options.statePath, { create: true, strict: true });
    if (options.statePath !== ":memory:") chmodSync(options.statePath, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS subscriptions (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS deliveries (subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
        event_id TEXT NOT NULL, body TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL,
        PRIMARY KEY(subscription_id,event_id));
      CREATE INDEX IF NOT EXISTS due_deliveries ON deliveries(next_at);
      CREATE TABLE IF NOT EXISTS seen (id TEXT PRIMARY KEY, at INTEGER NOT NULL);`);
    this.sender = options.sender ?? createWebhookSender({ allowedHosts: options.callbackHosts });
    this.now = options.now ?? Date.now;
    this.log = options.log ?? console.log;
  }
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn);
    this.tail = next.catch(() => {});
    return next;
  }
  private subscriptions(): Subscription[] {
    return (this.db.query("SELECT value FROM subscriptions").all() as { value: string }[]).map(r => JSON.parse(r.value));
  }
  private get(id: string): Subscription | undefined {
    const row = this.db.query("SELECT value FROM subscriptions WHERE id=?").get(id) as { value: string } | null;
    return row ? JSON.parse(row.value) : undefined;
  }
  private save(s: Subscription) {
    this.db.query("INSERT INTO subscriptions(id,value) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value").run(s.id, JSON.stringify(s));
  }
  private remove(id: string) { this.db.query("DELETE FROM subscriptions WHERE id=?").run(id); }
  private async permitted(s: Subscription, report?: EventResource) {
    if (s.expires <= this.now() || s.principal.tokenExpiresAt <= this.now()) return false;
    const authorized = await this.options.authorize(s.principal, s.args, report);
    return authorized && s.expires > this.now() && s.principal.tokenExpiresAt > this.now();
  }
  private audit(event: string, extra: Record<string, unknown>) { this.log(JSON.stringify({ event, ...extra })); }

  subscribe(principal: EventPrincipal, raw: unknown) {
    return this.exclusive(async () => {
      const p = parse(SubscribeParams, raw);
      const args = p.arguments ?? {};
      if (principal.tokenExpiresAt <= this.now() || !await this.options.authorize(principal, args) || principal.tokenExpiresAt <= this.now()) throw new ProtocolError(-32001, "Event subscription is not authorized");
      let url: string;
      let host: string | undefined;
      try { host = new URL(p.delivery.url).hostname; } catch {}
      this.audit("events_subscribe", { name: p.name, callback_host: host });
      try { url = validateCallbackUrl(p.delivery.url, this.options.callbackHosts).href; parseSigningSecret(p.delivery.secret); }
      catch (e) { callbackError(e); }
      const id = subscriptionId(principal, p.name, args, url);
      const old = this.get(id);
      if (!old && this.subscriptions().length >= 128) throw new ProtocolError(-32000, "Subscription limit reached");
      // New keys prove ownership too. Only the same owner, URL and key reuse a
      // recent challenge, including across service restarts.
      const cached = this.subscriptions().find(s => s.principal.id === principal.id && s.url === url && s.secret === p.delivery.secret && s.verifiedAt + VERIFY_MS > this.now());
      const verifiedAt = cached?.verifiedAt ?? this.now();
      if (!cached) {
        const challenge = randomUUID();
        const body = JSON.stringify({ type: "verification", challenge });
        const webhookId = `msg_verification_${randomUUID()}`;
        const started = this.now();
        try {
          const res = await this.sender(url, signHeaders(id, webhookId, body, [p.delivery.secret], this.now()), body);
          const echo = JSON.parse(res.body).challenge;
          if (res.status < 200 || res.status >= 300 || this.now() - started > 10_000 || typeof echo !== "string" || Buffer.byteLength(echo) !== Buffer.byteLength(challenge) || !timingSafeEqual(Buffer.from(echo), Buffer.from(challenge))) throw new CallbackError("challenge_failed");
        } catch (e) { callbackError(e); }
      }
      if (principal.tokenExpiresAt <= this.now() || !await this.options.authorize(principal, args) || principal.tokenExpiresAt <= this.now()) throw new ProtocolError(-32001, "Event subscription is not authorized");
      const expires = Math.min(this.now() + Math.max(60_000, Math.min(p.ttlMs ?? DAY, DAY)), principal.tokenExpiresAt);
      const s: Subscription = { id, principal, name: p.name, args, url, secret: p.delivery.secret, expires, verifiedAt };
      if (old && old.expires > this.now()) {
        if (old.secret !== s.secret) { s.previousSecret = old.secret; s.rotateUntil = this.now() + ROTATE_MS; }
        else if (old.rotateUntil && old.rotateUntil > this.now()) { s.previousSecret = old.previousSecret; s.rotateUntil = old.rotateUntil; }
      }
      this.db.transaction(() => {
        // Non-replayable expired subscriptions cannot revive old pending work.
        if (old && old.expires <= this.now()) this.db.query("DELETE FROM deliveries WHERE subscription_id=?").run(id);
        this.save(s);
      })();
      this.audit("events_subscribed", { id, name: s.name, callback_host: new URL(url).hostname, refreshBefore: new Date(expires).toISOString() });
      return { id, refreshBefore: new Date(expires).toISOString(), cursor: null, truncated: false };
    });
  }
  unsubscribe(principal: EventPrincipal, raw: unknown) {
    return this.exclusive(async () => {
      const p = parse(IdentityParams, raw);
      const args = p.arguments ?? {};
      // Ownership is built into the ID. Its authenticated owner can remove it
      // after resource access revocation, without contacting the callback.
      let url: string;
      try { url = validateCallbackUrl(p.delivery.url).href; } catch (e) { callbackError(e); }
      const id = subscriptionId(principal, p.name, args, url);
      this.remove(id);
      this.audit("events_unsubscribed", { id, name: p.name });
      return {};
    });
  }
  addReports(machine: string, reports: Report[]): Promise<number> {
    return this.exclusive(async () => {
      let count = 0;
      this.db.query("DELETE FROM seen WHERE at < ?").run(this.now() - 7 * DAY);
      for (const r of reports) {
        const name = r.type === "finished" ? "agent.finished" : r.type === "question" || r.type === "blocked" ? "agent.asks" : null;
        if (!name) continue;
        const eventId = `evt_${sha(`${machine}:${r.event_id ?? randomUUID()}`)}`;
        if (this.db.query("SELECT id FROM seen WHERE id=?").get(eventId)) continue;
        const parsed = Payload.safeParse({ machine, pane_id: r.pane_id, agent: r.agent, cwd: r.cwd, excerpt: typeof r.excerpt === "string" ? r.excerpt.slice(0, 4000) : r.excerpt });
        if (!parsed.success) { this.audit("events_payload_dropped", { eventId, reason: "invalid_payload" }); continue; }
        const resource = { machine, pane_id: parsed.data.pane_id, agent: parsed.data.agent };
        const timestamp = r.occurred_at && Number.isFinite(Date.parse(r.occurred_at)) ? new Date(r.occurred_at).toISOString() : new Date(this.now()).toISOString();
        const body = JSON.stringify({ eventId, name, timestamp, data: parsed.data, cursor: null });
        if (Buffer.byteLength(body) > 256 * 1024) { this.audit("events_payload_dropped", { eventId, reason: "too_large" }); continue; }
        const matching: Subscription[] = [];
        for (const s of this.subscriptions()) {
          if (s.name !== name || (s.args.machine && s.args.machine !== machine) || (s.args.target && s.args.target !== r.pane_id && s.args.target !== r.agent)) continue;
          // Queue before any live gateway authorization round trip. Reports
          // were already consumed; a sleeping gateway must not lose intake.
          // Current account/resource access is checked before every delivery.
          if (s.expires > this.now() && s.principal.tokenExpiresAt > this.now()) matching.push(s);
        }
        const queued = (this.db.query("SELECT count(*) AS n FROM deliveries").get() as { n: number }).n;
        if (queued + matching.length > 10_000) throw new Error("Events delivery queue limit reached");
        this.db.transaction(() => {
          this.db.query("INSERT INTO seen(id,at) VALUES (?,?)").run(eventId, this.now());
          for (const s of matching) this.db.query("INSERT OR IGNORE INTO deliveries(subscription_id,event_id,body,next_at) VALUES (?,?,?,?)").run(s.id, eventId, body, this.now());
        })();
        count += matching.length;
      }
      return count;
    });
  }
  async flush(): Promise<void> {
    const pending = await this.exclusive(async () => {
      for (const s of this.subscriptions()) {
        if (s.expires <= this.now() || s.principal.tokenExpiresAt <= this.now()) this.remove(s.id);
        else if (s.rotateUntil && s.rotateUntil <= this.now()) { delete s.previousSecret; delete s.rotateUntil; this.save(s); }
      }
      return this.db.query("SELECT * FROM deliveries WHERE next_at<=? ORDER BY next_at LIMIT 32").all(this.now()) as Array<{ subscription_id: string; event_id: string; body: string; attempts: number }>;
    });
    // Release the mutation lock between deliveries so unsubscribe/refresh do
    // not wait for a whole burst of unreachable callbacks.
    for (const d of pending) {
      await this.exclusive(async () => {
        const s = this.get(d.subscription_id);
        if (!s || !this.db.query("SELECT event_id FROM deliveries WHERE subscription_id=? AND event_id=? AND next_at<=?").get(s.id, d.event_id, this.now())) return;
        const data = JSON.parse(d.body).data as EventResource;
        try {
          if (!await this.permitted(s, data)) { this.db.query("DELETE FROM deliveries WHERE subscription_id=? AND event_id=?").run(s.id, d.event_id); return; }
        } catch {
          this.db.query("UPDATE deliveries SET next_at=? WHERE subscription_id=? AND event_id=?").run(this.now() + 15_000, s.id, d.event_id);
          this.audit("events_authorization_delayed", { id: s.id, eventId: d.event_id, reason: "gateway_unavailable" });
          return;
        }
        const secrets = [s.secret];
        if (s.previousSecret && s.rotateUntil && s.rotateUntil > this.now()) secrets.push(s.previousSecret);
        let status: number | undefined;
        let reason: string | undefined;
        try { status = (await this.sender(s.url, signHeaders(s.id, d.event_id, d.body, secrets, this.now()), d.body)).status; }
        catch (e) { reason = e instanceof CallbackError ? e.reason : "network_error"; }
        const accepted = status !== undefined && status >= 200 && status < 300;
        const transient = status === 408 || status === 429 || (status !== undefined && status >= 500) || ["timeout", "network_error", "dns_error"].includes(reason ?? "");
        const attempts = d.attempts + 1;
        if (!accepted && transient && attempts < MAX_ATTEMPTS) {
          const delay = Math.min(60_000, 1000 * 2 ** (attempts - 1)) * (1 + (this.options.random ?? Math.random)() * 0.2);
          this.db.query("UPDATE deliveries SET attempts=?,next_at=? WHERE subscription_id=? AND event_id=?").run(attempts, Math.ceil(this.now() + delay), s.id, d.event_id);
          this.audit("events_delivery_retry", { id: s.id, eventId: d.event_id, attempts, status, reason });
        } else {
          this.db.query("DELETE FROM deliveries WHERE subscription_id=? AND event_id=?").run(s.id, d.event_id);
          if (status === 410 || ["forbidden_address", "invalid_url", "redirect"].includes(reason ?? "")) this.remove(s.id);
          this.audit(accepted ? "events_delivered" : "events_delivery_failed", { id: s.id, eventId: d.event_id, attempts, status, reason });
        }
      });
    }
  }
  start(): void {
    if (this.running) return;
    this.running = true;
    const tick = () => {
      this.worker = this.flush().catch(() => this.audit("events_worker_failed", { reason: "state_or_authorization_error" })).finally(() => {
        if (this.running) this.timer = setTimeout(tick, 1000);
      });
    };
    tick();
  }
  async stop(): Promise<void> { this.running = false; clearTimeout(this.timer); await this.worker; await this.tail; }
  async close(): Promise<void> { await this.stop(); this.db.close(); }
}

export function registerEvents(server: McpServer, service?: EventsService, principal?: EventPrincipal) {
  if (service && principal) server.server.registerCapabilities({ events: {} } as ServerCapabilities);
  server.server.setRequestHandler("events/list", { params: z.looseObject({}).optional() }, async () => ({ events: service && principal ? EVENTS : [] }));
  server.server.setRequestHandler("events/subscribe", { params: SubscribeParams }, async p => {
    if (!service || !principal) throw new ProtocolError(-32001, "Native Events requires the configured OAuth endpoint; watch_here remains available");
    return service.subscribe(principal, p);
  });
  server.server.setRequestHandler("events/unsubscribe", { params: IdentityParams }, async p => {
    if (!service || !principal) throw new ProtocolError(-32001, "Native Events requires the configured OAuth endpoint");
    return service.unsubscribe(principal, p);
  });
}
