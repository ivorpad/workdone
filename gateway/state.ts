// Small JSON files in the gateway's state directory: which panes, tabs and workspaces
// the bridge created, and which agents to report on when they finish or need the owner.
// Also the audit log, and the lock that keeps two processes from answering one menu.

import { appendFileSync, closeSync, mkdirSync, openSync, readSync, statSync } from "node:fs";
import { STATE_FILES, readState, recoverState, commitState } from "./state-journal.ts";
import { tryLock } from "./state-lock.ts";
import { randomUUID } from "node:crypto";
import type { Report, TurnResult } from "./watcher.ts";
import { normalizeStore, type CoordStore } from "./coord.ts";
import { resolve } from "node:path";

// disposable: panes spawned with disposable: true, which close without the owner's go-ahead.
export type CreatedKind = "panes" | "tabs" | "workspaces" | "disposable";

// A watched agent, keyed by pane ID. prompt_agent watches one turn: the entry goes
// once that turn is reported. A managed entry (watch_agent, or an agent started
// through the bridge) reports every turn and stays until the agent exits.
export interface Told {
  pane_id: string | null;
  text: string;
  at: string;
  event_id?: string;
  // "owner": typed by the owner in the WorkDone console (owner_note), not by an agent.
  origin?: "owner";
  objective?: string;
  recipient_lease?: string;
  transition?: { task: string; seq: number; kind: string };
}

// Something an agent told the owner, kept on the gateway so it outlives any chat card or
// console page: a tell, a turn that ended, an exit, a question, or the result of a reply: true request. Identity is kept
// with it (which agent, its session, its task) so a later pane reuse can't be mistaken for it.
export interface InboxEntry {
  id: string;
  // tell: an agent wrote to the owner. result: the answer to a reply: true request. finished, gone,
  // question: a watched agent's turn ended, it exited, or it stopped asking something.
  kind: "tell" | "result" | "finished" | "gone" | "question";
  at: string;
  pane_id: string | null;
  agent: string | null;
  agent_kind: string | null;
  cwd: string | null;
  session: string | null;
  // The ChatGPT thread that held the agent when it was said (its whole lease; views show the tail).
  lease: string | null;
  task: { objective: string; id: string } | null;
  text: string;
  result?: TurnResult;
  // unanswered until someone sends the agent a follow-up (prompt, steer or nudge) or the owner dismisses it.
  status: "unanswered" | "answered" | "dismissed";
  resolved_at?: string;
  resolved_by?: string;
}

const INBOX_MAX = 500;
const INBOX_KEEP_MS = 14 * 24 * 3600_000;

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
  // The last result resolved for this agent, for a caller whose event never showed.
  last_result?: TurnResult;
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
  // Metadata revision and substantive progress are distinct: shared-repo HEAD
  // changes do not establish progress for an individual coordination task.
  task_version?: number;
  task_progress?: number;
  task_identity?: { objective: string; id: string; binding: string };
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

  private staged: Map<string, unknown> | null = null;

  private read(file: string): unknown {
    if (!this.staged) return this.locked(() => this.read(file));
    return this.staged.has(file) ? this.staged.get(file) : readState(this.dir, file);
  }

  private write(file: string, value: unknown): void {
    if (!this.staged) return this.locked(() => this.write(file, value));
    this.staged.set(file, JSON.parse(JSON.stringify(value)));
  }

  // Synchronous state changes and their notifications share one commit. Nested
  // helpers reuse the transaction. Never hold it over Herdr/network calls.
  transaction<T>(fn: () => T): T { return this.locked(fn); }

  outbox(): Report[] { return (this.read("outbox.json") as Report[] | undefined) ?? []; }

  enqueueReports(reports: Report[]) {
    this.locked(() => {
      const queued = this.outbox();
      const ids = new Set(queued.map(r => r.event_id));
      for (const report of reports) {
        if (!report.event_id) throw new Error("Outbox reports require a stable event ID");
        if (!ids.has(report.event_id)) { queued.push(report); ids.add(report.event_id); }
      }
      if (queued.length > 10_000) throw new Error("Gateway outbox limit reached; acknowledge intake before consuming more state");
      this.write("outbox.json", queued);
    });
  }

  acknowledgeReports(ids: string[]) {
    this.locked(() => {
      const acknowledged = new Set(ids);
      const queued = this.outbox();
      const remaining = queued.filter(r => !acknowledged.has(r.event_id!));
      if (remaining.length !== queued.length) this.write("outbox.json", remaining);
    });
  }

  created(kind: CreatedKind): string[] {
    const v = this.read(`created-${kind}.json`);
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  }

  remember(kind: CreatedKind, id: string) {
    this.locked(() => this.write(`created-${kind}.json`, [...this.created(kind).filter((x) => x !== id), id].slice(-200)));
  }

  forget(kind: CreatedKind, id: string) {
    this.locked(() => this.write(`created-${kind}.json`, this.created(kind).filter((x) => x !== id)));
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
      if (m.event_id && cur.some(t => t.event_id === m.event_id)) return;
      if (cur.length >= 10_000) throw new Error("Gateway told queue limit reached");
      this.write("told.json", [...cur, { ...m, event_id: m.event_id ?? randomUUID() }]);
    });
  }

  told(): Told[] { return (this.read("told.json") as Told[] | undefined) ?? []; }

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

  inbox(): InboxEntry[] { return (this.read("inbox.json") as InboxEntry[] | undefined) ?? []; }

  hasOpenInbox(): boolean { return this.inbox().some((e) => e.status === "unanswered"); }

  // Idempotent by id. Old resolved entries age out and the list is capped, resolved ones first.
  inboxAdd(entry: InboxEntry, now = Date.now()) {
    this.locked(() => {
      const cur = this.inbox();
      if (cur.some((e) => e.id === entry.id)) return;
      let next = [...cur, entry].filter((e) => e.status === "unanswered" || now - Date.parse(e.resolved_at ?? e.at) < INBOX_KEEP_MS);
      while (next.length > INBOX_MAX) {
        const drop = next.findIndex((e) => e.status !== "unanswered");
        next.splice(drop === -1 ? 0 : drop, 1);
      }
      this.write("inbox.json", next);
    });
  }

  // Marks unanswered entries resolved, by id or for every entry of one agent (pane id or
  // name, as a prompt's target may be either). Returns how many changed.
  inboxResolve(match: { id?: string; target?: string }, status: "answered" | "dismissed", by: string, now = new Date()): number {
    return this.locked(() => {
      let n = 0;
      const next = this.inbox().map((e) => {
        const hit = e.status === "unanswered" && ((match.id !== undefined && e.id === match.id) || (match.target !== undefined && (e.pane_id === match.target || (e.agent !== null && e.agent === match.target))));
        if (!hit) return e;
        n++;
        return { ...e, status, resolved_at: now.toISOString(), resolved_by: by };
      });
      if (n) this.write("inbox.json", next);
      return n;
    });
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

  // Fail closed on contention or invalid state. Legacy JSON stays readable, and
  // only ENOENT initializes it. Recovery finishes an interrupted committed journal.
  private locked<T>(fn: () => T): T {
    if (this.staged) return fn();
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const lock = resolve(this.dir, "watch.lock");
    let release: (() => void) | null = null;
    const deadline = Date.now() + 3000;
    do {
      release = tryLock(lock);
      if (!release) Bun.sleepSync(10);
    } while (!release && Date.now() < deadline);
    if (!release) throw new Error("Gateway state lock is held; refusing mutation");
    try {
      recoverState(this.dir);
      // Validate the canonical store before any write, including sibling files.
      for (const file of STATE_FILES) readState(this.dir, file);
      this.staged = new Map();
      const out = fn();
      if (out instanceof Promise) throw new Error("State transactions must be synchronous");
      commitState(this.dir, this.staged);
      return out;
    } finally {
      this.staged = null;
      release();
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
        last_result: cur?.last_result,
      };
      for (const k of ["launch", "role", "result_request", "last_result", "reply_to", "last_event", "dialog_id", "prompted_at"] as const) if (entry[k] === undefined) delete entry[k];
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
      const { result_request: req, ...rest } = cur;
      // The thread was owed this result only: its next turn is nobody's reply.
      if (req.lease && rest.reply_to === req.lease) delete rest.reply_to;
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

  // Canonical coordination state (coord.ts). Tasks outlive agents, so unwatch leaves
  // them alone.
  coord(): CoordStore {
    return normalizeStore(this.read("coord.json"));
  }

  updateCoord<T>(fn: (c: CoordStore) => T): T {
    return this.locked(() => {
      const c = this.coord();
      const before = JSON.stringify(c);
      const out = fn(c);
      if (JSON.stringify(c) !== before) this.write("coord.json", c);
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

  // The agent in this pane is gone: its history must not judge the next one.
  clearSupervision(paneIds: string[]) {
    if (!paneIds.length) return;
    this.locked(() => {
      const sup = this.supervision();
      if (!paneIds.some((id) => sup[id])) return;
      for (const id of paneIds) delete sup[id];
      this.write("supervisor.json", sup);
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

  // Menu locks use the same owner checks; age never authorizes a second answer.
  async withPane<T>(paneId: string, waitMs: number, fn: () => Promise<T>): Promise<T | null> {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const lock = resolve(this.dir, `answer-${paneId.replace(/[^A-Za-z0-9_.-]/g, "_")}.lock`);
    const deadline = Date.now() + waitMs;
    let release: (() => void) | null;
    while (!(release = tryLock(lock))) {
      if (Date.now() >= deadline) return null;
      await Bun.sleep(Math.min(100, Math.max(1, deadline - Date.now())));
    }
    try { return await fn(); } finally { release(); }
  }

  // The newest n audit lines, oldest first. Reads only the file's tail.
  // ops, when given, keeps only those ops, before the newest n are taken.
  auditTail(n: number, ops?: string[]): Array<Record<string, unknown>> {
    try {
      const file = resolve(this.dir, "audit.jsonl");
      const size = statSync(file).size;
      const len = Math.min(size, 256 * 1024);
      const fd = openSync(file, "r");
      const buf = Buffer.alloc(len);
      try { readSync(fd, buf, 0, len, size - len); } finally { closeSync(fd); }
      const lines = buf.toString("utf8").split("\n").filter(Boolean);
      // A tail read can start mid-line: that first fragment is dropped.
      if (size > len) lines.shift();
      const want = ops ? new Set(ops) : null;
      const out: Array<Record<string, unknown>> = [];
      for (const l of lines) {
        try {
          const e = JSON.parse(l);
          if (!want || want.has(e?.op)) out.push(e);
        } catch { /* a torn line */ }
      }
      return out.slice(-n);
    } catch {
      return [];
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
