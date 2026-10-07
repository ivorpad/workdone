import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { timing } from "../gateway/answer-ops.ts";
import { loadConfig, type HerdrCall } from "../gateway/config.ts";
import { Gateway } from "../gateway/gateway.ts";
import { StateStore } from "../gateway/state.ts";

// A fake Herdr like the one in layout-agents.test.ts, with worktree.create. Without a
// path it does what Herdr does: puts the worktree under ~/.herdr/worktrees.
function world() {
  const panes: Record<string, any> = {};
  const sent: Array<[string, any]> = [];
  let n = 0;
  const herdr: HerdrCall = async (method, params: any) => {
    if (method === "pane.report_metadata") return { type: "ok" };
    sent.push([method, params]);
    switch (method) {
      case "worktree.create": {
        const id = `w8${++n}`;
        const cwd = params.path ?? `/Users/me/.herdr/worktrees/app/${params.branch}`;
        const pane = { pane_id: `${id}:p1`, workspace_id: id, tab_id: `${id}:t1`, cwd };
        panes[pane.pane_id] = pane;
        return { workspace: { workspace_id: id, label: params.label }, tab: { tab_id: `${id}:t1` }, root_pane: pane, worktree: { path: cwd, branch: params.branch } };
      }
      case "pane.get":
        return { pane: panes[params.pane_id] };
      case "agent.list":
        return { agents: Object.values(panes).filter((p) => p.agent) };
      case "agent.get":
        if (!panes[params.target]?.agent) throw Object.assign(new Error("nope"), { code: "agent_not_found" });
        return { agent: panes[params.target] };
      case "agent.start":
        Object.assign(panes[params.pane_id], { agent: params.kind, name: params.name, agent_status: "unknown" });
        return { agent: panes[params.pane_id] };
      case "agent.wait":
        panes[params.target].agent_status = "idle";
        return { agent: panes[params.target] };
      case "agent.prompt":
        return { type: "agent_prompted", agent: { ...panes[params.target], agent_status: "working" } };
      case "agent.read":
        return { text: "> " };
      default:
        return {};
    }
  };
  return { panes, sent, herdr };
}

function gateway(extra: Record<string, unknown> = {}, wrap: (h: HerdrCall) => HerdrCall = (h) => h) {
  timing.key = timing.text = timing.settle = 0;
  const w = world();
  const state = mkdtempSync(join(tmpdir(), "herdr-wt-"));
  const cfg = loadConfig({
    allowedRoots: ["/srv/allowed"], repos: { app: { path: "/srv/allowed/app" } }, stateDir: state, transcriptRoots: [state],
    cursorTranscriptRoots: [state], agentKinds: ["claude"], ...extra,
  });
  return { ...w, state, gw: new Gateway(cfg, wrap(w.herdr)) };
}

const methods = (sent: Array<[string, any]>) => sent.map(([m]) => m);

describe("worktrees stay inside the allowed roots", () => {
  test("spawn_agent puts the worktree next to the repo, and its agent takes the next prompt", async () => {
    const { gw, sent, state } = gateway();
    const res: any = await gw.handle("spawn_agent", { kind: "claude", name: "fixer", repo: "app", worktree_branch: "fix/login", prompt: "start" });
    expect(sent[0]).toEqual(["worktree.create", { cwd: "/srv/allowed/app", branch: "fix/login", path: "/srv/allowed/app.worktrees/fix/login", label: "fixer", focus: false }]);
    expect(res.pane).toMatchObject({ pane_id: "w81:p1", cwd: "/srv/allowed/app.worktrees/fix/login" });
    expect(res.prompt.submitted).toBe(true);
    expect(await gw.handle("prompt_agent", { target: "w81:p1", text: "and the tests" })).toMatchObject({ submitted: true });
    expect(new StateStore(state).watched()["w81:p1"]).toMatchObject({ name: "fixer", managed: true });
  });

  test("create_worktree passes the same sibling path", async () => {
    const { gw, sent } = gateway();
    await gw.handle("create_worktree", { repo: "app", branch: "spike" });
    expect(sent).toEqual([["worktree.create", { cwd: "/srv/allowed/app", branch: "spike", path: "/srv/allowed/app.worktrees/spike", focus: false }]]);
  });

  test("a worktree folder outside the roots is refused before Herdr creates anything", async () => {
    // The repo is the root itself, so its sibling folder is outside it.
    const { gw, sent } = gateway({ allowedRoots: ["/srv/allowed/app"] });
    const refusal = { code: "path_not_allowed", message: expect.stringMatching(/\/srv\/allowed\/app\.worktrees\/fix\/login.*set worktreeRoot/) };
    await expect(gw.handle("spawn_agent", { kind: "claude", name: "fixer", repo: "app", worktree_branch: "fix/login" })).rejects.toMatchObject(refusal);
    await expect(gw.handle("create_worktree", { repo: "app", branch: "fix/login" })).rejects.toMatchObject(refusal);
    expect(sent).toEqual([]);
  });

  test("with worktreeRoot set, worktrees go under it by repo key, even when the repo is a root itself", async () => {
    // Two repos in folders of the same name: their keys keep the worktrees apart.
    const { gw, sent } = gateway({
      allowedRoots: ["/srv/allowed/app", "/srv/allowed/fork", "/srv/allowed/trees"], worktreeRoot: "/srv/allowed/trees",
      repos: { app: { path: "/srv/allowed/app" }, fork: { path: "/srv/allowed/fork/app" } },
    });
    await gw.handle("create_worktree", { repo: "app", branch: "fix/login" });
    await gw.handle("create_worktree", { repo: "fork", branch: "fix/login" });
    expect(sent.map(([, p]) => p.path)).toEqual(["/srv/allowed/trees/app/fix/login", "/srv/allowed/trees/fork/fix/login"]);
    expect(() => loadConfig({ allowedRoots: ["/srv/allowed/app"], worktreeRoot: "/srv/elsewhere" })).toThrow("worktreeRoot is outside allowedRoots");
  });

  test("spawn_agent starts no agent in a pane Herdr placed outside the roots", async () => {
    // A Herdr that ignores path, as one without it would.
    const { gw, sent } = gateway({}, (h) => (m, p) => h(m, m === "worktree.create" ? { ...p, path: undefined } : p));
    const err: any = await gw.handle("spawn_agent", { kind: "claude", name: "fixer", repo: "app", worktree_branch: "fix/login", prompt: "start" }).catch((e) => e);
    expect(err.code).toBe("path_not_allowed");
    expect(err.message).toContain("w81:p1");
    expect(err.message).not.toContain(".herdr");
    expect(methods(sent)).toEqual(["worktree.create"]);
  });
});

describe("watcher", () => {
  function watching(cwdNow: string | null) {
    const g = gateway();
    if (cwdNow) g.panes["w1:p1"] = { pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1", agent: "claude", name: "fixer", agent_status: "working", cwd: cwdNow };
    writeFileSync(join(g.state, "watch.json"), JSON.stringify({
      "w1:p1": { name: "fixer", kind: "claude", cwd: "/srv/allowed/app", since: new Date().toISOString(), last_status: "working", managed: true, busy: true },
    }));
    return g;
  }

  test("an agent that moved outside the roots is dropped, and said to have left, without its new folder", async () => {
    const { gw, state } = watching("/srv/secret/elsewhere");
    const found: any = await gw.handle("watch_poll", {});
    expect(found).toMatchObject({ messages: ["fixer in app left the allowed roots, so WorkDone stopped watching it"], remaining: 0 });
    expect(found.reports.map((r: any) => [r.type, r.cwd, r.excerpt])).toEqual([["gone", "/srv/allowed/app", null]]);
    const inbox = new StateStore(state).inbox();
    expect(inbox.map((e) => [e.kind, e.cwd, e.text])).toEqual([["gone", "/srv/allowed/app", "left the allowed roots, so WorkDone stopped watching it"]]);
    expect(JSON.stringify([found, inbox])).not.toContain("secret");
  });

  test("an agent Herdr no longer lists is gone, as before", async () => {
    const { gw, state } = watching(null);
    expect(await gw.handle("watch_poll", {})).toMatchObject({ messages: ["fixer in app is gone (pane closed or agent exited)"], remaining: 0 });
    expect(new StateStore(state).inbox().map((e) => e.text)).toEqual(["gone"]);
  });
});
