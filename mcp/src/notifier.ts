// Phone notifications for agents that finish after the tool call returned. The MCP
// server is the one process that is always up and reaches every gateway, so it polls
// each machine's watch list here and sends what it finds through the gateway whose
// notifyCommand reaches the phone. A sleeping Mac only delays its own messages.

import type { CallGateway } from "./gateway-client.ts";

// A machine asleep or its Herdr restarting: expected, retried without a log line.
const TRANSIENT = new Set(["machine_offline", "gateway_unreachable", "herdr_unavailable", "herdr_timeout", "herdr_closed"]);

export interface Notifier {
  markPending(machine: string): void;
  tick(): Promise<void>;
  stop(): void;
}

export function startNotifier(call: CallGateway, machines: string[], via: string, intervalMs: number): Notifier {
  // Every machine once at startup, to pick up agents prompted before a restart.
  const pending = new Set(machines);
  const failing = new Map<string, string>();
  let inflight: Promise<void> | null = null;

  // A tick that finds one already running waits for it rather than starting a second.
  function tick(): Promise<void> {
    if (inflight) return inflight;
    if (pending.size === 0) return Promise.resolve();
    inflight = sweep().finally(() => {
      inflight = null;
    });
    return inflight;
  }

  async function sweep() {
    for (const machine of [...pending]) {
      const res = await call(machine, "watch_poll", {});
      if (!res.ok) {
        // Only a gateway older than watch_poll fails the same way every time. Anything
        // else is retried: watches last for days, and dropping the machine would leave
        // them unreported until the next watching tool call there.
        if (res.error.code === "unknown_operation") {
          console.error(JSON.stringify({ event: "watch_poll_stopped", machine, error: res.error }));
          pending.delete(machine);
        } else if (!TRANSIENT.has(res.error.code) && failing.get(machine) !== res.error.code) {
          console.error(JSON.stringify({ event: "watch_poll_failed", machine, error: res.error }));
        }
        failing.set(machine, res.error.code);
        continue;
      }
      failing.delete(machine);
      const { messages = [], remaining = 0 } = (res.result ?? {}) as { messages?: string[]; remaining?: number };
      for (const message of messages) {
        const sent = await call(via, "notify", { message: machines.length > 1 ? `${machine}: ${message}` : message });
        if (!sent.ok) console.error(JSON.stringify({ event: "notify_failed", machine, message, error: sent.error }));
      }
      if (remaining === 0) pending.delete(machine);
    }
  }

  const timer = setInterval(() => void tick(), intervalMs);
  void tick();
  return {
    markPending: (machine) => void pending.add(machine),
    tick,
    stop: () => clearInterval(timer),
  };
}
