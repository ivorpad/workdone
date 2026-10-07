import { describe, expect, test } from "bun:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { parseConfig, sshArgs } from "../src/config.ts";
import type { CallGateway } from "../src/gateway-client.ts";
import { createEventService, createHandler, logRpc } from "../src/server.ts";
import { TOOLS } from "../src/tools.ts";

// Registered next to TOOLS by registerConfirm, registerImage and registerWatch.
const CONFIRM_TOOLS = ["request_confirmation", "confirm_pending", "wake_test", "wake_test_log", "watch_here", "watch_next", "watch_stop", "show_image", "screenshot"];

const target = { user: "ivor", host: "mac.example.ts.net", identityFile: "/k", knownHostsFile: "/kh" };
const cfg = parseConfig({
  listen: { host: "127.0.0.1", port: 8787 },
  machines: { mac: target, ovh: { ...target, user: "debian", host: "127.0.0.1", identityFile: "/k2" } },
});

const calls: Array<[string, string, Record<string, unknown>]> = [];
const fake: CallGateway = async (machine, op, params) => {
  calls.push([machine, op, params]);
  if (op === "run_command_in_pane") return { ok: false, error: { code: "capability_disabled", message: "off" } };
  if (op === "list_panes" && machine === "ovh") return { ok: false, error: { code: "gateway_unreachable", message: "down" } };
  if (op === "read_file") return { ok: true, result: { path: "/x.png", kind: "image", image: { mime: "image/png", data: "iVBORw==" } } };
  return { ok: true, result: { op, machine } };
};
const prompted: string[] = [];
const handler = createHandler(cfg, fake, (m) => prompted.push(m));

function rpc(body: unknown, host = "127.0.0.1:8787") {
  return handler(
    new Request(`http://${host}/mcp`, {
      method: "POST",
      headers: { host, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify(body),
    }),
  );
}

async function callTool(name: string, args: Record<string, unknown>) {
  const res = await rpc({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name, arguments: args } });
  return ((await res.json()) as any).result;
}

describe("owner override", () => {
  test("a ChatGPT tool call cannot say it is the console: origin is dropped before the gateway", async () => {
    calls.length = 0;
    await callTool("steer_agent", { target: "w1:p1", text: "x", origin: "console" });
    const forwarded = calls.find((c) => c[1] === "steer_agent");
    expect(forwarded).toBeDefined();
    expect("origin" in forwarded![2]).toBe(false);
  });
});

describe("config", () => {
  test("refuses a non-loopback listener", () => {
    expect(() => parseConfig({ listen: { host: "0.0.0.0" }, ssh: {} })).toThrow(/loopback/);
  });
  test("ssh args pin host keys and disable forwarding", () => {
    const args = sshArgs(cfg.machines.mac!).join(" ");
    expect(args).toContain("-F /dev/null");
    expect(args).toContain("StrictHostKeyChecking=yes");
    expect(args).toContain("ForwardAgent=no");
    expect(args).toContain("ClearAllForwardings=yes");
    expect(args).not.toContain("StrictHostKeyChecking=no");
  });
  test("rejects option-shaped ssh host", () => {
    expect(() => parseConfig({ ssh: { user: "u", host: "-oProxyCommand=x", identityFile: "/k", knownHostsFile: "/kh" } })).toThrow();
  });
  test("the old single ssh block becomes machine mac", () => {
    const old = parseConfig({ ssh: target });
    expect(Object.keys(old.machines)).toEqual(["mac"]);
    expect(old.defaultMachine).toBe("mac");
  });
  test("rejects odd machine names and an unknown default", () => {
    expect(() => parseConfig({ machines: { "Bad Name": target } })).toThrow(/machine name/);
    expect(() => parseConfig({ machines: { mac: target }, defaultMachine: "ovh" })).toThrow(/defaultMachine/);
  });
});

describe("http", () => {
  test("healthz", async () => {
    const res = await handler(new Request("http://127.0.0.1:8787/healthz"));
    expect(res.status).toBe(200);
  });
  test("oauth metadata probe gets 404", async () => {
    const res = await handler(new Request("http://127.0.0.1:8787/.well-known/oauth-protected-resource"));
    expect(res.status).toBe(404);
  });
  test("no-auth fallback does not offer native subscriptions", async () => {
    const listed = await rpc({ jsonrpc: "2.0", id: 1, method: "events/list", params: {} });
    expect((await listed.json() as any).result.events).toEqual([]);
    const subscribed = await rpc({ jsonrpc: "2.0", id: 2, method: "events/subscribe", params: { name: "agent.finished", arguments: { machine: "mac" }, delivery: { mode: "webhook", url: "https://callbacks.openai.com/thread", secret: `whsec_${Buffer.alloc(32).toString("base64")}` } } });
    expect((await subscribed.json() as any).error.code).toBe(-32001);
  });
  test("lists every tool, each with a free-form machine parameter", async () => {
    const res = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    const body = (await res.json()) as any;
    expect(body.result.tools.map((t: any) => t.name).sort()).toEqual([...Object.keys(TOOLS), ...CONFIRM_TOOLS].sort());
    for (const t of body.result.tools.filter((t: any) => !CONFIRM_TOOLS.includes(t.name))) {
      expect(t.inputSchema.properties.machine.type).toBe("string");
      expect(t.inputSchema.properties.machine.enum).toBeUndefined();
    }
  });
  test("an unknown machine is refused with the list of machines", async () => {
    const before = calls.length;
    const result = await callTool("exec", { machine: "nas", command: "id" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("machines: mac, ovh");
    expect(calls.length).toBe(before);
  });
  test("forwards a call to the default machine and surfaces gateway errors", async () => {
    const result = await callTool("run_command_in_pane", { pane_id: "w1:p1", command: "id" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("capability_disabled");
    expect(calls.at(-1)).toEqual(["mac", "run_command_in_pane", { pane_id: "w1:p1", command: "id" }]);
  });
  test("an explicit machine is used and stripped from the params", async () => {
    await callTool("exec", { machine: "ovh", command: "uname" });
    expect(calls.at(-1)).toEqual(["ovh", "exec", { command: "uname" }]);
  });
  test("listing without a machine asks every machine", async () => {
    const result = await callTool("list_panes", {});
    const payload = JSON.parse(result.content[0].text);
    expect(payload.mac).toEqual({ op: "list_panes", machine: "mac" });
    expect(payload.ovh.error.code).toBe("gateway_unreachable");
    expect(result.isError).toBe(false);
  });
  test("an image result becomes MCP image content", async () => {
    const result = await callTool("read_file", { path: "/x.png" });
    expect(result.content[1]).toEqual({ type: "image", data: "iVBORw==", mimeType: "image/png" });
    expect(result.content[0].text).not.toContain("iVBORw==");
  });
  test("tools that can watch an agent mark its machine for the notifier", async () => {
    await callTool("prompt_agent", { machine: "ovh", target: "w1:p1", text: "go" });
    await callTool("list_panes", {});
    await callTool("watch_agent", { target: "w3T:pKV" });
    await callTool("start_agent", { machine: "ovh", pane_id: "w1:p2", kind: "cursor", name: "stays" });
    await callTool("spawn_agent", { kind: "cursor", name: "worker", repo: "relay" });
    await callTool("set_agent_approval", { machine: "ovh", target: "w1:p1", lease: "L-abc123", mode: "ask", ttl_seconds: 300 });
    expect(prompted).toEqual(["ovh", "mac", "ovh", "mac", "ovh"]);
    expect(calls.at(-1)).toEqual(["ovh", "set_agent_approval", { target: "w1:p1", lease: "L-abc123", mode: "ask", ttl_seconds: 300 }]);
  });
  test("rejects a foreign Host header", async () => {
    const res = await rpc({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} }, "evil.example:8787");
    expect(res.status).toBe(403);
  });
});

describe("2026-07-28", () => {
  // The SDK's own client, pinned to the modern revision: it answers server/discover and
  // sends the per-request _meta envelope, as the tunnel client tries first.
  async function modernClient() {
    const client = new Client({ name: "test", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
    const transport = new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8787/mcp"), {
      // A real socket adds Host; an in-process Request does not.
      fetch: (input, init) => {
        const req = new Request(String(input), init);
        req.headers.set("host", "127.0.0.1:8787");
        return handler(req);
      },
    });
    await client.connect(transport);
    return client;
  }
  test("server/discover negotiates the modern era", async () => {
    const client = await modernClient();
    expect(client.getProtocolEra()).toBe("modern");
    expect(client.getNegotiatedProtocolVersion()).toBe("2026-07-28");
    expect(client.getServerVersion()?.name).toBe("herdr-remote");
    expect(client.getInstructions()).toContain("claim_agents");
    // Without it a chat that is offered no subscribe action looks for a WorkDone tool.
    expect(client.getInstructions()).toMatch(/only in a Work chat.*no tool to subscribe.*never moves a subscription/);
    expect((client.getServerCapabilities() as any)?.events).toBeUndefined();
    await client.close();
  });
  test("tools list and call work the same as on 2025", async () => {
    const client = await modernClient();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...Object.keys(TOOLS), ...CONFIRM_TOOLS].sort());
    const result = (await client.callTool({ name: "exec", arguments: { machine: "ovh", command: "uptime" } })) as any;
    expect(result.isError).toBe(false);
    expect(calls.at(-1)).toEqual(["ovh", "exec", { command: "uptime" }]);
    await client.close();
  });
});

describe("rpc log", () => {
  test("records the client's hello in full and other methods by name only, in a batch too", () => {
    const lines: string[] = [];
    const push = (l: string) => lines.push(l);
    const init = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-11-25", clientInfo: { name: "openai-mcp" }, capabilities: { extensions: { "openai/elicitation": { form: {} } } } },
    };
    logRpc([init, { jsonrpc: "2.0", method: "notifications/initialized" }], null, push);
    logRpc({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "exec", arguments: { command: "secret" } } }, "2025-11-25", push);
    const envelope = { "io.modelcontextprotocol/clientCapabilities": { extensions: { "openai/elicitation": { form: {} } } } };
    logRpc({ jsonrpc: "2.0", id: 3, method: "server/discover", params: { _meta: envelope } }, "2026-07-28", push);
    logRpc(undefined, null, push);
    expect(lines.map((l) => JSON.parse(l))).toEqual([
      { event: "client_hello", method: "initialize", protocolHeader: null, protocolVersion: "2025-11-25", clientInfo: { name: "openai-mcp" }, capabilities: init.params.capabilities },
      { event: "rpc", method: "notifications/initialized", protocolHeader: null },
      { event: "rpc", method: "tools/call", name: "exec", protocolHeader: "2025-11-25" },
      { event: "client_hello", method: "server/discover", protocolHeader: "2026-07-28", meta: envelope },
    ]);
    expect(lines.join("\n")).not.toContain("secret");
  });
});

describe("agent event authorization", () => {
  // agent: what get_agent answers for the report's pane right now.
  function setup(agent: "live" | "gone" | "down" | "other", allowed = true) {
    const requests: Array<[string, string, Record<string, unknown>]> = [];
    const logs: string[] = [];
    let delivered = 0;
    const call: CallGateway = async (machine, op, params) => {
      requests.push([machine, op, params]);
      if (agent === "live") return { ok: true, result: { pane_id: params.target } };
      if (agent === "gone") return { ok: false, error: { code: "agent_not_found", message: "agent not found" } };
      if (agent === "down") return { ok: false, error: { code: "herdr_unavailable", message: "down" } };
      return { ok: false, error: { code: "invalid_params", message: "bad" } };
    };
    const auth = { allowedMachines: async () => allowed ? ["test"] : [], isAuthorized: async () => allowed } as any;
    const config = { ...cfg, events: { statePath: ":memory:", callbackHosts: ["callbacks.example.com"] } };
    const service = createEventService(config, call, auth, { now: () => 1000, log: (l) => logs.push(l), sender: async (_url, _headers, body) => { const event = JSON.parse(body); if (event.type !== "verification") delivered++; return { status: 200, body: JSON.stringify({ challenge: event.challenge }) }; } })!;
    const identity = { id: "owner", issuer: "https://issuer.example.test", subject: "owner", scopes: ["workdone"], tokenExpiresAt: 1000000 };
    const subscribe = (args: Record<string, string>) => service.subscribe(identity, { name: "agent.finished", arguments: args, delivery: { mode: "webhook", url: "https://callbacks.example.com/mock", secret: `whsec_${Buffer.alloc(32, 4).toString("base64")}` } });
    const report = (id: string, type: "finished" | "gone" = "finished") => ({ event_id: id, pane_id: "w1:p1", type, agent: "worker", kind: "claude", cwd: "/src/app", excerpt: "done", lease: null, reply_to: null, message: "worker finished",
      ...(type === "gone" ? { result: { result_id: "res_0123456789abcdef", requested_at: "2026-10-07T00:00:00.000Z", status: "gone" as const, summary: null, commit: null, tree: null, clean: null, changed: null, branch: null, kind: "claude", model: null, model_id: null, effort: null } } : {}) });
    return { service, requests, logs, subscribe, report, delivered: () => delivered };
  }

  test("a target that no longer exists still subscribes and renews: the target only filters", async () => {
    const f = setup("gone");
    try {
      await f.subscribe({ machine: "test", target: "respawned-worker" });
      await f.subscribe({ machine: "test", target: "respawned-worker" });
      expect(f.requests.filter(([, op]) => op === "get_agent")).toEqual([]);
    } finally { await f.service.close(); }
  });

  test("a machine the account has no grant for still refuses, target or not", async () => {
    const f = setup("live");
    try {
      await expect(f.subscribe({ machine: "elsewhere", target: "worker" })).rejects.toThrow(/authorized/);
    } finally { await f.service.close(); }
  });

  test("an exit result goes out on the machine grant; any other report about a missing agent is refused and logged", async () => {
    const f = setup("gone");
    try {
      await f.subscribe({ machine: "test" });
      await f.service.addReports("test", [f.report("fin1"), f.report("gone1", "gone")]);
      await f.service.flush();
      // agent_not_found can also mean the roots were narrowed: only the exit result passes.
      expect(f.delivered()).toBe(1);
      const denied = f.logs.map((l) => JSON.parse(l)).filter((l) => l.event === "events_authorization_denied");
      expect(denied).toHaveLength(1);
    } finally { await f.service.close(); }
  });

  test("a live agent is still checked, an unexpected refusal is logged, and an outage waits", async () => {
    const live = setup("live");
    try {
      await live.subscribe({ machine: "test" });
      await live.service.addReports("test", [live.report("a")]);
      await live.service.flush();
      expect(live.delivered()).toBe(1);
      expect(live.requests.at(-1)).toEqual(["test", "get_agent", { target: "w1:p1" }]);
    } finally { await live.service.close(); }
    const other = setup("other");
    try {
      await other.subscribe({ machine: "test" });
      await other.service.addReports("test", [other.report("b")]);
      await other.service.flush();
      expect(other.delivered()).toBe(0);
      expect(other.logs.some((l) => JSON.parse(l).event === "events_authorization_denied")).toBe(true);
    } finally { await other.service.close(); }
    const down = setup("down");
    try {
      await down.subscribe({ machine: "test" });
      await down.service.addReports("test", [down.report("c")]);
      await down.service.flush();
      expect(down.delivered()).toBe(0);
      expect(down.logs.some((l) => JSON.parse(l).event === "events_authorization_delayed")).toBe(true);
    } finally { await down.service.close(); }
  });
});

describe("objective event authorization", () => {
  test("subscription and delivery recheck canonical objective read access without a pane lookup", async () => {
    const requests: Array<[string, string, Record<string, unknown>]> = [];
    let exists = true;
    let allowed = true;
    let delivered = 0;
    const call: CallGateway = async (machine, op, params) => {
      requests.push([machine, op, params]);
      return exists ? { ok: true, result: { objectives: [{ id: "beta" }] } } : { ok: false, error: { code: "unknown_objective", message: "missing" } };
    };
    const auth = { allowedMachines: async () => allowed ? ["test"] : [], isAuthorized: async () => allowed } as any;
    const config = { ...cfg, events: { statePath: ":memory:", callbackHosts: ["callbacks.example.com"] } };
    const service = createEventService(config, call, auth, { now: () => 1000, log: () => {}, sender: async (_url, _headers, body) => { const event = JSON.parse(body); if (event.type !== "verification") delivered++; return { status: 200, body: JSON.stringify({ challenge: event.challenge }) }; } })!;
    const identity = { id: "observer", issuer: "https://issuer.example.test", subject: "observer", scopes: ["workdone"], tokenExpiresAt: 1000000 };
    const subscription = { name: "coord.changed", arguments: { machine: "test", objective: "beta" }, delivery: { mode: "webhook", url: "https://callbacks.example.com/mock", secret: `whsec_${Buffer.alloc(32, 3).toString("base64")}` } };
    try {
      await service.subscribe(identity, subscription);
      expect(requests).toEqual([["test", "coord_snapshot", { objective: "beta", view: "resume" }], ["test", "coord_snapshot", { objective: "beta", view: "resume" }]]);
      const source = { event_id: "beta1", objective: "beta", transition: { task: "same", seq: 1, kind: "ready" }, pane_id: null, type: "message" as const, agent: null, kind: null, cwd: null, excerpt: null, lease: null, reply_to: null, message: "hint" };
      await service.addReports("test", [source]);
      await service.flush();
      expect(delivered).toBe(1);
      expect(requests.at(-1)![1]).toBe("coord_snapshot");
      exists = false;
      await service.addReports("test", [{ ...source, event_id: "beta2" }]);
      await service.flush();
      expect(delivered).toBe(1);
      await expect(service.subscribe(identity, subscription)).rejects.toThrow(/authorized/);
      allowed = false;
      await expect(service.subscribe(identity, subscription)).rejects.toThrow(/authorized/);
      expect(requests.every(([, op]) => op === "coord_snapshot")).toBe(true);
    } finally { await service.close(); }
  });
});
