// Herdr's turn and state counters pass through every agent view: a client that polls
// compares them to know something happened without diffing screens.
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type HerdrCall } from "../gateway/config.ts";
import { Gateway } from "../gateway/gateway.ts";
import { agentView } from "../gateway/views.ts";

const base = { pane_id: "w1:p1", name: "worker", agent: "claude", agent_status: "idle", cwd: "/srv/allowed/app", workspace_id: "w1", tab_id: "w1:t1" };

describe("agentView sequence counters", () => {
  test("numbers pass through, including zero", () => {
    expect(agentView({ ...base, completion_seq: 7, state_change_seq: 0 })).toMatchObject({ completion_seq: 7, state_change_seq: 0 });
  });
  test("null when Herdr omits them or sends something that is not a number", () => {
    expect(agentView(base)).toMatchObject({ completion_seq: null, state_change_seq: null });
    expect(agentView({ ...base, completion_seq: "7", state_change_seq: undefined })).toMatchObject({ completion_seq: null, state_change_seq: null });
  });
  test("overview, get_agent and console_snapshot show them", async () => {
    const state = mkdtempSync(join(tmpdir(), "herdr-seq-"));
    const agent = { ...base, foreground_cwd: base.cwd, completion_seq: 3, state_change_seq: 9 };
    const herdr: HerdrCall = async (method) => {
      if (method === "agent.list") return { agents: [agent] };
      if (method === "agent.get") return { agent };
      if (method === "session.snapshot") return { snapshot: { agents: [agent], panes: [] } };
      return { read: { text: "" } };
    };
    const gw = new Gateway(loadConfig({ allowedRoots: ["/srv/allowed"], stateDir: state, transcriptRoots: [state], cursorTranscriptRoots: [state], codexSessionRoots: [state], opencodeDb: null, piSessionRoots: [state] }), herdr);
    const want = { completion_seq: 3, state_change_seq: 9 };
    expect(((await gw.handle("overview", {})) as any).agents[0]).toMatchObject(want);
    expect(await gw.handle("get_agent", { target: "w1:p1" })).toMatchObject(want);
    expect(((await gw.handle("console_snapshot", {})) as any).agents[0]).toMatchObject(want);
  });
});
