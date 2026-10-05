// The opt-in turn contract through the gateway (docs/coordination.md): what Herdr
// receives, what the store keeps, and what a worker's token may do.
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { timing } from "../gateway/answer-ops.ts";
import { loadConfig, type HerdrCall } from "../gateway/config.ts";
import { Gateway } from "../gateway/gateway.ts";
import { TOOLS } from "../mcp/src/tools.ts";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function setup() {
  timing.key = timing.text = timing.settle = 0;
  const state = mkdtempSync(join(tmpdir(), "turn-"));
  dirs.push(state);
  const agents: any[] = [
    { pane_id: "w1:p1", name: "worker-a", agent: "claude", agent_status: "idle", cwd: "/srv/allowed/app", agent_session: { value: "sa" }, state_change_seq: 1 },
    { pane_id: "w1:p2", name: "worker-b", agent: "codex", agent_status: "idle", cwd: "/srv/allowed/app", agent_session: { value: "sb" }, state_change_seq: 1 },
    { pane_id: "w1:p3", name: "plain", agent: "claude", agent_status: "idle", cwd: "/srv/allowed/app", agent_session: { value: "sc" }, state_change_seq: 1 },
  ];
  const prompts: Array<{ target: string; text: string }> = [];
  const herdr: HerdrCall = async (method, params: any) => {
    if (method === "agent.list") return { agents };
    if (method === "agent.get") return { agent: agents.find((a) => a.pane_id === params.target || a.name === params.target) };
    if (method === "session.snapshot") return { snapshot: { agents, panes: [] } };
    if (method === "agent.prompt") {
      prompts.push({ target: params.target, text: params.text });
      const a = agents.find((x) => x.pane_id === params.target)!;
      a.agent_status = "working";
      a.state_change_seq++;
      return { agent: { ...a } };
    }
    return { read: { text: "" } };
  };
  const g = new Gateway(loadConfig({ allowedRoots: ["/srv/allowed"], stateDir: state, leases: true }), herdr);
  const coord = () => JSON.parse(readFileSync(join(state, "coord.json"), "utf8"));
  const tokenIn = (text: string) => /--token (wdt_[A-Za-z0-9_-]+)/.exec(text)?.[1];
  return { g, state, agents, prompts, coord, tokenIn };
}
const plan = (lease: string) => ({
  objective: "demo", title: "Demo objective", lease,
  tasks: [
    { id: "build", title: "Build it", owner: "worker-a", acceptance: ["tests pass"] },
    { id: "ship", title: "Ship it", owner: "worker-b", deps: ["build"], status: "waiting_dependency", blocker_kind: "dependency" },
  ],
});

describe("turn contract", () => {
  test("one_off_prompt_unchanged: an unbound agent gets exactly the text sent, and no coordination state appears", async () => {
    const { g, prompts, state } = setup();
    await g.handle("prompt_agent", { target: "plain", text: "summarise the last change" });
    expect(prompts).toEqual([{ target: "w1:p3", text: "summarise the last change" }]);
    expect(() => readFileSync(join(state, "coord.json"))).toThrow();
    // With an objective in the store, an agent outside it is still untouched.
    const { lease } = (await g.request("claim_agents", { label: "sup", targets: [] })) as any;
    await g.request("coord_update", plan(lease));
    prompts.length = 0;
    await g.handle("prompt_agent", { target: "plain", text: "again" });
    expect(prompts[0]!.text).toBe("again");
  });

  test("bound_prompt_gets_slice_and_report_persists, by token alone (no HERDR_PANE_ID)", async () => {
    const { g, prompts, coord, tokenIn } = setup();
    const { lease } = (await g.request("claim_agents", { label: "sup", targets: ["worker-a"] })) as any;
    await g.request("coord_update", plan(lease));
    const res: any = await g.handle("prompt_agent", { target: "worker-a", text: "start on build", task: { objective: "demo", id: "build" }, lease });
    expect(res.task_slice).toBe(true);
    const text = prompts[0]!.text;
    expect(text.startsWith("start on build\n\n[WorkDone task] objective demo")).toBe(true);
    expect(text).toContain("Acceptance:\n- tests pass");
    expect(text).toMatch(/\.local\/bin\/workdone-task --token wdt_/);
    const token = tokenIn(text)!;
    expect(coord().objectives.demo.tasks.build).toMatchObject({ status: "executing", generation: 1, binding: { pane_id: "w1:p1", session: "sa" } });
    const out: any = await g.handle("coord_report", { token, report_id: "r1", evidence: ["unit tests pass"] });
    expect(out.task).toMatchObject({ id: "build", evidence: ["unit tests pass"] });
    expect(out.task.binding).toBeUndefined();
    const again: any = await g.handle("coord_report", { token, report_id: "r1", evidence: ["ignored"] });
    expect(again.duplicate).toBe(true);
    expect(coord().objectives.demo.tasks.build.evidence).toEqual(["unit tests pass"]);
    // A later prompt to the bound agent carries the current slice without asking again.
    prompts.length = 0;
    await g.handle("prompt_agent", { target: "worker-a", text: "continue" });
    expect(prompts[0]!.text).toContain("Evidence so far: unit tests pass");
    expect(tokenIn(prompts[0]!.text)).toBe(token);
  });

  test("binding needs the objective's lease; a bound task needs its token, not the pane", async () => {
    const { g, tokenIn, prompts } = setup();
    const { lease } = (await g.request("claim_agents", { label: "sup", targets: ["worker-a"] })) as any;
    const { lease: other } = (await g.request("claim_agents", { label: "other", targets: ["worker-b"] })) as any;
    await g.request("coord_update", plan(lease));
    await expect(g.handle("prompt_agent", { target: "worker-b", text: "x", task: { objective: "demo", id: "ship" }, lease: other })).rejects.toMatchObject({ code: "not_your_objective" });
    await g.handle("prompt_agent", { target: "worker-a", text: "go", task: { objective: "demo", id: "build" }, lease });
    await expect(g.handle("coord_report", { pane_id: "w1:p1", status: "blocked", blocker: "x", blocker_kind: "human" })).rejects.toMatchObject({ code: "token_required" });
    expect(tokenIn(prompts.at(-1)!.text)).toBeDefined();
  });

  test("stale_generation_rejected: a rebind or a restarted session can't write with the old token", async () => {
    const { g, agents, prompts, tokenIn } = setup();
    const { lease } = (await g.request("claim_agents", { label: "sup", targets: ["worker-a"] })) as any;
    await g.request("coord_update", plan(lease));
    await g.handle("prompt_agent", { target: "worker-a", text: "go", task: { objective: "demo", id: "build" }, lease });
    const first = tokenIn(prompts.at(-1)!.text)!;
    agents[0].agent_status = "idle";
    await g.handle("prompt_agent", { target: "worker-a", text: "again", task: { objective: "demo", id: "build" }, lease });
    const second = tokenIn(prompts.at(-1)!.text)!;
    expect(second).not.toBe(first);
    await expect(g.handle("coord_report", { token: first, evidence: ["late"] })).rejects.toMatchObject({ code: "stale_binding" });
    agents[0].agent_session = { value: "restarted" };
    await expect(g.handle("coord_report", { token: second, evidence: ["after restart"] })).rejects.toMatchObject({ code: "stale_binding" });
  });

  test("missing_report_not_complete through the watcher, with a recoverable transition and a hint", async () => {
    const { g, agents, coord } = setup();
    const { lease } = (await g.request("claim_agents", { label: "sup", targets: ["worker-a"] })) as any;
    await g.request("coord_update", plan(lease));
    await g.handle("prompt_agent", { target: "worker-a", text: "go", task: { objective: "demo", id: "build" }, lease });
    g.state.manage("w1:p1", { name: "worker-a", cwd: "/srv/allowed/app" }, { ...agents[0], agent_status: "working" });
    agents[0].agent_status = "done";
    agents[0].state_change_seq++;
    await g.handle("watch_poll", {});
    expect(coord().objectives.demo.tasks.build).toMatchObject({ status: "executing", protocol: "missing_report" });
    const resume: any = await g.handle("coord_snapshot", { objective: "demo", view: "resume" });
    expect(resume.objectives[0].protocol.map((t: any) => [t.id, t.protocol])).toEqual([["build", "missing_report"]]);
    expect(g.state.hasTold()).toBe(true);
  });

  test("lost_tell_recovered_from_resume_view; ack_seq clears it", async () => {
    const { g, prompts, tokenIn } = setup();
    const { lease } = (await g.request("claim_agents", { label: "sup", targets: ["worker-a"] })) as any;
    await g.request("coord_update", plan(lease));
    await g.handle("prompt_agent", { target: "worker-a", text: "go", task: { objective: "demo", id: "build" }, lease });
    await g.handle("coord_report", { token: tokenIn(prompts[0]!.text)!, result: { summary: "built", commit: "abc1234" } });
    g.state.takeTold(); // the notification was lost
    const r: any = await g.handle("coord_snapshot", { objective: "demo", view: "resume" });
    const pending = r.objectives[0].pending_transitions;
    expect(pending.map((t: any) => t.kind)).toEqual(["needs_acceptance"]);
    await g.request("coord_update", { objective: "demo", lease, ack_seq: pending[0].seq, tasks: [{ id: "build", status: "complete" }] });
    const after: any = await g.handle("coord_snapshot", { objective: "demo", view: "resume" });
    // Acknowledged, and completing build made ship ready: one new transition.
    expect(after.objectives[0].pending_transitions.map((t: any) => [t.task, t.kind])).toEqual([["ship", "ready"]]);
    expect(after.objectives[0].ready.map((t: any) => t.id)).toEqual(["ship"]);
  });

  test("two bound workers run in parallel; spawn can bind without a prompt", async () => {
    const { g, prompts, tokenIn, coord } = setup();
    const { lease } = (await g.request("claim_agents", { label: "sup", targets: ["worker-a", "worker-b"] })) as any;
    await g.request("coord_update", { ...plan(lease), tasks: [{ id: "build", title: "Build", owner: "worker-a" }, { id: "docs", title: "Docs", owner: "worker-b" }] });
    await g.handle("prompt_agent", { target: "worker-a", text: "a", task: { objective: "demo", id: "build" }, lease });
    await g.handle("prompt_agent", { target: "worker-b", text: "b", task: { objective: "demo", id: "docs" }, lease });
    await g.handle("coord_report", { token: tokenIn(prompts[0]!.text)!, evidence: ["a1"] });
    await g.handle("coord_report", { token: tokenIn(prompts[1]!.text)!, evidence: ["b1"] });
    expect([coord().objectives.demo.tasks.build.evidence, coord().objectives.demo.tasks.docs.evidence]).toEqual([["a1"], ["b1"]]);
    expect(TOOLS.spawn_agent!.input.task).toBeDefined();
    expect(TOOLS.prompt_agent!.input.task).toBeDefined();
  });

  test("workdone-task: --token is the identity; HERDR_PANE_ID only without one; JSON can't smuggle either", () => {
    const state = mkdtempSync(join(tmpdir(), "cli-"));
    dirs.push(state);
    const launcher = join(state, "launcher.sh");
    writeFileSync(launcher, "#!/bin/sh\ncat\n");
    chmodSync(launcher, 0o755);
    const run = (args: string[], env: Record<string, string> = {}) => Bun.spawnSync(["sh", "scripts/task.sh", ...args], { env: { PATH: process.env.PATH!, HOME: process.env.HOME!, HERDR_GATEWAY_LAUNCHER: launcher, ...env }, cwd: join(import.meta.dir, "..") });
    const t = "wdt_" + "a".repeat(32);
    const sent = JSON.parse(run(["--token", t, '{"status":"executing","token":"wdt_other","pane_id":"w9:p9"}']).stdout.toString());
    expect(sent).toEqual({ id: "task", op: "coord_report", params: { status: "executing", token: t } });
    expect(JSON.parse(run([], { WORKDONE_TASK_TOKEN: t }).stdout.toString()).params).toEqual({ token: t });
    expect(JSON.parse(run([], { HERDR_PANE_ID: "w1:p1" }).stdout.toString()).params).toEqual({ pane_id: "w1:p1" });
    expect(run([]).exitCode).toBe(2);
    expect(run(["--token", t, "not json"]).exitCode).toBe(2);
  });
});
