import { describe, expect, test } from "bun:test";
import { bindTask, byToken, emptyStore, ensureObjective, notePrompted, planTasks, reportTask, resolveOwners, runEnded, ack, type CoordStore } from "../gateway/coord.ts";
import { criticalPath, resumeView, snapshotView, taskSlice } from "../gateway/coord-views.ts";
import { supervise } from "../gateway/supervisor.ts";

const T0 = "2026-10-05T19:00:00.000Z";
const T1 = "2026-10-05T19:01:00.000Z";
const T2 = "2026-10-05T19:02:00.000Z";
const T3 = "2026-10-05T19:03:00.000Z";
const tok = (n: number) => `wdt_${String(n).padStart(24, "x")}`;
const code = (fn: () => unknown) => { try { fn(); } catch (e: any) { return e.code; } return null; };

// A Relay-shaped objective: two parallel slices feeding a landing task.
function relay(): CoordStore {
  const s = emptyStore();
  ensureObjective(s, "relay-pwc", "Ship Relay Public Web Chat milestone", T0);
  planTasks(s, "relay-pwc", [
    { id: "#772", title: "Transcripts, retention, erasure", owner: "pwc-770-codex", acceptance: ["staff erasure proof", "consolidated e2e"] },
    { id: "#775", title: "Abuse and spend controls", owner: "pwc-775-codex" },
    { id: "landing", title: "Push accepted commits", owner: "fix-672", status: "waiting_dependency", blocker_kind: "dependency", deps: ["#772", "#775"] },
  ], undefined, T0);
  return s;
}
const bind = (s: CoordStore, task: string, pane: string, n: number, session = `s-${pane}`) =>
  bindTask(s, "relay-pwc", task, { pane_id: pane, session, name: null }, tok(n), `run_${n}`, T1);

describe("model", () => {
  test("snapshot: waits, critical path, machine-wide resources", () => {
    const s = relay();
    planTasks(s, "relay-pwc", [], { e2e: "#772" }, T1);
    const v = snapshotView(s, s.objectives["relay-pwc"]!);
    expect(v.critical_path).toEqual(["#772", "landing"]);
    expect(v.waiting).toEqual([{ id: "landing", kind: "dependency", on: ["#772", "#775"], resources: [], blocker: null }]);
    expect(v.resources.e2e).toMatchObject({ objective: "relay-pwc", task: "#772", generation: 1 });
  });
  test("deps are task ids without cycles", () => {
    const s = relay();
    expect(code(() => planTasks(s, "relay-pwc", [{ id: "#772", deps: ["landing"] }], undefined, T1))).toBe("dependency_cycle");
    expect(code(() => planTasks(relay(), "relay-pwc", [{ id: "#775", deps: ["#772 acceptance"] }], undefined, T1))).toBe("invalid_params");
    expect(code(() => planTasks(relay(), "relay-pwc", [{ id: "#775", deps: ["nope"] }], undefined, T1))).toBe("unknown_dependency");
  });
  test("a_complete_makes_b_ready_once", () => {
    const s = relay();
    planTasks(s, "relay-pwc", [{ id: "#772", status: "complete" }], undefined, T1);
    expect(s.objectives["relay-pwc"]!.tasks.landing!.status).toBe("waiting_dependency");
    const done = planTasks(s, "relay-pwc", [{ id: "#775", status: "complete" }], undefined, T2);
    expect(done.transitions.map((t) => [t.task, t.kind])).toEqual([["landing", "ready"]]);
    expect(s.objectives["relay-pwc"]!.tasks.landing).toMatchObject({ status: "queued", blocker_kind: null });
    // A later merge never surfaces the same readiness again.
    expect(planTasks(s, "relay-pwc", [{ id: "#772", evidence: ["late note"] }], undefined, T3).transitions).toEqual([]);
  });
  test("duplicate_report_id_noop; the same id with other content is a conflict", () => {
    const s = relay();
    bind(s, "#775", "w1:p3", 1);
    const first = reportTask(s, "relay-pwc", "#775", { report_id: "r1", evidence: ["focused checks passed"] }, T2);
    const v = s.objectives["relay-pwc"]!.tasks["#775"]!.version;
    const again = reportTask(s, "relay-pwc", "#775", { report_id: "r1", evidence: ["focused checks passed"] }, T3);
    expect([first.duplicate, again.duplicate]).toEqual([false, true]);
    expect(again.receipt).toEqual(first.receipt);
    // Intentional contract: reusing an id for different content is refused, not dropped.
    expect(code(() => reportTask(s, "relay-pwc", "#775", { report_id: "r1", evidence: ["something else"] }, T3))).toBe("report_conflict");
    expect(s.objectives["relay-pwc"]!.tasks["#775"]).toMatchObject({ version: v, evidence: ["focused checks passed"] });
  });
  test("per_task_expected_version: a stale merge conflicts on its task only", () => {
    const s = relay();
    const v = s.objectives["relay-pwc"]!.tasks["#772"]!.version;
    reportTask(s, "relay-pwc", "#775", { evidence: ["unrelated worker update"] }, T1);
    planTasks(s, "relay-pwc", [{ id: "#772", expected_version: v, next_action: "run staff erasure proof" }], undefined, T2);
    expect(code(() => planTasks(s, "relay-pwc", [{ id: "#772", expected_version: v, next_action: "stale" }], undefined, T3))).toBe("version_conflict");
  });
  test("stale_generation_rejected: rebinding or reassigning retires the old token", () => {
    const s = relay();
    bind(s, "#772", "w1:p2", 1);
    expect(byToken(s, tok(1)).t.id).toBe("#772");
    bind(s, "#772", "w1:p2", 2);
    expect(code(() => byToken(s, tok(1)))).toBe("stale_binding");
    expect(s.objectives["relay-pwc"]!.tasks["#772"]!.generation).toBe(2);
    planTasks(s, "relay-pwc", [{ id: "#772", owner: "someone-else" }], undefined, T2);
    expect(code(() => byToken(s, tok(2)))).toBe("stale_binding");
  });
  test("result_keeps_explicit_blocker, and complete is the supervisor's", () => {
    const s = relay();
    bind(s, "#772", "w1:p2", 1);
    reportTask(s, "relay-pwc", "#772", { status: "blocked", blocker: "staff erasure needs prod data access", blocker_kind: "human" }, T1);
    const r = reportTask(s, "relay-pwc", "#772", { result: { summary: "isolation and retention pass", commit: "26a3e2af" } }, T2);
    expect(s.objectives["relay-pwc"]!.tasks["#772"]).toMatchObject({ status: "verifying", blocker: "staff erasure needs prod data access", blocker_kind: "human", artifacts: ["26a3e2af"] });
    // blocked_human came with the report that set the blocker; the result adds only
    // needs_acceptance.
    expect(r.transitions.map((t) => t.kind)).toEqual(["needs_acceptance"]);
    expect(code(() => reportTask(s, "relay-pwc", "#772", { status: "complete" }, T3))).toBe("not_allowed");
    expect(code(() => reportTask(s, "relay-pwc", "#772", { owner: "x" } as any, T3))).toBe("not_allowed");
    expect(code(() => reportTask(s, "relay-pwc", "#775", { status: "blocked", blocker: "lint" }, T3))).toBe("invalid_params");
  });
  test("resource_conflict_across_objectives", () => {
    const s = relay();
    ensureObjective(s, "other", "Another objective", T0);
    planTasks(s, "other", [{ id: "t1", title: "Uses the browser" }], undefined, T0);
    bindTask(s, "other", "t1", { pane_id: "w2:p1", session: "x", name: null }, tok(9), "run_9", T1);
    reportTask(s, "other", "t1", { acquire: ["jev-browser"] }, T1);
    bind(s, "#772", "w1:p2", 1);
    expect(code(() => reportTask(s, "relay-pwc", "#772", { acquire: ["jev-browser"] }, T2))).toBe("resource_busy");
    expect(code(() => planTasks(s, "relay-pwc", [], { "jev-browser": "#772" }, T2))).toBe("resource_busy");
    expect(code(() => planTasks(s, "relay-pwc", [], { "jev-browser": null }, T2))).toBe("resource_busy");
  });
  test("worker_gone_marks_resource_stale_not_free; only explicit reconciliation frees it", () => {
    const s = relay();
    bind(s, "#772", "w1:p2", 1);
    notePrompted(s, "relay-pwc", "#772", T1);
    reportTask(s, "relay-pwc", "#772", { acquire: ["e2e"] }, T1);
    const gone = runEnded(s, "w1:p2", "gone", T2);
    expect(gone[0]!.transitions.map((t) => t.kind).sort()).toEqual(["resource_stale", "worker_gone"]);
    expect(s.resources.e2e!.stale_since).toBe(T2);
    bind(s, "#775", "w1:p3", 2);
    expect(code(() => reportTask(s, "relay-pwc", "#775", { acquire: ["e2e"] }, T3))).toBe("resource_stale");
    expect(code(() => planTasks(s, "relay-pwc", [], { e2e: "#775" }, T3))).toBe("resource_stale");
    planTasks(s, "relay-pwc", [], { e2e: null }, T3);
    reportTask(s, "relay-pwc", "#775", { acquire: ["e2e"] }, T3);
    expect(s.resources.e2e).toMatchObject({ task: "#775", generation: 2, stale_since: null });
  });
  test("missing_report_not_complete; a report clears it", () => {
    const s = relay();
    bind(s, "#772", "w1:p2", 1);
    notePrompted(s, "relay-pwc", "#772", T1);
    const ended = runEnded(s, "w1:p2", "finished", T2);
    expect(ended[0]!.transitions.map((t) => t.kind)).toEqual(["missing_report"]);
    expect(s.objectives["relay-pwc"]!.tasks["#772"]).toMatchObject({ status: "executing", protocol: "missing_report" });
    expect(runEnded(s, "w1:p2", "finished", T2)).toEqual([]);
    reportTask(s, "relay-pwc", "#772", { status: "executing", evidence: ["resumed"] }, T3);
    expect(s.objectives["relay-pwc"]!.tasks["#772"]!.protocol).toBeNull();
  });
  test("a resource wait clears when the holder releases, once", () => {
    const s = relay();
    bind(s, "#772", "w1:p2", 1);
    bind(s, "#775", "w1:p3", 2);
    reportTask(s, "relay-pwc", "#772", { acquire: ["e2e"] }, T1);
    reportTask(s, "relay-pwc", "#775", { wait_for: ["e2e"], blocker: "consolidated e2e needs the port" }, T1);
    expect(s.objectives["relay-pwc"]!.tasks["#775"]).toMatchObject({ status: "waiting_dependency", blocker_kind: "resource" });
    const freed = reportTask(s, "relay-pwc", "#772", { release: ["e2e"] }, T2);
    expect(freed.transitions.map((t) => [t.task, t.kind])).toEqual([["#775", "ready"]]);
  });
  test("two_bound_workers_in_parallel; one slice per pane", () => {
    const s = relay();
    bind(s, "#772", "w1:p2", 1);
    bind(s, "#775", "w1:p3", 2);
    reportTask(s, "relay-pwc", "#772", { evidence: ["a"] }, T2);
    reportTask(s, "relay-pwc", "#775", { evidence: ["b"] }, T2);
    expect(code(() => bind(s, "landing", "w1:p2", 3))).toBe("pane_busy");
  });
  test("lost_tell_recovered_from_resume_view until acknowledged", () => {
    const s = relay();
    bind(s, "#775", "w1:p3", 2);
    reportTask(s, "relay-pwc", "#775", { result: { summary: "rate limits", commit: "cc2245e3" } }, T1);
    const o = s.objectives["relay-pwc"]!;
    const r = resumeView(s, o);
    expect(r.pending_transitions.map((t) => t.kind)).toEqual(["needs_acceptance"]);
    expect(r.needs_acceptance.map((t) => t.id)).toEqual(["#775"]);
    ack(o, r.pending_transitions[0]!.seq);
    expect(resumeView(s, o).pending_transitions).toEqual([]);
    expect(code(() => ack(o, 999))).toBe("invalid_params");
  });
  test("the slice is bounded and names the exact report command", () => {
    const s = relay();
    const t = bind(s, "#772", "w1:p2", 1);
    reportTask(s, "relay-pwc", "#772", { evidence: ["e1", "e2", "e3", "e4", "e5"] }, T2);
    const text = taskSlice(s, s.objectives["relay-pwc"]!, t, "/home/x/.local/bin/workdone-task", tok(1));
    expect(text).toContain("Task #772");
    expect(text).toContain("last 3 of 5");
    expect(text).toContain(`/home/x/.local/bin/workdone-task --token ${tok(1)}`);
    expect(text).not.toContain("e1;");
    expect(text.length).toBeLessThan(2500);
  });
  test("owners resolve by name only to one live agent", () => {
    const s = relay();
    expect(resolveOwners(s.objectives["relay-pwc"]!, [{ pane_id: "a", name: "fix-672" }, { pane_id: "b", name: "fix-672" }])).toEqual(["fix-672"]);
    expect(criticalPath(s.objectives["relay-pwc"]!)).toEqual(["#772", "landing"]);
  });
});

test("supervise_prefers_task_progress_over_shared_head", () => {
  const task_identity = { objective: "relay-pwc", id: "#772", binding: "run_1" };
  const turn = (n: string, extra = {}) => ({ status: "idle", session: "s1", turn: n, at: `2026-10-05T12:0${n}:00Z`, commit: "abc", diff: "d", activity: `a${n}`, task_identity, ...extra });
  const task = (progress: number, status = "executing") => ({ id: "#772", status, progress, blocker: null, unmet_deps: [] });
  // Another worker's commit moved HEAD; this worker's task did not progress: stalled.
  const stuck = supervise(turn("3", { commit: "zzz", task_progress: 4 }), [turn("1", { task_progress: 4 }), turn("2", { commit: "yyy", task_progress: 4 })], { task: task(4) });
  expect(stuck.state).toBe("stalled");
  // Its own task progressed while HEAD stayed put: progress.
  const moving = supervise(turn("3", { task_progress: 6 }), [turn("1", { task_progress: 4 }), turn("2", { task_progress: 5 })], { task: task(6) });
  expect(moving.state).not.toBe("stalled");
  // Accepted complete: prunable even though the shared tree is dirty.
  expect(supervise({ status: "idle", clean: false }, [], { task: task(7, "complete") }).recommendations[0]!.action).toBe("prune_close");
});
