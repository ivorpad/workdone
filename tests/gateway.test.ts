import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, paneInScope, withinRoots, type HerdrCall } from "../gateway/config.ts";
import { Gateway } from "../gateway/gateway.ts";

const state = mkdtempSync(join(tmpdir(), "herdr-gw-"));
const cfg = loadConfig({
  allowedRoots: ["/srv/allowed"],
  repos: { app: { path: "/srv/allowed/app", tasks: { test: "bun test" } } },
  stateDir: state,
});

const panes: Record<string, any> = {
  "w1:p1": { pane_id: "w1:p1", agent: "claude", agent_status: "idle", cwd: "/srv/allowed/app", foreground_cwd: "/srv/allowed/app" },
  "w1:p2": { pane_id: "w1:p2", cwd: "/srv/allowed/app", foreground_cwd: "/srv/allowed/app" },
  "w2:p1": { pane_id: "w2:p1", agent: "codex", agent_status: "idle", cwd: "/srv/secret", foreground_cwd: "/srv/secret" },
  "w1:p3": { pane_id: "w1:p3", cwd: "/srv/allowed/app", foreground_cwd: "/srv/allowed-evil" },
};

const sent: Array<[string, any]> = [];
const herdr: HerdrCall = async (method, params) => {
  sent.push([method, params]);
  switch (method) {
    case "agent.list":
      return { agents: Object.values(panes).filter((p) => p.agent) };
    case "agent.get":
      if (!panes[params.target as string]?.agent) throw Object.assign(new Error("nope"), { code: "agent_not_found" });
      return { agent: panes[params.target as string] };
    case "pane.get":
      return { pane: panes[params.pane_id as string] };
    case "pane.split":
      return { pane: { pane_id: "w1:p9", cwd: params.cwd } };
    default:
      return {};
  }
};
const gw = new Gateway(cfg, herdr);

describe("scope", () => {
  test("prefix match respects path boundaries", () => {
    expect(withinRoots("/srv/allowed", ["/srv/allowed"])).toBe(true);
    expect(withinRoots("/srv/allowed/x", ["/srv/allowed"])).toBe(true);
    expect(withinRoots("/srv/allowed-evil", ["/srv/allowed"])).toBe(false);
  });
  test("a pane that cd'd out of the root is out of scope", () => {
    expect(paneInScope(panes["w1:p3"], cfg.allowedRoots)).toBe(false);
  });
  test("config refuses / and $HOME as roots", () => {
    expect(() => loadConfig({ allowedRoots: ["/"] })).toThrow(/too broad/);
    expect(() => loadConfig({ allowedRoots: ["~"] })).toThrow(/too broad/);
  });
  test("config refuses repos outside the roots", () => {
    expect(() => loadConfig({ allowedRoots: ["/srv/allowed"], repos: { x: { path: "/etc" } } })).toThrow(/outside/);
  });
  test("without agentKinds, cursor is offered only where cursor-agent is installed", () => {
    const bin = mkdtempSync(join(tmpdir(), "herdr-bin-"));
    writeFileSync(join(bin, "cursor-agent"), "#!/bin/sh\n");
    chmodSync(join(bin, "cursor-agent"), 0o755);
    expect(loadConfig({ allowedRoots: ["/srv/allowed"], extraPath: [bin] }).agentKinds).toContain("cursor");
    const listed = loadConfig({ allowedRoots: ["/srv/allowed"], extraPath: [bin], agentKinds: ["claude", "codex"] });
    expect(listed.agentKinds).toEqual(["claude", "codex"]);
  });
});

describe("ops", () => {
  test("list_agents hides out-of-root agents", async () => {
    const res: any = await gw.handle("list_agents", {});
    expect(res.agents.map((a: any) => a.pane_id)).toEqual(["w1:p1"]);
  });
  test("out-of-root agent reads as not found", async () => {
    await expect(gw.handle("read_agent", { target: "w2:p1" })).rejects.toMatchObject({ code: "agent_not_found" });
  });
  test("flag-shaped targets are rejected before reaching herdr", async () => {
    const before = sent.length;
    await expect(gw.handle("get_agent", { target: "--all" })).rejects.toMatchObject({ code: "invalid_params" });
    expect(sent.length).toBe(before);
  });
  test("raw run and worktree removal are disabled by default", async () => {
    await expect(gw.handle("run_command_in_pane", { pane_id: "w1:p2", command: "id" })).rejects.toMatchObject({ code: "capability_disabled" });
    await expect(gw.handle("remove_worktree", { workspace_id: "w1" })).rejects.toMatchObject({ code: "capability_disabled" });
  });
  test("unknown op", async () => {
    await expect(gw.handle("shell", {})).rejects.toMatchObject({ code: "unknown_operation" });
  });
  test("repo task sends the configured command, never caller text", async () => {
    await gw.handle("run_repo_task", { repo: "app", task: "test", pane_id: "w1:p2" });
    expect(sent.at(-1)).toEqual(["pane.send_input", { pane_id: "w1:p2", text: "bun test", keys: ["enter"] }]);
    await expect(gw.handle("run_repo_task", { repo: "app", task: "rm", pane_id: "w1:p2" })).rejects.toMatchObject({ code: "unknown_task" });
  });
  test("repo task refuses an agent pane", async () => {
    await expect(gw.handle("run_repo_task", { repo: "app", task: "test", pane_id: "w1:p1" })).rejects.toMatchObject({ code: "pane_busy" });
  });
  test("send_agent_keys only allows listed keys", async () => {
    await expect(gw.handle("send_agent_keys", { target: "w1:p1", keys: ["ctrl+d"] })).rejects.toMatchObject({ code: "invalid_params" });
  });
  test("close_pane only closes panes the bridge created", async () => {
    await expect(gw.handle("close_pane", { pane_id: "w1:p2" })).rejects.toMatchObject({ code: "not_bridge_pane" });
    await gw.handle("split_pane", { pane_id: "w1:p2", repo: "app" });
    panes["w1:p9"] = { pane_id: "w1:p9", cwd: "/srv/allowed/app" };
    await gw.handle("close_pane", { pane_id: "w1:p9" });
    expect(sent.at(-1)).toEqual(["pane.close", { pane_id: "w1:p9" }]);
  });
});
