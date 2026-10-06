// exec inside a Herdr pane. The gateway runs as its own ssh login, outside the owner's
// desktop session, so it has no keychain (gh's token lives there), no ssh-agent and only
// a login shell. A Herdr pane is the owner's own interactive zsh in that session: the
// same place they would ssh in and type the command.
//
// Each call opens a tab in one "workdone exec" workspace, sources the command from a file
// with its output sent to files, waits for the exit code, reads the output and closes the
// tab. The workspace stays so the owner can watch.

import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { GatewayError } from "./config.ts";
import type { Gateway } from "./gateway.ts";
import { execParams } from "./host-ops.ts";
import type { Op } from "./params.ts";
import { clipOutput } from "./process.ts";

const LABEL = "workdone exec";
// How often to look for the exit code, and how long ctrl+c gets before the tab is closed.
export const paneTiming = { poll: 150, interrupt: 500 };

// The main display as a JPEG at most 1600 px wide, which stays well under read_file's 3 MB.
// Overridable so tests don't photograph the screen of the machine running them.
export const screenCapture = {
  platform: process.platform as string,
  command: (file: string) => `screencapture -x -m -t jpg ${q(file)} && sips -Z 1600 -s formatOptions 70 ${q(file)} >/dev/null`,
};
const SHOTS_DIR = "workdone-screenshots";
const KEEP_SHOTS = 20;

// Single quotes for zsh, safe for any path.
const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export function paneExecOps(g: Gateway): Record<string, Op> {
  // The workspace the exec tabs go in: the saved one while Herdr still has it, else a new one.
  async function workspace(): Promise<string> {
    const saved = g.state.execWorkspace();
    if (saved) {
      const list = await g.herdr("workspace.list", {}).catch(() => null);
      if ((list?.workspaces ?? []).some((w: any) => w.workspace_id === saved)) return saved;
    }
    const res = await g.herdr("workspace.create", { cwd: g.cfg.allowedRoots[0], label: LABEL, focus: false });
    const id = res?.workspace?.workspace_id;
    if (!id) throw new GatewayError("exec_failed", "Herdr did not create the exec workspace");
    g.state.setExecWorkspace(id);
    return id;
  }

  const ops: Record<string, Op> = {
    async exec(params) {
      const { command, stdin, cwd, timeoutMs } = execParams(g.cfg, params, (key) => g.repo(key).path);
      const started = Date.now();
      const dir = resolve(g.cfg.stateDir, "exec", `${started}-${Math.random().toString(36).slice(2, 8)}`);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const f = (n: string) => resolve(dir, n);
      writeFileSync(f("cmd.zsh"), command + "\n", { mode: 0o600 });
      writeFileSync(f("in"), stdin ?? "", { mode: 0o600 });

      let tabId: string | undefined;
      try {
        const tab = await g.herdr("tab.create", { workspace_id: await workspace(), cwd, label: "exec", focus: false });
        tabId = tab?.tab?.tab_id;
        const paneId = tab?.root_pane?.pane_id ?? tab?.pane?.pane_id;
        if (!tabId || !paneId) throw new GatewayError("exec_failed", "Herdr did not return a pane for the command");
        // A leading space keeps it out of zsh history. The subshell is a copy of this
        // interactive shell, so .zshrc's aliases and functions apply, and an `exit` in the
        // command ends only the subshell. The redirections keep the pane's own output
        // (prompt, greetings) out of the result.
        const line = ` ( source ${q(f("cmd.zsh"))} ) <${q(f("in"))} >${q(f("out"))} 2>${q(f("err"))}; print -r -- $? >${q(f("code"))}`;
        await g.herdr("pane.send_input", { pane_id: paneId, text: line, keys: ["enter"] });

        let timedOut = false;
        while (!existsSync(f("code"))) {
          if (Date.now() - started > timeoutMs) {
            timedOut = true;
            await g.herdr("pane.send_input", { pane_id: paneId, keys: ["ctrl+c"] }).catch(() => {});
            await Bun.sleep(paneTiming.interrupt);
            break;
          }
          await Bun.sleep(paneTiming.poll);
        }
        const read = (n: string) => (existsSync(f(n)) ? readFileSync(f(n)) : Buffer.alloc(0));
        const out = clipOutput(read("out"), g.cfg.maxOutputBytes);
        const err = clipOutput(read("err"), g.cfg.maxOutputBytes);
        const code = read("code").toString().trim();
        return {
          cwd,
          via: "pane",
          exit_code: timedOut || code === "" ? null : Number(code),
          signal: null,
          timed_out: timedOut,
          duration_ms: Date.now() - started,
          stdout: out.text,
          stderr: err.text,
          stdout_truncated: out.truncated,
          stderr_truncated: err.truncated,
        };
      } finally {
        if (tabId) await g.herdr("tab.close", { tab_id: tabId }).catch(() => {});
        rmSync(dir, { recursive: true, force: true });
      }
    },

    // A pane, not the gateway's own process: the pane's shell descends from the owner's
    // terminal, which holds macOS Screen Recording permission; an ssh login has none. The
    // file lands in the first allowed root, so show_image and read_file can open it again.
    async screenshot() {
      if (screenCapture.platform !== "darwin") throw new GatewayError("capability_disabled", "screenshots need macOS");
      // Before capturing: the image comes back through read_file.
      if (!g.cfg.allowFileRead) throw new GatewayError("capability_disabled", "file reads are disabled in the gateway config");
      const dir = resolve(g.cfg.allowedRoots[0]!, SHOTS_DIR);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const file = resolve(dir, `screen-${new Date().toISOString().replace(/[:.]/g, "-")}.jpg`);
      const res: any = await ops.exec!({ command: screenCapture.command(file), timeout_ms: 30_000 });
      if (res.exit_code !== 0 || !existsSync(file)) {
        throw new GatewayError("screenshot_failed", `${String(res.stderr ?? "").trim().slice(-300) || "screencapture made no file"}. The terminal running Herdr needs Screen Recording permission (System Settings > Privacy & Security).`);
      }
      const shots = readdirSync(dir).filter((n) => /^screen-.*\.jpg$/.test(n)).sort();
      for (const old of shots.slice(0, Math.max(0, shots.length - KEEP_SHOTS))) rmSync(resolve(dir, old), { force: true });
      return await g.handle("read_file", { path: file, as: "image" });
    },
  };
  return ops;
}
