// What wakes a ChatGPT thread. watch_here opens a watch for the thread's lease on one
// machine; the notifier drops each gateway report into the watches whose lease holds
// that agent; the watch card in the thread long-polls watch_next and posts each event
// into the chat, so ChatGPT answers the agent without the owner relaying it.
//
// By default only a reply wakes it: the end of a turn this thread started with
// prompt_agent or steer_agent (the gateway marks it reply_to), or a menu that stops an
// agent. Turns the owner starts at the terminal don't, even when they end with a question. A watch ends after maxRounds wakes or at its expiry, so an agent and
// ChatGPT can't keep each other talking. Events are handed out once: a second card
// open on the same chat, or a reloaded one, finds nothing already delivered.
// Watches live in memory: a restart of the MCP server ends them.

import type { Report } from "../../gateway/watcher.ts";

// The event types a watch can wake on. "reply" is a finished or question turn owed to the
// watching thread. A gateway also reports "gone", "background" and "stopped"; those go to
// the phone only.
// "message" is one an agent sent this thread on purpose, with the gateway's tell.
const WAKE_TYPES = ["message", "reply", "question", "blocked", "finished"] as const;
export type WakeType = (typeof WAKE_TYPES)[number];
export const DEFAULT_WAKE: WakeType[] = ["message", "reply", "blocked"];

const isWakeType = (t: string): t is WakeType => (WAKE_TYPES as readonly string[]).includes(t);

export interface WakeEvent {
  seq: number;
  at: string;
  machine: string;
  pane_id: string;
  agent: string | null;
  type: WakeType;
  excerpt: string | null;
  message: string;
}

interface Watch {
  machine: string;
  lease: string;
  wake: Set<WakeType>;
  maxRounds: number;
  rounds: number;
  expires: number;
  queue: WakeEvent[];
  waiters: Array<() => void>;
  stopped: string | null;
  endedAt: number | null;
}

export interface WatchState {
  watch_id: string;
  machine: string;
  lease: string;
  wake: WakeType[];
  rounds: number;
  max_rounds: number;
  expires: string;
  active: boolean;
  ended?: string;
}

const MAX_WATCHES = 50;

// A message an agent sent while its thread had no open link waits this long for one.
const HOLD_MS = 3600_000;

export class Inbox {
  private watches = new Map<string, Watch>();
  // Messages (tell) for a machine and lease with no open watch, by `${machine}|${lease}`.
  private held = new Map<string, WakeEvent[]>();
  private seq = 0;
  constructor(private now: () => number = Date.now) {}

  open(machine: string, lease: string, opts: { wake?: WakeType[]; maxRounds?: number; hours?: number } = {}): WatchState {
    this.sweep();
    // One watch per thread and machine: a second watch_here replaces the first.
    for (const [id, w] of this.watches) if (w.machine === machine && w.lease === lease) this.end(id, "replaced by a new watch");
    // Make room: stopped watches go first, then the oldest live one. Each pass deletes one.
    while (this.watches.size >= MAX_WATCHES) {
      const stopped = [...this.watches].find(([, w]) => w.stopped)?.[0];
      const victim = stopped ?? this.watches.keys().next().value!;
      this.end(victim, "too many watches");
      this.watches.delete(victim);
    }
    const id = `wt_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
    this.watches.set(id, {
      machine,
      lease,
      wake: new Set(opts.wake?.length ? opts.wake : DEFAULT_WAKE),
      maxRounds: opts.maxRounds ?? 20,
      rounds: 0,
      expires: this.now() + (opts.hours ?? 12) * 3600_000,
      queue: [],
      waiters: [],
      stopped: null,
      endedAt: null,
    });
    // Messages the agent sent before this link opened.
    const key = `${machine}|${lease}`;
    const waiting = (this.held.get(key) ?? []).filter((e) => Date.parse(e.at) + HOLD_MS > this.now());
    this.held.delete(key);
    const w = this.watches.get(id)!;
    if (w.wake.has("message")) w.queue.push(...waiting);
    return this.state(id)!;
  }

  // Reports from one machine's watch pass. Returns how many watches got an event.
  add(machine: string, reports: Report[]): number {
    this.sweep();
    let n = 0;
    for (const r of reports) {
      if (!r.lease || !isWakeType(r.type)) continue;
      let taken = false;
      for (const w of this.watches.values()) {
        if (w.stopped || w.machine !== machine || w.lease !== r.lease) continue;
        // A turn this thread asked for is its reply, whatever the turn's end looked like.
        const owed = r.reply_to === w.lease && (r.type === "finished" || r.type === "question");
        const type: WakeType = owed ? "reply" : r.type;
        if (!w.wake.has(type)) continue;
        w.queue.push({ seq: ++this.seq, at: new Date(this.now()).toISOString(), machine, pane_id: r.pane_id, agent: r.agent, type, excerpt: r.excerpt, message: r.message });
        for (const wake of w.waiters.splice(0)) wake();
        n++;
        taken = true;
      }
      // Nobody linked yet: keep an agent's message for the thread's next link.
      if (!taken && r.type === "message") {
        const key = `${machine}|${r.lease}`;
        const list = this.held.get(key) ?? [];
        list.push({ seq: ++this.seq, at: new Date(this.now()).toISOString(), machine, pane_id: r.pane_id, agent: r.agent, type: "message", excerpt: r.excerpt, message: r.message });
        this.held.set(key, list.slice(-20));
      }
    }
    return n;
  }

  // Waits up to timeoutMs for events, then hands them out once, each one counting as a round.
  async next(id: string, timeoutMs: number): Promise<{ events: WakeEvent[]; state: WatchState | null }> {
    const w = this.watches.get(id);
    if (w && !w.stopped && w.queue.length === 0 && timeoutMs > 0) {
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          // Timed out: take this waiter off the list, or every idle long poll leaves one behind.
          const i = w.waiters.indexOf(done);
          if (i >= 0) w.waiters.splice(i, 1);
          resolve();
        }, timeoutMs);
        function done() {
          clearTimeout(t);
          resolve();
        }
        w.waiters.push(done);
      });
    }
    this.sweep();
    const cur = this.watches.get(id);
    if (!cur || cur.stopped) return { events: [], state: this.state(id) };
    const events = cur.queue.splice(0, Math.max(0, cur.maxRounds - cur.rounds));
    cur.rounds += events.length;
    if (cur.rounds >= cur.maxRounds) this.end(id, `reached its ${cur.maxRounds} rounds`);
    return { events, state: this.state(id) };
  }

  stop(id: string): WatchState | null {
    if (this.watches.has(id)) this.end(id, "stopped");
    return this.state(id);
  }

  state(id: string): WatchState | null {
    const w = this.watches.get(id);
    if (!w) return null;
    return {
      watch_id: id,
      machine: w.machine,
      lease: w.lease,
      wake: [...w.wake],
      rounds: w.rounds,
      max_rounds: w.maxRounds,
      expires: new Date(w.expires).toISOString(),
      active: !w.stopped,
      ...(w.stopped ? { ended: w.stopped } : {}),
    };
  }

  private end(id: string, why: string) {
    const w = this.watches.get(id);
    if (!w) return;
    w.stopped = why;
    w.endedAt = this.now();
    w.queue = [];
    for (const wake of w.waiters.splice(0)) wake();
  }

  // Ended watches stay an hour after ending so a card asking again hears why; expired ones end.
  private sweep() {
    const t = this.now();
    for (const [id, w] of this.watches) {
      if (!w.stopped && w.expires <= t) this.end(id, "expired");
      if (w.stopped && w.endedAt !== null && w.endedAt + 3600_000 <= t) this.watches.delete(id);
    }
  }
}

export const inbox = new Inbox();
