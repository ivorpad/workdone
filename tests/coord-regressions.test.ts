// Regressions for the orchestration review (2026-10-06): worker reuse, resource fencing,
// cross-objective wakes, blockers, report replay and progress, at the store level.
// Dispatch through the gateway is in coord-regressions-gateway.test.ts.
import { describe, expect, test } from "bun:test";
import {
  bindTask, byToken, currentTaskBinding, emptyStore, ensureObjective, MAX_COMMANDS, MAX_RECEIPTS, settleDispatch, normalizeStore, notePrompted, planTasks,
  prepareDispatch, reportTask, runEnded, type CoordStore, type Prepared,
} from "../gateway/coord.ts";
import { notifyTransitions } from "../gateway/coord-ops.ts";
import { resumeView } from "../gateway/coord-views.ts";
import { supervise } from "../gateway/supervisor.ts";

const T = (m: number) => `2026-10-06T05:${String(m).padStart(2, "0")}:00.000Z`;
const tok = (n: number) => `wdt_${String(n).padStart(24, "y")}`;
const code = (fn: () => unknown) => { try { fn(); } catch (e: any) { return e.code; } return null; };
const run = (pane: string, session = `s-${pane}`) => ({ pane_id: pane, session, name: null });
// An ordinary prompt to the pane (no task named): what it would carry.
const implicit = (s: CoordStore, r: ReturnType<typeof run>, id: string, n: number) =>
  prepareDispatch(s, null, r, { id, hash: id }, tok(n), `run_${n}`, T(n)) as Prepared | null;

function store(): CoordStore {
  const s = emptyStore();
  for (const id of ["alpha", "beta"]) {
    ensureObjective(s, id, id, T(0));
    s.objectives[id]!.supervisor = `lease-${id}`;
  }
  planTasks(s, "alpha", [{ id: "a1", title: "A one" }, { id: "a2", title: "A two" }, { id: "a3", title: "A three", deps: ["a1"], status: "waiting_dependency", blocker_kind: "dependency" }], undefined, T(0));
  planTasks(s, "beta", [{ id: "b1", title: "B one" }], undefined, T(0));
  return s;
}
const task = (s: CoordStore, o: string, t: string) => s.objectives[o]!.tasks[t]!;
const bind = (s: CoordStore, o: string, t: string, pane: string, n: number, session?: string) => {
  const x = bindTask(s, o, t, run(pane, session), tok(n), `run_${n}`, T(n));
  notePrompted(s, o, t, T(n));
  return x;
};

describe("1. worker reuse: one current binding per pane", () => {
  test("same objective: the verifying task never competes with the pane's current work", () => {
    const s = store();
    bind(s, "alpha", "a1", "p1", 1);
    reportTask(s, "alpha", "a1", { result: { summary: "a1 done" } }, T(2));
    bind(s, "alpha", "a2", "p1", 3);
    expect(currentTaskBinding(s, "p1")!.t.id).toBe("a2");
    // An ordinary prompt to the pane carries a2's token, not a1's.
    const p = implicit(s, run("p1"), "cmd_1", 90)!;
    expect([p.t.id, p.binding.token]).toEqual(["a2", tok(3)]);
    // a1's token still names a1 (late evidence is fine) but can't make it current or reopen it.
    expect(byToken(s, tok(1)).t.id).toBe("a1");
    reportTask(s, "alpha", "a1", { evidence: ["late log"] }, T(5));
    expect(code(() => reportTask(s, "alpha", "a1", { status: "executing" }, T(5)))).toBe("regressive_report");
    expect(currentTaskBinding(s, "p1")!.t.id).toBe("a2");
    // Turn ends are attributed to a2 only.
    const ended = runEnded(s, "p1", "finished", T(6));
    expect(ended.flatMap((c) => c.transitions.map((t) => [t.objective, t.task, t.kind]))).toEqual([["alpha", "a2", "missing_report"]]);
    expect(task(s, "alpha", "a1").protocol).toBeNull();
  });

  test("history never becomes current again: after the current task completes or is reassigned", () => {
    const s = store();
    bind(s, "alpha", "a1", "p1", 1);
    reportTask(s, "alpha", "a1", { result: { summary: "a1 done" } }, T(2));
    bind(s, "alpha", "a2", "p1", 3);
    planTasks(s, "alpha", [{ id: "a2", status: "complete" }], undefined, T(4));
    expect(currentTaskBinding(s, "p1")!.t.status).toBe("complete");
    expect(implicit(s, run("p1"), "cmd_2", 91)).toBeNull();
    planTasks(s, "alpha", [{ id: "a2", status: "executing", owner: "someone-else" }], undefined, T(6));
    expect(currentTaskBinding(s, "p1")).toBeNull();
    expect(implicit(s, run("p1"), "cmd_3", 92)).toBeNull();
  });

  test("cross objective: alpha's verifying task and beta's current one on the same pane", () => {
    const s = store();
    bind(s, "alpha", "a1", "p1", 1);
    reportTask(s, "alpha", "a1", { result: { summary: "a1 done" } }, T(2));
    bind(s, "beta", "b1", "p1", 3);
    const cur = currentTaskBinding(s, "p1")!;
    expect([cur.o.id, cur.t.id]).toEqual(["beta", "b1"]);
    expect(implicit(s, run("p1"), "cmd_4", 93)!.binding.token).toBe(tok(3));
  });

  test("session restart: the old run's binding is not current for the new session", () => {
    const s = store();
    bind(s, "alpha", "a1", "p1", 1, "s1");
    expect(currentTaskBinding(s, "p1", "s1")!.t.id).toBe("a1");
    expect(currentTaskBinding(s, "p1", "s2")).toBeNull();
    // A prompt to the restarted agent carries no token of the dead run.
    expect(implicit(s, run("p1", "s2"), "cmd_5", 94)).toBeNull();
    // Rebinding the same task to the new session makes it current again, with a new token.
    bindTask(s, "alpha", "a1", run("p1", "s2"), tok(5), "run_5", T(3));
    expect(currentTaskBinding(s, "p1", "s2")!.t.binding!.token).toBe(tok(5));
    expect(code(() => byToken(s, tok(1)))).toBe("stale_binding");
  });

  test("a v2 store with two open bindings on one pane migrates to the later one as current", () => {
    const s = store();
    bind(s, "alpha", "a1", "p1", 1);
    reportTask(s, "alpha", "a1", { report_id: "old", result: { summary: "a1 done" } }, T(2));
    bind(s, "beta", "b1", "p1", 3);
    const legacy = JSON.parse(JSON.stringify(s));
    delete legacy.current;
    for (const o of Object.values<any>(legacy.objectives)) for (const t of Object.values<any>(o.tasks)) {
      t.report_ids = Object.keys(t.binding?.receipts ?? {});
      if (t.binding) delete t.binding.receipts;
      delete t.receipts;
      delete t.progress;
    }
    const m = normalizeStore(legacy);
    expect(currentTaskBinding(m, "p1")!.t.id).toBe("b1");
    // A legacy report id is still a duplicate, whatever its payload.
    expect(reportTask(m, "alpha", "a1", { report_id: "old", evidence: ["x"] }, T(4)).duplicate).toBe(true);
  });
});

describe("4. command receipts live as long as their attempt", () => {
  test("beyond capacity: no receipt is evicted, the earliest retry is still a replay, and a new command is refused before anything changes", () => {
    const s = store();
    bind(s, "alpha", "a1", "p1", 1);
    const send = (id: string, hash = id) => {
      const p = prepareDispatch(s, null, run("p1"), { id, hash }, tok(99), "run_99", T(2)) as any;
      if (p && !("replay" in p)) settleDispatch(s, { objective: "alpha", task: "a1", binding_id: p.binding.id, command_id: id, fresh: false, sent_at: T(2) }, "delivered", T(2));
      return p;
    };
    for (let i = 0; i < MAX_COMMANDS; i++) send(`c${i}`);
    expect(Object.keys(s.commands!)).toHaveLength(MAX_COMMANDS);
    expect(send("c0").replay).toMatchObject({ state: "delivered", task: "a1" });
    const full = JSON.stringify(s);
    expect(code(() => send("c-new"))).toBe("commands_full");
    expect(JSON.stringify(s)).toBe(full);
    expect(code(() => send("c1", "other"))).toBe("command_conflict");
    // A rebind starts a new attempt and a new retry lifetime.
    bind(s, "alpha", "a1", "p1", 3);
    send("c-new");
    expect(Object.keys(s.commands!)).toEqual(["c-new"]);
  });
});

describe("2. resources belong to an attempt", () => {
  test("a gone attempt's stale lease is not reacquired by the same task rebound elsewhere", () => {
    const s = store();
    bind(s, "alpha", "a1", "p1", 1);
    reportTask(s, "alpha", "a1", { acquire: ["e2e"] }, T(1));
    runEnded(s, "p1", "gone", T(2));
    bind(s, "alpha", "a1", "p2", 3);
    expect(code(() => reportTask(s, "alpha", "a1", { acquire: ["e2e"] }, T(3)))).toBe("resource_stale");
    expect(code(() => planTasks(s, "alpha", [], { e2e: "a1" }, T(3)))).toBe("resource_stale");
    expect(s.resources.e2e).toMatchObject({ binding: "run_1", generation: 1 });
    planTasks(s, "alpha", [], { e2e: null }, T(4));
    reportTask(s, "alpha", "a1", { acquire: ["e2e"] }, T(4));
    expect(s.resources.e2e).toMatchObject({ binding: "run_3", generation: 2, stale_since: null });
  });

  test("rebinding to another pane makes the old attempt's live lease stale at once; the same run keeps it", () => {
    const s = store();
    bind(s, "alpha", "a1", "p1", 1);
    reportTask(s, "alpha", "a1", { acquire: ["e2e"] }, T(1));
    // Same pane and session (a re-prompt with task): the same process keeps its lease.
    bind(s, "alpha", "a1", "p1", 2);
    expect(s.resources.e2e).toMatchObject({ binding: "run_2", generation: 1, stale_since: null });
    reportTask(s, "alpha", "a1", { acquire: ["e2e"] }, T(2));
    expect(s.resources.e2e!.generation).toBe(1);
    // Another pane: the old process may still be using it.
    bind(s, "alpha", "a1", "p2", 3);
    expect(s.resources.e2e).toMatchObject({ binding: "run_2", stale_since: T(3) });
    expect(s.objectives.alpha!.transitions.map((t) => [t.task, t.kind, t.detail])).toContainEqual(["a1", "resource_stale", "e2e"]);
    expect(code(() => reportTask(s, "alpha", "a1", { acquire: ["e2e"] }, T(4)))).toBe("resource_stale");
    expect(code(() => reportTask(s, "alpha", "a1", { release: ["e2e"] }, T(4)))).toBe("resource_stale");
  });

  test("accepting or removing a task does not free a lease an unreconciled process holds", () => {
    const s = store();
    bind(s, "alpha", "a1", "p1", 1);
    reportTask(s, "alpha", "a1", { acquire: ["e2e"] }, T(1));
    bind(s, "alpha", "a1", "p2", 2);
    reportTask(s, "alpha", "a1", { acquire: ["port"] }, T(2));
    planTasks(s, "alpha", [{ id: "a1", status: "complete" }], undefined, T(3));
    // The current run's lease is freed; the old run's stays, stale.
    expect(s.resources.port).toBeUndefined();
    expect(s.resources.e2e).toMatchObject({ binding: "run_1", stale_since: T(2) });
    bind(s, "alpha", "a2", "p3", 4);
    reportTask(s, "alpha", "a2", { acquire: ["db"] }, T(4));
    runEnded(s, "p3", "gone", T(5));
    planTasks(s, "alpha", [{ id: "a2", remove: true }], undefined, T(6));
    expect(s.resources.db).toMatchObject({ task: "a2", stale_since: T(5) });
  });

  test("reassigning a live lease needs the generation the supervisor read", () => {
    const s = store();
    bind(s, "alpha", "a1", "p1", 1);
    reportTask(s, "alpha", "a1", { acquire: ["e2e"] }, T(1));
    expect(code(() => planTasks(s, "alpha", [], { e2e: "a2" }, T(2)))).toBe("resource_busy");
    expect(code(() => planTasks(s, "alpha", [], { e2e: { task: "a2", expected_generation: 7 } }, T(2)))).toBe("resource_conflict");
    expect(code(() => planTasks(s, "alpha", [], { e2e: { task: null, expected_generation: 7 } }, T(2)))).toBe("resource_conflict");
    planTasks(s, "alpha", [], { e2e: { task: "a2", expected_generation: 1 } }, T(2));
    expect(s.resources.e2e).toMatchObject({ task: "a2", generation: 2, binding: null });
  });

  test("a delayed release is fenced by generation within the same attempt", () => {
    const s = store();
    bind(s, "alpha", "a1", "p1", 1);
    reportTask(s, "alpha", "a1", { acquire: ["e2e"] }, T(1));
    reportTask(s, "alpha", "a1", { release: ["e2e@1"] }, T(2));
    reportTask(s, "alpha", "a1", { acquire: ["e2e"] }, T(3));
    expect(s.resources.e2e!.generation).toBe(2);
    expect(code(() => reportTask(s, "alpha", "a1", { release: ["e2e@1"] }, T(4)))).toBe("resource_conflict");
    expect(s.resources.e2e!.generation).toBe(2);
    reportTask(s, "alpha", "a1", { release: ["e2e@2"] }, T(5));
    expect(s.resources.e2e).toBeUndefined();
  });

  test("v2 leases without an attempt: tied to the binding only when pane and session match", () => {
    const s = store();
    bind(s, "alpha", "a1", "p1", 1);
    reportTask(s, "alpha", "a1", { acquire: ["e2e", "port"] }, T(1));
    const legacy = JSON.parse(JSON.stringify(s));
    delete legacy.resources.e2e.binding;
    delete legacy.resources.port.binding;
    legacy.resources.port.session = "an-older-session";
    const m = normalizeStore(legacy);
    expect(m.resources.e2e!.binding).toBe("run_1");
    expect(m.resources.port!.binding).toBeNull();
    reportTask(m, "alpha", "a1", { acquire: ["e2e"] }, T(2));
    expect(code(() => reportTask(m, "alpha", "a1", { acquire: ["port"] }, T(2)))).toBe("resource_stale");
  });
});

describe("3. transitions wake the objective they belong to", () => {
  test("a release in alpha readies beta's waiter, notified to beta's supervisor", () => {
    const s = store();
    bind(s, "alpha", "a1", "p1", 1);
    bind(s, "beta", "b1", "p2", 2);
    reportTask(s, "alpha", "a1", { acquire: ["e2e"] }, T(3));
    reportTask(s, "beta", "b1", { wait_for: ["e2e"] }, T(3));
    const freed = reportTask(s, "alpha", "a1", { release: ["e2e"] }, T(4));
    expect(freed.transitions.map((t) => [t.objective, t.task, t.kind])).toEqual([["beta", "b1", "ready"]]);
    const told: any[] = [];
    notifyTransitions({ addTold: (m: any) => told.push(m) } as any, s, [freed]);
    const seq = s.objectives.beta!.transitions.at(-1)!.seq;
    expect(told).toEqual([expect.objectContaining({ objective: "beta", recipient_lease: "lease-beta", event_id: `coord:beta:${seq}`, transition: { task: "b1", seq, kind: "ready" }, pane_id: "p2" })]);
    expect(resumeView(s, s.objectives.beta!).pending_transitions.map((t) => t.task)).toEqual(["b1"]);
    expect(resumeView(s, s.objectives.alpha!).pending_transitions.map((t) => t.task)).not.toContain("b1");
  });

  test("a newly ready task with no worker goes to the supervisor, not to any pane", () => {
    const s = store();
    bind(s, "alpha", "a1", "p1", 1);
    const done = planTasks(s, "alpha", [{ id: "a1", status: "complete" }], undefined, T(2));
    const told: any[] = [];
    notifyTransitions({ addTold: (m: any) => told.push(m) } as any, s, [done]);
    expect(told).toEqual([expect.objectContaining({ objective: "alpha", recipient_lease: "lease-alpha", pane_id: null, transition: expect.objectContaining({ task: "a3", kind: "ready" }) })]);
  });
});

describe("5. human and defect blockers stay visible", () => {
  test("partial result with a human blocker: verifying, listed as blocked_human and in acceptance; complete refused until resolved", () => {
    const s = store();
    bind(s, "alpha", "a1", "p1", 1);
    const r = reportTask(s, "alpha", "a1", { result: { summary: "half done" }, blocker: "needs prod credentials", blocker_kind: "human" }, T(2));
    expect(r.transitions.map((t) => t.kind).sort()).toEqual(["blocked_human", "needs_acceptance"]);
    const v = resumeView(s, s.objectives.alpha!);
    expect(v.blocked_human.map((t) => [t.id, t.status, t.blocker])).toEqual([["a1", "verifying", "needs prod credentials"]]);
    expect(v.needs_acceptance[0]).toMatchObject({ id: "a1", blocker: "needs prod credentials", blocker_kind: "human" });
    expect(v.pending_transitions.map((t) => t.kind).sort()).toEqual(["blocked_human", "needs_acceptance"]);
    expect(code(() => planTasks(s, "alpha", [{ id: "a1", status: "complete" }], undefined, T(3)))).toBe("unresolved_blocker");
    expect(task(s, "alpha", "a1").status).toBe("verifying");
    planTasks(s, "alpha", [{ id: "a1", status: "complete", blocker: null }], undefined, T(3));
    expect(task(s, "alpha", "a1")).toMatchObject({ status: "complete", blocker: null });
  });

  test("partial result with a defect blocker shows in blocked_other; an existing blocker survives a result", () => {
    const s = store();
    bind(s, "alpha", "a1", "p1", 1);
    reportTask(s, "alpha", "a1", { result: { summary: "most of it" }, blocker: "flaky e2e", blocker_kind: "defect", next_action: "fix the retry" }, T(2));
    bind(s, "beta", "b1", "p2", 3);
    reportTask(s, "beta", "b1", { status: "blocked", blocker: "needs a decision", blocker_kind: "human" }, T(3));
    reportTask(s, "beta", "b1", { result: { summary: "done what I could" } }, T(4));
    expect(resumeView(s, s.objectives.alpha!).blocked_other.map((t) => [t.id, t.kind])).toEqual([["a1", "defect"]]);
    expect(resumeView(s, s.objectives.beta!).blocked_human.map((t) => [t.id, t.status])).toEqual([["b1", "verifying"]]);
  });
});

describe("6. report receipts are per attempt", () => {
  test("an old executing report replayed after the result changes nothing; a new one can't regress", () => {
    const s = store();
    bind(s, "alpha", "a1", "p1", 1);
    reportTask(s, "alpha", "a1", { report_id: "r1", status: "executing", evidence: ["started"] }, T(2));
    reportTask(s, "alpha", "a1", { report_id: "r2", result: { summary: "done" } }, T(3));
    const v = task(s, "alpha", "a1").version;
    expect(reportTask(s, "alpha", "a1", { report_id: "r1", status: "executing", evidence: ["started"] }, T(4)).duplicate).toBe(true);
    expect(task(s, "alpha", "a1")).toMatchObject({ status: "verifying", version: v });
    expect(code(() => reportTask(s, "alpha", "a1", { report_id: "r3", status: "executing" }, T(4)))).toBe("regressive_report");
    expect(code(() => reportTask(s, "alpha", "a1", { report_id: "r3", wait_for: ["e2e"] }, T(4)))).toBe("regressive_report");
    // Remediation is the supervisor's explicit reopen.
    planTasks(s, "alpha", [{ id: "a1", status: "executing", next_action: "address review" }], undefined, T(5));
    reportTask(s, "alpha", "a1", { report_id: "r3", status: "executing", evidence: ["fixing"] }, T(6));
    expect(task(s, "alpha", "a1").status).toBe("executing");
  });

  test("a report id from an earlier attempt is not a duplicate in the next one", () => {
    const s = store();
    bind(s, "alpha", "a1", "p1", 1);
    reportTask(s, "alpha", "a1", { report_id: "r1", evidence: ["first run"] }, T(2));
    bind(s, "alpha", "a1", "p2", 3);
    const again = reportTask(s, "alpha", "a1", { report_id: "r1", evidence: ["second run"] }, T(4));
    expect(again.duplicate).toBe(false);
    expect(task(s, "alpha", "a1").evidence).toEqual(["first run", "second run"]);
  });

  test(`more than 500 reports: early acquire, release and result replays are still duplicates; the cap refuses before applying`, () => {
    const s = store();
    bind(s, "alpha", "a1", "p1", 1);
    reportTask(s, "alpha", "a1", { report_id: "acq", acquire: ["e2e"] }, T(2));
    reportTask(s, "alpha", "a1", { report_id: "rel", release: ["e2e@1"] }, T(2));
    for (let i = 0; i < 600; i++) reportTask(s, "alpha", "a1", { report_id: `ev${i}`, evidence: [`step ${i}`] }, T(3));
    reportTask(s, "alpha", "a1", { report_id: "res", result: { summary: "done" } }, T(4));
    const before = JSON.stringify(s);
    for (const [id, body] of [["acq", { acquire: ["e2e"] }], ["rel", { release: ["e2e@1"] }], ["ev0", { evidence: ["step 0"] }], ["res", { result: { summary: "done" } }]] as const) {
      expect(reportTask(s, "alpha", "a1", { report_id: id, ...body } as any, T(5)).duplicate).toBe(true);
    }
    expect(JSON.stringify(s)).toBe(before);
    expect(s.resources.e2e).toBeUndefined();
    expect(code(() => reportTask(s, "alpha", "a1", { report_id: "acq", acquire: ["other"] }, T(5)))).toBe("report_conflict");
    for (let i = 600; Object.keys(task(s, "alpha", "a1").binding!.receipts!).length < MAX_RECEIPTS; i++) {
      reportTask(s, "alpha", "a1", { report_id: `ev${i}`, evidence: [`step ${i}`] }, T(6));
    }
    const full = JSON.stringify(s);
    expect(code(() => reportTask(s, "alpha", "a1", { report_id: "one-more", acquire: ["e2e"] }, T(7)))).toBe("receipts_full");
    expect(JSON.stringify(s)).toBe(full);
    expect(reportTask(s, "alpha", "a1", { report_id: "acq", acquire: ["e2e"] }, T(7)).duplicate).toBe(true);
  });
});

describe("7. progress is substantive work, not reports", () => {
  test("heartbeats renew liveness and move neither version nor progress; next_action alone is not progress", () => {
    const s = store();
    bind(s, "alpha", "a1", "p1", 1);
    reportTask(s, "alpha", "a1", { status: "executing", acquire: ["e2e"] }, T(2));
    const t = task(s, "alpha", "a1");
    const [v, p] = [t.version, t.progress];
    for (let i = 3; i < 6; i++) reportTask(s, "alpha", "a1", { status: "executing" }, T(i));
    expect([t.version, t.progress]).toEqual([v, p]);
    expect(t.binding!.last_report_at).toBe(T(5));
    expect(s.resources.e2e!.renewed_at).toBe(T(5));
    reportTask(s, "alpha", "a1", { next_action: "think more" }, T(6));
    expect([t.version, t.progress]).toEqual([v + 1, p]);
    reportTask(s, "alpha", "a1", { evidence: ["tests pass"] }, T(7));
    expect(t.progress).toBe(p! + 1);
  });

  test("supervise: version-only movement is a stall; history without task_progress is unknown", () => {
    const task_identity = { objective: "alpha", id: "a1", binding: "run_1" };
    const turn = (n: string, extra = {}) => ({ status: "idle", session: "s1", turn: n, at: `2026-10-06T05:0${n}:00Z`, commit: `c${n}`, diff: `d${n}`, activity: `a${n}`, task_identity, ...extra });
    const t = { id: "a1", status: "executing", progress: 2, blocker: null, unmet_deps: [] };
    const hb = supervise(turn("3", { task_progress: 2, task_version: 9 }), [turn("1", { task_progress: 2, task_version: 5 }), turn("2", { task_progress: 2, task_version: 7 })], { task: t });
    expect(hb.state).toBe("stalled");
    // Old records with only task_version, and HEAD moving: neither stall nor progress.
    const old = supervise(turn("3", { task_version: 9 }), [turn("1", { task_version: 5 }), turn("2", { task_version: 7 })], { task: t });
    expect(["stalled", "repetitive_loop", "progressing"]).not.toContain(old.state);
  });

  test("supervise: another task's turns on the same pane and session are not this task's stall", () => {
    const a = { objective: "alpha", id: "a1", binding: "run_1" };
    const b = { objective: "alpha", id: "a2", binding: "run_2" };
    const turn = (n: string, task_identity: typeof a, extra = {}) => ({ status: "idle", session: "s1", turn: n, at: `2026-10-06T05:0${n}:00Z`, task_progress: 1, activity: "same", task_identity, ...extra });
    const history = [turn("1", a), turn("2", a), turn("3", a)];
    const t = { id: "a2", status: "executing", progress: 1, blocker: null, unmet_deps: [] };
    const fresh = supervise({ status: "working", session: "s1", task_progress: 1, task_identity: b }, history, { task: t });
    expect(["stalled", "repetitive_loop"]).not.toContain(fresh.state);
    expect(fresh.recommendations[0]!.action).not.toBe("nudge_ship_slice");
    // A rebind of the same task is a new run too.
    const rerun = supervise(turn("4", { ...a, binding: "run_9" }), history, { task: { ...t, id: "a1" } });
    expect(["stalled", "repetitive_loop"]).not.toContain(rerun.state);
    // The same task and run, unchanged progress: a stall.
    expect(supervise(turn("4", a), history, { task: { ...t, id: "a1" } }).state).toBe("repetitive_loop");
  });

  test("supervise: publication evidence and owed results before prune_close", () => {
    const action = (d: ReturnType<typeof supervise>) => [d.state, d.recommendations[0]!.action];
    const settled = (extra = {}) => ({ status: "idle", session: "s1", commit: "def", clean: true, upstream: "origin/main", ahead: 0, ...extra });
    const baseline = { commit: "abc" };
    // Unbound: landed needs the commit pushed.
    expect(action(supervise(settled({ ahead: 2 }), [], { baseline }))).toEqual(["checkpoint_ready", "verify_checkpoint"]);
    expect(action(supervise(settled({ upstream: null, ahead: null }), [], { baseline }))).toEqual(["checkpoint_ready", "verify_checkpoint"]);
    expect(action(supervise(settled(), [], { baseline }))).toEqual(["landed", "prune_close"]);
    const task = (status: string, commit: string | null = null) => ({ id: "a1", status, blocker: null, unmet_deps: [], commit });
    // Bound: only acceptance makes it prunable, whatever landed in the shared tree.
    expect(action(supervise(settled(), [], { baseline, task: task("verifying", "def") }))).toEqual(["checkpoint_ready", "verify_checkpoint"]);
    // Accepted with a result still owed: not yet.
    expect(action(supervise(settled({ clean: false }), [], { task: task("complete"), result_pending: true }))).toEqual(["accepted", "verify_checkpoint"]);
    // A coding task's commit must show published; accepted is not published.
    expect(action(supervise(settled({ ahead: 2 }), [], { task: task("complete", "def") }))).toEqual(["accepted", "verify_checkpoint"]);
    expect(action(supervise(settled({ upstream: null, ahead: null }), [], { task: task("complete", "def") }))).toEqual(["accepted", "verify_checkpoint"]);
    expect(action(supervise(settled(), [], { task: task("complete", "def") }))).toEqual(["landed", "prune_close"]);
    // A task with no commit (research, docs elsewhere) is done once accepted.
    expect(action(supervise({ status: "idle", clean: false }, [], { task: task("complete") }))).toEqual(["accepted", "prune_close"]);
  });
});
