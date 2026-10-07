// owed_work and the owed digest: what WorkDone started that is still owed to the user,
// derived from the gateway's state files; and the leases spawn_agent mints on its own.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { timing } from "../gateway/answer-ops.ts";
import { GatewayError, loadConfig, type HerdrCall } from "../gateway/config.ts";
import { Gateway } from "../gateway/gateway.ts";
import { NEXT, owedDigest } from "../gateway/owed.ts";
import { FANOUT, TOOLS } from "../mcp/src/tools.ts";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const APP = "/srv/allowed/app";
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

function setup() {
  timing.key = timing.text = timing.settle = 0;
  const state = mkdtempSync(join(tmpdir(), "owed-"));
  dirs.push(state);
  const panes: Record<string, any> = {
    "w1:p1": { pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1", name: "worker-a", agent: "claude", agent_status: "working", cwd: APP, foreground_cwd: APP, agent_session: { value: "sa" } },
    "w1:p2": { pane_id: "w1:p2", workspace_id: "w1", tab_id: "w1:t1", name: "worker-b", agent: "codex", agent_status: "idle", cwd: APP, foreground_cwd: APP, agent_session: { value: "sb" } },
  };
  const fail: Record<string, string> = {};
  let screen = "";
  let n = 0;
  const herdr: HerdrCall = async (method, params: any) => {
    if (fail[method]) throw new GatewayError(fail[method]!, `${method} failed`);
    switch (method) {
      case "agent.list": return { agents: Object.values(panes).filter((p) => p.agent) };
      case "pane.list": return { panes: Object.values(panes) };
      case "agent.get":
        if (!panes[params.target]?.agent) throw new GatewayError("agent_not_found", "nope");
        return { agent: panes[params.target] };
      case "pane.get": return { pane: panes[params.pane_id] };
      case "workspace.create": {
        const id = `w9${++n}`;
        const pane = { pane_id: `${id}:p1`, workspace_id: id, tab_id: `${id}:t1`, cwd: params.cwd };
        panes[pane.pane_id] = pane;
        return { workspace: { workspace_id: id, label: params.label }, tab: { tab_id: `${id}:t1`, label: "1" }, root_pane: pane };
      }
      case "agent.start":
        Object.assign(panes[params.pane_id], { agent: params.kind, name: params.name, agent_status: "unknown", foreground_cwd: panes[params.pane_id].cwd });
        return { agent: panes[params.pane_id] };
      case "agent.wait":
        panes[params.target].agent_status = "idle";
        return { agent: panes[params.target] };
      case "agent.prompt": return { agent: { ...panes[params.target], agent_status: params.wait ? "idle" : "working" } };
      case "agent.read": return { text: screen };
      default: return {};
    }
  };
  const g = new Gateway(loadConfig({
    allowedRoots: ["/srv/allowed"], repos: { app: { path: APP } }, stateDir: state, leases: true,
    transcriptRoots: [state], cursorTranscriptRoots: [state], agentKinds: ["claude", "codex"],
  }), herdr);
  const write = (file: string, value: unknown) => { mkdirSync(state, { recursive: true }); writeFileSync(join(state, file), JSON.stringify(value)); };
  const entry = (over: Record<string, unknown>) => ({
    id: `in_${Math.random().toString(16).slice(2, 14)}`, kind: "finished", at: ago(60_000), pane_id: "w1:p1", agent: "worker-a", agent_kind: "claude",
    cwd: APP, session: null, lease: null, task: null, text: "finished", status: "unanswered", ...over,
  });
  const owed = async (params: Record<string, unknown> = {}) => (await g.request("owed_work", params)) as any;
  return { g, state, panes, fail, write, entry, owed, setScreen: (s: string) => void (screen = s) };
}

describe("owed_work", () => {
  test("a spawned agent with its result pending is owed and working, held by the lease the spawn minted", async () => {
    const t = setup();
    const res: any = await t.g.request("spawn_agent", { kind: "claude", name: "tester", repo: "app", prompt: "run the tests", reply: true });
    expect(res.lease).toMatch(/^L-/);
    expect(res.result_request.result_id).toMatch(/^res_/);
    expect(t.g.state.leases()[res.lease]).toMatchObject({ origin: "spawn", panes: [res.pane.pane_id] });
    t.panes[res.pane.pane_id].agent_status = "working";
    const out = await t.owed({ lease: res.lease });
    const item = out.items.find((i: any) => i.pane_id === res.pane.pane_id);
    expect(item).toMatchObject({
      agent: "tester", kind: "claude", status: "working", state: "working", yours: true,
      result_pending: res.result_request.result_id, last_result: null, unanswered: [],
      holder: { lease: "…" + res.lease.slice(-4), label: "tester", origin: "spawn", live: true },
      next: NEXT.working,
    });
    expect(JSON.stringify(out)).not.toContain(res.lease);
    // The spawn's own result already carried the digest.
    expect(res.owed).toMatchObject({ open: 1, needs_you: 0, unread: 0 });
  });

  test("a turn that finished while no card was open is an unread result, with its summary", async () => {
    const t = setup();
    t.write("watch.json", { "w1:p1": { name: "worker-a", cwd: APP, since: ago(120_000), last_status: "working", managed: true, busy: true, session: "sa", result_request: { id: "res_0123456789abcdef", at: ago(120_000), lease: null } } });
    t.panes["w1:p1"].agent_status = "idle";
    t.setScreen("All done.\nRESULT: tests pass");
    await t.g.handle("watch_poll", {});
    const out = await t.owed();
    expect(out.items).toEqual([expect.objectContaining({ pane_id: "w1:p1", state: "unread_result", status: "idle", result_pending: null, next: NEXT.unread_result })]);
    expect(out.items[0].last_result).toMatchObject({ result_id: "res_0123456789abcdef", summary: "tests pass" });
    expect(out.items[0].unanswered).toEqual([expect.objectContaining({ kind: "result", text: "tests pass" })]);
    expect(out.counts).toEqual({ open: 1, needs_you: 0, unread: 1 });
    // A follow-up answers it: the agent is still watched, nothing is unread.
    await t.g.request("prompt_agent", { target: "w1:p1", text: "thanks", origin: "console" });
    expect((await t.owed()).counts.unread).toBe(0);
  });

  test("a question, or a menu, is needs_you ahead of anything unread", async () => {
    const t = setup();
    t.panes["w1:p1"].agent_status = "blocked";
    t.write("watch.json", { "w1:p1": { name: "worker-a", cwd: APP, since: ago(60_000), last_status: "blocked", managed: true, session: "sa" } });
    t.write("inbox.json", [
      t.entry({ pane_id: "w1:p2", agent: "worker-b", kind: "finished", text: "built it", at: ago(120_000) }),
      t.entry({ pane_id: "w1:p2", agent: "worker-b", kind: "question", text: "Which database should I use?" }),
    ]);
    const out = await t.owed();
    const byPane = Object.fromEntries(out.items.map((i: any) => [i.pane_id, i]));
    expect(byPane["w1:p1"]).toMatchObject({ state: "needs_you", status: "blocked", next: NEXT.needs_you });
    expect(byPane["w1:p2"]).toMatchObject({ state: "needs_you", status: "idle" });
    expect(byPane["w1:p2"].unanswered.map((e: any) => e.kind)).toEqual(["question", "finished"]);
    expect(out.counts).toEqual({ open: 2, needs_you: 2, unread: 0 });
  });

  test("an exit alone is not owed; an agent with open work that exited stays owed as gone", async () => {
    const t = setup();
    t.write("inbox.json", [t.entry({ pane_id: "w7:p1", agent: "left", kind: "gone", text: "gone" })]);
    expect((await t.owed()).items).toEqual([]);
    const id = "wk_00000000000000a1";
    t.write("work.json", { [id]: { id, pane_id: "w7:p1", session: null, agent: "left", kind: "claude", lease: null, title: "Port the parser", started_at: ago(120_000), started_by: "spawn_agent", status: "open" } });
    const out = await t.owed();
    expect(out.items).toEqual([expect.objectContaining({ pane_id: "w7:p1", agent: "left", status: "gone", state: "gone", cwd: APP, next: NEXT.gone, settle: { work_id: id } })]);
  });

  test("a lapsed lease is still listed as the holder, with live false", async () => {
    const t = setup();
    t.write("leases.json", { "L-lapsed01": { label: "old chat", panes: ["w1:p1"], created: ago(30 * 3600_000), used: ago(25 * 3600_000), origin: "claim" } });
    t.write("watch.json", { "w1:p1": { name: "worker-a", cwd: APP, since: ago(60_000), last_status: "working", managed: true, session: "sa", reply_to: "L-lapsed01" } });
    const out = await t.owed({ lease: "L-lapsed01" });
    expect(out.items[0]).toMatchObject({ pane_id: "w1:p1", yours: true, holder: { lease: "…ed01", label: "old chat", origin: "claim", live: false } });
    expect(JSON.stringify(out)).not.toContain("L-lapsed01");
  });

  test("three spawns without a lease mint three leases, each listed with origin spawn", async () => {
    const t = setup();
    const spawned: any[] = [];
    for (const name of ["one", "two", "three"]) spawned.push(await t.g.request("spawn_agent", { kind: "claude", name, repo: "app" }));
    expect(new Set(spawned.map((s) => s.lease)).size).toBe(3);
    const out = await t.owed();
    const items = spawned.map((s) => out.items.find((i: any) => i.pane_id === s.pane.pane_id));
    expect(items.map((i) => i.holder.origin)).toEqual(["spawn", "spawn", "spawn"]);
    expect(new Set(items.map((i) => i.holder.lease)).size).toBe(3);
    expect(items.every((i) => i.yours === false && i.holder.live)).toBe(true);
    // Another conversation's item says so, instead of what to do with it.
    const mine = await t.owed({ lease: spawned[0].lease });
    expect(mine.items.find((i: any) => i.pane_id === spawned[1].pane.pane_id).next).toBe(NEXT.held);
  });

  test("a live agent outside the allowed roots is not listed, even with state about it", async () => {
    const t = setup();
    t.panes["w2:p1"] = { pane_id: "w2:p1", name: "outside", agent: "claude", agent_status: "done", cwd: "/srv/secret", foreground_cwd: "/srv/secret" };
    t.write("watch.json", { "w2:p1": { name: "outside", cwd: APP, since: ago(60_000), last_status: "idle", managed: true } });
    t.write("inbox.json", [t.entry({ pane_id: "w2:p1", agent: "outside", kind: "question", text: "secret?" })]);
    const out = await t.owed();
    expect(out.items.map((i: any) => i.pane_id)).not.toContain("w2:p1");
    expect(out.unwatched_done).toEqual([]);
    expect(JSON.stringify(out)).not.toContain("/srv/secret");
  });

  test("a done agent nobody watches is in unwatched_done; one an item covers is not", async () => {
    const t = setup();
    t.panes["w1:p2"].agent_status = "done";
    t.panes["w3:p1"] = { pane_id: "w3:p1", name: "covered", agent: "codex", agent_status: "done", cwd: APP, foreground_cwd: APP };
    t.write("inbox.json", [t.entry({ pane_id: "w3:p1", agent: "covered", kind: "tell", text: "done here" })]);
    const out = await t.owed();
    expect(out.unwatched_done).toEqual([{ pane_id: "w1:p2", agent: "worker-b", kind: "codex", cwd: APP, last_reply_at: null }]);
    expect(out.items.map((i: any) => i.pane_id)).toEqual(["w3:p1"]);
  });

  test("objectives with something to decide are listed; it reads without writing anything", async () => {
    const t = setup();
    const claimed: any = await t.g.request("claim_agents", { label: "planner", targets: [] });
    expect(t.g.state.leases()[claimed.lease]!.origin).toBe("claim");
    await t.g.request("coord_update", { objective: "ship", title: "Ship it", lease: claimed.lease, tasks: [{ id: "a", title: "first" }, { id: "b", title: "second", deps: ["a"] }] });
    const files = ["watch.json", "inbox.json", "leases.json", "coord.json"];
    const before = files.map((f) => { try { return readFileSync(join(t.state, f), "utf8"); } catch { return null; } });
    const out = await t.owed({ lease: claimed.lease });
    expect(out.objectives).toEqual([expect.objectContaining({ id: "ship", supervisor: "…" + claimed.lease.slice(-4), supervisor_live: true, yours: true, ready: ["a"] })]);
    expect(files.map((f) => { try { return readFileSync(join(t.state, f), "utf8"); } catch { return null; } })).toEqual(before);
  });

  test("when Herdr does not answer, the state still says what is owed", async () => {
    const t = setup();
    t.write("inbox.json", [t.entry({ kind: "result", text: "RESULT done" })]);
    t.fail["agent.list"] = "herdr_unavailable";
    const out = await t.owed();
    expect(out.herdr_error).toBe("herdr_unavailable");
    expect(out.items).toEqual([expect.objectContaining({ pane_id: "w1:p1", state: "unread_result" })]);
  });

  test("no hint suggests a retry or a second prompt", () => {
    for (const text of Object.values(NEXT)) expect(text).not.toMatch(/retry|nudge|again|respawn|resend/i);
  });

  test("the MCP tool is read-only, takes an optional lease and asks every machine", () => {
    expect(TOOLS.owed_work!.annotations.readOnlyHint).toBe(true);
    expect((TOOLS.owed_work!.input.lease as any).safeParse(undefined).success).toBe(true);
    expect(FANOUT.has("owed_work")).toBe(true);
  });
});

describe("owed digest", () => {
  test("its counts equal owed_work's, and it rides on overview and get_agent", async () => {
    const t = setup();
    t.panes["w1:p2"].agent_status = "blocked";
    t.write("watch.json", {
      "w1:p1": { name: "worker-a", cwd: APP, since: ago(60_000), last_status: "working", managed: true, session: "sa", result_request: { id: "res_aaaaaaaaaaaaaaaa", at: ago(60_000), lease: null } },
      "w1:p2": { name: "worker-b", cwd: APP, since: ago(60_000), last_status: "blocked", managed: true, session: "sb" },
    });
    t.write("inbox.json", [
      t.entry({ pane_id: "w7:p1", agent: "left", kind: "gone", text: "gone" }),
      t.entry({ pane_id: "w8:p1", agent: "reporter", kind: "result", text: "x".repeat(400) }),
    ]);
    const out = await t.owed();
    const digest = owedDigest(t.g.state, t.g.cfg.allowedRoots);
    expect({ open: digest.open, needs_you: digest.needs_you, unread: digest.unread }).toEqual(out.counts);
    // w7:p1's exit alone is not owed.
    expect(out.counts).toEqual({ open: 3, needs_you: 1, unread: 1 });
    expect(digest.top.length).toBe(3);
    expect(digest.top.every((l) => l.length <= 120)).toBe(true);
    expect(digest.top[0]).toStartWith("worker-b (w1:p2) needs_you");
    for (const op of ["overview", "get_agent"]) {
      const res: any = await t.g.request(op, { target: "w1:p1" });
      expect(res.owed).toEqual(digest);
    }
  });

  test("it is left off when nothing is owed, and a digest that cannot be read never fails the call", async () => {
    const t = setup();
    expect(((await t.g.request("overview", {})) as any).owed).toBeUndefined();
    t.write("inbox.json", [t.entry({ kind: "question", text: "?" })]);
    // The digest's one read, e.g. the state lock held by another process past its wait.
    (t.g.state as any).transaction = () => { throw new Error("Gateway state lock is held; refusing mutation"); };
    const res: any = await t.g.request("get_agent", { target: "w1:p1" });
    expect(res.pane_id).toBe("w1:p1");
    expect(res.owed).toBeUndefined();
  });
});

describe("spawn leases", () => {
  test("a spawn that fails leaves no empty lease behind", async () => {
    const t = setup();
    t.fail["agent.start"] = "agent_start_failed";
    await expect(t.g.request("spawn_agent", { kind: "claude", name: "doomed", repo: "app" })).rejects.toMatchObject({ code: "agent_start_failed" });
    delete t.fail["agent.start"];
    t.fail["workspace.create"] = "herdr_unavailable";
    await expect(t.g.request("spawn_agent", { kind: "claude", name: "doomed", repo: "app" })).rejects.toMatchObject({ code: "herdr_unavailable" });
    expect(t.g.state.leases()).toEqual({});
  });

  test("a failed spawn under the caller's own lease leaves that lease alone", async () => {
    const t = setup();
    const claimed: any = await t.g.request("claim_agents", { label: "mine", targets: [] });
    t.fail["agent.start"] = "agent_start_failed";
    await expect(t.g.request("spawn_agent", { kind: "claude", name: "doomed", repo: "app", lease: claimed.lease })).rejects.toMatchObject({ code: "agent_start_failed" });
    expect(Object.keys(t.g.state.leases())).toEqual([claimed.lease]);
  });
});
