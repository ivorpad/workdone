// What wakes a ChatGPT thread. watch_here opens a watch for the thread's lease on one
// machine, and so does a regular chat's spawn_agent, prompt_agent or steer_agent by
// itself (link below); the notifier drops each gateway report into the watches whose lease holds
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
// need it; the lease alone is not enough. A watch that used up its rounds ends, and the
// thread can link again at once. Events are handed out once. Production persists
// watches and source intake; an in-memory inbox remains available for isolated tests.
//
// Polling is what ChatGPT sees, so a watch is only as long as the conversation: it ends
// IDLE_MS after its last activity (opening, a wake handed out, a message the thread sent
// to an agent), well before its hours run out. The chat's next spawn or prompt opens a
// new one. While quiet, polls get longer, and a second card polling
// the same watch is turned away, so two devices don't double the calls.

import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
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
  pane_id: string | null;
  agent: string | null;
  type: WakeType;
  excerpt: string | null;
  message: string;
  // The structured final result of a reply: true request (see gateway TurnResult).
  result?: Report["result"];
  objective?: string;
  transition?: Report["transition"];
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
  // When events were last handed out, and how many agent messages the thread sent since.
  lastWakeAt: number | null;
  sentSinceWake: number;
  // When a card last asked watch_next for this watch. Unset until one does.
  polledAt?: number | null;
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
const MAX_HELD_COORD = 10_000;
// After a wake, the thread gets one message to its agents in this window. There is no
// override: a back-and-forth goes on because each reply is a new wake.
const REPLY_WINDOW_MS = 10 * 60_000;
// A link no card has polled for this long has no card bringing its replies in: the card
// never rendered, or the device it ran on closed. Longer than a card's longest pause
// between polls (a 60 s retry while ChatGPT refuses a wake).
const CARD_GONE_MS = 90_000;

const hex = () => crypto.randomUUID().replaceAll("-", "");
const token = (prefix: string, n: number) => (prefix + hex() + hex()).slice(0, prefix.length + n);

export class Inbox {
  private watches = new Map<string, Watch>();
  // Messages (tell) for a machine and lease with no open watch, by `${machine}|${lease}`.
  private held = new Map<string, WakeEvent[]>();
  private seq = 0;
  private seen = new Set<string>();
  private db?: Database;
  private committed?: string;

  // Production attaches this before starting the notifier. Queues, held messages,
  // credentials and source IDs survive restart; never write this database publicly.
  persistTo(path: string) {
    if (this.db) throw new Error("Inbox persistence is already configured");
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new Database(path, { create: true, strict: true });
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS inbox (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL)");
    const row = this.db.query("SELECT value FROM inbox WHERE id=1").get() as { value: string } | null;
    if (row) { this.restore(row.value); this.committed = row.value; }
    else this.persist();
  }
  close() { this.db?.close(); this.db = undefined; }
  private snapshot(): string {
    return JSON.stringify({ version: 1, seq: this.seq, seen: [...this.seen], held: [...this.held], watches: [...this.watches].map(([id, w]) => [id, { ...w, wake: [...w.wake], waiters: [] }]) });
  }
  private restore(text: string) {
    const state = JSON.parse(text);
    if (state.version !== 1 || !Array.isArray(state.seen) || !Array.isArray(state.held) || !Array.isArray(state.watches) || !Number.isSafeInteger(state.seq)) throw new Error("Invalid durable inbox state");
    this.seq = state.seq;
    this.seen = new Set(state.seen);
    this.held = new Map(state.held);
    this.watches = new Map(state.watches.map(([id, w]: [string, any]) => [id, { ...w, wake: new Set(w.wake), waiters: [] }]));
  }
  private persist() {
    if (!this.db) return;
    const snapshot = this.snapshot();
    try {
      this.db.query("INSERT INTO inbox(id,value) VALUES (1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value").run(snapshot);
      this.committed = snapshot;
    } catch (err) {
      if (this.committed) {
        const waiters = new Map([...this.watches].map(([id, w]) => [id, w.waiters]));
        this.restore(this.committed);
        for (const [id, w] of this.watches) w.waiters = waiters.get(id) ?? [];
      }
      throw err;
    }
  }
  constructor(private now: () => number = Date.now, private busyMs = 30_000, private log: (line: string) => void = () => {}) {}

  // Which link a log line is about, without the credentials: the end of the watch id and of the lease.
  private tag(id: string, w: Watch) {
    return { machine: w.machine, watch: id.slice(-6), lease: "…" + w.lease.slice(-4) };
  }

  // cap: the open watch's cap, to replace or extend it. Without it, an open watch for
  // this machine and lease is left alone and the call is refused.
  open(machine: string, lease: string, opts: { wake?: WakeType[]; maxRounds?: number; hours?: number; cap?: string; panes?: string[] } = {}): Opened {
    this.sweep();
    const t = this.now();
    const same = [...this.watches].filter(([, w]) => w.machine === machine && w.lease === lease);
    const open = same.find(([, w]) => !w.stopped);
    if (open && opts.cap !== open[1].cap) {
      return { ok: false, code: "already_linked", message: `this chat's agents on ${machine} already have an open link; its card extends or replaces it, and Stop on the card ends it` };
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
      lastWakeAt: null,
      sentSinceWake: 0,
    };
    this.watches.set(id, w);
    this.log(JSON.stringify({ event: "watch_open", ...this.tag(id, w), hours: opts.hours ?? 72, replaced: Boolean(open) }));
    // Messages the agent sent before this link opened.
    const key = `${machine}|${lease}`;
    const waiting = (this.held.get(key) ?? []).filter((e) => e.objective || Date.parse(e.at) + HOLD_MS > t);
    this.held.delete(key);
    // A chat that took an agent over (claim_agents moves a pane to the new lease) also gets
    // what the agent told the lease it came from, which no card will ever open on.
    const panes = new Set(opts.panes ?? []);
    if (panes.size) {
      for (const [k, list] of [...this.held]) {
        if (!k.startsWith(`${machine}|`) || k === key) continue;
        const mine = list.filter((e) => !e.objective && (e.pane_id !== null && panes.has(e.pane_id)));
        if (!mine.length) continue;
        waiting.push(...mine.filter((e) => e.objective || Date.parse(e.at) + HOLD_MS > t));
        const rest = list.filter((e) => e.objective || !(e.pane_id !== null && panes.has(e.pane_id)));
        if (rest.length) this.held.set(k, rest);
        else this.held.delete(k);
      }
      waiting.sort((a, b) => a.seq - b.seq);
    }
    if (w.wake.has("message")) w.queue.push(...waiting);
    else this.retainHeld(key, waiting.filter(e => e.objective));
    this.persist();
    return { ok: true, state: this.state(id)!, key: { watch_id: id, cap, lease } };
  }

  linked(machine: string, lease: string): boolean {
    this.sweep();
    return [...this.watches.values()].some((w) => !w.stopped && w.machine === machine && w.lease === lease);
  }

  // A regular chat links itself when it hands an agent work (spawn_agent, prompt_agent,
  // steer_agent). With no open link, this opens one with the defaults. With one open, the
  // card that holds it keeps it, and this call gets no key while that card polls. If no
  // card has polled it for CARD_GONE_MS, this call's card gets the same key and brings the
  // replies in instead: nothing is replaced, and the rounds and ceilings carry on.
  link(machine: string, lease: string, opts: { panes?: string[] } = {}): { ok: true; state: WatchState; key: WatchKey | null } | { ok: false; code: string; message: string } {
    this.sweep();
    const open = [...this.watches].find(([, w]) => !w.stopped && w.machine === machine && w.lease === lease);
    if (!open) return this.open(machine, lease, { panes: opts.panes });
    const [id, w] = open;
    this.touch(w);
    this.persist();
    const polled = w.waiters.length > 0 || (w.polledAt != null && this.now() - w.polledAt < CARD_GONE_MS);
    return { ok: true, state: this.state(id)!, key: polled ? null : { watch_id: id, cap: w.cap, lease } };
  }

  // Reports from one machine's watch pass. Returns how many watches got an event.
  add(machine: string, reports: Report[]): number {
    const before = this.snapshot();
    try {
      const n = this.addReports(machine, reports);
      this.persist();
      for (const w of this.watches.values()) if (w.queue.length) for (const wake of w.waiters.splice(0)) wake();
      return n;
    } catch (err) {
      const waiters = new Map([...this.watches].map(([id, w]) => [id, w.waiters]));
      if (before) {
        this.restore(before);
        for (const [id, w] of this.watches) w.waiters = waiters.get(id) ?? [];
      }
      throw err;
    }
  }

  private addReports(machine: string, reports: Report[]): number {
    this.sweep();
    let n = 0;
    for (const source of reports) {
      const key = source.event_id ? JSON.stringify([machine, source.event_id]) : null;
      if (key && this.seen.has(key)) continue;
      // Objective transitions have an explicit supervisor recipient. Never infer
      // their authority or destination from an unrelated worker's lease.
      const r = source.recipient_lease ? { ...source, lease: source.recipient_lease } : source;
      if (r.objective && r.lease) {
        const held = (this.held.get(`${machine}|${r.lease}`) ?? []).filter(e => e.objective).length;
        const queued = [...this.watches.values()].filter(w => w.machine === machine && w.lease === r.lease).reduce((n, w) => n + w.queue.filter(e => e.objective).length, 0);
        if (held + queued >= MAX_HELD_COORD) throw new Error("Coordination inbox is full; source intake must wait");
      }
      if (key) this.seen.add(key);
      // An agent that exited with a result owed still answers the thread that asked.
      if (!r.lease || !(isWakeType(r.type) || (r.type === "gone" && r.result))) continue;
      let taken = false;
      for (const w of this.watches.values()) {
        if (w.stopped || w.machine !== machine || w.lease !== r.lease) continue;
        // A turn this thread asked for is its reply, whatever the turn's end looked like.
        const owed = r.reply_to === w.lease && (r.type === "finished" || r.type === "question" || (r.type === "gone" && !!r.result));
        if (!owed && !isWakeType(r.type)) continue;
        const type = (owed ? "reply" : r.type) as WakeType;
        if (!w.wake.has(type)) continue;
        w.queue.push({ seq: ++this.seq, at: new Date(this.now()).toISOString(), machine, pane_id: r.pane_id, agent: r.agent, type, excerpt: r.excerpt, message: r.message, ...(r.result ? { result: r.result } : {}), ...(r.objective ? { objective: r.objective, transition: r.transition } : {}) });
        n++;
        taken = true;
      }
      // Nobody linked yet: keep an agent's message for the thread's next link.
      if (!taken && r.type === "message") {
        const key = `${machine}|${r.lease}`;
        const list = this.held.get(key) ?? [];
        list.push({ seq: ++this.seq, at: new Date(this.now()).toISOString(), machine, pane_id: r.pane_id, agent: r.agent, type: "message", excerpt: r.excerpt, message: r.message, ...(r.objective ? { objective: r.objective, transition: r.transition } : {}) });
        this.retainHeld(key, list);
      }
    }
    return n;
  }

  private retainHeld(key: string, events: WakeEvent[]) {
    if (events.filter(e => e.objective).length > MAX_HELD_COORD) throw new Error("Coordination inbox is full; source intake must wait");
    const tells = new Set(events.filter(e => !e.objective).slice(-20));
    const retained = events.filter(e => e.objective || tells.has(e));
    if (retained.length) this.held.set(key, retained);
  }

  // Waits up to timeoutMs for events, then hands them out once, each one counting as a
  // round. A wrong cap gets what an unknown watch gets: nothing, and state null.
  // If another poll already waits on this watch, this one is held busyMs and turned away
  // with busy: true. The wait is here, not in the card, so an older card that doesn't know
  // busy can't spin on it.
  async next(id: string, cap: string, timeoutMs: number): Promise<{ events: WakeEvent[]; state: WatchState | null; busy?: true }> {
    const w = this.watches.get(id);
    if (!w || w.cap !== cap) return { events: [], state: null };
    w.polledAt = this.now();
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
      this.end(id, `reached its ${cur.maxRounds} rounds`);
    }
    this.persist();
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
    this.persist();
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
    this.persist();
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
    const coordination = w.queue.filter(e => e.objective);
    if (coordination.length) {
      const key = `${w.machine}|${w.lease}`;
      this.retainHeld(key, [...(this.held.get(key) ?? []), ...coordination]);
    }
    w.queue = [];
    for (const wake of w.waiters.splice(0)) wake();
  }

  // Ended watches stay an hour after ending, so a card asking again hears why; expired ones end.
  private sweep() {
    const t = this.now();
    for (const [id, w] of this.watches) {
      if (!w.stopped && w.expires <= t) this.end(id, "expired");
      else if (!w.stopped && w.idleUntil <= t) this.end(id, "idle for " + IDLE_MS / 60_000 + " minutes: link again when you send an agent work");
      if (w.stopped && w.endedAt !== null && w.endedAt + 3600_000 <= t) this.watches.delete(id);
    }
  }
}

export const inbox = new Inbox(Date.now, 30_000, console.log);
