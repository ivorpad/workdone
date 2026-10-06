import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type HerdrCall } from "../gateway/config.ts";
import { Gateway } from "../gateway/gateway.ts";
import { paneTiming, screenCapture } from "../gateway/pane-exec.ts";

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
  const cfg = loadConfig({ allowedRoots: [root], stateDir: mkdtempSync(join(tmpdir(), "herdr-pexec-state-")), allowExec: true, allowFileRead: true, execInPane: true });
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

test("a screenshot is taken in a pane, kept under the first root and returned as an image", async () => {
  const { gw, calls, root } = setup();
  const saved = { ...screenCapture };
  // A stand-in for screencapture: writes a small JPEG-named file where it was asked to.
  screenCapture.platform = "darwin";
  screenCapture.command = (file) => `printf 'jpegbytes' > '${file}'`;
  try {
    const res: any = await gw.handle("screenshot", {});
    expect(res.kind).toBe("image");
    expect(res.path).toMatch(new RegExp(`^${root}/workdone-screenshots/screen-.*\\.jpg$`));
    expect(res.image).toEqual({ mime: "image/jpeg", data: Buffer.from("jpegbytes").toString("base64") });
    expect(calls.some(([m, p]) => m === "pane.send_input" && String(p.text).includes("cmd.zsh"))).toBe(true);
  } finally {
    Object.assign(screenCapture, saved);
  }
});

test("a failed capture says so, with the permission hint", async () => {
  const { gw } = setup();
  const saved = { ...screenCapture };
  screenCapture.platform = "darwin";
  screenCapture.command = () => "echo 'could not create image from display' >&2; exit 1";
  try {
    await expect(gw.handle("screenshot", {})).rejects.toMatchObject({ code: "screenshot_failed", message: expect.stringContaining("Screen Recording") });
  } finally {
    Object.assign(screenCapture, saved);
  }
});

test("only the last 20 screenshots are kept", async () => {
  const { gw, root } = setup();
  const saved = { ...screenCapture };
  screenCapture.platform = "darwin";
  screenCapture.command = (file) => `printf 'x' > '${file}'`;
  const dir = join(root, "workdone-screenshots");
  mkdirSync(dir);
  for (let i = 0; i < 25; i++) writeFileSync(join(dir, `screen-2000-01-01T00-00-${String(i).padStart(2, "0")}.jpg`), "old");
  try {
    await gw.handle("screenshot", {});
    const left = readdirSync(dir).sort();
    expect(left).toHaveLength(20);
    expect(left.at(-1)).toMatch(/^screen-20[2-9]/);
    expect(left[0]).toBe("screen-2000-01-01T00-00-06.jpg");
  } finally {
    Object.assign(screenCapture, saved);
  }
});

test("off macOS, or without execInPane, screenshot is refused", async () => {
  const { gw } = setup();
  const saved = { ...screenCapture };
  screenCapture.platform = "linux";
  try {
    await expect(gw.handle("screenshot", {})).rejects.toMatchObject({ code: "capability_disabled" });
  } finally {
    Object.assign(screenCapture, saved);
  }
  const root = realpathSync(mkdtempSync(join(tmpdir(), "herdr-noshot-")));
  const plain = new Gateway(loadConfig({ allowedRoots: [root], stateDir: mkdtempSync(join(tmpdir(), "herdr-noshot-state-")), allowExec: true }), async () => ({}));
  await expect(plain.handle("screenshot", {})).rejects.toMatchObject({ code: "capability_disabled", message: expect.stringContaining("execInPane") });
});

test("with file reads off, nothing is captured", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "herdr-noread-")));
  const calls: string[] = [];
  const gw = new Gateway(loadConfig({ allowedRoots: [root], stateDir: mkdtempSync(join(tmpdir(), "herdr-noread-state-")), allowExec: true, execInPane: true }), async (m) => { calls.push(m); return {}; });
  const saved = { ...screenCapture };
  screenCapture.platform = "darwin";
  try {
    await expect(gw.handle("screenshot", {})).rejects.toMatchObject({ code: "capability_disabled" });
    expect(calls).toEqual([]);
  } finally {
    Object.assign(screenCapture, saved);
  }
});
