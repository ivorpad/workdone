// The owner's inbox on the gateway: what agents told the owner, kept whether or not any
// chat card or console page is open.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { timing } from "../gateway/answer-ops.ts";
import { loadConfig, type HerdrCall } from "../gateway/config.ts";
import { Gateway } from "../gateway/gateway.ts";
import { StateStore, type InboxEntry } from "../gateway/state.ts";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function setup() {
  timing.key = timing.text = timing.settle = 0;
  const state = mkdtempSync(join(tmpdir(), "inbox-"));
  dirs.push(state);
  const agents: any[] = [
    { pane_id: "w1:p1", name: "worker-a", agent: "claude", agent_status: "idle", cwd: "/srv/allowed/app", agent_session: { value: "sa" }, state_change_seq: 1 },
    { pane_id: "w1:p2", name: "worker-b", agent: "codex", agent_status: "idle", cwd: "/srv/allowed/app", agent_session: { value: "sb" }, state_change_seq: 1 },
  ];
  const herdr: HerdrCall = async (method, params: any) => {
    if (method === "agent.list") return { agents };
    if (method === "agent.get") return { agent: agents.find((a) => a.pane_id === params.target || a.name === params.target) };
    if (method === "pane.get") return { pane: agents.find((a) => a.pane_id === params.pane_id) };
    if (method === "session.snapshot") return { snapshot: { agents, panes: [] } };
    if (method === "agent.prompt") { const a = agents.find((x) => x.pane_id === params.target)!; return { agent: { ...a } }; }
    return { read: { text: "" } };
  };
  const g = new Gateway(loadConfig({ allowedRoots: ["/srv/allowed"], stateDir: state, leases: true }), herdr);
  const list = async (): Promise<any> => g.handle("inbox_list", {});
  return { g, state, agents, list };
}
const plan = (lease: string) => ({ objective: "demo", title: "Demo", lease, tasks: [{ id: "build", title: "Build it", owner: "worker-a", acceptance: ["tests pass"] }] });

describe("inbox: tells", () => {
  test("a tell is kept with who said it, its session, its task and the thread that held it", async () => {
    const { g, list } = setup();
    const { lease } = (await g.request("claim_agents", { label: "Run watcher", targets: ["w1:p1"] })) as any;
    await g.request("coord_update", plan(lease));
    expect(await g.handle("tell", { pane_id: "w1:p1", text: "Which retry policy do you want?" })).toMatchObject({ queued: true });
    const view = await list();
    expect(view.unanswered).toBe(1);
    expect(view.entries[0]).toMatchObject({
      kind: "tell", status: "unanswered", pane_id: "w1:p1", agent: "worker-a", agent_kind: "claude", cwd: "/srv/allowed/app", session: "sa",
      task: { objective: "demo", id: "build" }, thread: "Run watcher", text: "Which retry policy do you want?",
    });
    // A lease is a credential: the view carries its tail only.
    expect(view.entries[0].lease).toBe("…" + lease.slice(-4));
    expect(JSON.stringify(view)).not.toContain(lease);
  });
  test("it stays after the chat's queue was consumed: nothing depends on a card", async () => {
    const { g, state, list } = setup();
    await g.handle("tell", { pane_id: "w1:p2", text: "hello owner" });
    const found: any = await g.handle("watch_poll", {});
    expect(found.reports.filter((r: any) => r.type === "message").length).toBe(1);
    expect(new StateStore(state).told()).toEqual([]);
    expect((await list()).entries.map((e: any) => e.text)).toEqual(["hello owner"]);
  });
  test("an agent that isn't one the gateway sees is not recorded", async () => {
    const { g, list } = setup();
    await expect(g.handle("tell", { pane_id: "w9:p9", text: "x" })).rejects.toMatchObject({ code: "not_found" });
    expect((await list()).entries).toEqual([]);
  });
});

describe("inbox: results", () => {
  const since = () => new Date(Date.now() - 60_000).toISOString();
  const rid = "res_0123456789abcdef";

  test("a result asked for with reply: true is kept when its turn ends, with the agent and result identity", async () => {
    const { g, state, agents, list } = setup();
    const used = new Date().toISOString();
    writeFileSync(join(state, "leases.json"), JSON.stringify({ "L-abc12345": { label: "Run watcher", panes: ["w1:p1"], created: used, used } }));
    writeFileSync(join(state, "watch.json"), JSON.stringify({ "w1:p1": { name: "worker-a", cwd: "/srv/allowed/app", since: since(), last_status: "working", managed: true, busy: true, session: "sa", reply_to: "L-abc12345", result_request: { id: rid, at: since(), lease: "L-abc12345" } } }));
    agents[0].agent_status = "idle";
    await g.handle("watch_poll", {});
    const view = await list();
    expect(view.entries[0]).toMatchObject({ kind: "result", status: "unanswered", pane_id: "w1:p1", agent: "worker-a", thread: "Run watcher", result: { result_id: rid, status: "finished" } });
    expect(view.pending).toEqual([]);
  });
  test("a result still owed shows as pending, with the thread that asked", async () => {
    const { g, state, list } = setup();
    const used = new Date().toISOString();
    writeFileSync(join(state, "leases.json"), JSON.stringify({ "L-abc12345": { label: "Run watcher", panes: ["w1:p1"], created: used, used } }));
    writeFileSync(join(state, "watch.json"), JSON.stringify({ "w1:p1": { name: "worker-a", cwd: "/srv/allowed/app", since: since(), last_status: "working", managed: true, busy: true, result_request: { id: rid, at: since(), lease: "L-abc12345" } } }));
    const view = await list();
    expect(view.pending).toEqual([expect.objectContaining({ id: `pending:${rid}`, status: "pending", pane_id: "w1:p1", agent: "worker-a", result_id: rid, thread: "Run watcher", lease: "…2345" })]);
    void g;
  });
});

describe("inbox: completions with no chat awake", () => {
  const since = () => new Date(Date.now() - 60_000).toISOString();

  test("an agent finishes while no card is awake: the turn end is in the inbox, unanswered, and stays there", async () => {
    const { g, state, agents, list } = setup();
    // Watched and managed, no lease, no card, no Events subscription: nothing could be woken.
    writeFileSync(join(state, "watch.json"), JSON.stringify({
      "w1:p1": { name: "worker-a", cwd: "/srv/allowed/app", since: since(), last_status: "working", managed: true, busy: true, session: "sa" },
      "w1:p2": { name: "worker-b", cwd: "/srv/allowed/app", since: since(), last_status: "working", managed: true, busy: true, session: "sb" },
    }));
    agents[0].agent_status = "idle";
    agents[1].agent_status = "done";
    await g.handle("watch_poll", {});
    await g.handle("watch_poll", {});
    const view = await list();
    expect(view.entries.map((e: any) => [e.kind, e.agent, e.status, e.thread]).sort()).toEqual([["finished", "worker-a", "unanswered", null], ["finished", "worker-b", "unanswered", null]]);
    expect(view.unanswered).toBe(2);
    expect(view.entries[0]).toMatchObject({ agent_kind: expect.any(String), cwd: "/srv/allowed/app", session: expect.any(String) });
  });
  test("an agent that exits is recorded as gone, and one still working is not recorded", async () => {
    const { g, state, agents, list } = setup();
    writeFileSync(join(state, "watch.json"), JSON.stringify({
      "w1:p1": { name: "worker-a", cwd: "/srv/allowed/app", since: since(), last_status: "working", managed: true, busy: true },
      "w1:p2": { name: "worker-b", cwd: "/srv/allowed/app", since: since(), last_status: "working", managed: true, busy: true },
    }));
    agents[1].agent_status = "working";
    agents.splice(0, 1);
    await g.handle("watch_poll", {});
    expect((await list()).entries.map((e: any) => [e.kind, e.agent])).toEqual([["gone", "worker-a"]]);
  });
  test("a finished turn the chat answered by prompting the agent again is answered, not open", async () => {
    const { g, state, agents, list } = setup();
    writeFileSync(join(state, "watch.json"), JSON.stringify({ "w1:p1": { name: "worker-a", cwd: "/srv/allowed/app", since: since(), last_status: "working", managed: true, busy: true } }));
    agents[0].agent_status = "idle";
    await g.handle("watch_poll", {});
    expect((await list()).unanswered).toBe(1);
    const { lease } = (await g.request("claim_agents", { label: "t", targets: ["w1:p1"] })) as any;
    await g.request("prompt_agent", { target: "w1:p1", text: "next step", lease });
    expect((await list()).unanswered).toBe(0);
  });
});

describe("inbox: answered and dismissed", () => {
  test("a follow-up to the agent answers its entries, by the thread or by the console, and only that agent's", async () => {
    const { g, list } = setup();
    const { lease } = (await g.request("claim_agents", { label: "Run watcher", targets: ["w1:p1", "w1:p2"] })) as any;
    await g.handle("tell", { pane_id: "w1:p1", text: "a" });
    await g.handle("tell", { pane_id: "w1:p2", text: "b" });
    await g.request("prompt_agent", { target: "worker-a", text: "go ahead", lease });
    let view = await list();
    expect(view.entries.find((e: any) => e.text === "a")).toMatchObject({ status: "answered", resolved_by: 'thread "Run watcher"' });
    expect(view.entries.find((e: any) => e.text === "b").status).toBe("unanswered");
    await g.request("steer_agent", { target: "w1:p2", text: "do it", origin: "console" });
    view = await list();
    expect(view.entries.find((e: any) => e.text === "b")).toMatchObject({ status: "answered", resolved_by: "console" });
    expect(view.unanswered).toBe(0);
  });
  test("a prompt that fails answers nothing", async () => {
    const { g, list } = setup();
    await g.handle("tell", { pane_id: "w1:p1", text: "a" });
    await expect(g.request("prompt_agent", { target: "w1:p1", text: "x" })).rejects.toMatchObject({ code: "needs_lease" });
    expect((await list()).unanswered).toBe(1);
  });
  test("the owner can dismiss one entry or everything from one agent, once", async () => {
    const { g, list } = setup();
    await g.handle("tell", { pane_id: "w1:p1", text: "one" });
    await g.handle("tell", { pane_id: "w1:p1", text: "two" });
    await g.handle("tell", { pane_id: "w1:p2", text: "three" });
    const first = (await list()).entries.find((e: any) => e.text === "one");
    expect(await g.handle("inbox_resolve", { id: first.id, origin: "console" })).toEqual({ resolved: 1 });
    expect(await g.handle("inbox_resolve", { id: first.id })).toEqual({ resolved: 0 });
    expect(await g.handle("inbox_resolve", { target: "worker-a" })).toEqual({ resolved: 1 });
    const view = await list();
    expect(view.entries.filter((e: any) => e.status === "dismissed").map((e: any) => e.text).sort()).toEqual(["one", "two"]);
    expect(view.unanswered).toBe(1);
    await expect(g.handle("inbox_resolve", {})).rejects.toMatchObject({ code: "invalid_params" });
  });
});

describe("inbox: bounds", () => {
  const entry = (i: number, over: Partial<InboxEntry> = {}): InboxEntry => ({ id: `e${i}`, kind: "tell", at: new Date(Date.now() - 1000).toISOString(), pane_id: "w1:p1", agent: "a", agent_kind: null, cwd: null, session: null, lease: null, task: null, text: `t${i}`, status: "unanswered", ...over });

  test("capped at 500, dropping resolved entries before unanswered ones", () => {
    const dir = mkdtempSync(join(tmpdir(), "inbox-cap-"));
    dirs.push(dir);
    const s = new StateStore(dir);
    for (let i = 0; i < 300; i++) s.inboxAdd(entry(i));
    for (let i = 300; i < 560; i++) s.inboxAdd(entry(i, { status: "dismissed", resolved_at: new Date().toISOString() }));
    const all = s.inbox();
    expect(all.length).toBe(500);
    expect(all.filter((e) => e.status === "unanswered").length).toBe(300);
  });
  test("resolved entries age out after two weeks, unanswered ones never do, and an id is added once", () => {
    const dir = mkdtempSync(join(tmpdir(), "inbox-age-"));
    dirs.push(dir);
    const s = new StateStore(dir);
    const old = new Date(Date.now() - 15 * 24 * 3600_000).toISOString();
    s.inboxAdd(entry(1, { at: old, status: "dismissed", resolved_at: old }));
    s.inboxAdd(entry(2, { at: old }));
    s.inboxAdd(entry(3));
    s.inboxAdd(entry(3));
    expect(s.inbox().map((e) => e.id)).toEqual(["e2", "e3"]);
  });
});
