// Regressions for the orchestration review (2026-10-06) through the gateway: a prompt
// carrying a task slice is a dispatch with an outcome. Herdr is mocked; state is a
// temporary directory.
import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { timing } from "../gateway/answer-ops.ts";
import { GatewayError, loadConfig, type HerdrCall } from "../gateway/config.ts";
import { Gateway } from "../gateway/gateway.ts";

const dirs: string[] = [];
afterEach(() => { setSystemTime(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function setup() {
  timing.key = timing.text = timing.settle = 0;
  const state = mkdtempSync(join(tmpdir(), "coord-reg-"));
  dirs.push(state);
  const agents: any[] = [
    { pane_id: "w1:p1", name: "worker-a", agent: "claude", agent_status: "idle", cwd: "/srv/allowed/app", agent_session: { value: "sa" }, state_change_seq: 1 },
    { pane_id: "w1:p2", name: "worker-b", agent: "codex", agent_status: "idle", cwd: "/srv/allowed/app", agent_session: { value: "sb" }, state_change_seq: 1 },
    { pane_id: "w1:p3", name: "plain", agent: "claude", agent_status: "idle", cwd: "/srv/allowed/app", agent_session: { value: "sc" }, state_change_seq: 1 },
  ];
  const sent: Array<{ method: string; text?: string }> = [];
  // Per method: what the next send does. "ok", a GatewayError to throw, or a hook that
  // runs while the send is in flight (a worker reporting, a supervisor merging).
  const next: Record<string, Array<"ok" | GatewayError | (() => Promise<void>)>> = { "agent.prompt": [], "pane.send_input": [], "agent.send_keys": [] };
  const step = async (method: string) => {
    const s = next[method]?.shift() ?? "ok";
    if (typeof s === "function") return await s();
    if (s instanceof GatewayError) throw s;
  };
  const herdr: HerdrCall = async (method, params: any) => {
    if (method === "agent.list") return { agents };
    if (method === "agent.get") return { agent: agents.find((a) => a.pane_id === params.target || a.name === params.target) };
    if (method === "session.snapshot") return { snapshot: { agents, panes: [] } };
    if (method === "agent.prompt" || method === "pane.send_input" || method === "agent.send_keys") {
      await step(method);
      sent.push({ method, text: params.text });
      if (method === "agent.prompt") {
        const a = agents.find((x) => x.pane_id === params.target)!;
        a.agent_status = "working";
        a.state_change_seq++;
        return { agent: { ...a } };
      }
      return {};
    }
    return { read: { text: "" } };
  };
  const g = new Gateway(loadConfig({ allowedRoots: ["/srv/allowed"], stateDir: state, leases: true }), herdr);
  const coord = () => JSON.parse(readFileSync(join(state, "coord.json"), "utf8"));
  const tokenIn = (text: string) => /--token (wdt_[A-Za-z0-9_-]+)/.exec(text)?.[1];
  const prompts = () => sent.filter((x) => x.method === "agent.prompt").map((x) => x.text!);
  return { g, agents, sent, next, coord, tokenIn, prompts };
}

async function planned(t: ReturnType<typeof setup>) {
  const { lease } = (await t.g.request("claim_agents", { label: "sup", targets: ["worker-a", "worker-b"] })) as any;
  await t.g.request("coord_update", {
    objective: "demo", title: "Demo", lease,
    tasks: [
      { id: "build", title: "Build it", owner: "worker-a" },
      { id: "ship", title: "Ship it", owner: "worker-b", deps: ["build"] },
    ],
  });
  return lease as string;
}

describe("4. dispatch of a bound prompt", () => {
  test("a definitive refusal (agent_busy) leaves no binding, no running task, and a retry works", async () => {
    const t = setup();
    const lease = await planned(t);
    t.next["agent.prompt"]!.push(new GatewayError("agent_busy", "the agent is busy"));
    await expect(t.g.handle("prompt_agent", { target: "worker-a", text: "go", task: { objective: "demo", id: "build" }, lease })).rejects.toMatchObject({ code: "agent_busy" });
    expect(t.coord().objectives.demo.tasks.build).toMatchObject({ status: "queued", binding: null, pending: null, generation: 0, protocol: null });
    expect(t.coord().current ?? {}).toEqual({});
    const res: any = await t.g.handle("prompt_agent", { target: "worker-a", text: "go", task: { objective: "demo", id: "build" }, lease });
    expect(res.dispatch).toMatchObject({ state: "delivered" });
    const build = t.coord().objectives.demo.tasks.build;
    expect(build).toMatchObject({ status: "executing", generation: 1, binding: { pane_id: "w1:p1", dispatch: { state: "delivered", command_id: res.dispatch.command_id } } });
    await t.g.handle("coord_report", { token: t.tokenIn(t.prompts().at(-1)!)!, evidence: ["started"] });
  });

  test("an ambiguous transport failure is dispatch_unknown: not running, not resent, settled by the run's report", async () => {
    const t = setup();
    const lease = await planned(t);
    t.next["agent.prompt"]!.push(new GatewayError("herdr_timeout", "herdr agent.prompt timed out"));
    await expect(t.g.handle("prompt_agent", { target: "worker-a", text: "go", task: { objective: "demo", id: "build" }, lease })).rejects.toMatchObject({ code: "herdr_timeout" });
    expect(t.prompts()).toEqual([]);
    const build = t.coord().objectives.demo.tasks.build;
    expect(build).toMatchObject({ status: "queued", protocol: "dispatch_unknown", binding: { dispatch: { state: "unknown" } } });
    const resume: any = await t.g.handle("coord_snapshot", { objective: "demo", view: "resume" });
    expect(resume.objectives[0].pending_transitions.map((x: any) => [x.task, x.kind])).toContainEqual(["build", "dispatch_unknown"]);
    // If the prompt did land, the run reports with its token and that settles it.
    await t.g.handle("coord_report", { token: build.binding.token, status: "executing" });
    expect(t.coord().objectives.demo.tasks.build).toMatchObject({ status: "executing", protocol: null, binding: { dispatch: { state: "delivered" } } });
  });

  test("a report that lands while the prompt is in flight is kept even if the send then fails", async () => {
    const t = setup();
    const lease = await planned(t);
    t.next["agent.prompt"]!.push(async () => {
      // The agent got the text and reported before Herdr answered.
      const token = t.coord().objectives.demo.tasks.build.pending.binding.token;
      await t.g.handle("coord_report", { token, report_id: "early", evidence: ["already working"] });
      await t.g.request("coord_update", { objective: "demo", lease, tasks: [{ id: "build", next_action: "keep going" }] });
      throw new GatewayError("agent_busy", "late refusal");
    });
    await expect(t.g.handle("prompt_agent", { target: "worker-a", text: "go", task: { objective: "demo", id: "build" }, lease })).rejects.toMatchObject({ code: "agent_busy" });
    expect(t.coord().objectives.demo.tasks.build).toMatchObject({ status: "executing", evidence: ["already working"], next_action: "keep going", binding: { pane_id: "w1:p1", dispatch: { state: "delivered" } } });
  });

  test("a refused re-prompt of a bound run keeps its binding and the reports that came in meanwhile", async () => {
    const t = setup();
    const lease = await planned(t);
    await t.g.handle("prompt_agent", { target: "worker-a", text: "go", task: { objective: "demo", id: "build" }, lease });
    const token = t.tokenIn(t.prompts()[0]!)!;
    const before = t.coord().objectives.demo.tasks.build.binding;
    t.next["agent.prompt"]!.push(async () => {
      await t.g.handle("coord_report", { token, evidence: ["mid-flight"] });
      throw new GatewayError("agent_busy", "busy");
    });
    t.agents[0].agent_status = "idle";
    await expect(t.g.handle("prompt_agent", { target: "worker-a", text: "more" })).rejects.toMatchObject({ code: "agent_busy" });
    const build = t.coord().objectives.demo.tasks.build;
    expect(build.evidence).toEqual(["mid-flight"]);
    expect(build.binding).toMatchObject({ id: before.id, prompted_at: before.prompted_at, dispatch: before.dispatch });
  });

  test("execution needs dependencies complete, named or implicit; binding without a prompt is allowed; one-off prompts unchanged", async () => {
    const t = setup();
    const lease = await planned(t);
    await expect(t.g.handle("prompt_agent", { target: "worker-b", text: "ship", task: { objective: "demo", id: "ship" }, lease })).rejects.toMatchObject({ code: "deps_unmet" });
    expect(t.prompts()).toEqual([]);
    // Preallocated with no prompt (spawn_agent without prompt does this).
    const { dispatchSlice } = await import("../gateway/coord-ops.ts");
    dispatchSlice(t.g, t.agents[1], { task: { objective: "demo", id: "ship" }, lease }, "", false);
    expect(t.coord().objectives.demo.tasks.ship).toMatchObject({ status: "queued", binding: { pane_id: "w1:p2" } });
    // An ordinary prompt to that pane would start it: refused the same way.
    await expect(t.g.handle("prompt_agent", { target: "worker-b", text: "start shipping" })).rejects.toMatchObject({ code: "deps_unmet" });
    expect(t.prompts()).toEqual([]);
    await t.g.handle("prompt_agent", { target: "plain", text: "summarise the last change" });
    expect(t.prompts()).toEqual(["summarise the last change"]);
  });

  test("steer: a refused send drops the pending binding; a failure after typing is unknown", async () => {
    const t = setup();
    const lease = await planned(t);
    t.agents[0].agent_status = "working";
    t.next["pane.send_input"]!.push(new GatewayError("pane_not_found", "no such pane"));
    await expect(t.g.handle("steer_agent", { target: "worker-a", text: "also do x", task: { objective: "demo", id: "build" }, lease })).rejects.toMatchObject({ code: "pane_not_found" });
    expect(t.coord().objectives.demo.tasks.build).toMatchObject({ binding: null, pending: null, status: "queued" });
    t.next["agent.send_keys"]!.push(new GatewayError("herdr_closed", "closed"));
    await expect(t.g.handle("steer_agent", { target: "worker-a", text: "also do x", task: { objective: "demo", id: "build" }, lease })).rejects.toMatchObject({ code: "herdr_closed" });
    expect(t.coord().objectives.demo.tasks.build).toMatchObject({ status: "queued", protocol: "dispatch_unknown", binding: { dispatch: { state: "unknown" } } });
    // In doubt: nothing more goes to that pane until the supervisor resolves it.
    await expect(t.g.handle("steer_agent", { target: "worker-a", text: "and y", lease })).rejects.toMatchObject({ code: "dispatch_unknown" });
    await t.g.request("coord_update", { objective: "demo", lease, tasks: [{ id: "build", dispatch: "lost" }] });
    const ok: any = await t.g.handle("steer_agent", { target: "worker-a", text: "and y", lease });
    expect(ok.dispatch).toMatchObject({ state: "delivered" });
    expect(t.coord().objectives.demo.tasks.build).toMatchObject({ status: "executing", protocol: null });
  });
});

describe("4. idempotent commands and the pane fence (review P2s)", () => {
  test("a retry with the same command_id after an ambiguous failure is not sent again", async () => {
    const t = setup();
    const lease = await planned(t);
    // Herdr took the prompt, then the connection broke before it answered.
    t.next["agent.prompt"]!.push(async () => { t.sent.push({ method: "agent.prompt", text: "landed" }); throw new GatewayError("herdr_closed", "closed"); });
    const ask = { target: "worker-a", text: "go", task: { objective: "demo", id: "build" }, lease, command_id: "client-command-1" };
    await expect(t.g.handle("prompt_agent", ask)).rejects.toMatchObject({ code: "herdr_closed" });
    await expect(t.g.handle("prompt_agent", ask)).rejects.toMatchObject({ code: "dispatch_unknown" });
    await expect(t.g.handle("prompt_agent", { ...ask, command_id: "client-command-2" })).rejects.toMatchObject({ code: "dispatch_unknown" });
    await expect(t.g.handle("prompt_agent", { target: "worker-a", text: "plain question" })).rejects.toMatchObject({ code: "dispatch_unknown" });
    expect(t.prompts()).toEqual(["landed"]);
    expect(t.coord().commands["client-command-1"]).toMatchObject({ state: "unknown", task: "build" });
    // The supervisor read the agent: it has the prompt. A retry now returns the outcome.
    await t.g.request("coord_update", { objective: "demo", lease, tasks: [{ id: "build", dispatch: "delivered" }] });
    expect(t.coord().objectives.demo.tasks.build).toMatchObject({ status: "executing", protocol: null });
    const again: any = await t.g.handle("prompt_agent", ask);
    expect(again).toMatchObject({ duplicate: true, dispatch: { command_id: "client-command-1", state: "delivered" } });
    await expect(t.g.handle("prompt_agent", { ...ask, text: "something else" })).rejects.toMatchObject({ code: "command_conflict" });
    expect(t.prompts()).toEqual(["landed"]);
    // A one-off prompt to an unbound agent is unchanged, command_id or not.
    await t.g.handle("prompt_agent", { target: "plain", text: "hello", command_id: "one-off-1" });
    await t.g.handle("prompt_agent", { target: "plain", text: "hello", command_id: "one-off-1" });
    expect(t.prompts().slice(1)).toEqual(["hello", "hello"]);
  });

  test("through Gateway.request: a retry stamped minutes later is the same command, not a conflict", async () => {
    const t = setup();
    const lease = await planned(t);
    const ask = { target: "worker-a", text: "go", task: { objective: "demo", id: "build" }, lease, command_id: "client-command-7" };
    setSystemTime(new Date("2026-10-06T05:00:10Z"));
    t.next["agent.prompt"]!.push(async () => { t.sent.push({ method: "agent.prompt", text: "landed" }); throw new GatewayError("herdr_closed", "closed"); });
    await expect(t.g.request("prompt_agent", ask)).rejects.toMatchObject({ code: "herdr_closed" });
    setSystemTime(new Date("2026-10-06T05:07:40Z"));
    await expect(t.g.request("prompt_agent", ask)).rejects.toMatchObject({ code: "dispatch_unknown" });
    await t.g.request("coord_update", { objective: "demo", lease, tasks: [{ id: "build", dispatch: "delivered" }] });
    setSystemTime(new Date("2026-10-06T05:12:00Z"));
    const again: any = await t.g.request("prompt_agent", ask);
    expect(again).toMatchObject({ duplicate: true, dispatch: { command_id: "client-command-7", state: "delivered" } });
    await expect(t.g.request("prompt_agent", { ...ask, text: "go now" })).rejects.toMatchObject({ code: "command_conflict" });
    // The same text as a steer is another operation.
    t.agents[0].agent_status = "working";
    await expect(t.g.request("steer_agent", ask)).rejects.toMatchObject({ code: "command_conflict" });
    expect(t.prompts()).toEqual(["landed"]);
  });

  test("a prompt in flight holds the pane against other tasks and plain prompts; a late settle can't take it back", async () => {
    const t = setup();
    const lease = await planned(t);
    await t.g.request("coord_update", { objective: "demo", lease, tasks: [{ id: "docs", title: "Docs", owner: "worker-a" }] });
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    t.next["agent.prompt"]!.push(async () => { await held; });
    const a = t.g.handle("prompt_agent", { target: "worker-a", text: "build", task: { objective: "demo", id: "build" }, lease });
    await Bun.sleep(5);
    await expect(t.g.handle("prompt_agent", { target: "worker-a", text: "docs", task: { objective: "demo", id: "docs" }, lease })).rejects.toMatchObject({ code: "dispatch_in_flight" });
    await expect(t.g.handle("prompt_agent", { target: "worker-a", text: "plain" })).rejects.toMatchObject({ code: "dispatch_in_flight" });
    release();
    await a;
    const c = t.coord();
    expect(c.objectives.demo.tasks.build.status).toBe("executing");
    expect(c.objectives.demo.tasks.docs).toMatchObject({ status: "queued", binding: null });
    expect(c.current["w1:p1"]).toBe(c.objectives.demo.tasks.build.binding.id);
  });

  test("a gateway that died before settling leaves the pane held until the supervisor resolves it; the stale settle revives nothing", async () => {
    const t = setup();
    const lease = await planned(t);
    await t.g.request("coord_update", { objective: "demo", lease, tasks: [{ id: "docs", title: "Docs", owner: "worker-a" }] });
    const { dispatchSlice } = await import("../gateway/coord-ops.ts");
    // Prepared, then the process died: no settle ever ran.
    const orphan: any = dispatchSlice(t.g, t.agents[0], { task: { objective: "demo", id: "build" }, lease }, "build");
    await expect(t.g.handle("prompt_agent", { target: "worker-a", text: "plain" })).rejects.toMatchObject({ code: "dispatch_in_flight" });
    await t.g.request("coord_update", { objective: "demo", lease, tasks: [{ id: "build", dispatch: "lost" }] });
    await t.g.handle("prompt_agent", { target: "worker-a", text: "docs", task: { objective: "demo", id: "docs" }, lease });
    orphan.settle("delivered");
    const c = t.coord();
    expect(c.objectives.demo.tasks.build).toMatchObject({ status: "queued", binding: null, pending: null });
    expect(c.current["w1:p1"]).toBe(c.objectives.demo.tasks.docs.binding.id);
  });
});

describe("wait: true timeouts on a bound prompt (frozen review delta)", () => {
  test("herdr_timeout (no answer) is unknown: not submitted, not working, and not resent", async () => {
    const t = setup();
    const lease = await planned(t);
    t.next["agent.prompt"]!.push(async () => { t.sent.push({ method: "agent.prompt", text: "landed?" }); throw new GatewayError("herdr_timeout", "herdr agent.prompt timed out"); });
    const ask = { target: "worker-a", text: "go", wait: true, timeout_ms: 1000, task: { objective: "demo", id: "build" }, lease, command_id: "wait-1" };
    const out: any = await t.g.request("prompt_agent", ask);
    expect(out).toMatchObject({ submitted: null, timed_out: true, status: "unknown", dispatch: { command_id: "wait-1", state: "unknown" } });
    expect(t.coord().objectives.demo.tasks.build).toMatchObject({ status: "queued", protocol: "dispatch_unknown", binding: { dispatch: { state: "unknown" }, prompted_at: null } });
    await expect(t.g.request("prompt_agent", ask)).rejects.toMatchObject({ code: "dispatch_unknown" });
    expect(t.prompts()).toEqual(["landed?"]);
  });

  test("Herdr's own timeout (it took the prompt, the wait ran out) stays delivered and working", async () => {
    const t = setup();
    const lease = await planned(t);
    t.next["agent.prompt"]!.push(async () => { t.sent.push({ method: "agent.prompt", text: "landed" }); throw new GatewayError("timeout", "wait timed out"); });
    const ask = { target: "worker-a", text: "go", wait: true, timeout_ms: 1000, task: { objective: "demo", id: "build" }, lease, command_id: "wait-2" };
    const out: any = await t.g.request("prompt_agent", ask);
    expect(out).toMatchObject({ submitted: true, timed_out: true, status: "working", dispatch: { command_id: "wait-2", state: "delivered" } });
    expect(t.coord().objectives.demo.tasks.build).toMatchObject({ status: "executing", protocol: null, binding: { dispatch: { state: "delivered" } } });
    expect(await t.g.request("prompt_agent", ask)).toMatchObject({ duplicate: true, dispatch: { state: "delivered" } });
    expect(t.prompts()).toEqual(["landed"]);
  });
});

describe("binding transitions are notified with the change that made them (frozen review deltas)", () => {
  // build holds e2e from worker-a's run; rebinding it to worker-b makes that lease stale.
  async function holding(t: ReturnType<typeof setup>) {
    const lease = await planned(t);
    await t.g.handle("prompt_agent", { target: "worker-a", text: "build", task: { objective: "demo", id: "build" }, lease });
    await t.g.handle("coord_report", { token: t.tokenIn(t.prompts()[0]!)!, acquire: ["e2e"] });
    t.g.state.takeTold();
    return lease;
  }
  const staleTold = (t: ReturnType<typeof setup>) => t.g.state.takeTold().filter((m: any) => m.transition?.kind === "resource_stale");
  const expectOnce = (t: ReturnType<typeof setup>, told: any[], lease: string) => {
    const tr = t.coord().objectives.demo.transitions.filter((x: any) => x.kind === "resource_stale");
    expect(tr).toHaveLength(1);
    expect(told).toEqual([expect.objectContaining({ objective: "demo", recipient_lease: lease, event_id: `coord:demo:${tr[0].seq}`, transition: { task: "build", seq: tr[0].seq, kind: "resource_stale" } })]);
  };

  test("a report with the new run's token before the prompt settles", async () => {
    const t = setup();
    const lease = await holding(t);
    t.next["agent.prompt"]!.push(async () => {
      await t.g.handle("coord_report", { token: t.coord().objectives.demo.tasks.build.pending.binding.token, evidence: ["started on b"] });
    });
    await t.g.handle("prompt_agent", { target: "worker-b", text: "take over", task: { objective: "demo", id: "build" }, lease });
    expect(t.coord().resources.e2e.stale_since).not.toBeNull();
    expectOnce(t, staleTold(t), lease);
  });

  test("a send whose response is lost (dispatch_unknown)", async () => {
    const t = setup();
    const lease = await holding(t);
    t.next["agent.prompt"]!.push(new GatewayError("herdr_closed", "closed"));
    await expect(t.g.handle("prompt_agent", { target: "worker-b", text: "take over", task: { objective: "demo", id: "build" }, lease })).rejects.toMatchObject({ code: "herdr_closed" });
    const told = t.g.state.takeTold() as any[];
    expect(told.map((m) => m.transition?.kind).sort()).toEqual(["dispatch_unknown", "resource_stale"]);
    expectOnce(t, told.filter((m) => m.transition?.kind === "resource_stale"), lease);
  });

  test("a replacement bound with no prompt", async () => {
    const t = setup();
    const lease = await holding(t);
    const { dispatchSlice } = await import("../gateway/coord-ops.ts");
    dispatchSlice(t.g, t.agents[1], { task: { objective: "demo", id: "build" }, lease }, "", false);
    expectOnce(t, staleTold(t), lease);
  });
});

describe("prototype-sensitive ids (frozen review delta)", () => {
  test("__proto__ and other built-in names are refused before anything is sent or stored; safe ids replay after a reload", async () => {
    const t = setup();
    const lease = await planned(t);
    const ask = { target: "worker-a", text: "go", task: { objective: "demo", id: "build" }, lease };
    for (const id of ["__proto__", "constructor", "toString"]) {
      await expect(t.g.request("prompt_agent", { ...ask, command_id: id })).rejects.toMatchObject({ code: "invalid_params" });
    }
    expect(t.prompts()).toEqual([]);
    expect(t.coord().objectives.demo.tasks.build).toMatchObject({ binding: null, pending: null });
    await t.g.request("prompt_agent", { ...ask, command_id: "safe-1" });
    const token = t.tokenIn(t.prompts()[0]!)!;
    await expect(t.g.handle("coord_report", { token, report_id: "__proto__", evidence: ["x"] })).rejects.toMatchObject({ code: "invalid_params" });
    await expect(t.g.handle("coord_report", { token, report_id: "constructor", evidence: ["x"] })).rejects.toMatchObject({ code: "invalid_params" });
    await expect(t.g.request("coord_update", { objective: "demo", lease, tasks: [{ id: "constructor", title: "x" }] })).rejects.toMatchObject({ code: "invalid_params" });
    await expect(t.g.handle("coord_report", { token, acquire: ["constructor"] })).rejects.toMatchObject({ code: "invalid_params" });
    expect(Object.keys(t.coord().commands)).toEqual(["safe-1"]);
    // Persisted: a fresh gateway on the same state directory replays it without sending.
    const reloaded = new Gateway(t.g.cfg, (t.g as any).herdr);
    t.agents[0].agent_status = "idle";
    expect(await reloaded.request("prompt_agent", { ...ask, command_id: "safe-1" })).toMatchObject({ duplicate: true, dispatch: { command_id: "safe-1", state: "delivered" } });
    expect(t.prompts()).toHaveLength(1);
  });
});

describe("1 and 7 through the gateway", () => {
  test("get_agent and supervision see the pane's current task, never its verifying history", async () => {
    const t = setup();
    const lease = await planned(t);
    await t.g.request("coord_update", { objective: "demo", lease, tasks: [{ id: "docs", title: "Docs", owner: "worker-a" }] });
    await t.g.handle("prompt_agent", { target: "worker-a", text: "build", task: { objective: "demo", id: "build" }, lease });
    await t.g.handle("coord_report", { token: t.tokenIn(t.prompts()[0]!)!, result: { summary: "built" } });
    t.agents[0].agent_status = "idle";
    await t.g.handle("prompt_agent", { target: "worker-a", text: "docs", task: { objective: "demo", id: "docs" }, lease });
    const view: any = await t.g.handle("get_agent", { target: "worker-a" });
    expect(view.task).toMatchObject({ objective: "demo", id: "docs", status: "executing" });
    t.agents[0].agent_status = "idle";
    await t.g.handle("prompt_agent", { target: "worker-a", text: "continue" });
    expect(t.tokenIn(t.prompts().at(-1)!)).toBe(t.tokenIn(t.prompts()[1]!));
    expect(t.prompts().at(-1)).toContain("Task docs");
  });

  test("a heartbeat report moves neither version nor progress", async () => {
    const t = setup();
    const lease = await planned(t);
    await t.g.handle("prompt_agent", { target: "worker-a", text: "go", task: { objective: "demo", id: "build" }, lease });
    const token = t.tokenIn(t.prompts()[0]!)!;
    const a: any = await t.g.handle("coord_report", { token, status: "executing", evidence: ["e1"] });
    const b: any = await t.g.handle("coord_report", { token, status: "executing" });
    expect([b.task.version, b.task.progress]).toEqual([a.task.version, a.task.progress]);
  });
});
