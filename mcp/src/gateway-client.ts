// Calls a machine's gateway: one ssh process per request, one JSON line in, one out.

import { sshArgs, type OvhConfig } from "./config.ts";

export type GatewayResponse =
  | { ok: true; result: unknown }
  | { ok: false; error: { code: string; message: string } };

export type CallGateway = (machine: string, op: string, params: Record<string, unknown>) => Promise<GatewayResponse>;

// ssh's own wording when it never reached the machine (asleep, offline, off the tailnet).
const UNREACHABLE = /timed out|No route to host|Connection refused|Could not resolve|Network is unreachable|Host is down|Connection closed by remote host/i;
// After a machine fails to connect, calls to it fail fast for this long instead of each
// waiting out the connect timeout: a sleeping Mac would otherwise stall every listing.
export const OFFLINE_MS = 60_000;

let seq = 0;

export function sshGateway(cfg: OvhConfig, now: () => number = Date.now): CallGateway {
  const argv = new Map(Object.entries(cfg.machines).map(([name, t]) => [name, [t.binary, ...sshArgs(t)]]));
  const offline = new Map<string, { until: number; since: string; reason: string }>();
  return async (machine, op, params) => {
    const cmd = argv.get(machine);
    if (!cmd) return { ok: false, error: { code: "unknown_machine", message: `machine ${machine} is not configured` } };
    const down = offline.get(machine);
    if (down && now() < down.until) {
      return {
        ok: false,
        error: {
          code: "machine_offline",
          message: `${machine} did not answer at ${down.since} (${down.reason}); calls to it fail fast until ${new Date(down.until).toISOString()}. Use another machine or try again later.`,
        },
      };
    }
    const id = `mcp-${Date.now()}-${++seq}`;
    const proc = Bun.spawn(cmd, {
      stdin: new TextEncoder().encode(JSON.stringify({ id, op, params }) + "\n"),
      stdout: "pipe",
      stderr: "pipe",
      env: { PATH: "/usr/bin:/bin", HOME: process.env.HOME ?? "/nonexistent" },
    });
    const timer = setTimeout(() => proc.kill(), cfg.requestTimeoutMs);
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    clearTimeout(timer);

    const line = stdout.split("\n").find((l) => l.trim());
    if (!line) {
      const reason = proc.signalCode ? `timed out after ${cfg.requestTimeoutMs}ms` : `ssh exited ${code}`;
      console.error(JSON.stringify({ event: "gateway_unreachable", machine, op, code, stderr: stderr.slice(0, 500) }));
      if (code === 255 && UNREACHABLE.test(stderr)) {
        const detail = stderr.trim().split("\n").pop()?.slice(0, 160) ?? reason;
        offline.set(machine, { until: now() + OFFLINE_MS, since: new Date(now()).toISOString(), reason: detail });
        return { ok: false, error: { code: "machine_offline", message: `${machine} is not reachable: ${detail}` } };
      }
      return { ok: false, error: { code: "gateway_unreachable", message: `${machine}: ${reason}: ${stderr.trim().slice(0, 300)}` } };
    }
    offline.delete(machine);
    try {
      const msg = JSON.parse(line);
      if (msg.ok === true) return { ok: true, result: msg.result };
      return { ok: false, error: { code: msg.error?.code ?? "gateway_error", message: msg.error?.message ?? "gateway error" } };
    } catch {
      return { ok: false, error: { code: "gateway_bad_response", message: "gateway returned invalid JSON" } };
    }
  };
}
