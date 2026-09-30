import { describe, expect, test } from "bun:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { z } from "zod";
import { parseConfig } from "../src/config.ts";
import { CONFIRM_URI, PENDING_TTL_MS, PendingCalls } from "../src/confirm.ts";
import { describeSubscribe } from "../src/events.ts";
import type { CallGateway } from "../src/gateway-client.ts";
import { createHandler } from "../src/server.ts";

const target = { user: "ivor", host: "mac.example.ts.net", identityFile: "/k", knownHostsFile: "/kh" };
const cfg = parseConfig({ listen: { host: "127.0.0.1", port: 8787 }, machines: { mac: target, ovh: { ...target, host: "127.0.0.1" } } });

// A gateway that refuses git push without confirm, like gateway/gated.ts does.
const calls: Array<[string, string, Record<string, unknown>]> = [];
const fake: CallGateway = async (machine, op, params) => {
  calls.push([machine, op, params]);
  if (op === "exec" && String(params.command).includes("git push") && params.confirm !== true) {
    return { ok: false, error: { code: "needs_confirmation", message: "this command runs a git push, which is the owner's call: ask them, then call again with confirm: true" } };
  }
  return { ok: true, result: { exit_code: 0, stdout: "pushed", stderr: "" } };
};
const handler = createHandler(cfg, fake);

// The v2 client drops capability keys it does not know (events), so keep the raw discover result.
let discovered: any;

async function client() {
  const c = new Client({ name: "test", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
  await c.connect(
    new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8787/mcp"), {
      fetch: async (input, init) => {
        const req = new Request(String(input), init);
        req.headers.set("host", "127.0.0.1:8787");
        const isDiscover = String(init?.body ?? "").includes('"server/discover"');
        const res = await handler(req);
        if (isDiscover) discovered = await res.clone().json();
        return res;
      },
    }),
  );
  return c;
}

const text = (r: any) => JSON.parse(r.content[0].text);

async function holdPush(c: Client) {
  const r = (await c.callTool({ name: "exec", arguments: { machine: "ovh", command: "git push", cwd: "~/src/relay" } })) as any;
  return { r, pending: text(r).error.pending as string };
}

describe("confirm by click", () => {
  test("a gated call is held and returns a pending id instead of running", async () => {
    const c = await client();
    const before = calls.length;
    const { r, pending } = await holdPush(c);
    expect(r.isError).toBe(true);
    expect(text(r).error.code).toBe("needs_confirmation");
    expect(pending).toMatch(/^pc_[0-9a-f]{20}$/);
    expect(text(r).error.message).toContain("request_confirmation");
    expect(calls.length).toBe(before + 1);
    await c.close();
  });

  test("request_confirmation shows what the server holds, with the card", async () => {
    const c = await client();
    const { pending } = await holdPush(c);
    const r = (await c.callTool({ name: "request_confirmation", arguments: { pending } })) as any;
    expect(r.isError).toBe(false);
    expect(r.structuredContent).toMatchObject({ status: "pending", pending, machine: "ovh", op: "exec", reason: "runs git push", detail: "cd ~/src/relay\ngit push" });
    const { tools } = await c.listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(byName.request_confirmation!._meta).toEqual({ ui: { resourceUri: CONFIRM_URI } });
    // Only the card may run a held call: the host keeps app-only tools from the model.
    expect(byName.confirm_pending!._meta).toEqual({ ui: { visibility: ["app"] } });
    const res = await c.readResource({ uri: CONFIRM_URI });
    expect(res.contents[0]).toMatchObject({ uri: CONFIRM_URI, mimeType: "text/html;profile=mcp-app" });
    expect((res.contents[0] as any).text).toContain("confirm_pending");
    // ChatGPT's iOS app asks for an older URI; it gets the current card, not an error.
    const old = await c.readResource({ uri: "ui://workdone/confirm.html" });
    expect((old.contents[0] as any).text).toBe((res.contents[0] as any).text);
    expect(old.contents[0]!._meta).toMatchObject({ ui: { csp: { connectDomains: [] } } });
    await c.close();
  });

  test("approve runs the held call once, with confirm: true and the same params", async () => {
    const c = await client();
    const { pending } = await holdPush(c);
    const r = (await c.callTool({ name: "confirm_pending", arguments: { pending, approve: true } })) as any;
    expect(r.isError).toBe(false);
    expect(r.structuredContent).toMatchObject({ status: "ran", result: { exit_code: 0, stdout: "pushed" } });
    expect(calls.at(-1)).toEqual(["ovh", "exec", { command: "git push", cwd: "~/src/relay", confirm: true }]);
    const again = (await c.callTool({ name: "confirm_pending", arguments: { pending, approve: true } })) as any;
    expect(again.isError).toBe(true);
    expect(text(again).error.code).toBe("pending_not_found");
    await c.close();
  });

  test("decline drops the held call without touching the gateway", async () => {
    const c = await client();
    const { pending } = await holdPush(c);
    const before = calls.length;
    const r = (await c.callTool({ name: "confirm_pending", arguments: { pending, approve: false } })) as any;
    expect(r.structuredContent.status).toBe("declined");
    expect(calls.length).toBe(before);
    const shown = (await c.callTool({ name: "request_confirmation", arguments: { pending } })) as any;
    expect(shown.isError).toBe(true);
    await c.close();
  });

  test("a confirm the model passes is not kept in the held call", () => {
    const store = new PendingCalls();
    const id = store.hold("mac", "exec", { command: "git push" }, "this command runs a git push");
    expect(store.take(id)?.params).toEqual({ command: "git push" });
  });

  test("held calls expire", () => {
    let now = 1_000;
    const store = new PendingCalls(() => now);
    const id = store.hold("mac", "exec", { command: "git push" }, "git push");
    now += PENDING_TTL_MS - 1;
    expect(store.peek(id)).toBeDefined();
    now += 1;
    expect(store.take(id)).toBeUndefined();
  });
});

describe("events probe", () => {
  test("server/discover declares events and events/list names them", async () => {
    const c = await client();
    expect(discovered.result.capabilities.events).toEqual({});
    const r = await c.request({ method: "events/list", params: {} }, z.looseObject({ events: z.array(z.looseObject({ name: z.string() })) }));
    expect(r.events.map((e) => e.name)).toEqual(["agent.finished", "agent.asks"]);
    await c.close();
  });

  test("events/subscribe is refused and its log keeps no secret or callback path", async () => {
    const c = await client();
    const params = { name: "agent.finished", arguments: { machine: "mac" }, delivery: { mode: "webhook", url: "https://hooks.openai.example/cb/abc123", secret: "whsec_c2VjcmV0c2VjcmV0c2VjcmV0c2VjcmV0" }, cursor: null };
    await expect(c.request({ method: "events/subscribe", params }, z.looseObject({}))).rejects.toThrow(/does not deliver them yet/);
    const line = JSON.stringify(describeSubscribe(params));
    expect(line).toContain("hooks.openai.example");
    expect(line).not.toContain("abc123");
    expect(line).not.toContain("whsec_");
    await c.close();
  });
});
