// Work records: what a ChatGPT chat started through WorkDone stays owed until settle_work
// or a coordination merge records an outcome. Turns, errors, exits and lost notifications
// change its state, never whether it is open. Herdr is faked; state is a temporary directory.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { timing } from "../gateway/answer-ops.ts";
import { GatewayError, loadConfig, type HerdrCall } from "../gateway/config.ts";
import { Gateway } from "../gateway/gateway.ts";
import { NEXT, owedDigest } from "../gateway/owed.ts";
import { StateStore } from "../gateway/state.ts";
import { describe as describeTurn } from "../gateway/watcher.ts";
import { NO_TITLE, apiError, type Work } from "../gateway/work.ts";
import { TOOLS } from "../mcp/src/tools.ts";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const APP = "/srv/allowed/app";
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

function setup() {
  timing.key = timing.text = timing.settle = 0;
  const state = mkdtempSync(join(tmpdir(), "work-"));
  dirs.push(state);
  const panes: Record<string, any> = {
    "w1:p1": { pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1", name: "worker-a", agent: "claude", agent_status: "idle", cwd: APP, foreground_cwd: APP, agent_session: { value: "sa" }, state_change_seq: 1 },
    "w1:p2": { pane_id: "w1:p2", workspace_id: "w1", tab_id: "w1:t1", name: "worker-b", agent: "codex", agent_status: "idle", cwd: APP, foreground_cwd: APP, agent_session: { value: "sb" }, state_change_seq: 1 },
    "w1:p3": { pane_id: "w1:p3", workspace_id: "w1", tab_id: "w1:t1", cwd: APP, foreground_cwd: APP },
  };
  const fail: Record<string, string> = {};
  const calls: string[] = [];
  let screen = "";
  let n = 0;
  const find = (target: string) => Object.values(panes).find((p) => p.agent && (p.pane_id === target || p.name === target));
  // Every status change moves Herdr's state_change_seq, as it does for real.
  const set = (paneId: string, status: string) => {
    const p = panes[paneId];
    p.agent_status = status;
    p.state_change_seq = (p.state_change_seq ?? 0) + 1;
  };
  const herdr: HerdrCall = async (method, params: any) => {
    calls.push(method);
    if (fail[method]) throw new GatewayError(fail[method]!, `${method} failed`);
    switch (method) {
      case "agent.list": return { agents: Object.values(panes).filter((p) => p.agent) };
      case "pane.list": return { panes: Object.values(panes) };
      case "agent.get": {
        const a = find(params.target);
        if (!a) throw new GatewayError("agent_not_found", "nope");
        return { agent: a };
      }
      case "pane.get": return { pane: panes[params.pane_id] };
      case "workspace.create": {
        const id = `w9${++n}`;
        const pane = { pane_id: `${id}:p1`, workspace_id: id, tab_id: `${id}:t1`, cwd: params.cwd };
        panes[pane.pane_id] = pane;
        return { workspace: { workspace_id: id, label: params.label }, tab: { tab_id: `${id}:t1`, label: "1" }, root_pane: pane };
      }
      case "agent.start":
        Object.assign(panes[params.pane_id], { agent: params.kind, name: params.name, foreground_cwd: panes[params.pane_id].cwd, agent_session: { value: `s-${params.name}` } });
        set(params.pane_id, "unknown");
        return { agent: panes[params.pane_id] };
      case "agent.wait":
        set(params.target, "idle");
        return { agent: panes[params.target] };
      case "agent.prompt": {
        const a = find(params.target)!;
        set(a.pane_id, params.wait ? "idle" : "working");
        return { agent: { ...a } };
      }
      case "agent.read": return { text: screen };
      default: return {};
    }
  };
  const cfg = loadConfig({
    allowedRoots: ["/srv/allowed"], repos: { app: { path: APP } }, stateDir: state, leases: true,
    transcriptRoots: [state], cursorTranscriptRoots: [state], agentKinds: ["claude", "codex", "cursor"],
  });
  const g = new Gateway(cfg, herdr);
  const claim = async (label: string, targets: string[] = []) => ((await g.request("claim_agents", { label, targets })) as any).lease as string;
  const work = () => Object.values(new StateStore(state).work());
  const owed = async (params: Record<string, unknown> = {}) => (await g.request("owed_work", params)) as any;
  const poll = () => g.handle("watch_poll", {}) as Promise<any>;
  // The agent ends its turn with this answer, and the watcher looks.
  const finish = async (paneId: string, answer: string) => {
    set(paneId, "idle");
    screen = answer;
    return await poll();
  };
  return { g, cfg, herdr, state, panes, fail, calls, claim, work, owed, poll, set, finish, setScreen: (s: string) => void (screen = s) };
}

describe("work is opened by what a chat starts", () => {
  test("spawn_agent opens work titled by the prompt's first line, under the lease it minted", async () => {
    const t = setup();
    const res: any = await t.g.request("spawn_agent", { kind: "claude", name: "tester", repo: "app", prompt: "\nFix the login bug\nDetails follow." });
    expect(res.work_id).toMatch(/^wk_[a-f0-9]{16}$/);
    expect(t.work()).toEqual([expect.objectContaining({
      id: res.work_id, pane_id: res.pane.pane_id, agent: "tester", kind: "claude", lease: res.lease, title: "Fix the login bug",
      started_by: "spawn_agent", status: "open", session: "s-tester",
    })]);
    // The digest on the spawn's own result counts it.
    expect(res.owed.open).toBe(1);
  });

  test("start_agent opens work with no title yet; the first prompt names it and joins it", async () => {
    const t = setup();
    const lease = await t.claim("mine");
    const started: any = await t.g.request("start_agent", { pane_id: "w1:p3", kind: "codex", name: "starter", lease });
    expect(t.work()).toEqual([expect.objectContaining({ id: started.work_id, pane_id: "w1:p3", title: NO_TITLE, started_by: "start_agent", agent: "starter", kind: "codex" })]);
    const prompted: any = await t.g.request("prompt_agent", { target: "starter", text: "Write the docs", lease });
    expect(prompted.work_id).toBe(started.work_id);
    expect(t.work()).toEqual([expect.objectContaining({ id: started.work_id, title: "Write the docs", status: "open" })]);
  });

  test("a first prompt to an agent with no open work opens it; a follow-up joins it and it stays open", async () => {
    const t = setup();
    const lease = await t.claim("reviewing", ["worker-b"]);
    const first: any = await t.g.request("prompt_agent", { target: "worker-b", text: "Review the PR", lease });
    expect(first.work_id).toMatch(/^wk_/);
    t.set("w1:p2", "idle");
    const steer: any = await t.g.request("steer_agent", { target: "w1:p2", text: "also check the tests", lease });
    expect(steer.work_id).toBe(first.work_id);
    expect(t.work()).toEqual([expect.objectContaining({ id: first.work_id, title: "Review the PR", started_by: "prompt_agent", lease, status: "open" })]);
  });

  test("a call that fails opens nothing; a spawn that fails before its agent starts leaves no lease", async () => {
    const t = setup();
    const lease = await t.claim("mine", ["worker-b"]);
    t.fail["agent.prompt"] = "agent_busy";
    await expect(t.g.request("prompt_agent", { target: "worker-b", text: "go", lease })).rejects.toMatchObject({ code: "agent_busy" });
    t.fail["agent.start"] = "agent_start_failed";
    await expect(t.g.request("spawn_agent", { kind: "claude", name: "doomed", repo: "app", prompt: "x" })).rejects.toMatchObject({ code: "agent_start_failed" });
    expect(t.work()).toEqual([]);
    expect(Object.keys(t.g.state.leases())).toEqual([lease]);
  });

  test("the console opens no work and adds no watch beyond the turn", async () => {
    const t = setup();
    const res: any = await t.g.request("prompt_agent", { target: "worker-b", text: "from the owner", origin: "console" });
    expect(res.work_id).toBeUndefined();
    const spawned: any = await t.g.request("spawn_agent", { kind: "claude", name: "owners", repo: "app", prompt: "x", origin: "console" });
    expect(spawned.work_id).toBeUndefined();
    expect(t.work()).toEqual([]);
    expect(t.g.state.watched()["w1:p2"]?.managed).toBeUndefined();
  });

  test("a state failure after the prompt went in does not fail the call: it is sent once and says work_error", async () => {
    const t = setup();
    const lease = await t.claim("mine", ["worker-b"]);
    (t.g.state as any).updateWork = () => { throw new Error("Gateway state lock is held; refusing mutation"); };
    const res: any = await t.g.request("prompt_agent", { target: "worker-b", text: "Run the migration", lease });
    expect(res).toMatchObject({ submitted: true, work_id: null, work_error: "state_error" });
    expect(t.calls.filter((m) => m === "agent.prompt").length).toBe(1);
    expect(t.g.state.auditTail(5, ["after_op_failed"])).toEqual([expect.objectContaining({ ok: false, of: "prompt_agent", stage: "work", code: "state_error" })]);
  });

  test("a new agent that could not join the lease says how to claim it; one failed try is retried", async () => {
    const t = setup();
    const real = t.g.leases.after;
    let fails = 1;
    (t.g.leases as any).after = (...a: Parameters<typeof real>) => {
      if (fails-- > 0) throw new Error("Gateway state lock is held; refusing mutation");
      return real(...a);
    };
    const once: any = await t.g.request("spawn_agent", { kind: "claude", name: "first", repo: "app" });
    expect(once.lease_error).toBeUndefined();
    expect(t.g.state.leases()[once.lease]?.panes).toEqual([once.pane.pane_id]);
    fails = 2;
    const res: any = await t.g.request("spawn_agent", { kind: "claude", name: "second", repo: "app" });
    expect(res).toMatchObject({ state_error: "state_error", lease_error: { code: "state_error", message: expect.stringContaining(`targets ["${res.pane.pane_id}"]`) } });
    expect(t.g.state.leases()[res.lease]?.panes).toEqual([]);
    // Doing what it says works: nobody holds the pane.
    await t.g.request("claim_agents", { lease: res.lease, targets: [res.pane.pane_id] });
    expect(await t.g.request("prompt_agent", { target: res.pane.pane_id, text: "go", lease: res.lease })).toMatchObject({ submitted: true });
  });

  test("a first prompt that fails after the agent started keeps the spawn: its lease, its pane and its work", async () => {
    const t = setup();
    t.fail["agent.prompt"] = "herdr_unavailable";
    const res: any = await t.g.request("spawn_agent", { kind: "claude", name: "tester", repo: "app", prompt: "Fix the flaky test" });
    expect(res.prompt_error).toMatchObject({ code: "herdr_unavailable" });
    // Delivery is in doubt: the note says to look, not to send again.
    expect(res.note).toContain("unknown");
    expect(t.g.state.leases()[res.lease]?.panes).toEqual([res.pane.pane_id]);
    expect(t.work()).toEqual([expect.objectContaining({ id: res.work_id, pane_id: res.pane.pane_id, title: "Fix the flaky test", status: "open" })]);
    t.fail["agent.prompt"] = "agent_busy";
    const refused: any = await t.g.request("spawn_agent", { kind: "claude", name: "second", repo: "app", prompt: "Other" });
    expect(refused.prompt_error.code).toBe("agent_busy");
    expect(refused.note).toContain("was not sent: prompt_agent it once");
  });
});

describe("settle_work", () => {
  test("accepted closes it, answers the agent's inbox, closes nothing in Herdr, and the item leaves owed_work", async () => {
    const t = setup();
    const lease = await t.claim("reviewing", ["worker-b"]);
    const { work_id }: any = await t.g.request("prompt_agent", { target: "worker-b", text: "Review the PR", lease });
    await t.finish("w1:p2", "LGTM, two nits.");
    const entry = t.g.state.inbox().find((e) => e.pane_id === "w1:p2" && e.status === "unanswered")!;
    expect(entry.text).toContain("LGTM");
    expect((await t.owed()).items.map((i: any) => [i.pane_id, i.settle])).toEqual([["w1:p2", { work_id }]]);
    const before = t.calls.length;
    const res: any = await t.g.request("settle_work", { work_id, outcome: "accepted", note: "merged", lease });
    expect(res).toMatchObject({ settled: true, inbox_answered: 1, work: { id: work_id, status: "accepted", note: "merged", closed_by: `lease …${lease.slice(-4)} "reviewing"` } });
    expect(JSON.stringify(res)).not.toContain(lease);
    expect(t.calls.slice(before).filter((m) => /close|remove|stop|kill/.test(m))).toEqual([]);
    expect(t.g.state.inbox().find((e) => e.id === entry.id)).toMatchObject({ status: "answered" });
    expect(t.panes["w1:p2"].agent).toBe("codex");
    expect((await t.owed()).items).toEqual([]);
    await expect(t.g.request("settle_work", { work_id, outcome: "dropped", lease })).rejects.toMatchObject({ code: "work_closed" });
    await expect(t.g.request("settle_work", { work_id: "wk_0000000000000000", outcome: "accepted", lease })).rejects.toMatchObject({ code: "work_not_found" });
    await expect(t.g.request("settle_work", { work_id, outcome: "done", lease })).rejects.toMatchObject({ code: "invalid_params" });
    await expect(t.g.request("settle_work", { outcome: "accepted", lease })).rejects.toMatchObject({ code: "invalid_params" });
  });

  test("another chat's lease is refused, a missing one too; the console may settle", async () => {
    const t = setup();
    const lease = await t.claim("holder", ["worker-b"]);
    const { work_id }: any = await t.g.request("prompt_agent", { target: "worker-b", text: "Do it", lease });
    const other = await t.claim("other");
    await expect(t.g.request("settle_work", { work_id, outcome: "dropped", lease: other })).rejects.toMatchObject({ code: "not_your_agent" });
    await expect(t.g.request("settle_work", { target: "worker-b", outcome: "dropped", lease: other })).rejects.toMatchObject({ code: "not_your_agent" });
    await expect(t.g.request("settle_work", { work_id, outcome: "dropped" })).rejects.toMatchObject({ code: "needs_lease" });
    expect(t.work()[0]!.status).toBe("open");
    const res: any = await t.g.request("settle_work", { work_id, outcome: "dropped", origin: "console" });
    expect(res.work).toMatchObject({ status: "dropped", closed_by: "console" });
  });

  test("work whose pane no live lease holds can be settled by any live lease", async () => {
    const t = setup();
    const lease = await t.claim("gone chat", ["worker-b"]);
    const { work_id }: any = await t.g.request("prompt_agent", { target: "worker-b", text: "Do it", lease });
    // The chat that held it lapsed a day ago.
    t.g.state.updateLeases((l) => { l[lease]!.used = ago(25 * 3600_000); });
    const other = await t.claim("new chat");
    const res: any = await t.g.request("settle_work", { work_id, outcome: "accepted", lease: other });
    expect(res.work).toMatchObject({ status: "accepted", closed_by: `lease …${other.slice(-4)} "new chat"` });
  });

  test("by target: the pane's open work, or with none, what the agent told the owner", async () => {
    const t = setup();
    const lease = await t.claim("mine", ["worker-b"]);
    const { work_id }: any = await t.g.request("prompt_agent", { target: "worker-b", text: "Do it", lease });
    const byName: any = await t.g.request("settle_work", { target: "worker-b", outcome: "accepted", lease });
    expect(byName).toMatchObject({ settled: true, work: { id: work_id, status: "accepted" } });
    // worker-a has no work, only a message for the owner.
    await t.g.handle("tell", { pane_id: "w1:p1", text: "Heads up: the CI token expires Friday." });
    const item = (await t.owed()).items.find((i: any) => i.pane_id === "w1:p1");
    expect(item).toMatchObject({ work: null, settle: { target: "w1:p1" }, state: "unread_result" });
    const res: any = await t.g.request("settle_work", { target: "w1:p1", outcome: "accepted", lease });
    expect(res).toMatchObject({ settled: false, pane_id: "w1:p1", resolved: 1 });
    // worker-b's turn is still owed to this chat; worker-a owes nothing now.
    expect((await t.owed()).items.map((i: any) => i.pane_id)).toEqual(["w1:p2"]);
  });

  test("the MCP tool takes the lease, a work_id or a target, and only accepted or dropped", () => {
    const tool = TOOLS.settle_work!;
    expect(tool.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(tool.input.lease).toBeDefined();
    expect((tool.input.outcome as any).safeParse("closed").success).toBe(false);
    expect((tool.input.work_id as any).safeParse("wk_0123456789abcdef").success).toBe(true);
    expect((tool.input.work_id as any).safeParse(undefined).success).toBe(true);
    expect((tool.input.target as any).safeParse("w1:p1").success).toBe(true);
  });
});

describe("turns change the work's state, never whether it is open", () => {
  test("each prompted turn's end is recorded; after settle, a turn the owner typed is not reported", async () => {
    const t = setup();
    const lease = await t.claim("mine", ["worker-b"]);
    const { work_id }: any = await t.g.request("prompt_agent", { target: "worker-b", text: "Refactor the parser", lease });
    // A prompt watches its own turn, not every turn.
    expect(t.g.state.watched()["w1:p2"]?.managed).toBeUndefined();
    await t.finish("w1:p2", "Parser refactored.");
    const first = t.work()[0]!.last_turn!;
    expect(first).toMatchObject({ type: "finished", inbox_id: expect.any(String) });
    expect(t.g.state.watched()["w1:p2"]).toBeUndefined();
    await t.g.request("prompt_agent", { target: "worker-b", text: "Now the lexer", lease });
    await t.finish("w1:p2", "Lexer done too.");
    const second = t.work()[0]!;
    expect(second).toMatchObject({ id: work_id, status: "open", last_turn: { type: "finished" } });
    expect(second.last_turn!.inbox_id).not.toBe(first.inbox_id);
    expect(t.g.state.inbox().find((e) => e.id === second.last_turn!.inbox_id)?.text).toContain("Lexer");
    await t.g.request("settle_work", { work_id, outcome: "accepted", lease });
    // The owner types in the terminal: nothing watches it, so nothing is reported.
    t.set("w1:p2", "working");
    expect((await t.poll()).messages).toEqual([]);
    expect((await t.finish("w1:p2", "Owner's own turn.")).messages).toEqual([]);
    expect(t.g.state.inbox().filter((e) => e.status === "unanswered")).toEqual([]);
    expect((await t.owed()).items).toEqual([]);
  });

  test("a turn that ended on an API error is failed and still open; the agent exiting leaves it open", async () => {
    const t = setup();
    const spawned: any = await t.g.request("spawn_agent", { kind: "claude", name: "shipper", repo: "app", prompt: "Ship it", reply: true });
    const paneId = spawned.pane.pane_id;
    await t.finish(paneId, "API Error: 529 Overloaded");
    const w = t.work()[0]!;
    expect(w).toMatchObject({ id: spawned.work_id, status: "open", last_turn: { type: "failed", result_id: expect.stringMatching(/^res_/) } });
    // The result is unchanged: still finished, as the Events schema says.
    expect(t.g.state.watched()[paneId]?.last_result?.status).toBe("finished");
    let item = (await t.owed()).items.find((i: any) => i.pane_id === paneId);
    expect(item).toMatchObject({ state: "failed", work: { id: spawned.work_id, title: "Ship it", last_turn: { type: "failed" } } });
    delete t.panes[paneId].agent;
    await t.poll();
    expect(t.work()[0]).toMatchObject({ status: "open", last_turn: { type: "gone" } });
    item = (await t.owed()).items.find((i: any) => i.pane_id === paneId);
    expect(item).toMatchObject({ status: "gone", work: { id: spawned.work_id, last_turn: { type: "gone" } }, settle: { work_id: spawned.work_id } });
    // Settling needs no agent: only records change.
    expect(await t.g.request("settle_work", { work_id: spawned.work_id, outcome: "dropped", lease: spawned.lease })).toMatchObject({ settled: true });
  });

  test("an API error or a Cursor turn that ended badly is failed; an interrupted turn is not", async () => {
    const t = setup();
    expect(apiError("API Error: 500 {\"type\":\"error\"}")).toBe(true);
    expect(apiError("[error: stream closed] API Error (Request timed out.)")).toBe(true);
    expect(apiError("The API Error handling is done.")).toBe(false);
    t.setScreen("[interrupted] half way");
    expect((await describeTurn(t.cfg, t.herdr, "finished", t.panes["w1:p1"])).failed).toBeUndefined();
    const id = "5bada10f-7201-4b25-8616-ec95d6a71501";
    const dir = join(t.state, "srv-allowed-relay", "agent-transcripts", id);
    mkdirSync(dir, { recursive: true });
    const lines = [
      { role: "user", message: { content: [{ type: "text", text: "<user_query>\nbuild it\n</user_query>" }] } },
      { role: "assistant", message: { content: [{ type: "text", text: "Starting." }] } },
      { type: "turn_ended", status: "error", error: "connection reset" },
    ];
    writeFileSync(join(dir, `${id}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n"));
    const cursor = { pane_id: "w3:p1", agent: "cursor", agent_status: "idle", cwd: "/srv/allowed/relay", agent_session: { kind: "id", value: id } };
    expect(await describeTurn(t.cfg, t.herdr, "finished", cursor)).toMatchObject({ type: "finished", failed: true });
  });

  test("owed_work is the same whether the turn's report was delivered or dropped", async () => {
    const run = async (deliver: boolean) => {
      const t = setup();
      const lease = await t.claim("mine", ["worker-b"]);
      await t.g.request("prompt_agent", { target: "worker-b", text: "Count the files", lease });
      t.set("w1:p2", "idle");
      t.setScreen("There are 12 files.");
      const found: any = await t.g.handle("watch_poll", { delivery: "ack" });
      expect(found.reports.length).toBe(1);
      // Delivered: the MCP server acknowledges it. Dropped: nobody ever does.
      if (deliver) await t.g.handle("watch_poll", { delivery: "ack", ack: found.reports.map((r: any) => r.event_id) });
      const out = await t.owed();
      return JSON.parse(JSON.stringify(out, (k, v) => (["id", "at", "started_at", "inbox_id", "pane_id", "lease", "created_at", "work_id"].includes(k) ? "_" : v)));
    };
    const delivered = await run(true);
    expect(delivered.items).toEqual([expect.objectContaining({ state: "unread_result", work: expect.objectContaining({ title: "Count the files" }) })]);
    expect(await run(false)).toEqual(delivered);
  });

  test("with no open work, a finished turn or an exit is not owed; a tell is", async () => {
    const t = setup();
    const spawned: any = await t.g.request("spawn_agent", { kind: "claude", name: "tester", repo: "app", prompt: "Write tests" });
    const paneId = spawned.pane.pane_id;
    await t.g.request("settle_work", { work_id: spawned.work_id, outcome: "accepted", lease: spawned.lease });
    // Spawned agents stay watched: the owner's own turn is reported and kept in the inbox,
    // but nobody is owed it.
    t.set(paneId, "working");
    await t.poll();
    expect((await t.finish(paneId, "Did a thing the owner typed.")).messages.length).toBe(1);
    expect(t.g.state.inbox().some((e) => e.pane_id === paneId && e.kind === "finished" && e.status === "unanswered")).toBe(true);
    const quiet = await t.owed();
    expect(quiet.counts).toEqual({ open: 0, needs_you: 0, unread: 0 });
    expect(owedDigest(t.g.state, t.cfg.allowedRoots)).toMatchObject({ open: 0, needs_you: 0, unread: 0 });
    await t.g.handle("tell", { pane_id: paneId, text: "I also noticed the README is stale." });
    expect((await t.owed()).items).toEqual([expect.objectContaining({ pane_id: paneId, work: null, settle: { target: paneId } })]);
    expect(owedDigest(t.g.state, t.cfg.allowedRoots).open).toBe(1);
  });
});

describe("work outlives the process, the scope and its coordination task", () => {
  test("a new StateStore and Gateway on the same directory still see it open", async () => {
    const t = setup();
    const res: any = await t.g.request("spawn_agent", { kind: "claude", name: "tester", repo: "app", prompt: "Long job" });
    const again = new Gateway(t.cfg, t.herdr);
    expect(Object.keys(new StateStore(t.state).work())).toEqual([res.work_id]);
    const out: any = await again.request("owed_work", {});
    expect(out.items).toEqual([expect.objectContaining({ pane_id: res.pane.pane_id, work: expect.objectContaining({ id: res.work_id, title: "Long job" }) })]);
  });

  test("open work of an agent now outside the roots is listed as left, with nothing from the live agent, and still settles", async () => {
    const t = setup();
    const lease = await t.claim("mine", ["worker-b"]);
    const { work_id }: any = await t.g.request("prompt_agent", { target: "worker-b", text: "Move the repo", lease });
    Object.assign(t.panes["w1:p2"], { cwd: "/srv/secret/moved", foreground_cwd: "/srv/secret/moved", agent_status: "done" });
    const out = await t.owed();
    expect(out.items).toEqual([expect.objectContaining({ pane_id: "w1:p2", cwd: null, status: "left", state: "gone", next: NEXT.left, work: expect.objectContaining({ id: work_id }), settle: { work_id } })]);
    expect(JSON.stringify(out)).not.toContain("secret");
    const digest = owedDigest(t.g.state, t.cfg.allowedRoots);
    expect({ open: digest.open, needs_you: digest.needs_you, unread: digest.unread }).toEqual(out.counts);
    expect(await t.g.request("settle_work", { work_id, outcome: "dropped", lease })).toMatchObject({ settled: true });
  });

  test("a coord_update that merges the bound task complete accepts its work", async () => {
    const t = setup();
    const lease = await t.claim("sup", ["worker-a"]);
    await t.g.request("coord_update", { objective: "demo", title: "Demo", lease, tasks: [{ id: "build", title: "Build it", owner: "worker-a" }] });
    const { work_id }: any = await t.g.request("prompt_agent", { target: "worker-a", text: "Build it", lease, task: { objective: "demo", id: "build" } });
    expect(t.work()[0]).toMatchObject({ id: work_id, coord: { objective: "demo", id: "build" }, status: "open" });
    // A merge that leaves it open changes nothing.
    await t.g.request("coord_update", { objective: "demo", lease, tasks: [{ id: "build", next_action: "verify" }] });
    expect(t.work()[0]!.status).toBe("open");
    await t.g.request("coord_update", { objective: "demo", lease, tasks: [{ id: "build", status: "complete" }] });
    expect(t.work()[0]).toMatchObject({ status: "accepted", closed_by: "coord" });
  });

  test("a task bind that was refused gives the work no task, so that task's completion leaves it open", async () => {
    const t = setup();
    const lease = await t.claim("sup");
    await t.g.request("coord_update", { objective: "demo", title: "Demo", lease, tasks: [{ id: "build", title: "Build it" }, { id: "ship", title: "Ship it", deps: ["build"] }] });
    const res: any = await t.g.request("spawn_agent", { kind: "claude", name: "shipper", repo: "app", prompt: "Ship it", lease, task: { objective: "demo", id: "ship" } });
    expect(res.prompt_error.code).toBe("deps_unmet");
    expect(t.work()[0]).toMatchObject({ id: res.work_id, status: "open" });
    expect(t.work()[0]!.coord).toBeUndefined();
    // Another agent's work on it is merged complete.
    await t.g.request("coord_update", { objective: "demo", lease, tasks: [{ id: "build", status: "complete" }, { id: "ship", status: "complete" }] });
    expect(t.work()[0]!.status).toBe("open");
  });

  test("work.json keeps every open record and the newest 500 closed ones, and refuses a malformed one", () => {
    const t = setup();
    const at = (i: number) => new Date(Date.UTC(2026, 9, 1, 0, 0, i)).toISOString();
    t.g.state.updateWork((all) => {
      for (let i = 0; i < 503; i++) {
        const id = `wk_${i.toString(16).padStart(16, "0")}`;
        const open = i < 2;
        all[id] = { id, pane_id: `w${i}:p1`, session: null, agent: null, kind: null, lease: null, title: "t", started_at: at(i), started_by: "prompt_agent", status: open ? "open" : "accepted", ...(open ? {} : { closed_at: at(i), closed_by: "console" }) } as Work;
      }
    });
    const kept = Object.values(t.g.state.work());
    expect(kept.length).toBe(502);
    expect(kept.filter((w) => w.status === "open").length).toBe(2);
    expect(kept.some((w) => w.id === `wk_${(2).toString(16).padStart(16, "0")}`)).toBe(false);
    writeFileSync(join(t.state, "work.json"), JSON.stringify({ wk_bad: { id: "wk_bad" } }));
    expect(() => t.g.state.work()).toThrow("Invalid gateway state: work.json");
  });
});
