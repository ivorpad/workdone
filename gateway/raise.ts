// Herdr's focus commands switch the pane inside Herdr's own window. They don't bring that
// window's terminal app (Ghostty, iTerm, ...) to the front, so on macOS a focus also
// raises the app that hosts the Herdr client. The app is gateway.json's terminalApp, or
// found from the process tree: the app bundle above the `herdr` client (not the server).

import type { GatewayConfig } from "./config.ts";

export interface Raised { raised: boolean; app?: string; reason?: string }

const BUNDLE = /^(\/[\w .+-]+(?:\/[\w .+-]+)*\.app)\/Contents\//;
// A Herdr client is `herdr` alone or with only --session NAME: `herdr server` and the
// plugin daemons are not it.
const CLIENT = /^(?:\S*\/)?herdr(?:\s+--session\s+\S+)?$/;

// ps -axo pid=,ppid=,args= output in, the app bundle path of the first Herdr client that
// runs inside one, or null (a client under mosh or ssh has no app above it).
export function findTerminalApp(ps: string): string | null {
  const procs = new Map<number, { ppid: number; args: string }>();
  for (const line of ps.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (m) procs.set(Number(m[1]), { ppid: Number(m[2]), args: m[3]!.trim() });
  }
  for (const [pid, p] of procs) {
    if (!CLIENT.test(p.args)) continue;
    let cur: number | undefined = p.ppid;
    for (let hops = 0; cur && cur > 1 && hops < 12; hops++) {
      const up = procs.get(cur);
      if (!up) break;
      const app = BUNDLE.exec(up.args)?.[1];
      if (app) return app;
      cur = up.ppid;
    }
    void pid;
  }
  return null;
}

async function run(argv: string[]): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe", env: { PATH: "/usr/bin:/bin" } });
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return { code, out };
}

export async function raiseTerminal(cfg: Pick<GatewayConfig, "terminalApp">): Promise<Raised> {
  if (process.platform !== "darwin") return { raised: false, reason: "raising a terminal window is only done on macOS" };
  let app = cfg.terminalApp;
  if (!app) {
    app = findTerminalApp((await run(["/bin/ps", "-axo", "pid=,ppid=,args="])).out);
    if (!app) return { raised: false, reason: "no terminal app above a Herdr client (it may run over mosh or ssh); set terminalApp in gateway.json" };
  }
  const { code } = await run(["/usr/bin/open", "-a", app]);
  return code === 0 ? { raised: true, app } : { raised: false, app, reason: `open -a failed (${code})` };
}
