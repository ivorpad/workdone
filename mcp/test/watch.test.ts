import { describe, expect, test } from "bun:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { parseConfig } from "../src/config.ts";
import type { CallGateway } from "../src/gateway-client.ts";
import { inbox } from "../src/inbox.ts";
import { createHandler } from "../src/server.ts";
import { KEY_META, limitsFor } from "../src/watch.ts";

const target = { user: "ivor", host: "mac.example.ts.net", identityFile: "/k", knownHostsFile: "/kh" };
const cfg = parseConfig({ listen: { host: "127.0.0.1", port: 8787 }, machines: { mac: target, ovh: { ...target, host: "127.0.0.1" } } });

// A gateway that knows three leases: one live, one lapsed, and everything else unknown.
const calls: Array<[string, string, Record<string, unknown>]> = [];
const fake: CallGateway = async (machine, op, params) => {
  calls.push([machine, op, params]);
  if (op === "lease_check") {
    if (typeof params.lease === "string" && params.lease.startsWith("L-live")) return { ok: true, result: { valid: true, label: "t", panes: ["w1:p1"] } };
    if (params.lease === "L-lapsed1") return { ok: true, result: { valid: false, reason: "lapsed", panes: [] } };
    return { ok: true, result: { valid: false, reason: "unknown", panes: [] } };
  }
  return { ok: true, result: { submitted: true, status: "working" } };
};
const handler = createHandler(cfg, fake);

async function client() {
  const c = new Client({ name: "test", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
  await c.connect(
    new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8787/mcp"), {
      fetch: async (input, init) => {
        const req = new Request(String(input), init);
        req.headers.set("host", "127.0.0.1:8787");
        return handler(req);
      },
    }),
  );
  return c;
}
const err = (r: any) => JSON.parse(r.content[0].text).error;

describe("watch_here", () => {
  test("refuses a lease the gateway doesn't know or has let lapse", async () => {
    const c = await client();
    const unknown = (await c.callTool({ name: "watch_here", arguments: { lease: "L-madeup1" } })) as any;
    expect(unknown.isError).toBe(true);
    expect(err(unknown)).toMatchObject({ code: "invalid_lease" });
    expect(err(unknown).message).toContain("unknown");
    const lapsed = (await c.callTool({ name: "watch_here", arguments: { lease: "L-lapsed1" } })) as any;
    expect(err(lapsed).message).toContain("lapsed");
    await c.close();
  });

  test("the key is only in _meta: no lease, watch id or cap in what the model sees", async () => {
    const c = await client();
    const r = (await c.callTool({ name: "watch_here", arguments: { lease: "L-live0001" } })) as any;
    expect(r.isError).toBe(false);
    const key = r._meta[KEY_META];
    expect(key).toMatchObject({ lease: "L-live0001" });
    expect(key.cap).toMatch(/^wc_/);
    const visible = JSON.stringify([r.content, r.structuredContent]);
    for (const secret of [key.lease, key.watch_id, key.cap]) expect(visible).not.toContain(secret);
    await c.close();
  });

  test("a second watch_here for the same lease is refused; the card's cap may reopen it", async () => {
    const c = await client();
    const first = (await c.callTool({ name: "watch_here", arguments: { lease: "L-live0002" } })) as any;
    const again = (await c.callTool({ name: "watch_here", arguments: { lease: "L-live0002" } })) as any;
    expect(err(again)).toMatchObject({ code: "already_linked" });
    const card = (await c.callTool({ name: "watch_here", arguments: { lease: "L-live0002", watch_cap: first._meta[KEY_META].cap } })) as any;
    expect(card.isError).toBe(false);
    await c.close();
  });

  test("ceilings follow what the link wakes on, whatever the model asks for", async () => {
    expect(limitsFor(false, false)).toEqual({ hours: 72, rounds: 200 });
    expect(limitsFor(true, false)).toEqual({ hours: 24, rounds: 50 });
    expect(limitsFor(true, true)).toEqual({ hours: 8, rounds: 25 });
    const c = await client();
    const r = (await c.callTool({ name: "watch_here", arguments: { lease: "L-live0003", finished: true, max_rounds: 200, hours: 72 } })) as any;
    expect(r.structuredContent).toMatchObject({ max_rounds: 25 });
    const hours = (Date.parse(r.structuredContent.expires) - Date.now()) / 3600_000;
    expect(hours).toBeGreaterThan(7.9);
    expect(hours).toBeLessThanOrEqual(8);
    await c.close();
  });

  test("watch_next with the watch id but the wrong cap gets nothing", async () => {
    const c = await client();
    const r = (await c.callTool({ name: "watch_here", arguments: { lease: "L-live0004" } })) as any;
    const { watch_id } = r._meta[KEY_META];
    const stolen = (await c.callTool({ name: "watch_next", arguments: { watch_id, cap: "wc_guess" } })) as any;
    expect(stolen.structuredContent).toEqual({ events: [], state: null });
    await c.close();
  });
});

describe("one message per wake", () => {
  test("after a wake, a second prompt to the agent is refused, and no parameter lifts that", async () => {
    const c = await client();
    const r = (await c.callTool({ name: "watch_here", arguments: { lease: "L-live0005" } })) as any;
    const key = r._meta[KEY_META];
    inbox.add("mac", [{ pane_id: "w1:p1", type: "finished", agent: "robin", kind: "claude", cwd: "/src", excerpt: "done", lease: "L-live0005", reply_to: "L-live0005", message: "robin finished" }]);
    const woke = (await c.callTool({ name: "watch_next", arguments: key })) as any;
    expect(woke.structuredContent.events.map((e: any) => e.type)).toEqual(["reply"]);
    const prompt = (extra: Record<string, unknown> = {}) => c.callTool({ name: "prompt_agent", arguments: { target: "robin", text: "next", lease: "L-live0005", ...extra } }) as Promise<any>;
    expect((await prompt()).isError).toBe(false);
    expect(err(await prompt())).toMatchObject({ code: "one_message_per_wake" });
    // The old override is gone: an unknown parameter is dropped and the limit holds.
    expect(err(await prompt({ continue_conversation: true }))).toMatchObject({ code: "one_message_per_wake" });
    const steer = (await c.callTool({ name: "steer_agent", arguments: { target: "robin", text: "also", lease: "L-live0005" } })) as any;
    expect(err(steer)).toMatchObject({ code: "one_message_per_wake" });
    const tools = (await c.listTools()).tools.filter((t) => t.name === "prompt_agent" || t.name === "steer_agent");
    for (const t of tools) expect(JSON.stringify(t.inputSchema)).not.toContain("continue_conversation");
    await c.close();
  });
});
