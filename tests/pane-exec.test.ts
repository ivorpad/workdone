import { expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type HerdrCall } from "../gateway/config.ts";
import { Gateway } from "../gateway/gateway.ts";
import { paneTiming } from "../gateway/pane-exec.ts";

paneTiming.poll = 10;
paneTiming.interrupt = 10;

// A fake Herdr whose panes run what is typed into them with a real zsh, as a pane would.
function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "herdr-pexec-root-")));
  const calls: Array<[string, any]> = [];
  let n = 0;
  const running: Array<ReturnType<typeof Bun.spawn>> = [];
  const herdr: HerdrCall = async (method, params: any) => {
    calls.push([method, params]);
    switch (method) {
      case "workspace.list":
        return { workspaces: [] };
      case "workspace.create":
        return { workspace: { workspace_id: "wX" } };
      case "tab.create":
        n++;
        return { tab: { tab_id: `wX:t${n}` }, root_pane: { pane_id: `wX:p${n}`, cwd: params.cwd } };
      case "pane.send_input":
        if (params.text) running.push(Bun.spawn(["zsh", "-fc", params.text], { cwd: calls.find(([m]) => m === "tab.create")![1].cwd, stdout: "ignore", stderr: "ignore" }));
        if (params.keys?.includes("ctrl+c")) running.forEach((p) => p.kill());
        return {};
      default:
        return {};
    }
  };
  const cfg = loadConfig({ allowedRoots: [root], stateDir: mkdtempSync(join(tmpdir(), "herdr-pexec-state-")), allowExec: true, execInPane: true });
  return { gw: new Gateway(cfg, herdr), calls, root };
}

test("a command runs in a pane tab and comes back with its output and exit code", async () => {
  const { gw, calls, root } = setup();
  const res: any = await gw.handle("exec", { command: "echo out; echo err >&2; exit 3" });
  expect(res).toMatchObject({ via: "pane", cwd: root, exit_code: 3, timed_out: false, stdout: "out\n", stderr: "err\n" });
  const methods = calls.map(([m]) => m);
  expect(methods).toEqual(["workspace.create", "tab.create", "pane.send_input", "tab.close"]);
  expect(calls[1]![1]).toMatchObject({ workspace_id: "wX", cwd: root, focus: false });
  // Out of history, in a subshell, output to files.
  expect(calls[2]![1].text).toMatch(/^ \( source '.+\/cmd\.zsh' \) </);
});

test("stdin, quotes and several lines reach the command unchanged", async () => {
  const { gw } = setup();
  const res: any = await gw.handle("exec", { command: "x='it'\\''s'\nprintf '%s\\n' \"$x\"\ncat", stdin: "piped\n" });
  expect(res).toMatchObject({ exit_code: 0, stdout: "it's\npiped\n" });
});

test("a command past its timeout is interrupted and the tab still closes", async () => {
  const { gw, calls } = setup();
  const res: any = await gw.handle("exec", { command: "sleep 20", timeout_ms: 1000 });
  expect(res).toMatchObject({ timed_out: true, exit_code: null });
  expect(calls.map(([m]) => m)).toContain("tab.close");
  expect(calls.some(([m, p]) => m === "pane.send_input" && p.keys?.includes("ctrl+c"))).toBe(true);
});

test("the exec workspace is reused while Herdr still has it", async () => {
  const { gw, calls } = setup();
  await gw.handle("exec", { command: "true" });
  (gw as any).herdr = async (method: string, params: any) => {
    calls.push([method, params]);
    if (method === "workspace.list") return { workspaces: [{ workspace_id: "wX" }] };
    if (method === "tab.create") return { tab: { tab_id: "wX:t9" }, root_pane: { pane_id: "wX:p9" } };
    if (method === "pane.send_input" && params.text) Bun.spawn(["zsh", "-fc", params.text], { stdout: "ignore" });
    return {};
  };
  await gw.handle("exec", { command: "true" });
  expect(calls.filter(([m]) => m === "workspace.create")).toHaveLength(1);
});
