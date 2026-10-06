import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "../src/config.ts";
import { PendingCalls } from "../src/confirm.ts";
import { ConsoleBus, createConsole } from "../src/console.ts";
import { createEndpoints, createReportSink } from "../src/server.ts";
import { auditToEvent, buildNeeds, controlOf, deliveryOf, pollDelay } from "../src/console-model.ts";
import type { CallGateway, GatewayResponse } from "../src/gateway-client.ts";

const target = { user: "u", host: "mac.example.ts.net", identityFile: "/k", knownHostsFile: "/kh" };
const DIALOG = "a".repeat(64);
const OWNER = "owner@example.com";

function setup(opts: { devNoAuth?: boolean; wants?: boolean; legacy?: boolean; inbox?: { entries: any[]; pending: any[]; unanswered: number }; pollBaseMs?: number; pollMaxMs?: number; calls?: GatewayResponse | ((op: string, p: any) => GatewayResponse | undefined) } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "console-"));
  const cfg = parseConfig({
    machines: { mac: target },
    console: { port: 8790, ...(opts.devNoAuth ? { devNoAuth: true } : { ownerLogins: [OWNER] }) },
  });
  const calls: Array<[string, string, any]> = [];
  let leaseCounter = 0;
  const answer = (op: string, params: any): GatewayResponse => {
    switch (op) {
      case "overview": return { ok: true, result: { counts: { blocked: 1, working: 1 }, agents: [
        { pane_id: "w1:p1", name: "alpha", agent: "claude", status: "blocked", attention: "dialog", choices: { dialog_id: DIALOG, kind: "permission", go_ahead: 1, text: "Run ls?", options: [{ n: 1, label: "Yes" }, { n: 2, label: "No" }] } },
        { pane_id: "w1:p2", name: "beta", agent: "codex", status: "working", watch: { result_pending: "res_1" } },
      ] } };
      case "supervisor_status": return { ok: true, result: { agents: [{ pane_id: "w1:p2", state: "stalled", recommendations: [{ action: "nudge_ship_slice", reasons: ["no commit"] }] }] } };
      case "coord_snapshot": return { ok: true, result: { objectives: [{ id: "obj", blocked_human: [{ id: "t1", blocker: "need the key" }] }] } };
      case "lease_list": return { ok: true, result: { leases: [{ tail: "…abcd", label: "Run watcher", panes: ["w1:p2"], used: "now", mine: false }] } };
      case "claims": return { ok: true, result: { claims: [{ repo: "app", path: "migrations/meta/_journal.json", holder: "codex", pane_id: null, at: null, note: null }] } };
      case "audit_tail": return { ok: true, result: { entries: [
        { ts: "2026-10-06T12:00:00Z", op: "prompt_agent", ok: true, args: { target: "w1:p2", lease: "…abcd", text: "go" } },
        { ts: "2026-10-06T12:01:00Z", op: "steer_agent", ok: false, code: "not_your_agent", args: { target: "w1:p2", lease: "…abcd" } },
        { ts: "2026-10-06T12:02:00Z", op: "overview", ok: true, args: {} },
      ] } };
      case "claim_agents": return { ok: true, result: { lease: params.lease ?? `L-console${++leaseCounter}`, label: "console", panes: params.targets ?? [], refused: [] } };
      case "owner_note": return { ok: true, result: { queued: true, held_by: "Run watcher" } };
      default:
        return { ok: true, result: { op } };
    }
  };
  // The gateway as the console sees it: console_snapshot assembles the same sections the separate ops answer.
  const gateway: CallGateway = async (machine, op, params) => {
    calls.push([machine, op, params]);
    const over = typeof opts.calls === "function" ? opts.calls(op, params) : undefined;
    if (over) return over;
    if (op === "console_snapshot") {
      if (opts.legacy) return { ok: false, error: { code: "unknown_operation", message: "no such op" } };
      const r = (o: string) => (answer(o, {}) as any).result;
      return { ok: true, result: { agents: r("overview").agents, counts: r("overview").counts, supervisor: r("supervisor_status").agents, objectives: r("coord_snapshot").objectives, leases: r("lease_list").leases, claims: r("claims").claims, audit: r("audit_tail").entries, inbox: opts.inbox ?? { entries: [], pending: [], unanswered: 0 }, errors: {} } };
    }
    return answer(op, params);
  };
  const pending = new PendingCalls();
  const bus = new ConsoleBus();
  const con = createConsole({ cfg: { ...cfg, console: cfg.console! }, call: gateway, pending, bus, wantsMessages: () => opts.wants ?? false, pollBaseMs: opts.pollBaseMs, pollMaxMs: opts.pollMaxMs });
  const req = (path: string, init: RequestInit & { login?: string | null } = {}) => {
    const { login = OWNER, ...rest } = init;
    const headers = new Headers(rest.headers);
    headers.set("host", "console.test");
    if (login) headers.set("tailscale-user-login", login);
    return con.handler(new Request(`http://console.test${path}`, { ...rest, headers }));
  };
  const act = (body: unknown) => req("/api/act", { method: "POST", headers: { "x-workdone-console": "1", "content-type": "application/json" }, body: JSON.stringify(body) });
  return { con, calls, pending, bus, req, act, dir };
}

describe("console access", () => {
  test("needs a tailnet identity, and only the owner's", async () => {
    const t = setup();
    expect((await t.req("/", { login: null })).status).toBe(401);
    expect((await t.req("/", { login: "someone@example.com" })).status).toBe(403);
    const page = await t.req("/", { login: OWNER.toUpperCase() });
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect((await t.req("/api/state", { login: null })).status).toBe(401);
  });
  test("devNoAuth answers loopback hosts only", async () => {
    const t = setup({ devNoAuth: true });
    expect((await t.con.handler(new Request("http://127.0.0.1:8790/", { headers: { host: "127.0.0.1:8790" } }))).status).toBe(200);
    expect((await t.con.handler(new Request("http://evil.example/", { headers: { host: "evil.example" } }))).status).toBe(421);
  });
  test("config refuses a console with no owner and no devNoAuth, and a port clash", () => {
    expect(() => parseConfig({ machines: { mac: target }, console: { port: 8790 } })).toThrow(/ownerLogins/);
    expect(() => parseConfig({ machines: { mac: target }, console: { port: 8787, ownerLogins: [OWNER] } })).toThrow(/differ/);
  });
  test("an Origin of null or garbage is refused, not a crash", async () => {
    const t = setup();
    for (const origin of ["null", "::not a url::"]) {
      const res = await t.req("/api/act", { method: "POST", headers: { "x-workdone-console": "1", origin }, body: "{}" });
      expect(res.status).toBe(403);
    }
    expect(t.calls.length).toBe(0);
  });
  test("a post needs the console header and the same origin", async () => {
    const t = setup();
    const bare = await t.req("/api/act", { method: "POST", body: "{}" });
    expect(bare.status).toBe(403);
    const cross = await t.req("/api/act", { method: "POST", headers: { "x-workdone-console": "1", origin: "https://evil.example" }, body: "{}" });
    expect(cross.status).toBe(403);
    expect(t.calls.length).toBe(0);
  });
});

describe("console listener", () => {
  test("is a third loopback endpoint, and the MCP endpoint never serves the console", async () => {
    const t = setup();
    const cfg = parseConfig({ machines: { mac: target }, console: { port: 8790, ownerLogins: [OWNER] } });
    const endpoints = createEndpoints(cfg, async () => ({ ok: true, result: {} }), undefined, {}, t.con.handler);
    expect(endpoints.map((e) => [e.host, e.port])).toEqual([["127.0.0.1", 8787], ["127.0.0.1", 8790]]);
    const mcp = endpoints[0]!.handler;
    expect((await mcp(new Request("http://127.0.0.1:8787/api/state", { headers: { host: "127.0.0.1:8787", "tailscale-user-login": OWNER } }))).status).toBe(404);
    expect((await mcp(new Request("http://127.0.0.1:8787/", { headers: { host: "127.0.0.1:8787" } }))).status).toBe(404);
    // No console block: no console endpoint, even if a handler is passed.
    const plain = createEndpoints(parseConfig({ machines: { mac: target } }), async () => ({ ok: true, result: {} }), undefined, {}, t.con.handler);
    expect(plain.length).toBe(1);
  });
});

const entry = (over: Record<string, unknown>) => ({ id: "e1", kind: "finished", status: "unanswered", at: "2026-10-06T15:00:00Z", pane_id: "w1:p1", agent: "alpha", agent_kind: "claude", cwd: "/x", session: "s", lease: null, thread: null, task: null, text: "all done", ...over });

describe("console snapshot path", () => {
  test("one gateway call per machine per refresh, and it is console_snapshot", async () => {
    const t = setup();
    await t.req("/api/state?fresh=1");
    expect(t.calls.map((c) => [c[0], c[1]])).toEqual([["mac", "console_snapshot"]]);
  });
  test("a gateway from before console_snapshot is read the old way, flagged, and not asked again", async () => {
    const t = setup({ legacy: true });
    const body: any = await (await t.req("/api/state?fresh=1")).json();
    expect(body.machines.mac).toMatchObject({ ok: true, legacy: true });
    expect(body.machines.mac.agents.length).toBe(2);
    expect(t.calls.map((c) => c[1]).sort()).toEqual(["audit_tail", "claims", "console_snapshot", "coord_snapshot", "lease_list", "overview", "supervisor_status"]);
    t.calls.length = 0;
    await t.req("/api/state?fresh=1");
    expect(t.calls.some((c) => c[1] === "console_snapshot")).toBe(false);
  });
  test("a snapshot that fails for another reason is the machine being down, not a reason to fall back", async () => {
    const t = setup({ calls: (op) => (op === "console_snapshot" ? { ok: false, error: { code: "herdr_unavailable", message: "herdr down" } } : undefined) });
    const body: any = await (await t.req("/api/state")).json();
    expect(body.machines.mac).toMatchObject({ ok: false, error: { code: "herdr_unavailable" } });
    expect(t.calls.map((c) => c[1])).toEqual(["console_snapshot"]);
  });
});

describe("console inbox", () => {
  const inbox = { unanswered: 2, pending: [], entries: [entry({ id: "t1", kind: "tell", pane_id: "w1:p2", agent: "beta", thread: "Run watcher", text: "need a decision" }), entry({ id: "f1" }), entry({ id: "old", status: "answered", pane_id: "w1:p2", resolved_by: "console" })] };

  test("entries come through with where each could go, and the unanswered ones are in Needs you, one per agent", async () => {
    const t = setup({ inbox });
    const body: any = await (await t.req("/api/state")).json();
    const entries = body.machines.mac.inbox.entries;
    expect(entries.find((e: any) => e.id === "t1").delivery.route).toBe("thread");
    expect(entries.find((e: any) => e.id === "f1").delivery).toMatchObject({ route: "none" });
    expect(entries.find((e: any) => e.id === "f1").delivery.text).toContain("undelivered");
    expect(entries.find((e: any) => e.id === "old").delivery.text).toBe("answered");
    const needs = body.needs.filter((n: any) => n.kind === "inbox");
    expect(needs.map((n: any) => n.title).sort()).toEqual(["alpha (w1:p1) finished", "beta (w1:p2) wrote to you"]);
  });
  test("a chat subscribed to agent events makes an unheld agent's entry deliverable, in words, not as delivered", async () => {
    const t = setup({ inbox, wants: true });
    const body: any = await (await t.req("/api/state")).json();
    const d = body.machines.mac.inbox.entries.find((e: any) => e.id === "f1").delivery;
    expect(d.route).toBe("events");
    expect(d.text).not.toMatch(/delivered:|arrived/i);
  });
  test("it needs no chat card and no Events subscription: the entry is there with neither", async () => {
    const t = setup({ inbox, wants: false });
    const body: any = await (await t.req("/api/state")).json();
    expect(body.machines.mac.inbox.unanswered).toBe(2);
  });
  test("dismissing passes the id and the agent, as the console", async () => {
    const t = setup();
    const res: any = await (await t.act({ action: "dismiss", machine: "mac", target: "w1:p1", id: "derived:w1:p1:x" })).json();
    expect(res.ok).toBe(true);
    expect(t.calls.find((c) => c[1] === "inbox_resolve")![2]).toEqual({ id: "derived:w1:p1:x", target: "w1:p1", origin: "console" });
    await t.act({ action: "dismiss", machine: "mac", target: "w1:p2" });
    expect(t.calls.filter((c) => c[1] === "inbox_resolve").at(-1)![2]).toEqual({ target: "w1:p2", origin: "console" });
  });
  test("deliveryOf never says an unanswered entry arrived", () => {
    for (const e of [{ status: "unanswered", thread: "t" }, { status: "unanswered", thread: null }]) for (const ev of [true, false]) expect(deliveryOf(e, ev).text).not.toMatch(/^(delivered|sent|arrived)/i);
  });
});

describe("console polling pace", () => {
  test("backs off by doubling to a ceiling, and a change starts it over", () => {
    expect([0, 1, 2, 3, 4, 5, 20].map((n) => pollDelay(n))).toEqual([4000, 8000, 16000, 32000, 60000, 60000, 60000]);
    expect(pollDelay(0, 100, 1000)).toBe(100);
    expect(pollDelay(3, 100, 1000)).toBe(800);
  });
  test("with a page open and nothing changing it looks less and less often; with no page open it does not look at all", async () => {
    const quiet = setup({ pollBaseMs: 5, pollMaxMs: 40 });
    quiet.con.start();
    await Bun.sleep(120);
    expect(quiet.calls.length).toBe(0);
    quiet.con.stop();

    const t = setup({ pollBaseMs: 5, pollMaxMs: 40 });
    const off = t.bus.subscribe(() => {});
    t.con.start();
    await Bun.sleep(400);
    // A fixed 5 ms pace would be about 80 looks; doubling to 40 ms is about a dozen.
    expect(t.calls.length).toBeGreaterThan(3);
    expect(t.calls.length).toBeLessThan(25);
    const before = t.calls.length;
    t.con.soon();
    await Bun.sleep(150);
    expect(t.calls.length).toBeGreaterThan(before);
    t.con.stop();
    off();
  });
});

describe("console wiring", () => {
  test("the report sink hands each fresh report to the console once, and the bus keeps the notifier polling", async () => {
    const seen: string[] = [];
    const sink = createReportSink(undefined, () => {}, (m, r) => seen.push(`${m}:${r.map((x) => x.event_id).join(",")}`));
    const r: any = { event_id: "e1", pane_id: "p", type: "finished", agent: "a", excerpt: "x", message: "m" };
    await sink("mac", [r]);
    await sink("mac", [r, { ...r, event_id: "e2" }]);
    expect(seen).toEqual(["mac:e1", "mac:e2"]);
    const bus = new ConsoleBus();
    const wanted = () => bus.hasClients();
    expect(wanted()).toBe(false);
    let connected = 0;
    bus.onConnect = () => connected++;
    const off = bus.subscribe(() => {});
    expect(wanted()).toBe(true);
    expect(connected).toBe(1);
    off();
    expect(wanted()).toBe(false);
  });
});

describe("console state", () => {
  test("merges overview, supervisor, coordination, leases and claims, and ranks what needs the owner", async () => {
    const t = setup();
    const body: any = await (await t.req("/api/state")).json();
    const mac = body.machines.mac;
    expect(mac.ok).toBe(true);
    expect(mac.agents.find((a: any) => a.name === "beta").control).toEqual({ by: "thread", label: "Run watcher" });
    expect(mac.agents.find((a: any) => a.name === "alpha").control.by).toBe("none");
    expect(mac.claims[0].path).toBe("migrations/meta/_journal.json");
    expect(body.needs.map((n: any) => n.kind)).toEqual(["menu", "human", "stalled", "result"]);
    expect(body.needs[0].menu.options.map((o: any) => o.n)).toEqual([1, 2]);
    // An agent is named with its pane id, so two unnamed agents in one repo cannot be mixed up.
    expect(body.needs[0].title).toBe("alpha (w1:p1) shows a menu");
  });
  test("the feed carries other controllers' touches, flags a collision, and skips reads", async () => {
    const t = setup();
    const body: any = await (await t.req("/api/state")).json();
    // The audit read asks only for ops worth a line, so reads cannot fill its window.
    const asked = t.calls.find((c) => c[1] === "console_snapshot")![2];
    expect(asked.audit_ops).toContain("steer_agent");
    expect(asked.audit_ops).not.toContain("overview");
    const kinds = body.events.map((e: any) => e.kind);
    expect(kinds).toContain("prompt_agent");
    expect(kinds).not.toContain("overview");
    const refused = body.events.find((e: any) => e.kind === "steer_agent");
    expect(refused.flag).toBe(true);
    expect(refused.source).toBe("chatgpt");
    expect(refused.text).toContain("not_your_agent");
    // The same audit lines on the next refresh are not published twice.
    const again: any = await (await t.req("/api/state?fresh=1")).json();
    expect(again.events.filter((e: any) => e.kind === "steer_agent").length).toBe(1);
  });
  test("an offline machine is a need, not a crash", async () => {
    const t = setup({ calls: (op) => (op === "console_snapshot" ? { ok: false, error: { code: "machine_offline", message: "mac did not answer" } } : undefined) });
    const body: any = await (await t.req("/api/state")).json();
    expect(body.machines.mac.ok).toBe(false);
    expect(body.needs[0]).toMatchObject({ kind: "machine", machine: "mac" });
  });
});

describe("console actions", () => {
  test("steering goes in as the console with no lease, so a thread that holds the agent keeps it", async () => {
    const t = setup();
    const steer: any = await (await t.act({ action: "steer", machine: "mac", target: "w1:p2", text: "use the cache" })).json();
    expect(steer.ok).toBe(true);
    const prompt: any = await (await t.act({ action: "prompt", machine: "mac", target: "w1:p1", text: "hello" })).json();
    expect(prompt.ok).toBe(true);
    expect(t.calls.map((c) => [c[1], c[2]])).toEqual([
      ["steer_agent", { target: "w1:p2", text: "use the cache", origin: "console" }],
      ["prompt_agent", { target: "w1:p1", text: "hello", origin: "console" }],
    ]);
    // Nothing is claimed, released or taken over.
    expect(t.calls.some((c) => ["claim_agents", "release_agents"].includes(c[1]))).toBe(false);
    expect(t.calls.every((c) => c[2].lease === undefined)).toBe(true);
  });
  test("there is no claim, release or takeover action", async () => {
    const t = setup();
    for (const action of ["claim", "release"]) expect((await t.act({ action, machine: "mac", target: "w1:p1" })).status).toBe(400);
    expect(t.calls.length).toBe(0);
  });
  test("an answer is bound to the menu shown and a gated one is held for a second click", async () => {
    const t = setup({ calls: (op, p) => (op === "answer_agent" && p.confirm !== true ? { ok: false, error: { code: "needs_confirmation", message: "this menu asks to run a git push, which is the owner's call: x", details: { dialog_id: DIALOG, menu: "git push?" } } } : undefined) });
    expect((await t.act({ action: "answer", machine: "mac", target: "w1:p1", option: 1 })).status).toBe(400);
    const held: any = await (await t.act({ action: "answer", machine: "mac", target: "w1:p1", option: 1, dialog_id: DIALOG })).json();
    expect(held.ok).toBe(false);
    expect(held.error.code).toBe("needs_confirmation");
    const listed = t.pending.list();
    expect(listed.length).toBe(1);
    const state: any = await (await t.req("/api/state?fresh=1")).json();
    expect(state.needs.some((n: any) => n.kind === "approve" && n.pending === listed[0]!.pending)).toBe(true);
    const done: any = await (await t.act({ action: "confirm", machine: "mac", pending: listed[0]!.pending, approve: true })).json();
    expect(done.ok).toBe(true);
    const last = t.calls.filter((c) => c[1] === "answer_agent").at(-1)!;
    expect(last[2]).toMatchObject({ confirm: true, expected_dialog_id: DIALOG, target: "w1:p1", origin: "console" });
    expect(last[2].lease).toBeUndefined();
    expect(t.pending.list().length).toBe(0);
    // Single use: a second click finds nothing.
    expect((await t.act({ action: "confirm", machine: "mac", pending: listed[0]!.pending, approve: true })).status).toBe(404);
  });
  test("declining runs nothing", async () => {
    const t = setup();
    const id = t.pending.hold("mac", "exec", { command: "git push" }, "runs git push");
    const res: any = await (await t.act({ action: "confirm", machine: "mac", pending: id, approve: false })).json();
    expect(res.result.declined).toBe(true);
    expect(t.calls.some((c) => c[1] === "exec")).toBe(false);
  });
  test("a note says what can deliver it and never that it arrived", async () => {
    const quiet = setup();
    const a: any = await (await quiet.act({ action: "note", machine: "mac", target: "w1:p2", text: "ship it" })).json();
    expect(a.ok).toBe(true);
    expect(quiet.calls.find((c) => c[1] === "owner_note")![2]).toEqual({ pane_id: "w1:p2", text: "ship it" });
    expect(a.result.events_subscribed).toBe(false);
    expect(a.result.delivery).toContain("link card is open");
    expect(a.result.delivery).not.toMatch(/delivered|arrived|sent/i);
    const events = setup({ wants: true });
    const b: any = await (await events.act({ action: "note", machine: "mac", target: "w1:p2", text: "ship it" })).json();
    expect(b.result.delivery).toContain("subscribed to agent.message");
  });
  test("focus brings the pane forward without a lease or any steering", async () => {
    const t = setup();
    const res: any = await (await t.act({ action: "focus", machine: "mac", target: "w1:p1" })).json();
    expect(res.ok).toBe(true);
    expect(t.calls).toEqual([["mac", "focus", { kind: "agent", id: "w1:p1" }]]);
    expect(t.bus.recent().find((e) => e.kind === "focus")!.flag).toBe(false);
  });
  test("rejects a bad target, an empty message and an unknown machine", async () => {
    const t = setup();
    expect((await t.act({ action: "steer", machine: "mac", target: "x; rm", text: "a" })).status).toBe(400);
    expect((await t.act({ action: "steer", machine: "mac", target: "w1:p1", text: "  " })).status).toBe(400);
    expect((await t.act({ action: "steer", machine: "nope", target: "w1:p1", text: "a" })).status).toBe(400);
    expect(t.calls.length).toBe(0);
  });
  test("its own actions reach the feed at once, flagged when refused", async () => {
    const t = setup({ calls: (op) => (op === "steer_agent" ? { ok: false, error: { code: "agent_blocked", message: "menu up" } } : undefined) });
    await t.act({ action: "steer", machine: "mac", target: "w1:p2", text: "x" });
    const ev = t.bus.recent().find((e) => e.kind === "steer")!;
    expect(ev.source).toBe("console");
    expect(ev.flag).toBe(true);
    expect(ev.text).toContain("agent_blocked");
  });
});

describe("console stream", () => {
  test("pushes a gateway report to a connected page", async () => {
    const t = setup();
    const res = await t.req("/api/events");
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    expect(dec.decode((await reader.read()).value)).toContain("retry:");
    t.bus.publishReports("mac", [{ event_id: "e1", occurred_at: "2026-10-06T12:00:00Z", pane_id: "w1:p2", type: "finished", agent: "beta", kind: "codex", cwd: null, excerpt: "done", lease: null, reply_to: null, message: "m" }]);
    const chunk = dec.decode((await reader.read()).value);
    expect(chunk).toContain("event: feed");
    expect(chunk).toContain('"agent":"beta"');
    await reader.cancel();
    expect(t.bus.hasClients()).toBe(false);
  });
  test("a repeated report is one event", () => {
    const bus = new ConsoleBus();
    const r: any = { event_id: "e1", pane_id: "w1:p1", type: "finished", agent: "a", excerpt: "x", message: "m" };
    bus.publishReports("mac", [r, r]);
    bus.publishReports("mac", [r]);
    expect(bus.recent().length).toBe(1);
  });
  test("an owner note shows as the console's, an agent's tell as the agent's", () => {
    const bus = new ConsoleBus();
    bus.publishReports("mac", [{ event_id: "n1", pane_id: "w1:p1", type: "message", agent: "a", excerpt: "do x", message: "m", origin: "owner" } as any, { event_id: "n2", pane_id: "w1:p1", type: "message", agent: "a", excerpt: "help", message: "m" } as any]);
    expect(bus.recent().map((e) => e.source)).toEqual(["console", "agent"]);
  });
});

describe("console model", () => {
  test("controlOf says which thread holds a pane, or nobody", () => {
    const leases = [{ label: "Run watcher", panes: ["b"] }];
    expect(controlOf("b", leases)).toEqual({ by: "thread", label: "Run watcher" });
    expect(controlOf("c", leases).by).toBe("none");
  });
  test("a takeover by a thread is flagged and the console's own calls are not shown twice", () => {
    const took = auditToEvent("mac", { ts: "t", op: "claim_agents", ok: true, args: { lease: "…abcd", take_over: true, target: "w1:p1" } });
    expect(took).toMatchObject({ flag: true, source: "chatgpt" });
    expect(took!.text).toContain("took over");
    expect(auditToEvent("mac", { ts: "t", op: "steer_agent", ok: true, args: { origin: "console", target: "w1:p1" } })).toBeNull();
    expect(auditToEvent("mac", { ts: "t", op: "read_agent", ok: true, args: {} })).toBeNull();
  });
  test("a stalled agent that is not watched yields no need and a clean machine yields none", () => {
    const needs = buildNeeds({ mac: { ok: true, agents: [{ pane_id: "p", name: "a", status: "idle" }], counts: {}, objectives: [], claims: [], leases: [], inbox: { entries: [], pending: [], unanswered: 0 } } }, {}, []);
    expect(needs).toEqual([]);
  });
});
