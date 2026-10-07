import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { bindTask, ensureObjective, planTasks, reportTask } from "../gateway/coord.ts";
import { notifyTransitions } from "../gateway/coord-ops.ts";
import { EventsService } from "../mcp/src/events.ts";
import { Gateway } from "../gateway/gateway.ts";
import { pollWatched } from "../gateway/watcher.ts";
import { StateStore } from "../gateway/state.ts";
import { watchPoll } from "../gateway/jobs.ts";
import { loadConfig, type HerdrCall } from "../gateway/config.ts";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
function setup() {
  const state = mkdtempSync(join(tmpdir(), "wd-outbox-")); dirs.push(state);
  const store = new StateStore(state);
  const cfg = loadConfig({ stateDir: state, allowedRoots: [state], autoApprove: false });
  const agent = { pane_id: "w1:p1", name: "worker", agent: "codex", agent_status: "done", cwd: state, foreground_cwd: state, state_change_seq: 2, agent_session: { value: "session1" } };
  const herdr: HerdrCall = async (method) => method === "agent.list" ? { agents: [agent] } : method === "agent.read" ? { read: { text: "RESULT: finished" } } : {};
  store.manage(agent.pane_id, { name: "worker", cwd: state, kind: "codex" }, { ...agent, agent_status: "working", state_change_seq: 1 });
  const result = store.requestResult(agent.pane_id, { name: "worker", cwd: state, kind: "codex" }, agent, "L-owner");
  return { state, store, cfg, herdr, result, agent };
}

describe("acknowledged gateway outbox", () => {
  test("lost poll response replays finished result with its original ID until acknowledged", async () => {
    const f = setup();
    const discarded = await watchPoll(f.cfg, f.herdr, { delivery: "ack" });
    expect(discarded.reports).toHaveLength(1);
    const source = discarded.reports![0]!;
    expect(source.result?.result_id).toBe(f.result.result_id);
    expect(f.store.watched()["w1:p1"]!.result_request).toBeUndefined();
    expect(f.store.watched()["w1:p1"]!.last_result?.result_id).toBe(f.result.result_id);
    const replay = await watchPoll(f.cfg, f.herdr, { delivery: "ack" });
    expect(replay.reports).toEqual(discarded.reports);
    expect(replay.messages).toEqual([]); // phones remain one-shot, even when source reports replay
    const acked = await watchPoll(f.cfg, f.herdr, { delivery: "ack", ack: [source.event_id!] });
    expect(acked.reports).toBeUndefined();
    expect(f.store.outbox()).toEqual([]);
    await watchPoll(f.cfg, f.herdr, { delivery: "ack", ack: [source.event_id!, "unknown"] });
    expect(f.store.outbox()).toEqual([]);
  });

  test("a tell from OpenClaw has no pane behind it and goes to the lease it names", async () => {
    const f = setup();
    f.store.addTold({ pane_id: "openclaw", from: "openclaw", recipient_lease: "L-asker01", event_id: "openclaw:x", text: "Answer to ask x: Meeting at 10", at: new Date().toISOString() });
    const got = await watchPoll(f.cfg, f.herdr, { delivery: "ack" });
    const r = got.reports!.find((x) => x.event_id === "openclaw:x")!;
    expect(r).toMatchObject({ type: "message", pane_id: "openclaw", agent: "openclaw", lease: "L-asker01", excerpt: "Answer to ask x: Meeting at 10" });
    expect(r.message).toContain("openclaw says:");
  });

  test("restart before intake preserves tells, result and occurrence identity", async () => {
    const f = setup();
    f.store.addTold({ pane_id: "w1:p1", text: "message", at: new Date().toISOString() });
    const first = await watchPoll(f.cfg, f.herdr, { delivery: "ack" });
    expect(first.reports).toHaveLength(2);
    const restarted = new StateStore(f.state);
    expect(restarted.hasTold()).toBe(false);
    expect(restarted.outbox()).toEqual(first.reports!);
    expect((await watchPoll(f.cfg, f.herdr, { delivery: "ack" })).reports).toEqual(first.reports);
  });

  test("partial intake can acknowledge only its durable subset and duplicate ack is harmless", async () => {
    const f = setup();
    f.store.addTold({ pane_id: "w1:p1", text: "message", at: new Date().toISOString() });
    const first = await watchPoll(f.cfg, f.herdr, { delivery: "ack" });
    const [one, two] = first.reports!;
    const next = await watchPoll(f.cfg, f.herdr, { delivery: "ack", ack: [one!.event_id!] });
    expect(next.reports).toEqual([two!]);
    const again = await watchPoll(f.cfg, f.herdr, { delivery: "ack", ack: [one!.event_id!] });
    expect(again.reports).toEqual([two!]);
  });

  test("concurrent polls commit one source occurrence and return the same stable report", async () => {
    const f = setup();
    const [a, b] = await Promise.all([watchPoll(f.cfg, f.herdr, { delivery: "ack" }), watchPoll(f.cfg, f.herdr, { delivery: "ack" })]);
    expect(a.reports).toHaveLength(1);
    expect(b.reports).toEqual(a.reports);
    expect(a.messages.length + b.messages.length).toBe(1);
    expect(f.store.outbox()).toHaveLength(1);
  });

  test("a source process killed after commit but before returning replays its report", async () => {
    const f = setup();
    const module = resolve(import.meta.dir, "../gateway/jobs.ts");
    const script = `import {watchPoll} from ${JSON.stringify(module)}; const cfg=JSON.parse(process.argv[1]); const a={pane_id:"w1:p1",name:"worker",agent:"codex",agent_status:"done",cwd:cfg.stateDir,state_change_seq:2,agent_session:{value:"session1"}}; await watchPoll(cfg,async method=>method==="agent.list"?{agents:[a]}:method==="agent.read"?{read:{text:"RESULT: finished"}}:{},{delivery:"ack"}); process.kill(process.pid,"SIGKILL");`;
    const child = Bun.spawn([process.execPath, "-e", script, JSON.stringify(f.cfg)], { stdout: "pipe", stderr: "pipe" });
    await child.exited;
    expect(await new Response(child.stdout).text()).toBe("");
    expect(await new Response(child.stderr).text()).toBe("");
    const recovered = await watchPoll(f.cfg, f.herdr, { delivery: "ack" });
    expect(recovered.reports).toHaveLength(1);
    expect(recovered.reports![0]!.result?.result_id).toBe(f.result.result_id);
    expect(recovered.messages).toEqual([]);
  });

  test("legacy polls stay one-shot and do not drain reliable reports", async () => {
    const f = setup();
    const reliable = await watchPoll(f.cfg, f.herdr, { delivery: "ack" });
    expect((await watchPoll(f.cfg, f.herdr, {})).reports).toBeUndefined();
    expect(f.store.outbox()).toEqual(reliable.reports!);
    const legacy = setup();
    expect((await watchPoll(legacy.cfg, legacy.herdr, {})).reports).toHaveLength(1);
    expect((await watchPoll(legacy.cfg, legacy.herdr, {})).reports).toBeUndefined();
    expect(legacy.store.outbox()).toEqual([]);
  });

  test("invalid acknowledgment params refuse to consume any reports", async () => {
    const f = setup();
    await expect(watchPoll(f.cfg, f.herdr, { ack: ["id"] })).rejects.toMatchObject({ code: "invalid_params" });
    expect(f.store.watched()["w1:p1"]!.result_request).toBeDefined();
    await expect(watchPoll(f.cfg, f.herdr, { delivery: "ack", ack: [123] })).rejects.toMatchObject({ code: "invalid_params" });
  });
});

test("watcher attributes turn metadata and substantive progress to the current binding, not historical task order", async () => {
  const f = setup();
  const at = new Date().toISOString();
  f.store.updateCoord(c => {
    ensureObjective(c, "demo", "Mock objective", at);
    planTasks(c, "demo", [{ id: "historical", title: "Previous slice" }, { id: "current", title: "Current slice" }], undefined, at);
    const run = { pane_id: "w1:p1", session: "session1", name: "worker" };
    bindTask(c, "demo", "historical", run, `wdt_${"a".repeat(24)}`, "old-binding", at);
    c.objectives.demo!.tasks.historical!.status = "verifying";
    bindTask(c, "demo", "current", run, `wdt_${"b".repeat(24)}`, "new-binding", at);
    c.objectives.demo!.tasks.historical!.version = 91;
    c.objectives.demo!.tasks.historical!.progress = 81;
    c.objectives.demo!.tasks.current!.version = 7;
    c.objectives.demo!.tasks.current!.progress = 3;
  });
  await pollWatched(f.cfg, f.herdr, Date.now(), true);
  expect(f.store.supervision()["w1:p1"]!.turns[0]).toMatchObject({ task_version: 7, task_progress: 3,
    task_identity: { objective: "demo", id: "current", binding: "new-binding" } });
});

test("same-session task reuse records distinct objective and binding identities even with equal progress", async () => {
  const f = setup();
  const at = new Date().toISOString();
  const run = { pane_id: "w1:p1", session: "session1", name: "worker" };
  for (const [index, objective] of ["alpha", "beta"].entries()) {
    f.store.updateCoord(c => {
      if (index) c.objectives.alpha!.tasks.shared!.status = "complete";
      ensureObjective(c, objective, "Mock objective", at);
      planTasks(c, objective, [{ id: "shared", title: "Current slice" }], undefined, at);
      bindTask(c, objective, "shared", run, `wdt_${String(index + 1).repeat(24)}`, `binding-${objective}`, at);
      c.objectives[objective]!.tasks.shared!.progress = 1;
    });
    if (index) {
      f.agent.state_change_seq = 4;
      f.store.manage(run.pane_id, { name: "worker", cwd: f.state, kind: "codex" }, { ...f.agent, agent_status: "working", state_change_seq: 3 });
    }
    await pollWatched(f.cfg, f.herdr, Date.now(), true);
    f.store.acknowledgeReports(f.store.outbox().map(r => r.event_id!));
  }
  const turns = f.store.supervision()[run.pane_id]!.turns;
  expect(turns).toHaveLength(2);
  expect(turns.map(t => t.task_progress)).toEqual([1, 1]);
  expect(turns.map(t => t.task_identity)).toEqual([
    { objective: "alpha", id: "shared", binding: "binding-alpha" },
    { objective: "beta", id: "shared", binding: "binding-beta" },
  ]);
});

test("a mismatched agent session records no task progress or task identity", async () => {
  const f = setup();
  const at = new Date().toISOString();
  f.store.updateCoord(c => {
    ensureObjective(c, "demo", "Mock objective", at);
    planTasks(c, "demo", [{ id: "task", title: "Previous session" }], undefined, at);
    bindTask(c, "demo", "task", { pane_id: "w1:p1", session: "session0", name: "worker" }, `wdt_${"a".repeat(24)}`, "old-session", at);
  });
  await pollWatched(f.cfg, f.herdr, Date.now(), true);
  const turn = f.store.supervision()["w1:p1"]!.turns[0]!;
  expect(turn.task_version).toBeUndefined();
  expect(turn.task_progress).toBeUndefined();
  expect(turn.task_identity).toBeUndefined();
});

test("alpha resource release durably delivers beta's unbound transition through the objective subscription", async () => {
  const f = setup();
  f.store.unwatch("w1:p1");
  const at = new Date().toISOString();
  f.store.updateCoord(c => {
    for (const objective of ["alpha", "beta"]) {
      ensureObjective(c, objective, "Mock objective", at);
      planTasks(c, objective, [{ id: "same", title: "Colliding task ID" }], undefined, at);
      c.objectives[objective]!.supervisor = `L-${objective}`;
    }
    reportTask(c, "alpha", "same", { acquire: ["slot"] }, at);
    reportTask(c, "beta", "same", { wait_for: ["slot"], blocker: "Waiting for mock slot" }, at);
  });
  f.store.transaction(() => {
    const { change, coord } = f.store.updateCoord(c => ({ change: reportTask(c, "alpha", "same", { release: ["slot"] }, at), coord: c }));
    notifyTransitions(f.store, coord, [change]);
  });
  const source = await watchPoll(f.cfg, f.herdr, { delivery: "ack" });
  expect(source.reports).toHaveLength(1);
  expect(source.reports![0]).toMatchObject({ objective: "beta", recipient_lease: "L-beta", pane_id: null, transition: { task: "same", kind: "ready" } });
  expect(f.store.coord().objectives.beta!.tasks.same!.status).toBe("queued");
  const delivered: Array<{ headers: Record<string, string>; event: any }> = [];
  const service = new EventsService({ statePath: ":memory:", callbackHosts: ["callbacks.example.com"], authorize: async () => true, log: () => {}, sender: async (_url, headers, body) => {
    const event = JSON.parse(body);
    if (event.type !== "verification") delivered.push({ headers, event });
    return { status: 200, body: JSON.stringify({ challenge: event.challenge }) };
  } });
  const principal = { id: "supervisor", issuer: "https://issuer.example.com", subject: "mock", scopes: ["workdone"], tokenExpiresAt: Date.now() + 3600_000 };
  const delivery = { mode: "webhook", url: "https://callbacks.example.com/mock", secret: `whsec_${Buffer.alloc(32, 4).toString("base64")}` };
  try {
    const alpha = await service.subscribe(principal, { name: "coord.changed", arguments: { machine: "test", objective: "alpha" }, delivery });
    const beta = await service.subscribe(principal, { name: "coord.changed", arguments: { machine: "test", objective: "beta" }, delivery });
    expect(await service.addReports("test", source.reports!)).toBe(1);
    await service.flush();
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.headers["X-MCP-Subscription-Id"]).toBe(beta.id);
    expect(delivered[0]!.headers["X-MCP-Subscription-Id"]).not.toBe(alpha.id);
    expect(delivered[0]!.event.data).toEqual({ machine: "test", objective: "beta", task: "same", seq: expect.any(Number), kind: "ready" });
    const replay = await watchPoll(f.cfg, f.herdr, { delivery: "ack" });
    expect(await service.addReports("test", replay.reports!)).toBe(0);
    await watchPoll(f.cfg, f.herdr, { delivery: "ack", ack: source.reports!.map(r => r.event_id!) });
    expect(f.store.outbox()).toEqual([]);
  } finally { await service.close(); }
});

test("gateway watch_poll negotiates reliable mode and applies explicit acknowledgments", async () => {
  const f = setup();
  const g = new Gateway(f.cfg, f.herdr);
  const first: any = await g.handle("watch_poll", { delivery: "ack" });
  expect(first.delivery).toBe("ack");
  expect(first.reports).toHaveLength(1);
  expect((await g.handle("watch_poll", { delivery: "ack" }) as any).reports).toEqual(first.reports);
  const next: any = await g.handle("watch_poll", { delivery: "ack", ack: first.reports.map((r: any) => r.event_id) });
  expect(next.reports).toBeUndefined();
  expect(f.store.outbox()).toEqual([]);
});

test("unbound objective source reports are available even when Herdr is unavailable", async () => {
  const f = setup(); f.store.unwatch("w1:p1");
  f.store.addTold({ pane_id: null, objective: "beta", recipient_lease: "L-beta", event_id: "coord:beta:99", transition: { task: "same", seq: 99, kind: "ready" }, text: "canonical hint", at: new Date().toISOString() });
  const got = await watchPoll(f.cfg, async () => { throw new Error("Herdr offline"); }, { delivery: "ack" });
  expect(got.reports).toHaveLength(1);
  expect(got.reports![0]).toMatchObject({ event_id: "coord:beta:99", objective: "beta", pane_id: null, recipient_lease: "L-beta" });
});
