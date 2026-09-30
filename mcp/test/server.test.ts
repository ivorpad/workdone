import { describe, expect, test } from "bun:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { parseConfig, sshArgs } from "../src/config.ts";
import type { CallGateway } from "../src/gateway-client.ts";
import { createHandler, logRpc } from "../src/server.ts";
import { TOOLS } from "../src/tools.ts";

// Registered next to TOOLS by registerConfirm.
const CONFIRM_TOOLS = ["request_confirmation", "confirm_pending", "wake_test", "wake_test_log", "watch_here", "watch_next", "watch_stop"];

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
    expect(prompted).toEqual(["ovh", "mac", "ovh", "mac"]);
    expect(calls.at(-1)).toEqual(["mac", "spawn_agent", { kind: "cursor", name: "worker", repo: "relay" }]);
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
