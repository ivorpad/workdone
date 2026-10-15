import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type HerdrCall } from "../gateway/config.ts";
import { Gateway } from "../gateway/gateway.ts";

const state = mkdtempSync(join(tmpdir(), "herdr-read-"));
const cfg = loadConfig({
  allowedRoots: ["/srv/allowed"], stateDir: state,
  transcriptRoots: [state], cursorTranscriptRoots: [state], codexSessionRoots: [state], opencodeDb: null, piSessionRoots: [state],
});
const agents: Record<string, any> = {
  "w1:p1": { pane_id: "w1:p1", agent: "claude", agent_status: "done", cwd: "/srv/allowed/app", completion_seq: 7, state_change_seq: 9 },
  "w1:p2": { pane_id: "w1:p2", agent: "opencode", agent_status: "idle", cwd: "/srv/allowed/app", completion_seq: null, state_change_seq: 3 },
};

// Claude Code draws its suggested next prompt dim on the input line.
const GHOST = "❯ \x1b[0m\x1b[2mcommit it\x1b[0m\n";

function gateway() {
  const reads: any[] = [];
  const herdr: HerdrCall = async (method, params: any) => {
    if (method === "agent.get") return { agent: agents[params.target] };
    if (method === "agent.list") return { agents: Object.values(agents) };
    if (method === "agent.read") {
      reads.push(params);
      // As on a live server: format decides, strip_ansi changes nothing.
      return { text: params.format === "ansi" && params.source !== "detection" ? GHOST : "❯ commit it\n" };
    }
    return {};
  };
  return { gw: new Gateway(cfg, herdr), reads };
}

describe("read_agent", () => {
  test("strip_ansi false reads with format ansi and returns the escapes", async () => {
    const { gw, reads } = gateway();
    const res: any = await gw.handle("read_agent", { target: "w1:p1", source: "visible", strip_ansi: false });
    expect(res.text).toBe(GHOST);
    expect(reads[0]).toMatchObject({ source: "visible", format: "ansi" });
    // Attention is worked out from the stripped screen.
    expect(res.agent.attention).not.toBe("dialog");
  });
  test("by default the text comes back plain", async () => {
    const { gw, reads } = gateway();
    const res: any = await gw.handle("read_agent", { target: "w1:p1", source: "visible" });
    expect(res.text).toBe("❯ commit it\n");
    expect(reads[0]).toMatchObject({ format: "text", strip_ansi: true });
  });
  test("the agent carries Herdr's turn counters, null when Herdr has none", async () => {
    const { gw } = gateway();
    expect(((await gw.handle("read_agent", { target: "w1:p1" })) as any).agent).toMatchObject({ completion_seq: 7, state_change_seq: 9 });
    expect(((await gw.handle("read_agent", { target: "w1:p2" })) as any).agent).toMatchObject({ completion_seq: null, state_change_seq: 3 });
  });
});
