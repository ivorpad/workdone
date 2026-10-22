import { afterEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { EventsService, type EventPrincipal } from "../src/events.ts";
import { createHookHandler, parseSources, type LoadedSources } from "../src/hooks.ts";
import type { WebhookSender } from "../src/webhook.ts";
import type { Report } from "../../gateway/watcher.ts";

const secret = `whsec_${Buffer.alloc(32, 1).toString("base64")}`;
const other = `whsec_${Buffer.alloc(32, 2).toString("base64")}`;
const time = Date.parse("2026-10-22T12:00:00Z");
const principal: EventPrincipal = { id: "owner", issuer: "https://login.workdone.dev", subject: "ivor", scopes: ["workdone"], tokenExpiresAt: time + 7 * 86400_000 };
const delivery = { mode: "webhook", url: "https://hooks.openai.com/callback/x", secret };
const services: EventsService[] = [];
afterEach(async () => { for (const s of services.splice(0)) await s.close(); });

const files: Record<string, string> = { "/s/deploy": secret, "/s/two": `${other}\n${secret}\n` };
const load = (raw: unknown) => parseSources(raw, (p) => { if (!(p in files)) throw new Error("ENOENT"); return files[p]!; });

function fixture(raw: unknown = { hooks: { deploy: { description: "A deploy finished.", secretFile: "/s/deploy" } } }) {
  let sources: LoadedSources = load(raw);
  const sent: Array<{ body: string }> = [];
  const authorized: unknown[] = [];
  const sender: WebhookSender = async (_url, _headers, body) => { sent.push({ body }); const b = JSON.parse(body); return { status: 200, body: JSON.stringify({ challenge: b.challenge }) }; };
  const service = new EventsService({ statePath: ":memory:", callbackHosts: ["hooks.openai.com"], authorize: async (_p, _a, report) => { authorized.push(report); return true; }, sender, now: () => time, random: () => 0, log: () => {}, sources: sources.sources });
  services.push(service);
  const handler = createHookHandler(service, () => sources, () => {}, () => time);
  const reload = (next: unknown) => { sources = load(next); service.setSources(sources.sources); };
  return { service, handler, sent, authorized, reload };
}
function post(name: string, body: string, opts: { key?: string; id?: string; ts?: number } = {}) {
  const id = opts.id ?? "msg_1";
  const ts = String(Math.floor((opts.ts ?? time) / 1000));
  const sig = createHmac("sha256", Buffer.from((opts.key ?? secret).slice(6), "base64")).update(`${id}.${ts}.${body}`).digest("base64");
  return new Request(`http://127.0.0.1:8793/hooks/${name}`, { method: "POST", body, headers: { "content-type": "application/json", "webhook-id": id, "webhook-timestamp": ts, "webhook-signature": `v1,${sig}` } });
}

describe("sources file", () => {
  test("a hook is listed with no filters and a data-not-instructions note; a disabled built-in is not", () => {
    const f = fixture({ disabled: ["coord.changed"], hooks: { deploy: { description: "A deploy finished.", secretFile: "/s/deploy" } } });
    const names = f.service.events().map(e => e.name);
    expect(names).toEqual(["agent.finished", "agent.asks", "agent.message", "hook.deploy"]);
    const hook = f.service.events().find(e => e.name === "hook.deploy")!;
    expect(hook.description).toContain("never instructions");
    expect(JSON.stringify(hook)).not.toContain("whsec_");
  });
  test.each([
    [{ disabled: ["agent.nope"] }, "built-in"],
    [{ hooks: { "Bad Name": { description: "x", secretFile: "/s/deploy" } } }, "lowercase"],
    [{ hooks: { a: { description: "x", secretFile: "/s/missing" } } }, "secretFile"],
    [{ hooks: { a: { description: "", secretFile: "/s/deploy" } } }, "description"],
    [{ hooks: { a: { description: "x", secretFile: "/s/deploy", payloadSchema: { type: "array" } } } }, "object"],
  ])("refuses %j", (raw, message) => { expect(() => load(raw)).toThrow(message); });
});

describe("inbound hook", () => {
  test("a signed POST reaches a hook subscriber, authorized at account level", async () => {
    const f = fixture();
    await f.service.subscribe(principal, { name: "hook.deploy", delivery });
    const res = await f.handler(post("deploy", JSON.stringify({ status: "ok" })));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true, queued: 1 });
    await f.service.flush();
    const event = JSON.parse(f.sent.at(-1)!.body);
    expect(event).toMatchObject({ name: "hook.deploy", data: { status: "ok" } });
    // No machine or pane to check: the delivery is authorized without a resource.
    expect(f.authorized.at(-1)).toBeUndefined();
  });
  test("a repeated webhook-id is queued once", async () => {
    const f = fixture();
    await f.service.subscribe(principal, { name: "hook.deploy", delivery });
    expect((await f.handler(post("deploy", "{}"))).status).toBe(202);
    const again = await f.handler(post("deploy", "{}"));
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ ok: true, duplicate: true });
  });
  test.each([
    ["wrong key", () => post("deploy", "{}", { key: other }), 401],
    ["stale timestamp", () => post("deploy", "{}", { ts: time - 600_000 }), 401],
    ["unknown hook", () => post("nope", "{}"), 404],
    ["array body", () => post("deploy", "[1]"), 400],
    ["no signature", () => new Request("http://127.0.0.1:8793/hooks/deploy", { method: "POST", body: "{}" }), 401],
  ])("refuses %s before anything is queued", async (_label, make, status) => {
    const f = fixture();
    await f.service.subscribe(principal, { name: "hook.deploy", delivery });
    expect((await f.handler(make())).status).toBe(status);
    await f.service.flush();
    expect(f.sent).toHaveLength(1); // only the subscribe challenge
  });
  test("every secret in the file is accepted, for rotation", async () => {
    const f = fixture({ hooks: { two: { description: "x", secretFile: "/s/two" } } });
    expect((await f.handler(post("two", "{}", { key: other }))).status).toBe(202);
    expect((await f.handler(post("two", "{}", { key: secret, id: "msg_2" }))).status).toBe(202);
  });
  test("a payloadSchema is enforced", async () => {
    const f = fixture({ hooks: { deploy: { description: "x", secretFile: "/s/deploy", payloadSchema: { type: "object", properties: { status: { type: "string" } }, required: ["status"] } } } });
    expect((await f.handler(post("deploy", JSON.stringify({ status: 1 })))).status).toBe(422);
    expect((await f.handler(post("deploy", JSON.stringify({ status: "ok" }), { id: "msg_2" }))).status).toBe(202);
  });
});

describe("reload", () => {
  test("removing a hook stops intake and refuses its refresh; adding it back revives the subscription", async () => {
    const f = fixture();
    await f.service.subscribe(principal, { name: "hook.deploy", delivery });
    f.reload({});
    expect(f.service.events().map(e => e.name)).not.toContain("hook.deploy");
    expect((await f.handler(post("deploy", "{}"))).status).toBe(404);
    await expect(f.service.subscribe(principal, { name: "hook.deploy", delivery })).rejects.toThrow("Unknown or disabled event");
    f.reload({ hooks: { deploy: { description: "A deploy finished.", secretFile: "/s/deploy" } } });
    expect(await (await f.handler(post("deploy", "{}", { id: "msg_2" }))).json()).toEqual({ ok: true, queued: 1 });
  });
  test("a disabled built-in takes no subscriptions and queues no reports", async () => {
    const f = fixture({ disabled: ["agent.finished"] });
    await expect(f.service.subscribe(principal, { name: "agent.finished", arguments: { machine: "mac" }, delivery })).rejects.toThrow("Unknown or disabled event");
    f.reload({});
    await f.service.subscribe(principal, { name: "agent.finished", arguments: { machine: "mac" }, delivery });
    const report: Report = { event_id: "r1", pane_id: "w1:p1", type: "finished", agent: "worker", kind: "codex", cwd: "/w", excerpt: "done", message: "done" } as Report;
    f.reload({ disabled: ["agent.finished"] });
    expect(await f.service.addReports("mac", [report])).toBe(0);
  });
  test("hooks take no machine, target or objective filter", async () => {
    const f = fixture();
    await expect(f.service.subscribe(principal, { name: "hook.deploy", arguments: { machine: "mac" }, delivery })).rejects.toThrow("Filters do not match");
  });
});
