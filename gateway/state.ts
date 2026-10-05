// Small JSON files in the gateway's state directory: which panes, tabs and workspaces
// the bridge created, and which agents to report on when they finish or need the owner.
// Also the audit log, and the lock that keeps two processes from answering one menu.

import { appendFileSync, mkdirSync, readFileSync, renameSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

export type CreatedKind = "panes" | "tabs" | "workspaces";

// A watched agent, keyed by pane ID. prompt_agent watches one turn: the entry goes
// once that turn is reported. A managed entry (watch_agent, or an agent started
// through the bridge) reports every turn and stays until the agent exits.
export interface Told {
  pane_id: string;
  text: string;
  at: string;
}

export interface Watched {
  name: string | null;
  cwd: string | null;
  since: string;
  last_status?: string;
  kind?: string | null;
  managed?: boolean;
  // Managed only: a turn is running that has not been reported yet, and when
  // prompt_agent started it without waiting for the answer.
  busy?: boolean;
  prompted_at?: string;
  // Herdr's state_change_seq when last seen: it moves on every status change, so a
  // turn shorter than the poll interval still shows. session is its session ID.
  seq?: number;
  session?: string | null;
  // New on every write outside the poller, so a poll that read the entry earlier can
  // tell that its decision about it is out of date.
  rev?: string;
  last_event?: { type: string; at: string; excerpt: string | null };
  // Menu identity, independent of Herdr's status (some permission UIs read idle).
  dialog_id?: string;
  // A ChatGPT thread (its lease) prompted or steered this agent and did not wait: the
  // turn's end is that thread's reply, reported once with reply_to so it can be woken.
  reply_to?: string;
  // What WorkDone launched here (spawn_agent, start_agent): model and effective effort.
  launch?: Launch;
  // A reviewer's stalls go back to its coordinator; it is never nudged.
  role?: "worker" | "reviewer";
  // A caller asked for this agent's next final result (reply: true). Resolved once, by
  // the first finished turn or the agent's exit; a question or menu leaves it pending.
  result_request?: ResultRequest;
}

export interface ResultRequest {
  id: string;
  at: string;
  lease: string | null;
}

// The model and effort an agent was started with, and where each came from.
export interface Launch {
  kind: string;
  model: string | null;
  model_id: string | null;
  effort: string | null;
  model_source: "requested" | "default" | "cli_default";
  effort_source: "requested" | "model_default" | "none";
}

export type WatchInfo = Pick<Watched, "name" | "cwd" | "kind"> & Pick<Watched, "launch" | "role">;

// Checkpoint evidence the supervisor compares between turns (see checkpoint.ts).
export interface TurnRecord {
  turn: string;
  at: string;
  session: string | null;
  status: string;
  commit?: string;
  tree?: string;
  diff?: string;
  clean?: boolean;
  changed?: number;
  ahead?: number | null;
  upstream?: string | null;
  // Digest of the turn's final text, to tell the same answer repeated.
  activity?: string;
}

export interface Supervision {
  // Where the agent started from: a commit beyond it is work that landed.
  baseline?: { at: string; session: string | null; commit?: string; clean?: boolean };
  turns: TurnRecord[];
  // supervisor_nudge sends at most one per agent session.
  nudges: Array<{ at: string; session: string | null; after_turn: string | null }>;
}

const MAX_TURNS = 12;

// A ChatGPT thread's authorized panes. The thread keeps the ID and passes it on every
// call that acts on an agent or pane; used is when it last did.
export interface Lease {
  label: string;
  panes: string[];
  created: string;
  used: string;
  approvals?: Record<string, ApprovalPolicy>;
}

export interface ApprovalPolicy {
  mode: "ask" | "permissions" | "all_permissions";
  expires_at: string;
  kind: string | null;
  session: string | null;
  watch_since: string;
}

// What a Herdr agent object says about the fields the watcher compares.
export function seenState(a: any): Pick<Watched, "last_status" | "seq" | "session"> {
  const out: Pick<Watched, "last_status" | "seq" | "session"> = { last_status: a?.agent_status ?? "unknown" };
  if (typeof a?.state_change_seq === "number") out.seq = a.state_change_seq;
  if (typeof a?.agent_session?.value === "string") out.session = a.agent_session.value;
  return out;
}

const newRev = () => Math.random().toString(36).slice(2, 10);

export class StateStore {
  constructor(private dir: string) {}

  private read(file: string): unknown {
    try {
      return JSON.parse(readFileSync(resolve(this.dir, file), "utf8"));
    } catch {
      return undefined;
    }
  }

  private write(file: string, value: unknown) {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const path = resolve(this.dir, file);
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
    renameSync(tmp, path);
  }

  created(kind: CreatedKind): string[] {
    const v = this.read(`created-${kind}.json`);
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  }

  remember(kind: CreatedKind, id: string) {
    this.write(`created-${kind}.json`, [...this.created(kind).filter((x) => x !== id), id].slice(-200));
  }

  forget(kind: CreatedKind, id: string) {
    this.write(`created-${kind}.json`, this.created(kind).filter((x) => x !== id));
  }

  // The workspace pane exec opens its tabs in.
  execWorkspace(): string | null {
    const v = this.read("exec-workspace.json") as { id?: unknown } | undefined;
    return typeof v?.id === "string" ? v.id : null;
  }

  setExecWorkspace(id: string) {
    this.write("exec-workspace.json", { id });
  }

  // Messages agents sent their ChatGPT thread with tell, waiting for the next watch pass.
  addTold(m: Told) {
    this.locked(() => {
      const v = this.read("told.json");
      const cur = Array.isArray(v) ? (v as Told[]) : [];
      this.write("told.json", [...cur, m].slice(-50));
    });
  }

  takeTold(): Told[] {
    return this.locked(() => {
      const v = this.read("told.json");
      const cur = Array.isArray(v) ? (v as Told[]) : [];
      if (cur.length) this.write("told.json", []);
      return cur;
    });
  }

  hasTold(): boolean {
    const v = this.read("told.json");
    return Array.isArray(v) && v.length > 0;
  }

  // Which ChatGPT thread may act on which panes: lease ID to its label and panes.
  leases(): Record<string, Lease> {
    const v = this.read("leases.json");
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, Lease>) : {};
  }

  // Read, change and write leases.json under the same lock as watch.json.
  updateLeases<T>(fn: (l: Record<string, Lease>) => T): T {
    return this.locked(() => {
      const l = this.leases();
      const before = JSON.stringify(l);
      const out = fn(l);
      if (JSON.stringify(l) !== before) this.write("leases.json", l);
      return out;
    });
  }

  watched(): Record<string, Watched> {
    const v = this.read("watch.json");
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, Watched>) : {};
  }

  // Read, change and write watch.json while holding its lock. Every op runs in its own
  // process, so two watch_agent calls, or a prompt and a poll, can overlap. Writes
  // only when fn changed something.
  updateWatched<T>(fn: (w: Record<string, Watched>) => T): T {
    return this.locked(() => {
      const w = this.watched();
      const before = JSON.stringify(w);
      const out = fn(w);
      if (JSON.stringify(w) !== before) this.write("watch.json", w);
      return out;
    });
  }

  // A directory as the lock: mkdir either creates it or fails. The lock is held for a
  // read and a write. One older than 10 s was left by a process that died holding it;
  // after 3 s of waiting the caller goes ahead without it rather than fail the op.
  private locked<T>(fn: () => T): T {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const lock = resolve(this.dir, "watch.lock");
    let held = false;
    for (const deadline = Date.now() + 3000; !held && Date.now() < deadline; ) {
      try {
        mkdirSync(lock);
        held = true;
      } catch (err: any) {
        if (err?.code !== "EEXIST") break;
        try {
          if (Date.now() - statSync(lock).mtimeMs > 10_000) rmdirSync(lock);
        } catch {
          // gone already
        }
        Bun.sleepSync(10);
      }
    }
    try {
      return fn();
    } finally {
      if (held) rmdirSync(lock);
    }
  }

  // After prompt_agent. settled is the agent it returned when it waited for the answer,
  // else null; agent is what Herdr reported right after the prompt went in. The caller
  // already has a settled answer, so it is not reported again; a managed agent stays
  // watched either way.
  prompted(paneId: string, info: WatchInfo, agent: any, settled: boolean) {
    const now = new Date().toISOString();
    const seq = seenState(agent).seq;
    this.updateWatched((w) => {
      const cur = w[paneId];
      // A result asked for before the prompt went in belongs to this turn.
      const asked = cur?.result_request ? { result_request: cur.result_request, ...(cur.reply_to ? { reply_to: cur.reply_to } : {}) } : {};
      if (cur?.managed) {
        const status = agent?.agent_status;
        w[paneId] = settled
          ? { ...cur, last_status: status, seq, busy: status === "blocked", prompted_at: undefined, rev: newRev() }
          : { ...cur, seq, busy: true, prompted_at: now, rev: newRev() };
      } else if (settled) {
        delete w[paneId];
      } else {
        w[paneId] = { ...info, since: now, seq, ...asked, rev: newRev() };
      }
    });
  }

  // Report every turn of this agent from now on. A turn already running counts, and
  // so does one prompt_agent is watching that has not been reported yet. A dialog
  // already up is not reported: the caller sees the status. fresh replaces whatever
  // the pane had, for an agent that was just started there.
  manage(paneId: string, info: WatchInfo, agent: any, fresh = false): Watched {
    return this.updateWatched((w) => {
      const cur = fresh ? undefined : w[paneId];
      const seen = seenState(agent);
      const pending = cur ? (cur.managed ? cur.busy === true : true) : false;
      const entry: Watched = {
        ...info,
        since: cur?.managed ? cur.since : new Date().toISOString(),
        ...seen,
        managed: true,
        busy: seen.last_status === "working" || pending,
        prompted_at: cur ? (cur.managed ? cur.prompted_at : cur.since) : undefined,
        rev: newRev(),
        last_event: cur?.last_event,
        dialog_id: cur?.dialog_id,
        reply_to: cur?.reply_to,
        launch: info.launch ?? cur?.launch,
        role: info.role ?? cur?.role,
        result_request: cur?.result_request,
      };
      for (const k of ["launch", "role", "result_request", "reply_to", "last_event", "dialog_id", "prompted_at"] as const) if (entry[k] === undefined) delete entry[k];
      w[paneId] = entry;
      return entry;
    });
  }

  // prompt_agent or steer_agent from a thread that didn't wait for the answer: the end of
  // this turn is owed to that thread. An agent nobody watched is watched for this turn.
  owe(paneId: string, lease: string, info: WatchInfo, agent: any) {
    this.updateWatched((w) => {
      const cur = w[paneId] ?? { ...info, since: new Date().toISOString(), ...seenState(agent) };
      w[paneId] = { ...cur, reply_to: lease, rev: newRev() };
    });
  }

  // reply: true. The next final result of this agent is owed to the caller (and its
  // thread, for the fallback card). One request at a time: asking again while one is
  // pending returns it rather than queueing a second wake.
  requestResult(paneId: string, info: WatchInfo, agent: any, lease: string | null): { result_id: string; already_pending: boolean } {
    return this.updateWatched((w) => {
      const cur = w[paneId] ?? { ...info, since: new Date().toISOString(), ...seenState(agent) };
      if (cur.result_request) return { result_id: cur.result_request.id, already_pending: true };
      const id = `res_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
      w[paneId] = { ...cur, result_request: { id, at: new Date().toISOString(), lease }, ...(lease ? { reply_to: lease } : {}), rev: newRev() };
      return { result_id: id, already_pending: false };
    });
  }

  // The caller got the result inline after all, or the prompt never went in.
  dropResult(paneId: string, id: string) {
    this.updateWatched((w) => {
      const cur = w[paneId];
      if (cur?.result_request?.id !== id) return;
      const { result_request: _, ...rest } = cur;
      w[paneId] = { ...rest, rev: newRev() };
    });
  }

  supervision(): Record<string, Supervision> {
    const v = this.read("supervisor.json");
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, Supervision>) : {};
  }

  private updateSupervision<T>(paneId: string, fn: (s: Supervision) => T): T {
    return this.locked(() => {
      const all = this.supervision();
      const s = all[paneId] ?? { turns: [], nudges: [] };
      const out = fn(s);
      all[paneId] = { ...s, turns: s.turns.slice(-MAX_TURNS), nudges: s.nudges.slice(-MAX_TURNS) };
      this.write("supervisor.json", all);
      return out;
    });
  }

  // A fresh agent in this pane: its history starts over from here.
  setBaseline(paneId: string, baseline: NonNullable<Supervision["baseline"]>) {
    this.locked(() => {
      const all = this.supervision();
      all[paneId] = { baseline, turns: [], nudges: [] };
      this.write("supervisor.json", all);
    });
  }

  recordTurn(paneId: string, turn: TurnRecord) {
    this.updateSupervision(paneId, (s) => {
      if (!s.turns.some((t) => t.turn === turn.turn)) s.turns.push(turn);
    });
  }

  // The one nudge for a session: false when that session already had it.
  recordNudge(paneId: string, session: string | null): boolean {
    return this.updateSupervision(paneId, (s) => {
      if (s.nudges.some((n) => n.session === session)) return false;
      s.nudges.push({ at: new Date().toISOString(), session, after_turn: s.turns.at(-1)?.turn ?? null });
      return true;
    });
  }

  unwatch(paneId: string) {
    this.locked(() => {
      // Rewatching within the same clock tick must not revive an old policy.
      const leases = this.leases();
      let changed = false;
      for (const lease of Object.values(leases)) {
        if (lease.approvals?.[paneId]) { delete lease.approvals[paneId]; changed = true; }
      }
      if (changed) this.write("leases.json", leases);
      const watched = this.watched();
      if (watched[paneId]) { delete watched[paneId]; this.write("watch.json", watched); }
      const sup = this.supervision();
      if (sup[paneId]) { delete sup[paneId]; this.write("supervisor.json", sup); }
    });
  }

  // One process at a time answers a pane's menu: the notifier's poll and a tool call
  // can find the same menu, and keys pressed twice land in whatever the agent shows
  // next. null when another process still holds the pane after waitMs. A lock older
  // than 60 s was left by a process that died holding it.
  async withPane<T>(paneId: string, waitMs: number, fn: () => Promise<T>): Promise<T | null> {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const lock = resolve(this.dir, `answer-${paneId.replace(/[^A-Za-z0-9_.-]/g, "_")}.lock`);
    let held = false;
    for (const deadline = Date.now() + waitMs; !held; ) {
      try {
        mkdirSync(lock);
        held = true;
      } catch (err: any) {
        if (err?.code !== "EEXIST") break;
        let gone = false;
        try {
          if (Date.now() - statSync(lock).mtimeMs > 60_000) {
            rmdirSync(lock);
            gone = true;
          }
        } catch {
          gone = true;
        }
        if (gone) continue;
        if (Date.now() >= deadline) return null;
        await Bun.sleep(100);
      }
    }
    try {
      return await fn();
    } finally {
      if (held) rmdirSync(lock);
    }
  }

  audit(entry: Record<string, unknown>) {
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      const line = { ts: new Date().toISOString(), client: process.env.SSH_CLIENT?.split(" ")[0] ?? "local", ...entry };
      appendFileSync(resolve(this.dir, "audit.jsonl"), JSON.stringify(line) + "\n", { mode: 0o600 });
    } catch {
      // Auditing must never break a request.
    }
  }
}
