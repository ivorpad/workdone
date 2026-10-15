// The agent's input box read with its escapes: a suggestion Claude Code drew dim is
// ghost text, not a draft the owner typed. The byte shapes are from the 2026-10-15
// lab (herdr-tui-control.md section 3): ESC[0m ESC[2m try curl … ESC[0m.
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type HerdrCall } from "../gateway/config.ts";
import { inputLine } from "../gateway/dialog.ts";
import { Gateway } from "../gateway/gateway.ts";

const ESC = "\x1b";
const rule = "─".repeat(40);
const footer = `${ESC}[2m  ? for shortcuts${ESC}[0m`;
const screen = (box: string) => ["⏺ Done.", "", rule, box, rule, footer, ""].join("\n");

describe("inputLine", () => {
  test("a dim suggestion is ghost text", () => {
    expect(inputLine(screen(`${ESC}[0m❯ ${ESC}[2mtry curl -sI https://google.com | head -1${ESC}[0m`))).toEqual({ text: "try curl -sI https://google.com | head -1", ghost: true });
    expect(inputLine(screen(`❯ ${ESC}[2mcommit it${ESC}[0m`))).toEqual({ text: "commit it", ghost: true });
    // Claude's placeholder on a fresh pane, remote box in G16.
    expect(inputLine(screen(`❯ ${ESC}[2mTry "how do I log an error?"${ESC}[0m`))).toMatchObject({ ghost: true });
  });
  test("typed text is not ghost, nor is a typed line with a dim tail", () => {
    expect(inputLine(screen("❯ close #842 with pnpm issues:finish 842"))).toEqual({ text: "close #842 with pnpm issues:finish 842", ghost: false });
    expect(inputLine(screen(`❯ ${ESC}[1m1a, 2b and 3a${ESC}[22m — go ahead`))).toEqual({ text: "1a, 2b and 3a — go ahead", ghost: false });
    expect(inputLine(screen(`❯ fix it ${ESC}[2m(suggested)${ESC}[0m`))).toMatchObject({ text: "fix it (suggested)", ghost: false });
  });
  test("an empty box, combined and colon-separated SGR runs, dim cleared by 22", () => {
    expect(inputLine(screen("❯ "))).toEqual({ text: "", ghost: false });
    expect(inputLine(screen(`❯ ${ESC}[2;3mall dim and italic${ESC}[0m`))).toMatchObject({ ghost: true });
    expect(inputLine(screen(`❯ ${ESC}[2:3mcolon form${ESC}[0m`))).toMatchObject({ ghost: true });
    expect(inputLine(screen(`❯ ${ESC}[2mwas dim${ESC}[22m now typed`))).toMatchObject({ text: "was dim now typed", ghost: false });
    // A 24-bit colour's parameters are not attributes: 38;2;…;2;… does not dim.
    expect(inputLine(screen(`❯ ${ESC}[38;2;200;2;2mred text${ESC}[0m`))).toMatchObject({ ghost: false });
  });
  test("boxes, other CLIs' markers and cursor escapes", () => {
    expect(inputLine(screen(`│ › ${ESC}[2mAsk Codex to do anything${ESC}[0m │`))).toEqual({ text: "Ask Codex to do anything", ghost: true });
    expect(inputLine(screen(`→ ${ESC}[?25h${ESC}[2mPlan, search, build anything${ESC}[0m${ESC}]0;title${ESC}\\`))).toEqual({ text: "Plan, search, build anything", ghost: true });
  });
  test("a menu's cursor line is not an input box, and a screen without one gives null", () => {
    expect(inputLine(["Do you want to proceed?", "❯ 1. Yes", "  2. No", ""].join("\n"))).toBeNull();
    expect(inputLine(["Run this command?", "→ Run (once) (y)", "  Skip (s)", ""].join("\n"))).toBeNull();
    expect(inputLine("$ ls\nfile.txt\n")).toBeNull();
    // Only the bottom of the screen counts: an old prompt echo high up is scrollback.
    expect(inputLine(["❯ old prompt", ...Array(14).fill("output"), ""].join("\n"))).toBeNull();
  });
});

describe("read_agent and get_agent carry input_line from a raw read", () => {
  const raw = screen(`❯ ${ESC}[2mcommit it${ESC}[0m`);
  const plain = raw.replace(/\x1b\[[\d;]*m/g, "");
  function setup() {
    const state = mkdtempSync(join(tmpdir(), "herdr-il-"));
    const agent = { pane_id: "w1:p1", name: "worker", agent: "claude", agent_status: "idle", cwd: "/srv/allowed/app", foreground_cwd: "/srv/allowed/app" };
    const reads: any[] = [];
    const herdr: HerdrCall = async (method, params: any) => {
      if (method === "agent.list") return { agents: [agent] };
      if (method === "agent.get") return { agent };
      if (method === "agent.read") {
        reads.push(params);
        return { text: params.format === "ansi" ? raw : plain };
      }
      return {};
    };
    const cfg = loadConfig({ allowedRoots: ["/srv/allowed"], stateDir: state, transcriptRoots: [state], cursorTranscriptRoots: [state], codexSessionRoots: [state], opencodeDb: null, piSessionRoots: [state] });
    return { gw: new Gateway(cfg, herdr), reads };
  }
  test("read_agent strip_ansi: false asks Herdr for ansi and classifies the box", async () => {
    const { gw, reads } = setup();
    const res: any = await gw.handle("read_agent", { target: "w1:p1", source: "visible", strip_ansi: false });
    expect(res.text).toBe(raw);
    expect(res.input_line).toEqual({ text: "commit it", ghost: true });
    expect(reads.find((p) => p.source === "visible" && p.lines === 120)).toMatchObject({ format: "ansi", strip_ansi: false });
    // Attention still works on the stripped text.
    expect(res.agent.attention).toBeNull();
  });
  test("a text read has no input_line, and detection is plain whatever the format", async () => {
    const { gw } = setup();
    const res: any = await gw.handle("read_agent", { target: "w1:p1", source: "visible" });
    expect(res.text).toBe(plain);
    expect("input_line" in res).toBe(false);
    const det: any = await gw.handle("read_agent", { target: "w1:p1", source: "detection", strip_ansi: false });
    expect(det.input_line).toBeNull();
  });
  test("get_agent reads the box only when asked", async () => {
    const { gw, reads } = setup();
    const quiet: any = await gw.handle("get_agent", { target: "w1:p1" });
    expect("input_line" in quiet).toBe(false);
    expect(reads.some((p) => p.format === "ansi")).toBe(false);
    const asked: any = await gw.handle("get_agent", { target: "w1:p1", input_line: true });
    expect(asked.input_line).toEqual({ text: "commit it", ghost: true });
    expect(reads.filter((p) => p.format === "ansi")).toHaveLength(1);
  });
});
