// Calls a machine's gateway: one ssh process per request, one JSON line in, one out.

import { sshArgs, type OvhConfig } from "./config.ts";

export type GatewayResponse =
  | { ok: true; result: unknown }
  | { ok: false; error: { code: string; message: string; pending?: string; details?: { dialog_id?: string; menu?: string; targets?: unknown[] } } };

export type CallGateway = (machine: string, op: string, params: Record<string, unknown>) => Promise<GatewayResponse>;

// ssh's own wording when it never reached the machine (asleep, offline, off the tailnet).
const UNREACHABLE = /timed out|No route to host|Connection refused|Could not resolve|Network is unreachable|Host is down|Connection closed by remote host/i;
// After a machine fails to connect, calls to it fail fast for this long instead of each
// waiting out the connect timeout: a sleeping Mac would otherwise stall every listing.
export const OFFLINE_MS = 60_000;
// A connect that failed never reached the gateway, so it is safe to try again: one
// relayed Tailscale packet lost must not take a machine out for OFFLINE_MS.
export const CONNECT_RETRY_MS = 1000;
// After a box resumes, its tailnet link takes a few seconds to come back: wake_machine
// polls bridge_status this long, then reports it resumed but not reachable yet.
export const WAKE_REACH_MS = 45_000;

let seq = 0;

export function sshGateway(cfg: OvhConfig, now: () => number = Date.now, retryMs = CONNECT_RETRY_MS): CallGateway {
  const argv = new Map(Object.entries(cfg.machines).map(([name, t]) => [name, [t.binary, ...sshArgs(t)]]));
  const offline = new Map<string, { until: number; since: string; reason: string }>();
  const wakeHint = (machine: string) => cfg.machines[machine]?.wake ? ` It may be a paused cloud box: wake_machine with machine ${machine} resumes it.` : "";

  // Resumes a paused box through the machine that holds the instabox key. The command is
  // fixed by the config; nothing in params reaches it.
  const wake = async (machine: string): Promise<GatewayResponse> => {
    const w = cfg.machines[machine]?.wake;
    if (!w) return { ok: false, error: { code: "not_wakeable", message: `${machine} has no wake configured; only paused cloud boxes can be woken` } };
    const res = await call(w.via, "exec", { command: `"$HOME/.local/bin/instabox-wake" ${w.box}`, timeout_ms: 60_000 });
    if (!res.ok) return { ok: false, error: { code: "wake_failed", message: `asking ${w.via} to resume ${w.box}: ${res.error.code}: ${res.error.message}` } };
    const r = res.result as { exit_code?: number | null; stdout?: string; stderr?: string };
    let woke: { before?: string; state?: string } = {};
    try { woke = JSON.parse(r.stdout?.trim().split("\n").pop() ?? "{}"); } catch {}
    if (r.exit_code !== 0) return { ok: false, error: { code: "wake_failed", message: `${w.via} could not resume ${w.box}: ${`${r.stdout ?? ""}${r.stderr ?? ""}`.trim().slice(0, 400)}` } };
    const start = now();
    for (;;) {
      offline.delete(machine);
      const s = await call(machine, "bridge_status", {});
      if (s.ok) return { ok: true, result: { machine, box: w.box, before: woke.before ?? null, state: woke.state ?? "running", reachable: true, waited_ms: now() - start } };
      if (now() - start >= WAKE_REACH_MS) break;
      await Bun.sleep(3000);
    }
    offline.delete(machine);
    return { ok: true, result: { machine, box: w.box, before: woke.before ?? null, state: woke.state ?? "running", reachable: false, note: "resumed, but not reachable over the tailnet yet; try the machine again in a minute" } };
  };

  const call: CallGateway = async (machine, op, params) => {
    const cmd = argv.get(machine);
    if (!cmd) return { ok: false, error: { code: "unknown_machine", message: `machine ${machine} is not configured` } };
    if (op === "wake_machine") return wake(machine);
    const down = offline.get(machine);
    if (down && now() < down.until) {
      return {
        ok: false,
        error: {
          code: "machine_offline",
          message: `${machine} did not answer at ${down.since} (${down.reason}); calls to it fail fast until ${new Date(down.until).toISOString()}. Use another machine or try again later.${wakeHint(machine)}`,
        },
      };
    }
    const id = `mcp-${Date.now()}-${++seq}`;
    const run = async () => {
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
      return { proc, stdout, stderr, code };
    };
    let { proc, stdout, stderr, code } = await run();
    const unreachable = () => !stdout.trim() && code === 255 && UNREACHABLE.test(stderr);
    if (unreachable()) {
      console.error(JSON.stringify({ event: "gateway_connect_retry", machine, op, stderr: stderr.slice(0, 300) }));
      await Bun.sleep(retryMs);
      ({ proc, stdout, stderr, code } = await run());
    }

    const line = stdout.split("\n").find((l) => l.trim());
    if (!line) {
      const reason = proc.signalCode ? `timed out after ${cfg.requestTimeoutMs}ms` : `ssh exited ${code}`;
      console.error(JSON.stringify({ event: "gateway_unreachable", machine, op, code, stderr: stderr.slice(0, 500) }));
      if (code === 255 && UNREACHABLE.test(stderr)) {
        const detail = stderr.trim().split("\n").pop()?.slice(0, 160) ?? reason;
        offline.set(machine, { until: now() + OFFLINE_MS, since: new Date(now()).toISOString(), reason: detail });
        return { ok: false, error: { code: "machine_offline", message: `${machine} is not reachable: ${detail}.${wakeHint(machine)}` } };
      }
      return { ok: false, error: { code: "gateway_unreachable", message: `${machine}: ${reason}: ${stderr.trim().slice(0, 300)}` } };
    }
    offline.delete(machine);
    try {
      const msg = JSON.parse(line);
      if (msg.ok === true) return { ok: true, result: msg.result };
      return { ok: false, error: { code: msg.error?.code ?? "gateway_error", message: msg.error?.message ?? "gateway error", ...(msg.error?.details ? { details: msg.error.details } : {}) } };
    } catch {
      return { ok: false, error: { code: "gateway_bad_response", message: "gateway returned invalid JSON" } };
    }
  };
  return call;
}
