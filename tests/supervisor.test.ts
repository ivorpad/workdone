import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type HerdrCall } from "../gateway/config.ts";
import { Gateway } from "../gateway/gateway.ts";
import { supervise, type SupervisorObservation } from "../gateway/supervisor.ts";
import { FANOUT, TOOLS } from "../mcp/src/tools.ts";

const sample = (turn: string, extra: Partial<SupervisorObservation> = {}): SupervisorObservation =>
  ({ status: "working", session: "s1", turn, commit: "abc", diff: "digest", activity: "review", ...extra });
const action = (d: ReturnType<typeof supervise>) => d.recommendations[0]!.action;

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
  test("status, sequence and turn progression count without git evidence", () => {
    const previous = { status: "working", session: "s1", seq: 1, turn: "1" };
    for (const current of [{ ...previous, seq: 2 }, { ...previous, status: "unknown" }, { ...previous, turn: "2" }]) {
      expect(action(supervise(current, [previous]))).toBe("continue");
    }
  });
  test("three distinct turns with unchanged checkpoint establish a loop", () => {
    const d = supervise(sample("3"), [sample("1"), sample("2")]);
    expect(d.state).toBe("repetitive_loop");
    expect(action(d)).toBe("lower_or_change_model_effort");
  });
  test("three turns without a meaningful checkpoint suggest shipping a slice", () => {
    const d = supervise(sample("3", { activity: "test" }), [sample("1"), sample("2", { activity: "edit" })]);
    expect(d.state).toBe("stalled");
    expect(action(d)).toBe("nudge_ship_slice");
  });
  test("unknown artifacts, session changes and short histories do not establish stalls", () => {
    for (const current of [sample("3", { diff: undefined }), sample("3", { commit: undefined }), sample("3", { session: "s2" }), sample("3", { session: undefined })]) {
      expect(["stalled", "repetitive_loop"]).not.toContain(supervise(current, [sample("1"), sample("2")]).state);
    }
    expect(supervise(sample("2"), [sample("1")]).state).toBe("progressing");
  });
  test("review churn goes back to the coordinator", () => {
    for (const activity of ["review", "different review"]) {
      expect(action(supervise(sample("3", { activity }), [sample("1"), sample("2")], "reviewer"))).toBe("handoff");
    }
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
