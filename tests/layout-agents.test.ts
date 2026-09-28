import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type HerdrCall } from "../gateway/config.ts";
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
const CURSOR = "5bada10f-7201-4b25-8616-ec95d6a71501";

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
  let n = 0;
  const herdr: HerdrCall = async (method, params: any) => {
    sent.push([method, params]);
    switch (method) {
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
      case "agent.read":
        if (screen instanceof Error) throw screen;
        return { text: screen };
      default:
        return {};
    }
  };
  return { panes, sent, herdr };
}

function gateway(extra: Record<string, unknown> = {}) {
  screen = DIALOG_SCREEN;
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
    expect(sent.map(([m]) => m)).toEqual(["workspace.create", "agent.start", "agent.wait", "agent.get", "agent.prompt"]);
    expect(sent[0]![1]).toMatchObject({ cwd: "/srv/allowed/app", label: "worker", focus: false });
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
  test("a dialog Herdr misses stops a prompt before it is typed into the dialog", async () => {
    const { gw, panes, sent, state } = gateway();
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
  test("the trust check is for Cursor agents, and a screen it cannot read stops the prompt", async () => {
    const { gw, panes, sent } = gateway();
    screen = TRUST_SCREEN;
    // Claude and Codex dialogs are Herdr's to flag; their screens can quote the phrase.
    await gw.handle("prompt_agent", { target: "w1:p1", text: "go" });
    expect(sent.at(-1)![0]).toBe("agent.prompt");
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
