// What wakes a ChatGPT thread. watch_here opens a watch for the thread's lease on one
// machine; the notifier drops each gateway report into the watches whose lease holds
// that agent; the watch card in the thread long-polls watch_next and posts each event
// into the chat, so ChatGPT answers the agent without the owner relaying it.
//
// By default only a reply wakes it: the end of a turn this thread started with
// prompt_agent or steer_agent (the gateway marks it reply_to), a message the agent sent
// on purpose (tell), or a menu that stops an agent. Turns the owner starts at the
// terminal don't, even when they end with a question.
//
// A watch's credential is its cap, a random token the card gets in the tool result's
// _meta and the model never sees. watch_next, watch_stop and replacing an open watch
// need it; the lease alone is not enough. A watch that used up its rounds can't be
// opened again for an hour. Events are handed out once. Watches live in memory: a
// restart forgets them, and the card opens its watch again.
//
// Polling is what ChatGPT sees, so a watch is only as long as the conversation: it ends
// IDLE_MS after its last activity (opening, a wake handed out, a message the thread sent
// to an agent), well before its hours run out. The chat opens a new one with watch_here
// when it hands an agent work. While quiet, polls get longer, and a second card polling
// the same watch is turned away, so two devices don't double the calls.

import type { Report } from "../../gateway/watcher.ts";

// The event types a watch can wake on. "message" is one an agent sent this thread on
// purpose, with the gateway's tell. "reply" is a finished or question turn owed to the
// watching thread. A gateway also reports "gone", "background" and "stopped"; those go
// to the phone only.
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
  cap: string;
  wake: Set<WakeType>;
  maxRounds: number;
  rounds: number;
  expires: number;
  idleUntil: number;
  lastActive: number;
  queue: WakeEvent[];
  waiters: Array<() => void>;
  stopped: string | null;
  endedAt: number | null;
  usedUp: boolean;
  // When events were last handed out, and how many agent messages the thread sent since.
  lastWakeAt: number | null;
  sentSinceWake: number;
}

// What the model may see: no lease, no watch id, no cap.
export interface WatchState {
  machine: string;
  wake: WakeType[];
  rounds: number;
  max_rounds: number;
  expires: string;
  // Ends here unless something happens first; each wake or message to an agent moves it.
  idle_until: string;
  active: boolean;
  ended?: string;
}

// What only the card holds, from the tool result's _meta.
export interface WatchKey {
  watch_id: string;
  cap: string;
  lease: string;
}

export type Opened = { ok: true; state: WatchState; key: WatchKey } | { ok: false; code: string; message: string };

const MAX_WATCHES = 50;
// A watch with no activity for this long ends.
const IDLE_MS = 30 * 60_000;
// A watch quiet for this long gets the longer poll.
const QUIET_AFTER_MS = 5 * 60_000;
export const POLL_MS = 20_000;
export const QUIET_POLL_MS = 45_000;
// A message an agent sent while its thread had no open link waits this long for one.
const HOLD_MS = 3600_000;
// After using up its rounds, a watch for that machine and lease can't be opened again for this long.
const COOLDOWN_MS = 3600_000;
// After a wake, the thread gets one message to its agents in this window. There is no
// override: a back-and-forth goes on because each reply is a new wake.
const REPLY_WINDOW_MS = 10 * 60_000;

const hex = () => crypto.randomUUID().replaceAll("-", "");
const token = (prefix: string, n: number) => (prefix + hex() + hex()).slice(0, prefix.length + n);

export class Inbox {
  private watches = new Map<string, Watch>();
  // Messages (tell) for a machine and lease with no open watch, by `${machine}|${lease}`.
  private held = new Map<string, WakeEvent[]>();
  private seq = 0;
  constructor(private now: () => number = Date.now, private busyMs = 30_000, private log: (line: string) => void = () => {}) {}

  // Which link a log line is about, without the credentials: the end of the watch id and of the lease.
  private tag(id: string, w: Watch) {
    return { machine: w.machine, watch: id.slice(-6), lease: "…" + w.lease.slice(-4) };
  }

  // cap: the open watch's cap, to replace or extend it. Without it, an open watch for
  // this machine and lease is left alone and the call is refused.
  open(machine: string, lease: string, opts: { wake?: WakeType[]; maxRounds?: number; hours?: number; cap?: string } = {}): Opened {
    this.sweep();
    const t = this.now();
    const same = [...this.watches].filter(([, w]) => w.machine === machine && w.lease === lease);
    const open = same.find(([, w]) => !w.stopped);
    if (open && opts.cap !== open[1].cap) {
      return { ok: false, code: "already_linked", message: `this chat's agents on ${machine} already have an open link; its card extends or replaces it, and Stop on the card ends it` };
    }
    const spent = same.find(([, w]) => w.usedUp && w.endedAt !== null && w.endedAt + COOLDOWN_MS > t);
    if (spent) {
      const until = new Date(spent[1].endedAt! + COOLDOWN_MS).toISOString();
      return { ok: false, code: "cooldown", message: `the last link for these agents used up its rounds; a new one can open after ${until}` };
    }
    const maxRounds = opts.maxRounds ?? 200;
    // Replacing keeps the rounds already used, so replacing is never a way to reset them.
    const carried = open ? Math.min(open[1].rounds, maxRounds - 1) : 0;
    if (open) this.end(open[0], "replaced by a new watch");
    // Make room: stopped watches go first, then the oldest live one. Each pass deletes one.
    while (this.watches.size >= MAX_WATCHES) {
      const stopped = [...this.watches].find(([, w]) => w.stopped)?.[0];
      const victim = stopped ?? this.watches.keys().next().value!;
      this.end(victim, "too many watches");
      this.watches.delete(victim);
    }
    const id = token("wt_", 16);
    const cap = token("wc_", 40);
    const w: Watch = {
      machine,
      lease,
      cap,
      wake: new Set(opts.wake?.length ? opts.wake : DEFAULT_WAKE),
      maxRounds,
      rounds: carried,
      expires: t + (opts.hours ?? 72) * 3600_000,
      idleUntil: t + IDLE_MS,
      lastActive: t,
      queue: [],
      waiters: [],
      stopped: null,
      endedAt: null,
      usedUp: false,
      lastWakeAt: null,
      sentSinceWake: 0,
    };
    this.watches.set(id, w);
    this.log(JSON.stringify({ event: "watch_open", ...this.tag(id, w), hours: opts.hours ?? 72, replaced: Boolean(open) }));
    // Messages the agent sent before this link opened.
    const key = `${machine}|${lease}`;
    const waiting = (this.held.get(key) ?? []).filter((e) => Date.parse(e.at) + HOLD_MS > t);
    this.held.delete(key);
    if (w.wake.has("message")) w.queue.push(...waiting);
    return { ok: true, state: this.state(id)!, key: { watch_id: id, cap, lease } };
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

  // Waits up to timeoutMs for events, then hands them out once, each one counting as a
  // round. A wrong cap gets what an unknown watch gets: nothing, and state null.
  // If another poll already waits on this watch, this one is held busyMs and turned away
  // with busy: true. The wait is here, not in the card, so an older card that doesn't know
  // busy can't spin on it.
  async next(id: string, cap: string, timeoutMs: number): Promise<{ events: WakeEvent[]; state: WatchState | null; busy?: true }> {
    const w = this.watches.get(id);
    if (!w || w.cap !== cap) return { events: [], state: null };
    if (!w.stopped && w.queue.length === 0 && timeoutMs > 0 && w.waiters.length > 0) {
      await new Promise((r) => setTimeout(r, Math.min(timeoutMs, this.busyMs)));
      this.log(JSON.stringify({ event: "watch_poll_busy", ...this.tag(id, w) }));
      return { events: [], state: this.state(id), busy: true };
    }
    if (!w.stopped && w.queue.length === 0 && timeoutMs > 0) {
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
    const events = cur.queue.splice(0, cur.maxRounds - cur.rounds);
    cur.rounds += events.length;
    if (events.length) {
      cur.lastWakeAt = this.now();
      cur.sentSinceWake = 0;
      this.touch(cur);
    }
    if (cur.rounds >= cur.maxRounds) {
      cur.usedUp = true;
      this.end(id, `reached its ${cur.maxRounds} rounds`);
    }
    this.log(JSON.stringify({ event: "watch_poll", ...this.tag(id, cur), wake_events: events.length, idle_in_s: Math.round((cur.idleUntil - this.now()) / 1000) }));
    return { events, state: this.state(id) };
  }

  // How long the card's next poll should wait: longer once the watch has been quiet.
  pollMs(id: string): number {
    const w = this.watches.get(id);
    return w && this.now() - w.lastActive >= QUIET_AFTER_MS ? QUIET_POLL_MS : POLL_MS;
  }

  private touch(w: Watch) {
    w.lastActive = this.now();
    w.idleUntil = w.lastActive + IDLE_MS;
  }

  stop(id: string, cap: string): WatchState | null {
    const w = this.watches.get(id);
    if (!w || w.cap !== cap) return null;
    this.end(id, "stopped");
    return this.state(id);
  }

  // Before prompt_agent or steer_agent from this thread: after a wake, one message to its
  // agents. Without an open watch, or before its first wake, there is nothing to limit.
  allowMessage(machine: string, lease: string): { ok: true } | { ok: false; message: string } {
    const w = [...this.watches.values()].find((x) => !x.stopped && x.machine === machine && x.lease === lease);
    if (!w || w.lastWakeAt === null || this.now() - w.lastWakeAt >= REPLY_WINDOW_MS || w.sentSinceWake < 1) return { ok: true };
    return { ok: false, message: "one message to the agent per wake: you already answered this one. Wait for its reply, which wakes this chat again and allows the next message" };
  }

  noteMessage(machine: string, lease: string) {
    for (const w of this.watches.values()) if (!w.stopped && w.machine === machine && w.lease === lease) {
      w.sentSinceWake += 1;
      this.touch(w);
    }
  }

  state(id: string): WatchState | null {
    const w = this.watches.get(id);
    if (!w) return null;
    return {
      machine: w.machine,
      wake: [...w.wake],
      rounds: w.rounds,
      max_rounds: w.maxRounds,
      expires: new Date(w.expires).toISOString(),
      idle_until: new Date(w.idleUntil).toISOString(),
      active: !w.stopped,
      ...(w.stopped ? { ended: w.stopped } : {}),
    };
  }

  private end(id: string, why: string) {
    const w = this.watches.get(id);
    if (!w) return;
    w.stopped = why;
    w.endedAt = this.now();
    this.log(JSON.stringify({ event: "watch_end", ...this.tag(id, w), why, rounds: w.rounds }));
    w.queue = [];
    for (const wake of w.waiters.splice(0)) wake();
  }

  // Ended watches stay an hour after ending, so a card asking again hears why and a used-up
  // watch's cooldown holds; expired ones end.
  private sweep() {
    const t = this.now();
    for (const [id, w] of this.watches) {
      if (!w.stopped && w.expires <= t) this.end(id, "expired");
      else if (!w.stopped && w.idleUntil <= t) this.end(id, "idle for " + IDLE_MS / 60_000 + " minutes: link again when you send an agent work");
      if (w.stopped && w.endedAt !== null && w.endedAt + Math.max(3600_000, COOLDOWN_MS) <= t) this.watches.delete(id);
    }
  }
}

export const inbox = new Inbox(Date.now, 30_000, console.log);
