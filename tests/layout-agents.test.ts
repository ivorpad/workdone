import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { timing } from "../gateway/answer-ops.ts";
import { GatewayError, loadConfig, type HerdrCall } from "../gateway/config.ts";
import { Gateway } from "../gateway/gateway.ts";

const SESSION = "0b0f7d3e-1111-4222-8333-944455556666";
const DIALOG_SCREEN = "line1\nDo you want to proceed?\n1. Yes\n2. No\n";
// Cursor's first screen in a folder it has not been trusted with; Herdr reads it as idle.
const TRUST_SCREEN = [
  "live $ cursor-agent --model grok-4.7-low",
  "  ╭" + "─".repeat(60),
  "  │  ⚠ Workspace Trust Required",
  "  │  Cursor Agent can execute code and access files in this directory.",
  "  │  Do you trust the contents of this directory?",
  "  │    /srv/allowed/app",
  "  │    [a] Trust this workspace",
  "  │    [q] Quit",
  "  ╰" + "─".repeat(60),
].join("\n");
let screen: string | Error = DIALOG_SCREEN;
// What a key press does to the fake agent, e.g. close the menu it answered.
let onKeys: ((keys: string[]) => void) | null = null;
// What agent.explain answers: Herdr 0.9.1's shape, trimmed to two of its rules.
let explained: any = null;
const EXPLAIN = {
  agent: "cursor", state: "idle", manifest_source: "remote:/state/cursor.toml", manifest_version: "2026.09.11.1",
  matched_rule: { id: "live_prompt_box", priority: 950, region: "prompt_box_body", state: "idle" },
  evaluated_rules: [
    { id: "live_prompt_box", matched: true, state: "idle", priority: 950, evidence: { regex: ["x".repeat(2000)], region_preview: "→ Plan, search, build anything" } },
    { id: "generic_permission_prompt", matched: false, state: "blocked", priority: 840, evidence: { contains: ["Run this command?"], region_preview: "y".repeat(2000) } },
    { id: "osc_title_idle", matched: true, state: "idle", priority: 250, evidence: {} },
  ],
  fallback_reason: null, skip_state_update: false, skipped_update_reason: null, screen_detection_skipped: false,
  visible_blocker: false, visible_idle: true, visible_working: false, warning: null,
};
const CURSOR = "5bada10f-7201-4b25-8616-ec95d6a71501";
const fixture = (name: string) => readFileSync(join(import.meta.dir, "fixtures/screens", `${name}.txt`), "utf8");

function world() {
  const panes: Record<string, any> = {
    "w1:p1": { pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1", agent: "claude", agent_status: "idle", cwd: "/srv/allowed/app", agent_session: { kind: "id", value: SESSION } },
    "w1:p2": { pane_id: "w1:p2", workspace_id: "w1", tab_id: "w1:t1", cwd: "/srv/allowed/app" },
    "w2:p1": { pane_id: "w2:p1", workspace_id: "w2", tab_id: "w2:t1", cwd: "/srv/secret" },
    "w3:p1": { pane_id: "w3:p1", workspace_id: "w3", tab_id: "w3:t1", cwd: "/srv/allowed/app" },
    "w3:p2": { pane_id: "w3:p2", workspace_id: "w3", tab_id: "w3:t1", cwd: "/srv/secret" },
    "w4:p1": {
      pane_id: "w4:p1", workspace_id: "w4", tab_id: "w4:t1", agent: "cursor", agent_status: "working", cwd: "/srv/allowed/app",
      terminal_title_stripped: "Automations MVP", agent_session: { kind: "id", value: CURSOR },
    },
  };
  const sent: Array<[string, any]> = [];
  // Sidebar tokens go here rather than into sent: they are fire-and-forget extras.
  const reports: any[] = [];
  let n = 0;
  // Herdr 0.9's session.snapshot; noSnapshot() makes it answer as an older Herdr does.
  let snapshot = true;
  const herdr: HerdrCall = async (method, params: any) => {
    if (method === "pane.report_metadata") {
      reports.push(params);
      return { type: "ok" };
    }
    sent.push([method, params]);
    switch (method) {
      case "session.snapshot":
        if (!snapshot) throw new GatewayError("invalid_request", "invalid request: unknown variant `session.snapshot`");
        return {
          type: "session_snapshot",
          snapshot: { version: "0.9.1", protocol: 1, workspaces: [], tabs: [], layouts: [], panes: Object.values(panes), agents: Object.values(panes).filter((p) => p.agent) },
        };
      case "pane.list":
        return { panes: Object.values(panes).filter((p) => !params.workspace_id || p.workspace_id === params.workspace_id) };
      case "pane.get":
        if (!panes[params.pane_id]) throw Object.assign(new Error("gone"), { code: "pane_not_found" });
        return { pane: panes[params.pane_id] };
      case "workspace.list":
        return { workspaces: ["w1", "w2", "w3"].map((id) => ({ workspace_id: id, label: `ws ${id}` })) };
      case "tab.list":
        return { tabs: ["w1", "w2", "w3"].map((id) => ({ tab_id: `${id}:t1`, workspace_id: id, label: "1" })) };
      case "workspace.create": {
        const id = `w9${++n}`;
        const pane = { pane_id: `${id}:p1`, workspace_id: id, tab_id: `${id}:t1`, cwd: params.cwd };
        panes[pane.pane_id] = pane;
        return { workspace: { workspace_id: id, label: params.label }, tab: { tab_id: `${id}:t1`, label: "1" }, root_pane: pane };
      }
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
        return { type: "agent_prompted", agent: { ...panes[params.target], agent_status: params.wait ? "idle" : "working" } };
      case "agent.rename":
        return { agent: { ...panes[params.target], name: params.name } };
      case "agent.explain":
        if (explained instanceof Error) throw explained;
        return { type: "agent_explain", explain: explained };
      case "agent.read":
        if (screen instanceof Error) throw screen;
        return { text: screen };
      case "agent.send_keys":
        onKeys?.(params.keys);
        return {};
      default:
        return {};
    }
  };
  return { panes, sent, reports, herdr, noSnapshot: () => void (snapshot = false) };
}

function gateway(extra: Record<string, unknown> = {}) {
  screen = DIALOG_SCREEN;
  onKeys = null;
  explained = EXPLAIN;
  timing.key = timing.text = timing.settle = 0;
  const w = world();
  const state = mkdtempSync(join(tmpdir(), "herdr-lay-"));
  const cfg = loadConfig({
    allowedRoots: ["/srv/allowed"], repos: { app: { path: "/srv/allowed/app" } }, stateDir: state, transcriptRoots: [state],
    cursorTranscriptRoots: [state], agentKinds: ["claude", "codex", "cursor"], ...extra,
  });
  const watched = () => JSON.parse(readFileSync(join(state, "watch.json"), "utf8"));
  return { ...w, state, watched, gw: new Gateway(cfg, w.herdr) };
}

// A Cursor transcript for the w4:p1 agent, under the folder slug Cursor uses.
function cursorTranscript(root: string, entries: any[]) {
  const dir = join(root, "srv-allowed-app", "agent-transcripts", CURSOR);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${CURSOR}.jsonl`), entries.map((e) => JSON.stringify(e)).join("\n"));
}
const cursorAsk = (q: string) => ({ role: "user", message: { content: [{ type: "text", text: `<user_query>\n${q}\n</user_query>` }] } });
const cursorSay = (t: string) => ({ role: "assistant", message: { content: [{ type: "text", text: t }] } });

describe("layout", () => {
  test("list_workspaces shows only in-scope panes and drops empty workspaces", async () => {
    const { gw } = gateway();
    const res: any = await gw.handle("list_workspaces", {});
    expect(res.workspaces.map((w: any) => w.workspace_id)).toEqual(["w1", "w3"]);
    expect(res.workspaces[1].tabs[0].panes.map((p: any) => p.pane_id)).toEqual(["w3:p1"]);
  });
  test("create_workspace refuses a directory outside the roots", async () => {
    const { gw } = gateway();
    await expect(gw.handle("create_workspace", { cwd: "/srv/secret" })).rejects.toMatchObject({ code: "path_not_allowed" });
  });
  test("close: bridge-made things only, unless allowCloseAny", async () => {
    const { gw, sent } = gateway();
    const made: any = await gw.handle("create_workspace", { repo: "app", label: "scratch" });
    await gw.handle("close", { kind: "workspace", id: made.workspace.workspace_id });
    expect(sent.at(-1)).toEqual(["workspace.close", { workspace_id: made.workspace.workspace_id }]);
    await expect(gw.handle("close", { kind: "workspace", id: "w1" })).rejects.toMatchObject({ code: "not_bridge_workspace" });
    const any = gateway({ allowCloseAny: true });
    await any.gw.handle("close", { kind: "tab", id: "w1:t1" });
    expect(any.sent.at(-1)).toEqual(["tab.close", { tab_id: "w1:t1" }]);
    // w3 also holds a pane outside the roots: closing it would kill that pane.
    await expect(any.gw.handle("close", { kind: "workspace", id: "w3" })).rejects.toMatchObject({ code: "outside_scope" });
    await expect(any.gw.handle("close", { kind: "workspace", id: "w2" })).rejects.toMatchObject({ code: "workspace_not_found" });
  });
  test("rename checks names and labels", async () => {
    const { gw, sent } = gateway();
    await expect(gw.handle("rename", { kind: "agent", id: "w1:p1", label: "Not Valid" })).rejects.toMatchObject({ code: "invalid_params" });
    await expect(gw.handle("rename", { kind: "tab", id: "w1:t1" })).rejects.toMatchObject({ code: "invalid_params" });
    await gw.handle("rename", { kind: "pane", id: "w1:p2", label: "tests" });
    expect(sent.at(-1)).toEqual(["pane.rename", { pane_id: "w1:p2", label: "tests" }]);
  });
  test("send_pane_input needs raw pane run and valid key names", async () => {
    const off = gateway();
    await expect(off.gw.handle("send_pane_input", { pane_id: "w1:p2", keys: ["ctrl+c"] })).rejects.toMatchObject({ code: "capability_disabled" });
    const on = gateway({ allowRawPaneRun: true });
    await on.gw.handle("send_pane_input", { pane_id: "w1:p2", text: "q", keys: ["enter"] });
    expect(on.sent.at(-1)).toEqual(["pane.send_input", { pane_id: "w1:p2", text: "q", keys: ["enter"] }]);
    await expect(on.gw.handle("send_pane_input", { pane_id: "w1:p2", keys: ["enter; rm"] })).rejects.toMatchObject({ code: "invalid_params" });
  });
});

describe("agents", () => {
  test("spawn_agent places, starts, waits and prompts in one call", async () => {
    const { gw, sent } = gateway();
    const res: any = await gw.handle("spawn_agent", { kind: "claude", name: "worker", repo: "app", prompt: "run the tests" });
    expect(res.status).toBe("idle");
    expect(res.prompt.submitted).toBe(true);
    expect(sent.map(([m]) => m)).toEqual(["workspace.create", "agent.start", "agent.wait", "agent.read", "agent.get", "agent.read", "agent.prompt"]);
    expect(sent[0]![1]).toMatchObject({ cwd: "/srv/allowed/app", label: "worker", focus: false });
  });
  test("spawn_agent waits for a new pane's shell before starting the agent", async () => {
    const { gw, herdr } = gateway();
    let refusals = 2;
    const slow: typeof herdr = async (method, params) => {
      if (method === "agent.start" && refusals-- > 0) throw new GatewayError("agent_pane_busy", "agent target pane is not an available shell");
      return herdr(method, params);
    };
    const res: any = await new Gateway(gw.cfg, slow).handle("spawn_agent", { kind: "claude", name: "late", repo: "app" });
    expect(res).toMatchObject({ status: "idle", name: "late" });
    const never: typeof herdr = async (method, params) => {
      if (method === "agent.start") throw new GatewayError("agent_kind_unknown", "no such kind");
      return herdr(method, params);
    };
    await expect(new Gateway(gw.cfg, never).handle("spawn_agent", { kind: "claude", name: "x", repo: "app" })).rejects.toThrow(/the new pane is w9\d:p1/);
  });
  test("agent args need exec", async () => {
    const { gw } = gateway();
    await expect(gw.handle("spawn_agent", { kind: "claude", name: "w", repo: "app", args: ["--model", "x"] })).rejects.toMatchObject({ code: "capability_disabled" });
  });
  test("prompt_agent with wait returns the reply from the transcript", async () => {
    const tr = mkdtempSync(join(tmpdir(), "herdr-tr-"));
    mkdirSync(join(tr, "-srv-allowed-app"));
    const lines = [
      { type: "user", message: { content: "Summarise the change" } },
      { type: "assistant", timestamp: "t1", message: { id: "m", stop_reason: "end_turn", content: [{ type: "text", text: "It renames the flag." }] } },
    ];
    writeFileSync(join(tr, "-srv-allowed-app", `${SESSION}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n"));
    const { gw } = gateway({ transcriptRoots: [tr] });
    const res: any = await gw.handle("prompt_agent", { target: "w1:p1", text: "Summarise the change", wait: true });
    expect(res.reply).toMatchObject({ text: "It renames the flag.", matches_prompt: true });
  });
  test("an agent prompted without waiting goes on the watch list", async () => {
    const { gw, watched } = gateway();
    await gw.handle("prompt_agent", { target: "w1:p1", text: "long job" });
    expect(Object.keys(watched())).toEqual(["w1:p1"]);
    expect(watched()["w1:p1"].managed).toBeUndefined();
  });
  test("an answer returned by prompt_agent with wait is not reported again", async () => {
    const { gw, watched } = gateway();
    await gw.handle("prompt_agent", { target: "w1:p1", text: "long job" });
    await gw.handle("prompt_agent", { target: "w1:p1", text: "quick one", wait: true });
    expect(watched()).toEqual({});
  });
  test("overview shows the dialog of a blocked agent", async () => {
    const { gw, panes } = gateway();
    panes["w1:p1"].agent_status = "blocked";
    const res: any = await gw.handle("overview", {});
    expect(res.counts).toEqual({ blocked: 1, working: 1 });
    expect(res.agents[0]).toMatchObject({ attention: "dialog", watch: null });
    expect(res.agents[0].dialog).toContain("Do you want to proceed?");
  });
});

describe("cursor and managed agents", () => {
  test("start_agent and spawn_agent take kind cursor when it is configured", async () => {
    const { gw, sent } = gateway();
    await gw.handle("start_agent", { pane_id: "w1:p2", kind: "cursor", name: "stays" });
    expect(sent.find(([m]) => m === "agent.start")![1]).toMatchObject({ kind: "cursor", name: "stays", args: [] });
    const off = gateway({ agentKinds: ["claude", "codex"] });
    await expect(off.gw.handle("start_agent", { pane_id: "w1:p2", kind: "cursor", name: "stays" })).rejects.toMatchObject({ code: "invalid_params" });
    await expect(off.gw.handle("spawn_agent", { kind: "cursor", name: "stays", repo: "app" })).rejects.toMatchObject({ code: "invalid_params" });
  });
  test("an agent started through the bridge is managed unless watch is false", async () => {
    const { gw, watched } = gateway();
    await gw.handle("start_agent", { pane_id: "w1:p2", kind: "cursor", name: "stays" });
    expect(watched()["w1:p2"]).toMatchObject({ managed: true, busy: false, kind: "cursor", name: "stays", cwd: "/srv/allowed/app" });
    const res: any = await gw.handle("spawn_agent", { kind: "cursor", name: "worker", repo: "app", prompt: "build the editor" });
    expect(res).toMatchObject({ status: "idle", watching: true, prompt: { submitted: true } });
    // The first prompt went out without waiting: that turn is the one to report.
    expect(watched()[res.pane.pane_id]).toMatchObject({ managed: true, busy: true, name: "worker" });
    const quiet = gateway();
    await quiet.gw.handle("start_agent", { pane_id: "w1:p2", kind: "claude", name: "x", watch: false });
    expect(existsSync(join(quiet.state, "watch.json"))).toBe(false);
  });
  test("start_agent drops what is left of a watch on that pane", async () => {
    const { gw, state, watched } = gateway();
    writeFileSync(join(state, "watch.json"), JSON.stringify({ "w1:p2": { name: "old", cwd: null, since: "2026-09-01T00:00:00Z", managed: true, busy: true } }));
    await gw.handle("start_agent", { pane_id: "w1:p2", kind: "cursor", name: "stays" });
    expect(watched()["w1:p2"]).toMatchObject({ name: "stays", busy: false });
  });
  test("watch_agent manages a running agent; prompts keep it managed; stop ends it", async () => {
    const { gw, watched } = gateway();
    await expect(gw.handle("watch_agent", { target: "w2:p1" })).rejects.toMatchObject({ code: "agent_not_found" });
    const res: any = await gw.handle("watch_agent", { target: "w4:p1" });
    expect(res).toMatchObject({ watching: true, agent: { pane_id: "w4:p1", agent: "cursor", attention: null, watch: { mode: "managed", last_event: null } } });
    // It was working when watched, so that turn gets reported.
    expect(watched()["w4:p1"]).toMatchObject({ managed: true, busy: true, last_status: "working" });
    await gw.handle("prompt_agent", { target: "w4:p1", text: "and the tests", wait: true });
    expect(watched()["w4:p1"]).toMatchObject({ managed: true, busy: false, last_status: "idle" });
    await gw.handle("prompt_agent", { target: "w4:p1", text: "long job" });
    expect(watched()["w4:p1"]).toMatchObject({ managed: true, busy: true });
    expect(watched()["w4:p1"].prompted_at).toBeString();
    expect(await gw.handle("watch_agent", { target: "w4:p1", stop: true })).toMatchObject({ watching: false });
    expect(watched()).toEqual({});
  });
  test("a turn prompt_agent is watching carries over into a managed watch", async () => {
    const { gw, watched } = gateway();
    await gw.handle("prompt_agent", { target: "w1:p1", text: "long job" });
    await gw.handle("watch_agent", { target: "w1:p1" });
    expect(watched()["w1:p1"]).toMatchObject({ managed: true, busy: true });
    expect(watched()["w1:p1"].prompted_at).toBeString();
  });
  test("get_agent, read_agent and overview say when a Cursor agent stopped to ask", async () => {
    const { gw, panes, state } = gateway();
    panes["w4:p1"].agent_status = "done";
    cursorTranscript(state, [cursorAsk("finish the editor"), cursorSay("Editor done.\n\nShould I start the pack assignment?"), { type: "turn_ended", status: "success" }]);
    await gw.handle("watch_agent", { target: "w4:p1" });
    expect(await gw.handle("get_agent", { target: "w4:p1" })).toMatchObject({ status: "done", attention: "question", watch: { mode: "managed" } });
    const read: any = await gw.handle("read_agent", { target: "w4:p1", source: "reply" });
    expect(read.reply).toMatchObject({ text: "Editor done.\n\nShould I start the pack assignment?", in_reply_to: "finish the editor" });
    expect(read.agent.attention).toBe("question");
    const res: any = await gw.handle("overview", {});
    const cursor = res.agents.find((a: any) => a.pane_id === "w4:p1");
    expect(cursor).toMatchObject({ attention: "question", last_reply: { text: "Editor done.\n\nShould I start the pack assignment?" } });
    expect(res.agents.find((a: any) => a.pane_id === "w1:p1").watch).toBeNull();
  });
  test("get_agent explain: true adds Herdr's verdict without its rule evidence, and null on an older Herdr", async () => {
    const { gw, sent, panes } = gateway();
    expect(await gw.handle("get_agent", { target: "w4:p1" })).not.toHaveProperty("explain");
    expect(sent.some(([m]) => m === "agent.explain")).toBe(false);
    const res: any = await gw.handle("get_agent", { target: "w4:p1", explain: true });
    expect(sent.find(([m]) => m === "agent.explain")?.[1]).toEqual({ target: "w4:p1" });
    expect(res).toMatchObject({ status: "working" });
    expect(res.explain).toEqual({
      state: "idle",
      matched_rule: { id: "live_prompt_box", state: "idle", region: "prompt_box_body", priority: 950 },
      region_preview: "→ Plan, search, build anything",
      also_matched: ["osc_title_idle (idle)"],
      visible: { blocker: false, working: false, idle: true },
      skip_state_update: false, skipped_update_reason: null, fallback_reason: null,
      screen_detection_skipped: false, screen_detection_skip_reason: null,
      manifest: "remote:/state/cursor.toml 2026.09.11.1", warning: null,
    });
    expect(JSON.stringify(res.explain).length).toBeLessThan(1000);
    explained = new GatewayError("unknown_method", "unknown method agent.explain");
    expect(await gw.handle("get_agent", { target: "w4:p1", explain: true })).toMatchObject({ status: "working", explain: null, explain_error: "unknown_method" });
    // Scope checks come first: an agent outside the allowed roots is not found, and not explained.
    panes["w2:p1"].agent = "claude";
    await expect(gw.handle("get_agent", { target: "w2:p1", explain: true })).rejects.toMatchObject({ code: "agent_not_found" });
    expect(sent.some(([m, p]) => m === "agent.explain" && p.target === "w2:p1")).toBe(false);
  });
  test("a dialog Herdr misses stops a prompt before it is typed into the dialog", async () => {
    const { gw, panes, sent, state } = gateway({ autoApprove: false });
    panes["w4:p1"].agent_status = "idle";
    screen = TRUST_SCREEN;
    await expect(gw.handle("prompt_agent", { target: "w4:p1", text: "go" })).rejects.toMatchObject({ code: "agent_blocked" });
    expect(sent.some(([m]) => m === "agent.prompt")).toBe(false);
    expect(existsSync(join(state, "watch.json"))).toBe(false);
    expect(await gw.handle("get_agent", { target: "w4:p1" })).toMatchObject({ status: "idle", attention: "dialog" });
    // spawn_agent still returns the new agent, with the prompt held back.
    const res: any = await gw.handle("spawn_agent", { kind: "cursor", name: "fresh", repo: "app", prompt: "build it" });
    expect(res).toMatchObject({ status: "blocked", watching: true, name: "fresh" });
    expect(res.note).toContain("Do you trust the contents of this directory?");
    expect(res.prompt).toBeUndefined();
  });
  test("folder trust Herdr misses is given, then the prompt goes in", async () => {
    const { gw, panes, sent } = gateway();
    panes["w4:p1"].agent_status = "idle";
    screen = TRUST_SCREEN;
    onKeys = () => void (screen = "");
    const res: any = await gw.handle("prompt_agent", { target: "w4:p1", text: "go" });
    expect(res).toMatchObject({ submitted: true, auto_approved: [{ kind: "trust", option: "Trust this workspace" }] });
    expect(sent.filter(([m]) => m === "agent.send_keys" || m === "agent.prompt")).toEqual([
      ["agent.send_keys", { target: "w4:p1", keys: ["a"] }],
      ["agent.prompt", { target: "w4:p1", text: "go", wait: null }],
    ]);
    // spawn_agent answers it before its first prompt.
    screen = TRUST_SCREEN;
    const spawned: any = await gw.handle("spawn_agent", { kind: "cursor", name: "fresh", repo: "app", prompt: "build it" });
    expect(spawned).toMatchObject({ status: "idle", auto_approved: [{ kind: "trust" }], prompt: { submitted: true } });
    // A permission is not a startup menu: prompt_agent leaves it to answer_agent.
    screen = fixture("cursor-write");
    await expect(gw.handle("prompt_agent", { target: "w4:p1", text: "go" })).rejects.toMatchObject({ code: "agent_blocked" });
  });
  test("prompt_agent and wait_agent wait through a permission, and say what they approved", async () => {
    const { gw, herdr, panes, state } = gateway();
    const blocking: HerdrCall = async (method, params: any) => {
      if (method === "agent.prompt" && params.wait) {
        Object.assign(panes["w1:p1"], { agent_status: "blocked" });
        screen = fixture("claude-ask-rule");
        return { type: "agent_prompted", agent: { ...panes["w1:p1"] } };
      }
      return herdr(method, params);
    };
    onKeys = () => {
      panes["w1:p1"].agent_status = "working";
      screen = fixture("claude-steer");
    };
    const g2 = new Gateway(gw.cfg, blocking);
    const res: any = await g2.handle("prompt_agent", { target: "w1:p1", text: "run it", wait: true });
    expect(res).toMatchObject({ submitted: true, status: "idle", auto_approved: [{ kind: "permission", option: "Yes" }] });
    expect(res.auto_approved[0].menu).toContain("echo approve-capture");
    // Settled with the answer in hand: nothing left to report.
    expect(existsSync(join(state, "watch.json"))).toBe(false);
    // wait_agent: the default wait goes on past the menu; an explicit blocked stops there.
    let waits = 0;
    const stuck: HerdrCall = async (method, params: any) => {
      if (method === "agent.wait" && waits++ === 0) return { agent: { ...panes["w1:p1"], agent_status: "blocked" } };
      return herdr(method, params);
    };
    panes["w1:p1"].agent_status = "blocked";
    screen = fixture("claude-edit");
    const waited: any = await new Gateway(gw.cfg, stuck).handle("wait_agent", { target: "w1:p1" });
    expect(waited).toMatchObject({ agent: { agent_status: "idle" }, auto_approved: [{ kind: "permission", option: "Yes" }] });
    waits = 0;
    screen = fixture("claude-edit");
    expect(await new Gateway(gw.cfg, stuck).handle("wait_agent", { target: "w1:p1", until: ["blocked", "idle"] })).toMatchObject({ agent: { agent_status: "blocked" } });
  });
  test("a question stops the wait and stays for the owner", async () => {
    const { gw, herdr, panes } = gateway();
    const asking: HerdrCall = async (method, params: any) => {
      if (method === "agent.prompt" && params.wait) {
        panes["w1:p1"].agent_status = "blocked";
        screen = fixture("claude-ask");
        return { type: "agent_prompted", agent: { ...panes["w1:p1"] } };
      }
      return herdr(method, params);
    };
    const res: any = await new Gateway(gw.cfg, asking).handle("prompt_agent", { target: "w1:p1", text: "pick one", wait: true });
    expect(res.status).toBe("blocked");
    expect(res.auto_approved).toBeUndefined();
  });
  test("watch_agent and start_agent take a go-ahead that is already up", async () => {
    const { gw, herdr, panes, sent, watched } = gateway();
    // Herdr can still say working while Cursor's approval is up.
    screen = fixture("cursor-perm");
    onKeys = () => void (screen = fixture("cursor-steer-2"));
    const res: any = await gw.handle("watch_agent", { target: "w4:p1" });
    expect(res).toMatchObject({ watching: true, auto_approved: [{ kind: "permission", option: "Run (once)" }] });
    expect(sent.filter(([m]) => m === "agent.send_keys").map(([, p]) => p.keys)).toEqual([["y"]]);
    // A new agent at folder trust: agent.start gives up waiting for it to be ready.
    const trust: HerdrCall = async (method, params: any) => {
      if (method === "agent.start") {
        Object.assign(panes[params.pane_id], { agent: params.kind, name: params.name, agent_status: "idle" });
        throw new GatewayError("agent_not_ready", "agent did not become ready");
      }
      return herdr(method, params);
    };
    screen = TRUST_SCREEN;
    onKeys = () => void (screen = "");
    const started: any = await new Gateway(gw.cfg, trust).handle("start_agent", { pane_id: "w1:p2", kind: "cursor", name: "fresh" });
    expect(started).toMatchObject({ agent: { agent_status: "idle" }, auto_approved: [{ kind: "trust" }] });
    expect(watched()["w1:p2"]).toMatchObject({ managed: true, name: "fresh", last_status: "idle" });
  });
  test("a menu on any agent's screen stops the prompt, a quoted one does not", async () => {
    const { gw, panes, sent } = gateway();
    // A menu with an input box drawn under it was answered: it is only scrollback.
    screen = TRUST_SCREEN + "\n" + "─".repeat(40) + "\n❯ \n" + "─".repeat(40);
    await gw.handle("prompt_agent", { target: "w1:p1", text: "go" });
    expect(sent.at(-1)![0]).toBe("agent.prompt");
    screen = TRUST_SCREEN;
    await expect(gw.handle("prompt_agent", { target: "w1:p1", text: "go" })).rejects.toMatchObject({ code: "agent_blocked" });
    panes["w4:p1"].agent_status = "idle";
    screen = new Error("herdr_timeout");
    await expect(gw.handle("prompt_agent", { target: "w4:p1", text: "go" })).rejects.toThrow("herdr_timeout");
    expect(sent.at(-1)![0]).toBe("agent.read");
  });
  test("a transcript that cannot be read breaks only the reply source", async () => {
    const { gw, state } = gateway({ transcriptRoots: [mkdtempSync(join(tmpdir(), "herdr-bad-"))] });
    const root = (gw.cfg.transcriptRoots as string[])[0]!;
    mkdirSync(join(root, "-srv-allowed-app", `${SESSION}.jsonl`), { recursive: true });
    expect(await gw.handle("read_agent", { target: "w1:p1", source: "recent" })).toMatchObject({ agent: { pane_id: "w1:p1" } });
    await expect(gw.handle("read_agent", { target: "w1:p1", source: "reply" })).rejects.toBeDefined();
    expect(state).toBeString();
  });
  test("prompt_agent with wait returns a Cursor agent's reply", async () => {
    const { gw, state } = gateway();
    cursorTranscript(state, [cursorAsk("Reply with OK"), cursorSay("OK"), { type: "turn_ended", status: "success" }]);
    const res: any = await gw.handle("prompt_agent", { target: "w4:p1", text: "Reply with OK", wait: true });
    expect(res.reply).toMatchObject({ text: "OK", matches_prompt: true });
  });
});

describe("agent aliases", () => {
  const agentAliases = {
    otter: { kind: "claude", args: ["--model", "opus", "--effort", "{effort}"], efforts: ["low", "high", "xhigh", "max"], effort: "high" },
    fox: { kind: "cursor", args: ["--model", "{effort}"], efforts: { high: "grok-4.7-high", "high-fast": "grok-4.7-high-fast" } },
  };

  test("effort picks the args, and defaults to the alias's own", async () => {
    const { gw, sent } = gateway({ agentAliases });
    await gw.handle("spawn_agent", { kind: "fox", effort: "high-fast", name: "a", repo: "app" });
    await gw.handle("spawn_agent", { kind: " Otter.", effort: "Max", name: "b", repo: "app" });
    await gw.handle("spawn_agent", { kind: "Fox", effort: "High Fast", name: "d", repo: "app" });
    await gw.handle("spawn_agent", { kind: "otter", effort: "extra high", name: "e", repo: "app" });
    const starts = sent.filter(([m]) => m === "agent.start").map(([, p]) => p.args);
    expect(starts).toEqual([
      ["--model", "grok-4.7-high-fast"], ["--model", "opus", "--effort", "max"],
      ["--model", "grok-4.7-high-fast"], ["--model", "opus", "--effort", "xhigh"],
    ]);
    await expect(gw.handle("spawn_agent", { kind: "fox", effort: "max", name: "c", repo: "app" })).rejects.toThrow("fox: effort must be one of high, high-fast");
    const status: any = await gw.handle("bridge_status", {});
    expect(status.agents).toEqual({ otter: { efforts: ["low", "high", "xhigh", "max"], effort: "high" }, fox: { efforts: ["high", "high-fast"], effort: "high" } });
  });

  test("a machine offers only the aliases of kinds it has", () => {
    const cfg = loadConfig({ allowedRoots: ["/srv/allowed"], agentKinds: ["claude"], agentAliases });
    expect(Object.keys(cfg.agentAliases)).toEqual(["otter"]);
  });

  test("a bad alias fails the config", () => {
    const load = (a: unknown) => () => loadConfig({ allowedRoots: ["/srv/allowed"], agentAliases: { x: a } });
    expect(load({ kind: "claude", args: ["--effort", "{effort}"] })).toThrow("exactly when efforts");
    expect(load({ kind: "claude", args: ["--effort", "{effort}"], efforts: ["low"], effort: "max" })).toThrow("not in efforts");
  });

  test("an alias starts its kind with its args, and the result names the alias", async () => {
    const { gw, sent } = gateway({ agentAliases });
    const res: any = await gw.handle("spawn_agent", { kind: "otter", name: "w", repo: "app" });
    expect(sent.find(([m]) => m === "agent.start")![1]).toMatchObject({ kind: "claude", args: ["--model", "opus", "--effort", "high"] });
    const shown = JSON.stringify(gw.mask.result("spawn_agent", res));
    expect(shown).toContain('"kind":"otter"');
    expect(shown).not.toMatch(/claude/i);
    // The alias sticks to the pane and the name, not just the kind.
    const listed: any = gw.mask.result("list_agents", await gw.handle("list_agents", {}));
    expect(listed.agents.find((a: any) => a.name === "w").agent).toBe("otter");
    expect(listed.agents.find((a: any) => a.pane_id === "w1:p1").agent).toBe("otter");
  });

  test("screens, titles and errors lose vendor and model names but keep paths", async () => {
    const { gw } = gateway({ agentAliases });
    screen = TRUST_SCREEN + "\n claude-opus-5-thinking-high · Opus 5.5 · ~/.claude/x";
    const res: any = gw.mask.result("read_agent", await gw.handle("read_agent", { target: "w4:p1", source: "visible" }), "w4:p1");
    expect(res.agent.agent).toBe("fox");
    expect(res.agent.cwd).toBe("/srv/allowed/app");
    expect(res.text).toContain("live $ fox");
    expect(res.text).toContain("/srv/allowed/app");
    expect(res.text).not.toMatch(/cursor-agent|Cursor|grok|claude|Opus/);
    expect(gw.mask.text("pane w1 runs Claude Code")).toBe("pane w1 runs agent");
  });

  test("bridge_status offers the aliases, and file ops are not touched", async () => {
    const { gw } = gateway({ agentAliases });
    const status: any = await gw.handle("bridge_status", {});
    expect(status.agent_kinds).toEqual(["otter", "fox"]);
    await expect(gw.handle("spawn_agent", { kind: "gemini", name: "x", repo: "app" })).rejects.toThrow("kind must be one of otter, fox");
    const file = { path: "/srv/allowed/app/CLAUDE.md", text: "Claude reads this" };
    expect(gw.mask.result("read_file", file)).toEqual(file);
  });

  test("without aliases nothing is masked", async () => {
    const { gw } = gateway();
    const res = { agent: { pane_id: "w1:p1", agent: "claude" }, text: "Claude Code" };
    expect(gw.mask.result("read_agent", res)).toEqual(res);
  });
});

describe("prunable_agents", () => {
  const byPane = (list: any[]) => Object.fromEntries(list.map((x) => [x.pane_id, x]));

  test("done agents get what to close; working, menus and unreported turns are not done", async () => {
    const { gw, panes, state } = gateway();
    screen = "All tests pass. Committed as abc123.\n";
    const made: any = await gw.handle("create_workspace", { repo: "app" });
    const mine = made.pane.pane_id;
    Object.assign(panes[mine], { agent: "claude", name: "worker", agent_status: "idle" });
    const res: any = await gw.handle("prunable_agents", {});
    const done = byPane(res.done);
    expect(done[mine]).toMatchObject({ name: "worker", close: { kind: "workspace", id: made.workspace.workspace_id } });
    // Not made by the bridge: done, but nothing it may close.
    expect(done["w1:p1"].close).toBeNull();
    expect(byPane(res.not_done)["w4:p1"].reason).toBe("working");

    // A turn the notifier has not reported yet, and one that ended a minute ago.
    const at = new Date().toISOString();
    writeFileSync(join(state, "watch.json"), JSON.stringify({
      [mine]: { name: "worker", cwd: null, since: at, managed: true, busy: true },
      "w1:p1": { name: null, cwd: null, since: at, managed: true, busy: false, last_event: { type: "finished", at, excerpt: null } },
    }));
    const later: any = await gw.handle("prunable_agents", {});
    expect(byPane(later.not_done)[mine].reason).toMatch(/not been reported/);
    expect(byPane(later.not_done)["w1:p1"].reason).toMatch(/under min_idle_minutes/);
    expect(byPane((await gw.handle("prunable_agents", { min_idle_minutes: 0 }) as any).done)["w1:p1"]).toBeDefined();
  });

  test("an agent at a menu or asking a question is not done", async () => {
    const { gw, panes } = gateway();
    panes["w1:p1"].agent_status = "blocked";
    expect(byPane(((await gw.handle("prunable_agents", {})) as any).not_done)["w1:p1"].reason).toBe("waiting on a menu");
    panes["w1:p1"].agent_status = "idle";
    screen = "I found two ways to fix it. Should I rewrite the parser or patch the tokenizer?\n";
    expect(byPane(((await gw.handle("prunable_agents", {})) as any).not_done)["w1:p1"].reason).toBe("asked the owner a question");
  });

  test("exited lists bridge panes whose shell runs nothing", async () => {
    const w = world();
    screen = "done\n";
    const idle = Bun.spawn(["sleep", "30"]);
    const busy = Bun.spawn(["/bin/sh", "-c", "sleep 30; true"]);
    const shells: Record<string, number> = {};
    const herdr: HerdrCall = async (method, params: any) =>
      method === "pane.process_info" ? { process_info: { shell_pid: shells[params.pane_id] } } : w.herdr(method, params);
    const state = mkdtempSync(join(tmpdir(), "herdr-prune-"));
    const gw = new Gateway(loadConfig({ allowedRoots: ["/srv/allowed"], stateDir: state, transcriptRoots: [state], agentKinds: ["claude"] }), herdr);
    try {
      const a: any = await gw.handle("create_workspace", { cwd: "/srv/allowed/app" });
      const b: any = await gw.handle("create_workspace", { cwd: "/srv/allowed/app" });
      shells[a.pane.pane_id] = idle.pid;
      shells[b.pane.pane_id] = busy.pid;
      await Bun.sleep(100);
      const res: any = await gw.handle("prunable_agents", {});
      expect(res.exited).toEqual([{ pane_id: a.pane.pane_id, cwd: "/srv/allowed/app", label: null, close: { kind: "workspace", id: a.workspace.workspace_id } }]);
    } finally {
      idle.kill();
      busy.kill();
    }
  });
});

describe("session.snapshot", () => {
  test("prunable_agents reads agents and panes in one snapshot, and the lists on an older Herdr", async () => {
    const { gw, sent } = gateway();
    screen = "All tests pass.\n";
    const res: any = await gw.handle("prunable_agents", {});
    expect(sent.map(([m]) => m).filter((m) => m.endsWith(".list") || m === "session.snapshot")).toEqual(["session.snapshot"]);
    const old = gateway();
    old.noSnapshot();
    screen = "All tests pass.\n";
    const same: any = await old.gw.handle("prunable_agents", {});
    expect(old.sent.map(([m]) => m).filter((m) => m.endsWith(".list") || m === "session.snapshot")).toEqual(["session.snapshot", "agent.list", "pane.list"]);
    // Out-of-scope agents and panes stay out either way.
    const ids = (r: any) => [...r.done, ...r.not_done].map((x: any) => x.pane_id).sort();
    expect(ids(same)).toEqual(ids(res));
    expect(ids(res)).toEqual(["w1:p1", "w4:p1"]);
  });
});

describe("sidebar tokens", () => {
  const tokens = (reports: any[], pane: string) => reports.filter((r) => r.pane_id === pane).map((r) => ({ ...r.tokens, ...(r.ttl_ms ? { ttl_ms: r.ttl_ms } : {}) }));

  test("watched on watch_agent, spawn_agent and start_agent, cleared on stop", async () => {
    const { gw, reports } = gateway();
    await gw.handle("watch_agent", { target: "w4:p1" });
    expect(tokens(reports, "w4:p1")).toEqual([{ workdone: "watched" }]);
    await gw.handle("watch_agent", { target: "w4:p1", stop: true });
    expect(tokens(reports, "w4:p1").at(-1)).toEqual({ workdone: null, workdone_note: null });
    const spawned: any = await gw.handle("spawn_agent", { kind: "claude", name: "worker", repo: "app" });
    expect(tokens(reports, spawned.pane.pane_id)).toContainEqual({ workdone: "watched" });
    await gw.handle("start_agent", { pane_id: "w1:p2", kind: "claude", name: "x", watch: false });
    expect(tokens(reports, "w1:p2")).toEqual([{ workdone: null, workdone_note: null }]);
    expect(reports.every((r) => r.source === "workdone" && typeof r.seq === "number")).toBe(true);
    // Later reports carry a larger seq, so Herdr keeps the newest when two cross.
    expect(reports.map((r) => r.seq)).toEqual([...reports.map((r) => r.seq)].sort((a, b) => a - b));
  });

  test("an approval shows for a minute; done shows for ten; a prompt clears the note", async () => {
    const { gw, reports, panes } = gateway();
    screen = fixture("cursor-perm");
    onKeys = () => void (screen = fixture("cursor-steer-2"));
    await gw.handle("watch_agent", { target: "w4:p1" });
    expect(tokens(reports, "w4:p1").at(-1)).toEqual({ workdone_note: "approved permission: Run (once)", ttl_ms: 60_000 });
    panes["w4:p1"].agent_status = "working";
    screen = "All tests pass.\n";
    await gw.handle("prunable_agents", { min_idle_minutes: 0 });
    expect(tokens(reports, "w1:p1")).toEqual([{ workdone_note: "done", ttl_ms: 600_000 }]);
    // Working is not done: its note stays as it was.
    expect(tokens(reports, "w4:p1").at(-1)).toMatchObject({ workdone_note: "approved permission: Run (once)" });
    await gw.handle("prompt_agent", { target: "w1:p1", text: "more" });
    expect(tokens(reports, "w1:p1").at(-1)).toEqual({ workdone_note: null });
  });

  test("a failing or hanging report fails and slows nothing", async () => {
    const { gw, herdr } = gateway();
    for (const broken of [
      (async () => { throw new GatewayError("herdr_unavailable", "gone"); }) as HerdrCall,
      (() => { throw new Error("sync"); }) as unknown as HerdrCall,
      (() => new Promise(() => {})) as HerdrCall,
    ]) {
      const call: HerdrCall = (method, params, t) => (method === "pane.report_metadata" ? broken(method, params, t) : herdr(method, params, t));
      const g = new Gateway(gw.cfg, call);
      expect(await g.handle("watch_agent", { target: "w4:p1" })).toMatchObject({ watching: true });
      expect(await g.handle("watch_agent", { target: "w4:p1", stop: true })).toMatchObject({ watching: false });
      expect(await g.handle("prunable_agents", { min_idle_minutes: 0 })).toHaveProperty("done");
    }
  });
});
