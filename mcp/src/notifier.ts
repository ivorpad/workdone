// Phone notifications for agents that finish after the tool call returned. The MCP
// server is the one process that is always up and reaches every gateway, so it polls
// each machine's watch list here and sends what it finds through the gateway whose
// notifyCommand reaches the phone. A sleeping Mac only delays its own messages.
//
// Each machine with something watched has its own loop, one call at a time. A call
// asks the gateway to wait up to waitMs for something to happen (it listens to Herdr's
// events), and the next call goes out as soon as it returns. A call that fails, or
// comes back early with nothing (a gateway from before wait_ms, a Herdr without
// events, only browser runs to watch), is followed by intervalMs of rest instead.

import type { Report } from "../../gateway/watcher.ts";
import { randomUUID } from "node:crypto";
import type { CallGateway } from "./gateway-client.ts";

// A machine asleep or its Herdr restarting: expected, retried without a log line.
const TRANSIENT = new Set(["machine_offline", "gateway_unreachable", "herdr_unavailable", "herdr_timeout", "herdr_closed"]);
// Well below the ssh request timeout, and within what the gateway accepts (25 s).
export const WAIT_MS = 20_000;

export interface Notifier {
  markPending(machine: string): void;
  // Resolves when every machine's loop has stopped: nothing left to watch, or stop().
  idle(): Promise<void>;
  stop(): void;
}

// Both native Events and fallback cards consume these reports. Await durable
// enqueue before taking another gateway pass; phone delivery stays independent.
export function startNotifier(call: CallGateway, machines: string[], via: string | null, intervalMs: number, waitMs = WAIT_MS, onReports?: (machine: string, reports: Report[]) => void | Promise<void>): Notifier {
  const pending = new Set<string>();
  const failing = new Map<string, string>();
  const loops = new Map<string, Promise<void>>();
  const resting = new Map<string, () => void>();
  // Retain failed intake and apply backpressure before consuming another pass.
  const retryReports = new Map<string, Report[]>();
  // Bumped by every markPending, so a call that started before it cannot drop the machine.
  const marks = new Map<string, number>();
  let stopped = false;

  const rest = (machine: string) =>
    new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(t);
        resting.delete(machine);
        resolve();
      };
      const t = setTimeout(done, intervalMs);
      resting.set(machine, done);
    });

  // What to do after one call: call again now, rest first, stop because nothing is
  // left, or stop for good because the gateway has no watch_poll.
  async function once(machine: string): Promise<"now" | "rest" | "done" | "unsupported"> {
    const retry = retryReports.get(machine);
    if (retry) {
      try { await onReports?.(machine, retry); retryReports.delete(machine); }
      catch { return "rest"; }
    }
    const started = Date.now();
    const res = await call(machine, "watch_poll", { wait_ms: waitMs });
    if (!res.ok) {
      // Only a gateway older than watch_poll fails the same way every time. Anything
      // else is retried: watches last for days, and dropping the machine would leave
      // them unreported until the next watching tool call there.
      if (res.error.code === "unknown_operation") {
        console.error(JSON.stringify({ event: "watch_poll_stopped", machine, error: res.error }));
        return "unsupported";
      }
      if (!TRANSIENT.has(res.error.code) && failing.get(machine) !== res.error.code) {
        console.error(JSON.stringify({ event: "watch_poll_failed", machine, error: res.error }));
      }
      failing.set(machine, res.error.code);
      return "rest";
    }
    failing.delete(machine);
    const { messages = [], remaining = 0, reports = [] } = (res.result ?? {}) as { messages?: string[]; remaining?: number; reports?: Report[] };
    if (reports.length) {
      // Older gateways omit IDs. Assign them once so retries of a partially
      // committed batch cannot create duplicate native deliveries.
      for (const report of reports) {
        report.event_id ??= randomUUID();
        report.occurred_at ??= new Date().toISOString();
      }
      try { await onReports?.(machine, reports); }
      catch {
        retryReports.set(machine, reports);
        console.error(JSON.stringify({ event: "report_dispatch_failed", machine }));
      }
    }
    for (const message of via ? messages : []) {
      if (!via) continue;
      const sent = await call(via, "notify", { message: machines.length > 1 ? `${machine}: ${message}` : message });
      if (!sent.ok) console.error(JSON.stringify({ event: "notify_failed", machine, message, error: sent.error }));
    }
    if (retryReports.has(machine)) return "rest";
    if (remaining === 0) return "done";
    return messages.length > 0 || Date.now() - started >= waitMs / 2 ? "now" : "rest";
  }

  async function loop(machine: string) {
    while (!stopped && pending.has(machine)) {
      const mark = marks.get(machine);
      const next = await once(machine);
      if (next === "unsupported" || (next === "done" && marks.get(machine) === mark)) pending.delete(machine);
      else if (next === "rest" && !stopped) await rest(machine);
    }
  }

  function start(machine: string) {
    pending.add(machine);
    marks.set(machine, (marks.get(machine) ?? 0) + 1);
    // A machine resting after an early return is asked again now.
    resting.get(machine)?.();
    if (stopped || loops.has(machine)) return;
    loops.set(
      machine,
      loop(machine).finally(() => {
        loops.delete(machine);
        // Marked again while the last call was on its way out.
        if (!stopped && pending.has(machine)) start(machine);
      }),
    );
  }

  // Every machine once at startup, to pick up agents prompted before a restart.
  for (const m of machines) start(m);
  return {
    markPending: start,
    idle: async () => {
      while (loops.size) await Promise.all(loops.values());
    },
    stop: () => {
      stopped = true;
      for (const wake of [...resting.values()]) wake();
    },
  };
}
