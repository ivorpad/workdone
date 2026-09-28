import { describe, expect, test } from "bun:test";
import { parseConfig, sshArgs } from "../src/config.ts";
import type { CallGateway } from "../src/gateway-client.ts";
import { createHandler } from "../src/server.ts";
import { TOOLS } from "../src/tools.ts";

const target = { user: "ivor", host: "mac.example.ts.net", identityFile: "/k", knownHostsFile: "/kh" };
const cfg = parseConfig({
  listen: { host: "127.0.0.1", port: 8787 },
  machines: { mac: target, ovh: { ...target, user: "debian", host: "127.0.0.1", identityFile: "/k2" } },
});

const calls: Array<[string, string, Record<string, unknown>]> = [];
const fake: CallGateway = async (machine, op, params) => {
  calls.push([machine, op, params]);
  if (op === "run_command_in_pane") return { ok: false, error: { code: "capability_disabled", message: "off" } };
  if (op === "list_agents" && machine === "ovh") return { ok: false, error: { code: "gateway_unreachable", message: "down" } };
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
  test("lists every tool, each with a free-form machine parameter", async () => {
    const res = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    const body = (await res.json()) as any;
    expect(body.result.tools.map((t: any) => t.name).sort()).toEqual(Object.keys(TOOLS).sort());
    for (const t of body.result.tools) {
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
    const result = await callTool("list_agents", {});
    const payload = JSON.parse(result.content[0].text);
    expect(payload.mac).toEqual({ op: "list_agents", machine: "mac" });
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
    await callTool("list_agents", {});
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
