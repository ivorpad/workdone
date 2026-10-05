// ChatGPT acknowledges an event that arrives while the subscribed chat's own turn is
// running, then never shows it. Deliveries for an agent a chat drives wait until that
// chat goes quiet.
import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { LeaseActivity, leaseActivity } from "../src/activity.ts";
import { parseConfig } from "../src/config.ts";
import { EventsService, HOLD, holdUntil, type EventPrincipal } from "../src/events.ts";
import type { CallGateway } from "../src/gateway-client.ts";
import { createHandler } from "../src/server.ts";
import type { WebhookSender } from "../src/webhook.ts";
import type { Report } from "../../gateway/watcher.ts";

const secret = `whsec_${Buffer.alloc(32, 1).toString("base64")}`;
const time = Date.parse("2026-10-05T18:00:00Z");
const principal: EventPrincipal = { id: "owner", issuer: "https://login.workdone.dev", subject: "ivor", scopes: ["workdone"], tokenExpiresAt: time + 7 * 86400_000 };
const subscribe = { name: "agent.finished", arguments: { machine: "ovh" }, delivery: { mode: "webhook", url: "https://hooks.openai.com/callback/x", secret } };
const result = (requestedAt: number) => ({
  result_id: "res_0123456789abcdef", requested_at: new Date(requestedAt).toISOString(), status: "finished",
  summary: "smoke ok", commit: null, tree: null, clean: null, changed: null, branch: null, kind: "claude", model: "sonnet", model_id: "claude-sonnet-5-5", effort: "low",
});
const report = (changes: Partial<Report> = {}): Report => ({ event_id: "e1", occurred_at: new Date(time).toISOString(), pane_id: "w1:p1", type: "finished", agent: "smoke", kind: "claude", cwd: "/w", excerpt: "done", lease: "L-abc123", reply_to: "L-abc123", message: "smoke finished", ...changes });

const services: EventsService[] = [];
const dirs: string[] = [];
afterEach(async () => { for (const s of services.splice(0)) await s.close(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function fixture(statePath = ":memory:") {
  let now = time;
  let active: number | undefined;
  const sent: string[] = [];
  const logs: string[] = [];
  const sender: WebhookSender = async (_url, _headers, body) => {
    const parsed = JSON.parse(body);
    if (parsed.type === "verification") return { status: 200, body: JSON.stringify({ challenge: parsed.challenge }) };
    sent.push(body);
    return { status: 200, body: "" };
  };
  const service = new EventsService({ statePath, callbackHosts: ["hooks.openai.com"], authorize: async () => true, sender, now: () => now, random: () => 0, log: (l) => logs.push(l), lastActive: () => active });
  services.push(service);
  return { service, sent, logs, tick: (ms: number) => { now += ms; }, activeAt: (t: number | undefined) => { active = t; }, now: () => now };
}

describe("hold policy", () => {
  const hold = { machine: "ovh", lease: "L-abc123", queued_at: time };
  test("waits quietMs past the chat's last call, and a result afterRequestMs past its request", () => {
    expect(holdUntil(hold, time - 5000)).toBe(time - 5000 + HOLD.quietMs);
    expect(holdUntil({ ...hold, requested_at: time - 10_000 }, undefined)).toBe(time - 10_000 + HOLD.afterRequestMs);
    expect(holdUntil({ ...hold, requested_at: time - 10_000 }, time)).toBe(time + HOLD.quietMs);
    // Nothing known: no hold.
    expect(holdUntil(hold, undefined)).toBeLessThanOrEqual(time);
  });
  test("never past maxMs after it was queued", () => {
    expect(holdUntil(hold, time + 10 * 60_000)).toBe(time + HOLD.maxMs);
  });
});

describe("held deliveries", () => {
  test("an event for a chat that is mid-turn waits until it has been quiet, then goes once", async () => {
    const f = fixture();
    await f.service.subscribe(principal, subscribe);
    f.activeAt(time - 2000);
    await f.service.addReports("ovh", [report({ result: result(time - 9000) as any })]);
    await f.service.flush();
    expect(f.sent).toHaveLength(0);
    f.tick(HOLD.quietMs - 2000);
    await f.service.flush();
    expect(f.sent).toHaveLength(1);
    expect(JSON.parse(f.sent[0]!).data.result.result_id).toBe("res_0123456789abcdef");
    f.tick(60_000);
    await f.service.flush();
    expect(f.sent).toHaveLength(1);
  });
  test("a call while the event waits starts the quiet period again", async () => {
    const f = fixture();
    await f.service.subscribe(principal, subscribe);
    f.activeAt(time);
    await f.service.addReports("ovh", [report()]);
    f.tick(HOLD.quietMs - 1000);
    f.activeAt(f.now());
    f.tick(1000);
    await f.service.flush();
    expect(f.sent).toHaveLength(0);
    expect(f.logs.some((l) => l.includes("events_delivery_held"))).toBe(true);
    f.tick(HOLD.quietMs);
    await f.service.flush();
    expect(f.sent).toHaveLength(1);
  });
  test("a chat that never goes quiet still gets it after maxMs", async () => {
    const f = fixture();
    await f.service.subscribe(principal, subscribe);
    f.activeAt(time);
    await f.service.addReports("ovh", [report()]);
    for (let t = 0; t < HOLD.maxMs; t += 10_000) {
      f.tick(10_000);
      f.activeAt(f.now());
      await f.service.flush();
      if (f.sent.length) break;
    }
    expect(f.sent).toHaveLength(1);
    expect(f.now()).toBeLessThanOrEqual(time + HOLD.maxMs + 10_000);
  });
  test("after a restart (no activity known) a result still waits past its request", async () => {
    const f = fixture();
    await f.service.subscribe(principal, subscribe);
    await f.service.addReports("ovh", [report({ result: result(time - 5000) as any })]);
    await f.service.flush();
    expect(f.sent).toHaveLength(0);
    f.tick(HOLD.afterRequestMs - 5000);
    await f.service.flush();
    expect(f.sent).toHaveLength(1);
  });
  test("an event no chat drives goes at once", async () => {
    const f = fixture();
    await f.service.subscribe(principal, subscribe);
    f.activeAt(time);
    await f.service.addReports("ovh", [report({ lease: null, reply_to: null })]);
    await f.service.flush();
    expect(f.sent).toHaveLength(1);
  });
  test("a store from before holds existed gains the column and keeps its queue", async () => {
    const dir = mkdtempSync(join(tmpdir(), "events-hold-"));
    dirs.push(dir);
    const path = join(dir, "events.sqlite");
    const old = new Database(path, { create: true });
    old.exec(`CREATE TABLE subscriptions (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE deliveries (subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE, event_id TEXT NOT NULL, body TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL, PRIMARY KEY(subscription_id,event_id));
      CREATE TABLE seen (id TEXT PRIMARY KEY, at INTEGER NOT NULL);`);
    old.close();
    const f = fixture(path);
    await f.service.subscribe(principal, subscribe);
    await f.service.addReports("ovh", [report({ lease: null, reply_to: null })]);
    await f.service.flush();
    expect(f.sent).toHaveLength(1);
  });
});

describe("lease activity", () => {
  test("remembers the last call per machine and lease", () => {
    let now = 1000;
    const a = new LeaseActivity(() => now);
    a.touch("ovh", "L-abc123");
    now = 5000;
    a.touch("mac", "L-abc123");
    expect(a.lastActive("ovh", "L-abc123")).toBe(1000);
    expect(a.lastActive("mac", "L-abc123")).toBe(5000);
    expect(a.lastActive("ovh", "L-other1")).toBeUndefined();
  });
  test("every tool call with a lease, and the lease spawn_agent made, count as the chat's activity", async () => {
    const target = { user: "ivor", host: "mac.example.ts.net", identityFile: "/k", knownHostsFile: "/kh" };
    const cfg = parseConfig({ listen: { host: "127.0.0.1", port: 8787 }, machines: { mac: target, ovh: { ...target, host: "127.0.0.1" } } });
    const fake: CallGateway = async (_m, op) => ({ ok: true, result: op === "spawn_agent" ? { lease: "L-made111" } : { submitted: true } });
    const handler = createHandler(cfg, fake);
    const c = new Client({ name: "test", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
    await c.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8787/mcp"), {
      fetch: async (input, init) => { const req = new Request(String(input), init); req.headers.set("host", "127.0.0.1:8787"); return handler(req); },
    }));
    const before = Date.now();
    await c.callTool({ name: "prompt_agent", arguments: { machine: "ovh", target: "smoke", text: "hi", lease: "L-seen111" } });
    await c.callTool({ name: "spawn_agent", arguments: { machine: "ovh", kind: "claude", name: "x", cwd: "/w" } });
    expect(leaseActivity.lastActive("ovh", "L-seen111")).toBeGreaterThanOrEqual(before);
    expect(leaseActivity.lastActive("ovh", "L-made111")).toBeGreaterThanOrEqual(before);
    expect(leaseActivity.lastActive("mac", "L-seen111")).toBeUndefined();
    await c.close();
  });
});
