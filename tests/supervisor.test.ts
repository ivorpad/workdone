import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type HerdrCall } from "../gateway/config.ts";
import { Gateway } from "../gateway/gateway.ts";
import { SUPERVISOR_ACTIONS, supervise, type SupervisorObservation } from "../gateway/supervisor.ts";
import { FANOUT, TOOLS } from "../mcp/src/tools.ts";
import { SESSION, gitAgent } from "./git-agent.ts";

const at = (turn: string) => `2026-10-05T12:0${turn}:00.000Z`;
const sample = (turn: string, extra: Partial<SupervisorObservation> = {}): SupervisorObservation =>
  ({ status: "working", session: "s1", turn, at: at(turn), commit: "abc", diff: "digest", activity: "review", ...extra });
const action = (d: ReturnType<typeof supervise>) => d.recommendations[0]!.action;
const nudgedAfter = (turn: string) => [{ at: `2026-10-05T12:0${turn}:30.000Z`, session: "s1", after_turn: turn }];

describe("supervisor policy", () => {
  test("time and repeated polls alone never establish a stall", () => {
    const current = sample("1");
    expect(supervise(current, [current, current]).state).toBe("unknown");
    expect(action(supervise({ status: "working" }))).toBe("verify_checkpoint");
  });
  test("new commit or diff overrides repeated activity", () => {
    for (const evidence of [{ commit: "def" }, { diff: "new digest" }]) {
      const d = supervise(sample("3", evidence), [sample("1"), sample("2")]);
      expect(d.state).toBe("progressing");
      expect(action(d)).toBe("continue");
    }
  });
  test("a working agent whose files changed since its last turn is progressing, whatever its history", () => {
    const d = supervise({ status: "working", session: "s1", commit: "abc", diff: "moved" }, [sample("1"), sample("2"), sample("3")]);
    expect(d.state).toBe("progressing");
    expect(d.recommendations[0]!.evidence).toEqual(["diff: digest -> moved"]);
  });
  test("status, sequence and turn progression count without git evidence", () => {
    const previous = { status: "working", session: "s1", seq: 1, turn: "1" };
    for (const current of [{ ...previous, seq: 2 }, { ...previous, status: "unknown" }, { ...previous, turn: "2" }]) {
      expect(action(supervise(current, [previous]))).toBe("continue");
    }
  });
  test("two no-progress turns with the same answer are a loop; the first advice is the one nudge", () => {
    const d = supervise(sample("3"), [sample("1"), sample("2")]);
    expect(d.state).toBe("repetitive_loop");
    expect(action(d)).toBe("nudge_ship_slice");
    expect(d.recommendations[0]!.evidence).toContain("repeated answer digest=review");
  });
  test("two no-progress turns with different answers are a stall; the first advice is the one nudge", () => {
    const d = supervise(sample("3", { activity: "test" }), [sample("1"), sample("2", { activity: "edit" })]);
    expect(d.state).toBe("stalled");
    expect(action(d)).toBe("nudge_ship_slice");
  });
  test("exactly one nudge per session: wait for its turn, then hand off or change model, never nudge again", () => {
    const stalled = [sample("1", { activity: "a" }), sample("2", { activity: "b" })];
    // Nudged after turn 2 and nothing finished since: wait.
    expect(action(supervise(sample("2", { activity: "b" }), stalled.concat(sample("3", { activity: "c", at: "2026-10-05T12:01:59.000Z" })), { nudges: nudgedAfter("2") }))).not.toBe("nudge_ship_slice");
    const waiting = supervise({ status: "working", session: "s1", commit: "abc", diff: "digest" }, [...stalled, sample("3", { activity: "c" })], { nudges: [{ at: "2026-10-05T12:03:30.000Z", session: "s1" }] });
    expect(action(waiting)).toBe("continue");
    expect(waiting.state).toBe("stalled");
    // The nudged turn ended without progress: a stall hands off, a loop changes model or effort.
    const handoff = supervise(sample("4", { activity: "d" }), [...stalled, sample("3", { activity: "c" })], { nudges: nudgedAfter("3") });
    expect([handoff.state, action(handoff)]).toEqual(["stalled", "handoff"]);
    const loop = supervise(sample("4"), [sample("2"), sample("3")], { nudges: nudgedAfter("3") });
    expect([loop.state, action(loop)]).toEqual(["repetitive_loop", "lower_or_change_model_effort"]);
    // A nudge in another session (a restart) does not count against this one.
    expect(action(supervise(sample("4"), [sample("2"), sample("3")], { nudges: [{ ...nudgedAfter("3")[0]!, session: "s0" }] }))).toBe("nudge_ship_slice");
  });
  test("the nudged turn landing a commit is progress, and a later stall in that session is never nudged again", () => {
    const history = [sample("1"), sample("2"), sample("3")];
    expect(action(supervise(sample("4", { commit: "def" }), history, { nudges: nudgedAfter("3") }))).toBe("continue");
    const later = [sample("4", { commit: "def" }), sample("5", { commit: "def" })];
    expect(action(supervise(sample("6", { commit: "def" }), later, { nudges: nudgedAfter("3") }))).toBe("lower_or_change_model_effort");
  });
  test("unknown artifacts, session changes and short histories do not establish stalls", () => {
    for (const current of [sample("3", { diff: undefined }), sample("3", { commit: undefined }), sample("3", { session: "s2" }), sample("3", { session: undefined })]) {
      expect(["stalled", "repetitive_loop"]).not.toContain(supervise(current, [sample("1"), sample("2")]).state);
    }
    expect(supervise(sample("2"), [sample("1")]).state).toBe("progressing");
  });
  test("review churn goes back to the coordinator, and no advice ever creates a reviewer or retries", () => {
    for (const activity of ["review", "different review"]) {
      expect(action(supervise(sample("3", { activity }), [sample("1"), sample("2")], { role: "reviewer" }))).toBe("handoff");
    }
    expect(SUPERVISOR_ACTIONS.some((a) => /review|spawn|retry|restart/.test(a))).toBe(false);
  });
  test("ask_owner requires explicit owner necessity, not a generic question", () => {
    expect(action(supervise(sample("3", { attention: "question" })))).toBe("handoff");
    expect(action(supervise(sample("3", { attention: "dialog" })))).toBe("handoff");
    expect(action(supervise(sample("3", { attention: "question", owner_required: true })))).toBe("ask_owner");
  });
  test("settled agents require verification and a running prompt prevents readiness", () => {
    for (const status of ["idle", "done"]) {
      expect(supervise({ status }).state).toBe("checkpoint_ready");
      expect(action(supervise({ status }))).toBe("verify_checkpoint");
      expect(supervise({ status, prompt_running: true }).state).toBe("unknown");
    }
  });
  test("prune_close only once a commit beyond the start landed, the tree is clean and no result is owed", () => {
    const settled = (extra: Partial<SupervisorObservation> = {}) => ({ status: "idle", session: "s1", commit: "def", clean: true, ...extra });
    const baseline = { commit: "abc" };
    const landed = supervise(settled(), [], { baseline });
    expect([landed.state, action(landed)]).toEqual(["landed", "prune_close"]);
    for (const [obs, opts, why] of [
      [settled({ commit: "abc" }), { baseline }, "no commit beyond the start"],
      [settled({ clean: false }), { baseline }, "uncommitted changes"],
      [settled(), { baseline, result_pending: true }, "result is still owed"],
      [settled(), {}, "no baseline"],
      [settled({ status: "working" }), { baseline }, null],
      [settled({ prompt_running: true }), { baseline }, null],
    ] as const) {
      const d = supervise(obs, [], opts);
      expect(action(d)).not.toBe("prune_close");
      if (why) expect(d.recommendations[0]!.reasons[0]).toContain(why);
    }
  });
  test("every recommendation carries evidence and reasons, without changing inputs", () => {
    const current = Object.freeze(sample("3"));
    const history = Object.freeze([Object.freeze(sample("1")), Object.freeze(sample("2"))]);
    const first = supervise(current, history);
    expect(supervise(current, history)).toEqual(first);
    for (const r of first.recommendations) {
      expect(r.evidence.length).toBeGreaterThan(0);
      expect(r.reasons.length).toBeGreaterThan(0);
    }
  });
});

test("supervisor_status is scoped, read-only, lease-free and available through MCP", async () => {
  const dir = mkdtempSync(join(tmpdir(), "supervisor-"));
  try {
    const cfg = loadConfig({ allowedRoots: ["/srv/allowed"], stateDir: dir, leases: true });
    const agents = [
      { pane_id: "w1:p1", agent: "codex", agent_status: "working", cwd: "/srv/allowed", agent_session: { value: "s1" }, state_change_seq: 2 },
      { pane_id: "w1:p2", agent: "codex", agent_status: "done", cwd: "/srv/allowed" },
      { pane_id: "w1:p3", agent: "codex", agent_status: "blocked", cwd: "/srv/allowed" },
      { pane_id: "w1:p4", agent: "codex", agent_status: "working", cwd: "/srv/secret" },
      { pane_id: "w1:p5", agent: "codex", agent_status: "working", cwd: "/srv/allowed" },
    ];
    const calls: string[] = [];
    const herdr: HerdrCall = async (method) => {
      calls.push(method);
      if (method === "session.snapshot") return { snapshot: { agents, panes: [{ pane_id: "w1:p6", cwd: "/srv/allowed", agent: null }] } };
      if (method === "agent.list") return { agents };
      if (method === "agent.read") return { text: "" };
      throw new Error(`Unexpected call: ${method}`);
    };
    const g = new Gateway(cfg, herdr);
    for (const a of agents.slice(0, 4)) g.state.manage(a.pane_id, { name: null, cwd: a.cwd }, { ...a, state_change_seq: 1 });
    g.state.manage("w1:p6", { name: null, cwd: "/srv/allowed" }, { agent_status: "background" });
    const files = () => Object.fromEntries(readdirSync(dir).map((f) => [f, readFileSync(join(dir, f), "utf8")]));
    const before = files();
    const res: any = await g.request("supervisor_status", {});
    expect(res.agents.map((a: any) => a.pane_id)).toEqual(["w1:p1", "w1:p2", "w1:p3", "w1:p6"]);
    expect(res.agents.map((a: any) => a.state)).toEqual(["progressing", "checkpoint_ready", "blocked", "unknown"]);
    expect(files()).toEqual(before);
    expect(calls.every((m) => ["session.snapshot", "agent.list", "agent.read"].includes(m))).toBe(true);
    expect(TOOLS.supervisor_status!.annotations.readOnlyHint).toBe(true);
    expect(FANOUT.has("supervisor_status")).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("supervisor on real turn evidence", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
  const setup = (extra: Record<string, unknown> = {}) => {
    const t = gitAgent(extra);
    dirs.push(t.root);
    return t;
  };
  const status = async (t: ReturnType<typeof setup>) => ((await t.gw.handle("supervisor_status", {})) as any).agents[0];
  const turn = async (t: ReturnType<typeof setup>, answer: string) => { t.finish(answer); await t.poll(); };

  test("two finished turns with no new commit or diff: one nudge, refused the second time, then a handoff", async () => {
    const t = setup();
    await t.gw.handle("watch_agent", { target: "w1:p1" });
    await turn(t, "Looking into it.");
    expect((await status(t)).state).toBe("checkpoint_ready");
    await turn(t, "Still reading the code.");
    await turn(t, "Considering options.");
    const stalled = await status(t);
    expect([stalled.state, stalled.recommendations[0].action]).toEqual(["stalled", "nudge_ship_slice"]);
    expect(stalled.evidence.turns).toHaveLength(3);
    expect(stalled.recommendations[0].evidence.some((e: string) => e.startsWith(`unchanged commit=${t.git("rev-parse", "HEAD").slice(0, 12)}`))).toBe(true);

    const nudged: any = await t.gw.handle("supervisor_nudge", { target: "w1:p1" });
    expect(nudged).toMatchObject({ nudged: true, via: "prompt_agent", state: "stalled" });
    const prompts = t.sent.filter(([m]) => m === "agent.prompt").map(([, p]) => p.text);
    expect(prompts).toEqual([expect.stringContaining("RESULT:")]);
    // Its turn has not ended: no second nudge, and nothing else to do yet.
    await expect(t.gw.handle("supervisor_nudge", { target: "w1:p1" })).rejects.toMatchObject({ code: "nudge_not_recommended" });
    await turn(t, "I am not sure what to do.");
    const after = await status(t);
    expect([after.state, after.recommendations[0].action]).toEqual(["stalled", "handoff"]);
    await expect(t.gw.handle("supervisor_nudge", { target: "w1:p1" })).rejects.toMatchObject({ code: "nudge_not_recommended" });
    expect(t.sent.filter(([m]) => m === "agent.prompt")).toHaveLength(1);
    // The store itself refuses a second nudge for the session, whatever the caller saw.
    expect(t.gw.state.recordNudge("w1:p1", SESSION)).toBe(false);
  });

  test("an edit is progress; a landed commit with a clean tree is a prune recommendation", async () => {
    const t = setup();
    await t.gw.handle("watch_agent", { target: "w1:p1" });
    await turn(t, "Reading.");
    writeFileSync(join(t.repo, "a.txt"), "edited\n");
    await turn(t, "Edited a.txt.");
    t.agent.agent_status = "working";
    writeFileSync(join(t.repo, "a.txt"), "edited again\n");
    expect((await status(t)).state).toBe("progressing");
    t.git("commit", "-qam", "landed");
    await turn(t, "Committed.\nRESULT: landed");
    const landed = await status(t);
    expect([landed.state, landed.recommendations[0].action]).toEqual(["landed", "prune_close"]);
    expect(landed.recommendations[0].evidence).toContain("clean=true");
    // A dirty tree after the commit is not prunable.
    writeFileSync(join(t.repo, "b.txt"), "new\n");
    expect((await status(t)).recommendations[0].action).toBe("verify_checkpoint");
  });

  test("a reviewer's stall goes back to the coordinator and is never nudged", async () => {
    const t = setup();
    await t.gw.handle("watch_agent", { target: "w1:p1" });
    t.gw.state.updateWatched((w) => { w["w1:p1"]!.role = "reviewer"; });
    for (const a of ["Nit one.", "Nit two.", "Nit three."]) await turn(t, a);
    expect((await status(t)).recommendations[0].action).toBe("handoff");
    await expect(t.gw.handle("supervisor_nudge", { target: "w1:p1" })).rejects.toMatchObject({ code: "nudge_not_recommended" });
  });

  test("supervisor_nudge acts on an agent, so it needs this thread's lease and spends its one message per wake", async () => {
    const t = setup({ leases: true });
    await expect(t.gw.request("supervisor_nudge", { target: "w1:p1" })).rejects.toMatchObject({ code: "needs_lease" });
    expect(TOOLS.supervisor_nudge!.input.lease).toBeDefined();
    expect(TOOLS.supervisor_nudge!.annotations.readOnlyHint).toBe(false);
  });
});
