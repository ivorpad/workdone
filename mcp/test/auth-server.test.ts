import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import type { Report } from "../../gateway/watcher.ts";
import { AuthService, principalId } from "../src/auth.ts";
import { parseConfig } from "../src/config.ts";
import type { EventsService } from "../src/events.ts";
import type { CallGateway } from "../src/gateway-client.ts";
import { createEndpoints, createEventService, createHandler } from "../src/server.ts";

const issuer = "https://issuer.example";
const resource = "https://workdone.example/mcp";
const callback = "https://callbacks.openai.com/workdone-thread";
const secret = `whsec_${Buffer.alloc(32, 17).toString("base64")}`;
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let directory: string;
let grantsPath: string;
let bearer: string;
let service: EventsService;
let handler: ReturnType<typeof createHandler>;
let calls: string[];
let deliveries: any[];
let authorizationFailure: string | null;
let pendingMachines: string[];
let now: number;
let endpoints: ReturnType<typeof createEndpoints>;
let authorizationHook: (() => Promise<void>) | null;

beforeAll(async () => { keys = await generateKeyPair("RS256", { extractable: true }); });

async function token(subject = "owner") {
  return new SignJWT({ iss: issuer, aud: resource, sub: subject, scope: "workdone", exp: Math.floor(Date.now() / 1000) + 3600 }).setProtectedHeader({ alg: "RS256", kid: "test" }).sign(keys.privateKey);
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "workdone-auth-server-"));
  now = Date.now();
  grantsPath = join(directory, "grants.json");
  const jwksPath = join(directory, "jwks.json");
  await Bun.write(jwksPath, JSON.stringify({ keys: [{ ...await exportJWK(keys.publicKey), kid: "test", alg: "RS256" }] }));
  await Bun.write(grantsPath, JSON.stringify({ subjects: { owner: { scopes: ["workdone"], machines: ["mac"] }, other: { scopes: ["workdone"], machines: ["ovh"] } } }));
  const target = { user: "u", host: "host.example", identityFile: "/k", knownHostsFile: "/kh" };
  const cfg = parseConfig({ machines: { mac: target, ovh: target }, defaultMachine: "ovh", auth: { issuer, resource, jwksPath, grantsPath }, events: { statePath: join(directory, "events.sqlite"), callbackHosts: ["callbacks.openai.com"] } });
  calls = []; deliveries = []; pendingMachines = []; authorizationFailure = null; authorizationHook = null;
  const call: CallGateway = async (machine, op, args) => {
    calls.push(`${machine}:${op}`);
    if (op === "get_agent" && authorizationFailure) return { ok: false, error: { code: authorizationFailure, message: "not accessible" } };
    if (op === "get_agent") await authorizationHook?.();
    return { ok: true, result: { machine, pane_id: args.target ?? "w1:p1", name: "worker" } };
  };
  const auth = new AuthService(cfg.auth!, ["mac", "ovh"], () => now);
  service = createEventService(cfg, call, auth, {
    sender: async (_url, _headers, body) => {
      const event = JSON.parse(body);
      deliveries.push(event);
      return { status: 200, body: JSON.stringify(event.type === "verification" ? { challenge: event.challenge } : {}) };
    }, log: () => {}, now: () => now,
  })!;
  handler = createHandler(cfg, call, (machine) => pendingMachines.push(machine), { auth, events: service });
  endpoints = createEndpoints({ ...cfg, auth: { ...cfg.auth!, listenPort: 8788 } }, call, undefined, { auth, events: service });
  bearer = await token();
});
afterEach(async () => { await service.close(); await rm(directory, { recursive: true, force: true }); });

function rpc(method: string, params: Record<string, unknown> = {}, value: string | null = bearer, modern = true) {
  const headers: Record<string, string> = { host: "127.0.0.1:8787", "content-type": "application/json", accept: "application/json, text/event-stream" };
  if (value !== null) headers.authorization = `Bearer ${value}`;
  if (modern) {
    headers["mcp-protocol-version"] = "2026-07-28";
    headers["mcp-method"] = method;
    if (method === "tools/call") headers["mcp-name"] = String(params.name);
  }
  return handler(new Request("http://127.0.0.1:8787/mcp", { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { ...params, ...(modern ? { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientInfo": { name: "test", version: "1" }, "io.modelcontextprotocol/clientCapabilities": {} } } : {}) } }) }));
}

function identity(name = "agent.finished", args: Record<string, unknown> = { machine: "mac", target: "w1:p1" }) {
  return { name, arguments: args, delivery: { mode: "webhook", url: callback, secret } };
}

function report(): Report {
  return { event_id: "finished-once", occurred_at: new Date().toISOString(), type: "finished", pane_id: "w1:p1", agent: "worker", cwd: "/allowed", excerpt: "Finished", kind: "codex", lease: null, reply_to: null, message: "worker finished" };
}

describe("authenticated MCP endpoint", () => {
  test("discovery metadata is public but every MCP method needs validated OAuth", async () => {
    for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
      const response = await handler(new Request(`http://127.0.0.1:8787${path}`, { headers: { host: "127.0.0.1:8787" } }));
      expect(await response.json()).toEqual({ resource, authorization_servers: [issuer], scopes_supported: ["workdone"] });
    }
    for (const method of ["server/discover", "tools/list", "events/list", "events/subscribe", "events/unsubscribe"]) {
      const response = await rpc(method, {}, null);
      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toContain("oauth-protected-resource");
    }
    expect(calls).toHaveLength(0);
  });

  test("every tool, including the fallback cards and profile, advertises OAuth scopes", async () => {
    const response = await rpc("tools/list");
    const tools = (await response.json() as any).result.tools;
    expect(tools.some((tool: any) => tool.name === "watch_here")).toBe(true);
    expect(tools.some((tool: any) => tool.name === "get_profile" && tool._meta["openai/profile"] === true)).toBe(true);
    for (const tool of tools) {
      expect(tool.securitySchemes).toEqual([{ type: "oauth2", scopes: ["workdone"] }]);
      expect(tool._meta.securitySchemes).toEqual(tool.securitySchemes);
    }
  });

  test("concurrent requests retain distinct principal identities and machine permissions", async () => {
    const other = await token("other");
    const responses = await Promise.all([rpc("tools/call", { name: "get_profile", arguments: {} }), rpc("tools/call", { name: "get_profile", arguments: {} }, other)]);
    const profiles = await Promise.all(responses.map(async (response) => (await response.json() as any).result.structuredContent.id));
    expect(profiles).toEqual([principalId(issuer, "owner"), principalId(issuer, "other")]);
    const denied = await rpc("tools/call", { name: "exec", arguments: { machine: "ovh", command: "id" } });
    expect((await denied.json() as any).result.isError).toBe(true);
    expect(calls).toHaveLength(0);
    await rpc("tools/call", { name: "exec", arguments: { command: "id" } });
    expect(calls).toEqual(["mac:exec"]);
  });

  test("MCP 2.0 lists native Events while legacy tool clients keep only the fallback", async () => {
    const modern = await rpc("server/discover");
    expect((await modern.json() as any).result.capabilities.events).toEqual({});
    const legacy = await rpc("initialize", { protocolVersion: "2025-11-25", clientInfo: { name: "test", version: "1" }, capabilities: {} }, bearer, false);
    expect((await legacy.json() as any).result.capabilities.events).toBeUndefined();
    const listed = await rpc("events/list");
    expect((await listed.json() as any).result.events.map((event: any) => event.name)).toEqual(["agent.finished", "agent.asks", "agent.message"]);
  });

  test("same endpoint verifies and stores a subscription, then dispatches a scoped report", async () => {
    const subscribed = await rpc("events/subscribe", identity());
    const result = (await subscribed.json() as any).result;
    expect(result.id).toMatch(/^sub_/);
    expect(pendingMachines).toEqual(["mac"]);
    expect(deliveries[0].type).toBe("verification");
    expect(await service.addReports("mac", [report()])).toBe(1);
    await service.flush();
    expect(deliveries[1].name).toBe("agent.finished");
    expect(deliveries[1].data.pane_id).toBe("w1:p1");
    const stopped = await rpc("events/unsubscribe", identity());
    const { _meta, resultType, ...applicationResult } = (await stopped.json() as any).result;
    expect(applicationResult).toEqual({});
  });

  test("revoked grants prevent queued delivery and cannot be bypassed by a retained bearer", async () => {
    await rpc("events/subscribe", identity());
    await service.addReports("mac", [report()]);
    await Bun.write(grantsPath, JSON.stringify({ subjects: {} }));
    await service.flush();
    expect(deliveries).toHaveLength(1);
    expect((await rpc("tools/list")).status).toBe(401);
  });

  test("gateway scope revocation blocks delivery while temporary failure preserves the queue", async () => {
    await rpc("events/subscribe", identity("agent.finished", { machine: "mac" }));
    await service.addReports("mac", [report()]);
    authorizationFailure = "machine_offline";
    await service.flush();
    expect(deliveries).toHaveLength(1);
    authorizationFailure = null;
    now += 15_001;
    await service.flush();
    expect(deliveries).toHaveLength(2);
    await service.addReports("mac", [{ ...report(), event_id: "second-occurrence" }]);
    authorizationFailure = "agent_not_found";
    await service.flush();
    expect(deliveries).toHaveLength(2);
  });

  test("staged authenticated listener leaves the original no-auth fallback available in one process", async () => {
    expect(endpoints.map((endpoint) => [endpoint.port, endpoint.authenticated])).toEqual([[8787, false], [8788, true]]);
    for (const endpoint of endpoints) {
      const response = await endpoint.handler(new Request(`http://127.0.0.1:${endpoint.port}/mcp`, { method: "POST", headers: { host: `127.0.0.1:${endpoint.port}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) }));
      expect(response.status).toBe(endpoint.authenticated ? 401 : 200);
      if (!endpoint.authenticated) {
        const tools = (await response.json() as any).result.tools;
        expect(tools.some((tool: any) => tool.name === "watch_here")).toBe(true);
        expect(tools.some((tool: any) => tool.name === "get_profile")).toBe(false);
      }
    }
  });

  test("revocation during a gateway authorization round trip prevents the pending send", async () => {
    await rpc("events/subscribe", identity("agent.finished", { machine: "mac" }));
    await service.addReports("mac", [report()]);
    authorizationHook = async () => { await Bun.write(grantsPath, JSON.stringify({ subjects: {} })); };
    await service.flush();
    expect(deliveries).toHaveLength(1);
  });
});
