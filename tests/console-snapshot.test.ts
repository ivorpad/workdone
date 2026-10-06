// console_snapshot: the console's one round trip, and the owner's inbox through it.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { timing } from "../gateway/answer-ops.ts";
import { loadConfig, type HerdrCall } from "../gateway/config.ts";
import { Gateway } from "../gateway/gateway.ts";
import { CONSOLE_READS } from "../gateway/herdr-gateway.ts";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function setup(over: { failHerdr?: (m: string) => boolean } = {}) {
  timing.key = timing.text = timing.settle = 0;
  const state = mkdtempSync(join(tmpdir(), "snap-"));
  dirs.push(state);
  const agents: any[] = [
    { pane_id: "w1:p1", name: "worker-a", agent: "claude", agent_status: "working", cwd: "/srv/allowed/app", foreground_cwd: "/srv/allowed/app", agent_session: { value: "sa" } },
    { pane_id: "w1:p2", name: "worker-b", agent: "codex", agent_status: "working", cwd: "/srv/allowed/app", foreground_cwd: "/srv/allowed/app", agent_session: { value: "sb" } },
  ];
  const calls: string[] = [];
  const herdr: HerdrCall = async (method, params: any) => {
    calls.push(method);
    if (over.failHerdr?.(method)) throw Object.assign(new Error("herdr down"), { code: "herdr_unavailable" });
    if (method === "agent.list") return { agents };
    if (method === "agent.get") return { agent: agents.find((a) => a.pane_id === params.target || a.name === params.target) };
    if (method === "pane.get") return { pane: agents.find((a) => a.pane_id === params.pane_id) };
    if (method === "session.snapshot") return { snapshot: { agents, panes: [] } };
    return { read: { text: "" } };
  };
  const g = new Gateway(loadConfig({ allowedRoots: ["/srv/allowed"], stateDir: state, leases: true }), herdr);
  const watch = (entries: Record<string, unknown>) => writeFileSync(join(state, "watch.json"), JSON.stringify(entries));
  const since = () => new Date(Date.now() - 60_000).toISOString();
  return { g, agents, calls, watch, since };
}

describe("console_snapshot", () => {
  test("returns the agents, supervisor, objectives, leases, claims, audit and inbox in one call", async () => {
    const { g } = setup();
    await g.request("claim_agents", { label: "Run watcher", targets: ["w1:p1"] });
    g.state.audit({ op: "prompt_agent", ok: true, args: { target: "w1:p1" } });
    const snap: any = await g.handle("console_snapshot", { audit_ops: ["prompt_agent"] });
    expect(Object.keys(snap).sort()).toEqual(["agents", "audit", "claims", "counts", "errors", "inbox", "leases", "objectives", "supervisor"]);
    expect(snap.agents.map((a: any) => a.name)).toEqual(["worker-a", "worker-b"]);
    expect(snap.leases).toEqual([expect.objectContaining({ label: "Run watcher", panes: ["w1:p1"] })]);
    expect(snap.audit.map((e: any) => e.op)).toEqual(["prompt_agent"]);
    expect(snap.errors).toEqual({});
  });
  test("a section that fails is reported and the rest still comes back", async () => {
    const { g } = setup();
    g.state.audit({ op: "x", ok: true });
    const broken = g as any;
    const original = broken.handle.bind(g);
    broken.handle = async (op: string, params: any) => { if (op === "coord_snapshot") throw Object.assign(new Error("coord unreadable"), { code: "internal_error" }); return original(op, params); };
    const snap: any = await g.handle("console_snapshot", {});
    expect(snap.errors.coord).toMatchObject({ code: "internal_error" });
    expect(snap.objectives).toEqual([]);
    expect(snap.agents.length).toBe(2);
  });
  test("without the agent list there is nothing to show: that failure is the call's", async () => {
    const { g } = setup({ failHerdr: (m) => m === "agent.list" });
    await expect(g.handle("console_snapshot", {})).rejects.toMatchObject({ code: "herdr_unavailable" });
  });
  test("it is read-only and, like the console's other reads, not written to the audit log", () => {
    for (const op of ["console_snapshot", "inbox_list", "lease_list", "claims", "audit_tail"]) expect(CONSOLE_READS.has(op)).toBe(true);
    // The inbox write is audited: it changes state.
    expect(CONSOLE_READS.has("inbox_resolve")).toBe(false);
  });
});

describe("regression: an agent finishes while no card is awake", () => {
  test("the result is in the inbox when it happens and in every later snapshot, with no chat involved", async () => {
    const { g, agents, watch, since } = setup();
    // Watched by the gateway, but no thread holds it, no card polls, no Events subscription.
    watch({ "w1:p1": { name: "worker-a", cwd: "/srv/allowed/app", since: since(), last_status: "working", managed: true, busy: true, session: "sa" } });
    agents[0].agent_status = "idle";
    await g.handle("watch_poll", {});
    for (let i = 0; i < 2; i++) {
      const snap: any = await g.handle("console_snapshot", {});
      const mine = snap.inbox.entries.filter((e: any) => e.pane_id === "w1:p1");
      expect(mine).toEqual([expect.objectContaining({ kind: "finished", status: "unanswered", agent: "worker-a", thread: null })]);
      expect(mine[0].derived).toBeUndefined();
      expect(snap.inbox.unanswered).toBe(1);
    }
  });
  test("an agent nobody watches that Herdr marks done still shows, as derived, and a dismissal sticks", async () => {
    const { g, agents } = setup();
    agents[1].agent_status = "done";
    let snap: any = await g.handle("console_snapshot", {});
    const entry = snap.inbox.entries.find((e: any) => e.pane_id === "w1:p2");
    expect(entry).toMatchObject({ kind: "finished", derived: true, status: "unanswered", agent: "worker-b" });
    expect(snap.inbox.unanswered).toBe(1);
    expect(await g.handle("inbox_resolve", { id: entry.id, target: "w1:p2", origin: "console" })).toEqual({ resolved: 1 });
    snap = await g.handle("console_snapshot", {});
    expect(snap.inbox.entries.find((e: any) => e.pane_id === "w1:p2" && e.derived)).toBeUndefined();
    expect(snap.inbox.unanswered).toBe(0);
  });
  test("a derived entry says which thread holds the agent, so its delivery route is known", async () => {
    const { g, agents } = setup();
    await g.request("claim_agents", { label: "pane-close-guard", targets: ["w1:p2"] });
    agents[1].agent_status = "done";
    const snap: any = await g.handle("console_snapshot", {});
    expect(snap.inbox.entries.find((e: any) => e.pane_id === "w1:p2")).toMatchObject({ derived: true, thread: "pane-close-guard" });
  });
  test("a stored entry for the same finish stands in for the derived one", async () => {
    const { g, agents, watch, since } = setup();
    watch({ "w1:p2": { name: "worker-b", cwd: "/srv/allowed/app", since: since(), last_status: "working", managed: true, busy: true } });
    agents[1].agent_status = "done";
    await g.handle("watch_poll", {});
    const snap: any = await g.handle("console_snapshot", {});
    expect(snap.inbox.entries.filter((e: any) => e.pane_id === "w1:p2").length).toBe(1);
    expect(snap.inbox.entries.find((e: any) => e.pane_id === "w1:p2").derived).toBeUndefined();
  });
  test("an owed result shows as pending until it arrives", async () => {
    const { g, watch, since } = setup();
    watch({ "w1:p1": { name: "worker-a", cwd: "/srv/allowed/app", since: since(), last_status: "working", managed: true, busy: true, result_request: { id: "res_0123456789abcdef", at: since(), lease: "L-abc12345" } } });
    const snap: any = await g.handle("console_snapshot", {});
    expect(snap.inbox.pending).toEqual([expect.objectContaining({ status: "pending", pane_id: "w1:p1", result_id: "res_0123456789abcdef" })]);
  });
});
