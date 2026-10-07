import { describe, expect, test } from "bun:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { parseConfig } from "../src/config.ts";
import type { CallGateway } from "../src/gateway-client.ts";
import { inbox } from "../src/inbox.ts";
import { createHandler } from "../src/server.ts";
import { buildServer } from "../src/tools.ts";
import { KEY_META, WATCH_URI, limitsFor } from "../src/watch.ts";

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
  if (params.target === "gone") return { ok: false, error: { code: "agent_not_found", message: "no agent gone" } };
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

describe("a regular chat links itself", () => {
  const spawn = (c: Client, lease: string, extra: Record<string, unknown> = {}) =>
    c.callTool({ name: "spawn_agent", arguments: { kind: "claude", name: "robin", cwd: "~/src", prompt: "do it", lease, ...extra } }) as Promise<any>;

  test("a spawn with a prompt opens the link, asks for the result and shows the card", async () => {
    const c = await client();
    const r = await spawn(c, "L-live0101");
    expect(r.isError).toBe(false);
    const sent = calls.filter(([, op, p]) => op === "spawn_agent" && p.lease === "L-live0101");
    expect(sent.at(-1)![2].reply).toBe(true);
    expect(r.structuredContent.link).toMatchObject({ machine: "mac", active: true, wake: ["message", "reply", "blocked"] });
    const key = r._meta[KEY_META];
    expect(key).toMatchObject({ lease: "L-live0101" });
    expect(key.cap).toMatch(/^wc_/);
    expect(r.content.at(-1).text).toContain("come back here by themselves");
    const visible = JSON.stringify([r.content, r.structuredContent]);
    for (const secret of [key.watch_id, key.cap]) expect(visible).not.toContain(secret);
    await c.close();
  });

  test("an explicit reply: false is kept", async () => {
    const c = await client();
    await spawn(c, "L-live0102", { reply: false });
    const sent = calls.filter(([, op, p]) => op === "spawn_agent" && p.lease === "L-live0102");
    expect(sent.at(-1)![2].reply).toBe(false);
    await c.close();
  });

  test("while a card polls the link, later calls show it without a key and replace nothing", async () => {
    const c = await client();
    const first = await spawn(c, "L-live0103");
    const key = first._meta[KEY_META];
    await inbox.next(key.watch_id, key.cap, 0);
    const prompt = (await c.callTool({ name: "prompt_agent", arguments: { target: "robin", text: "more", lease: "L-live0103" } })) as any;
    expect(prompt.structuredContent.link).toMatchObject({ active: true });
    expect(prompt._meta?.[KEY_META]).toBeUndefined();
    expect((await inbox.next(key.watch_id, key.cap, 0)).state).toMatchObject({ active: true });
    const again = (await c.callTool({ name: "watch_here", arguments: { lease: "L-live0103" } })) as any;
    expect(err(again)).toMatchObject({ code: "already_linked" });
    await c.close();
  });

  test("a link no card ever polled is handed to the next card, under the same key", async () => {
    const c = await client();
    const first = await spawn(c, "L-live0104");
    const next = (await c.callTool({ name: "steer_agent", arguments: { target: "robin", text: "also", lease: "L-live0104" } })) as any;
    expect(next._meta[KEY_META]).toEqual(first._meta[KEY_META]);
    await c.close();
  });

  test("a failed call links nothing", async () => {
    const c = await client();
    const r = (await c.callTool({ name: "prompt_agent", arguments: { target: "gone", text: "hi", lease: "L-live0105" } })) as any;
    expect(r.isError).toBe(true);
    expect(r._meta?.[KEY_META]).toBeUndefined();
    expect(inbox.linked("mac", "L-live0105")).toBe(false);
    await c.close();
  });

  test("only the calls that hand out work carry the card, and only without native Events", async () => {
    const c = await client();
    const tools = Object.fromEntries((await c.listTools()).tools.map((t) => [t.name, t]));
    for (const name of ["spawn_agent", "prompt_agent", "steer_agent"]) expect((tools[name] as any)._meta?.ui?.resourceUri).toBe(WATCH_URI);
    for (const name of ["get_agent", "owed_work", "start_agent"]) expect((tools[name] as any)._meta?.ui?.resourceUri).toBeUndefined();
    await c.close();
    const work = buildServer(fake, ["mac"], "mac", undefined, { service: {} as any, principal: { id: "p" } as any }) as any;
    for (const name of ["spawn_agent", "prompt_agent", "steer_agent"]) expect(work._registeredTools[name]._meta).toBeUndefined();
  });
});
