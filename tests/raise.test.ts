import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../gateway/config.ts";
import { Gateway } from "../gateway/gateway.ts";
import { findTerminalApp } from "../gateway/raise.ts";

const ps = (lines: string[]) => lines.join("\n");

describe("finding the terminal app that hosts Herdr", () => {
  test("the app above the Herdr client, not the server or a plugin", () => {
    const out = ps([
      "    1     0 /sbin/launchd",
      " 8750     1 /Applications/Ghostty.app/Contents/MacOS/ghostty",
      " 8754  8750 login -flp ivor /bin/zsh",
      " 8755  8754 -/bin/zsh",
      " 8836  8755 herdr",
      " 8837  8836 /opt/homebrew/bin/herdr server",
      " 9702     1 /Users/ivor/.config/herdr/plugins/github/mirror/herdr-mirror daemon",
    ]);
    expect(findTerminalApp(out)).toBe("/Applications/Ghostty.app");
  });
  test("a session flag still counts as a client", () => {
    const out = ps([" 10     1 /Applications/iTerm.app/Contents/MacOS/iTerm2", " 11    10 zsh", " 12    11 herdr --session repo-fixes"]);
    expect(findTerminalApp(out)).toBe("/Applications/iTerm.app");
  });
  test("a client over mosh or ssh has no app above it, and a bare server is not a client", () => {
    const out = ps(["    1     0 /sbin/launchd", " 54789     1 /opt/homebrew/bin/mosh-server new", " 54790 54789 herdr --session default", " 52066     1 herdr --session repo-fixes server"]);
    expect(findTerminalApp(out)).toBeNull();
  });
  test("terminalApp in the config is validated", () => {
    expect(loadConfig({ allowedRoots: ["/srv/a"], terminalApp: "Ghostty" }).terminalApp).toBe("Ghostty");
    expect(loadConfig({ allowedRoots: ["/srv/a"], terminalApp: "/Applications/Ghostty.app" }).terminalApp).toBe("/Applications/Ghostty.app");
    expect(loadConfig({ allowedRoots: ["/srv/a"] }).terminalApp).toBeNull();
    expect(() => loadConfig({ allowedRoots: ["/srv/a"], terminalApp: "x; rm -rf /" })).toThrow(/terminalApp/);
  });
});

describe("focus raises the terminal", () => {
  function setup() {
    const root = mkdtempSync(join(tmpdir(), "raise-"));
    const agents = [{ pane_id: "w1:p1", agent: "claude", agent_status: "idle", cwd: root, foreground_cwd: root }];
    const sent: Array<[string, any]> = [];
    const herdr = async (method: string, params: any) => { sent.push([method, params]); return method === "agent.get" ? { agent: agents[0] } : method === "agent.list" ? { agents } : {}; };
    const gw = new Gateway(loadConfig({ allowedRoots: [root], stateDir: join(root, "s"), terminalApp: "Ghostty" }), herdr);
    const raised: unknown[] = [];
    gw.raiser = async (cfg) => { raised.push(cfg.terminalApp); return { raised: true, app: String(cfg.terminalApp) }; };
    return { gw, sent, raised };
  }
  test("focus switches the pane in Herdr and raises the app, reporting both", async () => {
    const { gw, sent, raised } = setup();
    const res: any = await gw.handle("focus", { kind: "agent", id: "w1:p1" });
    expect(sent.some(([m]) => m === "agent.focus")).toBe(true);
    expect(raised).toEqual(["Ghostty"]);
    expect(res).toEqual({ focused: "agent", id: "w1:p1", terminal: { raised: true, app: "Ghostty" } });
  });
  test("raise: false only switches the pane", async () => {
    const { gw, raised } = setup();
    const res: any = await gw.handle("focus", { kind: "agent", id: "w1:p1", raise: false });
    expect(raised).toEqual([]);
    expect(res.terminal).toBeUndefined();
  });
  test("a raise that throws still leaves the pane focused and says why", async () => {
    const { gw, sent } = setup();
    gw.raiser = async () => { throw new Error("no display"); };
    const res: any = await gw.handle("focus", { kind: "agent", id: "w1:p1" });
    expect(sent.some(([m]) => m === "agent.focus")).toBe(true);
    expect(res.terminal).toEqual({ raised: false, reason: "no display" });
  });
});
