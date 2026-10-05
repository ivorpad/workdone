import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type HerdrCall } from "../gateway/config.ts";
import { criticalPath, newObjective, planTasks, reportTask, resolveOwners, snapshotView, type Objective } from "../gateway/coord.ts";
import { Gateway } from "../gateway/gateway.ts";
import { supervise } from "../gateway/supervisor.ts";
import { EVENTS } from "../mcp/src/events.ts";
import { FANOUT, TOOLS } from "../mcp/src/tools.ts";

const T0 = "2026-10-05T18:30:00.000Z";
const T1 = "2026-10-05T18:31:00.000Z";

// The shape of the Relay snapshot this was built against, as tasks.
function relay(): Objective {
  let o = newObjective("relay-pwc", "Ship Relay Public Web Chat milestone", T0);
  o = planTasks(o, [
    { id: "#769", title: "PWC #769", owner: "pwc-769-codex", status: "executing" },
    { id: "#772", title: "Transcripts, retention, erasure", owner: "pwc-770-codex", status: "verifying", acceptance: ["staff erasure proof", "consolidated e2e"], evidence: ["isolation passed", "retention passed"], artifacts: ["72861b8c"] },
    { id: "#775", title: "Abuse and spend controls", owner: "pwc-775-codex", status: "verifying", artifacts: ["cc2245e3"], blocker: "consolidated e2e owned by #772" },
    { id: "demo-mapping", title: "Rail/demo slice", owner: "demo-mapping-opus", status: "executing" },
    { id: "landing", title: "Push accepted commits", owner: "fix-672", status: "waiting_dependency", deps: ["#772", "#775"], next_action: "verify checkpoint and push accepted contiguous commits" },
  ], { e2e: "#772" }, T0);
  return resolveOwners(o, [
    { pane_id: "w1:p1", name: "pwc-769-codex" }, { pane_id: "w1:p2", name: "pwc-770-codex" }, { pane_id: "w1:p3", name: "pwc-775-codex" },
    { pane_id: "w1:p4", name: "demo-mapping-opus" }, { pane_id: "w1:p5", name: "fix-672" },
  ]).objective;
}
const code = (fn: () => unknown) => { try { fn(); } catch (e: any) { return e.code; } return null; };

describe("model", () => {
  test("one snapshot gives waits, ready work, the critical path and resource holders", () => {
    const o = relay();
    const s = snapshotView(o, { "w1:p5": { status: "working", name: "fix-672" } });
    expect(s.critical_path).toEqual(["#772", "landing"]);
    expect(s.waiting).toEqual([{ id: "landing", on: ["#772", "#775"], blocker: null }]);
    expect(s.resources.e2e).toMatchObject({ task: "#772", pane_id: "w1:p2" });
    const landing = s.tasks.find((t) => t.id === "landing")!;
    // Its terminal says working; the canonical answer is that it waits.
    expect([landing.status, landing.activity, landing.owner_status]).toEqual(["waiting_dependency", "waiting_dependency", "working"]);
    expect(s.tasks.find((t) => t.id === "#772")!.holds).toEqual(["e2e"]);
  });
  test("deps are task ids of the objective, without cycles", () => {
    const o = relay();
    expect(code(() => planTasks(o, [{ id: "#772", deps: ["landing"] }], undefined, T1))).toBe("dependency_cycle");
    expect(code(() => planTasks(o, [{ id: "#769", deps: ["#772 acceptance"] }], undefined, T1))).toBe("invalid_params");
    expect(code(() => planTasks(o, [{ id: "#769", deps: ["nope"] }], undefined, T1))).toBe("unknown_dependency");
    // Declared in the same call is fine.
    expect(planTasks(o, [{ id: "a", title: "A", deps: ["b"] }, { id: "b", title: "B" }], undefined, T1).tasks.a!.deps).toEqual(["b"]);
    expect(code(() => planTasks(o, [{ id: "x", status: "done" }], undefined, T1))).toBe("invalid_params");
  });
  test("a worker changes only its own task, never ownership, deps, acceptance or complete", () => {
    const o = relay();
    expect(code(() => reportTask(o, "#772", "w1:p1", { status: "executing" }, T1))).toBe("not_your_task");
    expect(code(() => reportTask(o, "#769", "w1:p1", { status: "complete" }, T1))).toBe("not_allowed");
    for (const k of ["owner", "deps", "acceptance", "title"]) {
      expect(code(() => reportTask(o, "#769", "w1:p1", { [k]: "x" } as any, T1))).toBe("not_allowed");
    }
    const next = reportTask(o, "#769", "w1:p1", { status: "waiting_dependency", blocker: "needs consolidated e2e" }, T1);
    expect(next.tasks["#769"]).toMatchObject({ status: "waiting_dependency", blocker: "needs consolidated e2e", version: o.tasks["#769"]!.version + 1, updated_at: T1 });
    expect(next.version).toBe(o.version + 1);
    expect(o.tasks["#769"]!.status).toBe("executing");
  });
  test("a published result moves the task to verifying; repeats change nothing", () => {
    const o = reportTask(relay(), "#769", "w1:p1", { result: { summary: "slice shipped", commit: "abc1234" }, evidence: ["unit tests pass"] }, T1);
    expect(o.tasks["#769"]).toMatchObject({ status: "verifying", result: { summary: "slice shipped", commit: "abc1234", at: T1 }, evidence: ["unit tests pass"], artifacts: ["abc1234"] });
    const again = reportTask(o, "#769", "w1:p1", { evidence: ["unit tests pass"] }, T1);
    expect(again.tasks["#769"]!.evidence).toEqual(["unit tests pass"]);
  });
  test("resources are exclusive; complete frees them for the next task", () => {
    let o = relay();
    expect(code(() => reportTask(o, "#775", "w1:p3", { acquire: ["e2e"] }, T1))).toBe("resource_busy");
    o = planTasks(o, [{ id: "#772", status: "complete", evidence: ["staff erasure proof passed"] }], undefined, T1);
    expect(o.resources.e2e).toBeUndefined();
    o = reportTask(o, "#775", "w1:p3", { acquire: ["e2e"] }, T1);
    expect(o.resources.e2e).toMatchObject({ task: "#775", pane_id: "w1:p3" });
    o = reportTask(o, "#775", "w1:p3", { release: ["e2e"] }, T1);
    expect(o.resources.e2e).toBeUndefined();
  });
  test("the critical path drops finished work", () => {
    let o = relay();
    o = planTasks(o, [{ id: "#772", status: "complete" }, { id: "#775", status: "complete" }], undefined, T1);
    expect(criticalPath(o)).toEqual(["#769"]);
    expect(snapshotView(o).ready).toEqual([]);
  });
  test("owners resolve by name to exactly one live agent; two with the name are not guessed", () => {
    let o = newObjective("x", "X", T0);
    o = planTasks(o, [{ id: "a", title: "A", owner: "dup" }], undefined, T0);
    const r = resolveOwners(o, [{ pane_id: "w1:p1", name: "dup" }, { pane_id: "w1:p2", name: "dup" }]);
    expect(r.objective.tasks.a!.owner).toEqual({ name: "dup", pane_id: null });
    expect(r.ambiguous).toEqual(["dup"]);
  });
});

describe("gateway ops", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
  function setup() {
    const state = mkdtempSync(join(tmpdir(), "coord-"));
    dirs.push(state);
    const agents: any[] = [
      { pane_id: "w1:p1", name: "worker-a", agent: "codex", agent_status: "working", cwd: "/srv/allowed/app", agent_session: { value: "s1" } },
      { pane_id: "w1:p2", name: "worker-b", agent: "codex", agent_status: "working", cwd: "/srv/allowed/app", agent_session: { value: "s2" } },
      { pane_id: "w9:p1", name: "outsider", agent: "codex", agent_status: "idle", cwd: "/srv/secret" },
    ];
    const herdr: HerdrCall = async (method, params: any) => {
      if (method === "agent.list") return { agents };
      if (method === "agent.get") return { agent: agents.find((a) => a.pane_id === params.target || a.name === params.target) };
      if (method === "session.snapshot") return { snapshot: { agents, panes: [] } };
      return { read: { text: "" } };
    };
    const g = new Gateway(loadConfig({ allowedRoots: ["/srv/allowed"], stateDir: state, leases: true }), herdr);
    return { g, state, agents };
  }
  const plan = { objective: "demo", title: "Demo objective", tasks: [
    { id: "build", title: "Build", owner: "worker-a", status: "executing" },
    { id: "ship", title: "Ship", owner: "worker-b", status: "waiting_dependency", deps: ["build"], blocker: "needs build" },
  ] };

  test("coord_update needs this thread's lease and keeps the objective to it", async () => {
    const { g } = setup();
    await expect(g.request("coord_update", plan)).rejects.toMatchObject({ code: "needs_lease" });
    const { lease } = (await g.request("claim_agents", { label: "supervisor", targets: [] })) as any;
    const { lease: other } = (await g.request("claim_agents", { label: "other", targets: [] })) as any;
    const s: any = await g.request("coord_update", { ...plan, lease });
    expect(s.version).toBe(1);
    expect(s.tasks.map((t: any) => [t.id, t.owner.pane_id])).toEqual([["build", "w1:p1"], ["ship", "w1:p2"]]);
    await expect(g.request("coord_update", { objective: "demo", tasks: [{ id: "build", status: "complete" }], lease: other })).rejects.toMatchObject({ code: "not_your_objective" });
    await expect(g.request("coord_update", { objective: "demo", tasks: [], lease, expected_version: 0 })).rejects.toMatchObject({ code: "version_conflict" });
    expect(((await g.request("coord_update", { objective: "demo", tasks: [], lease: other, take_over: true })) as any).supervisor).toBe("…" + other.slice(-4));
  });

  test("workers report only their slice, from their pane; no fields reads it", async () => {
    const { g } = setup();
    const { lease } = (await g.request("claim_agents", { label: "supervisor", targets: [] })) as any;
    await g.request("coord_update", { ...plan, lease });
    const mine: any = await g.handle("coord_report", { pane_id: "w1:p2" });
    expect(mine.tasks[0]).toMatchObject({ objective: "demo", task: { id: "ship" }, deps: [{ id: "build", status: "executing", owner: "worker-a" }] });
    await expect(g.handle("coord_report", { pane_id: "w1:p2", task: "build", status: "blocked" })).rejects.toMatchObject({ code: "not_your_task" });
    await expect(g.handle("coord_report", { pane_id: "w9:p1", status: "executing" })).rejects.toMatchObject({ code: "not_found" });
    const done: any = await g.handle("coord_report", { pane_id: "w1:p1", result: { summary: "built", commit: "abc1234" } });
    expect(done.task).toMatchObject({ status: "verifying", result: { summary: "built" } });
    const snap: any = await g.handle("coord_snapshot", {});
    expect(snap.objectives[0]).toMatchObject({ id: "demo", critical_path: ["build", "ship"] });
  });

  test("agent views and the supervisor tell a waiting agent from a working one", async () => {
    const { g } = setup();
    const { lease } = (await g.request("claim_agents", { label: "supervisor", targets: [] })) as any;
    await g.request("coord_update", { ...plan, lease });
    const b: any = await g.handle("get_agent", { target: "worker-b" });
    expect([b.status, b.task.status, b.task.unmet_deps]).toEqual(["working", "waiting_dependency", ["build"]]);
    g.state.manage("w1:p2", { name: "worker-b", cwd: "/srv/allowed/app" }, { agent_status: "working" });
    const sup: any = await g.handle("supervisor_status", {});
    const view = sup.agents.find((a: any) => a.pane_id === "w1:p2");
    expect([view.state, view.recommendations[0].action]).toEqual(["waiting_dependency", "continue"]);
  });

  test("workdone-task sends the delta with its own pane ID, which a JSON pane_id cannot override", async () => {
    const { state } = setup();
    const launcher = join(state, "launcher.sh");
    writeFileSync(launcher, "#!/bin/sh\ncat\n");
    chmodSync(launcher, 0o755);
    const run = (arg?: string) => Bun.spawnSync(["sh", "scripts/task.sh", ...(arg === undefined ? [] : [arg])], { env: { ...process.env, HERDR_PANE_ID: "w1:p1", HERDR_GATEWAY_LAUNCHER: launcher }, cwd: join(import.meta.dir, "..") });
    const sent = JSON.parse(run('{"status":"executing","pane_id":"w9:p9"}').stdout.toString());
    expect(sent).toEqual({ id: "task", op: "coord_report", params: { status: "executing", pane_id: "w1:p1" } });
    expect(JSON.parse(run().stdout.toString()).params).toEqual({ pane_id: "w1:p1" });
    expect(run("not json").exitCode).toBe(2);
  });
});

test("a waiting worker is never called stalled or nudged", () => {
  const turn = (n: string) => ({ status: "idle", session: "s1", turn: n, at: `2026-10-05T12:0${n}:00Z`, commit: "abc", diff: "d", activity: "same" });
  const d = supervise(turn("3"), [turn("1"), turn("2")], { task: { id: "ship", status: "waiting_dependency", blocker: null, unmet_deps: ["build"] } });
  expect([d.state, d.recommendations[0]!.action]).toEqual(["waiting_dependency", "continue"]);
  expect(d.recommendations[0]!.evidence).toContain("unmet_deps=build");
});

test("MCP surface: snapshot is read-only on every machine, update is leased; event payloads unchanged", () => {
  expect(FANOUT.has("coord_snapshot")).toBe(true);
  expect(TOOLS.coord_snapshot!.annotations.readOnlyHint).toBe(true);
  expect(TOOLS.coord_update!.input.lease).toBeDefined();
  const finished = EVENTS.find((e) => e.name === "agent.finished")!;
  expect(Object.keys(finished.payloadSchema.properties as object).sort()).toEqual(["agent", "cwd", "excerpt", "machine", "pane_id", "result"]);
  expect(EVENTS.map((e) => e.name)).toEqual(["agent.finished", "agent.asks", "agent.message"]);
});
