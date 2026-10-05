// Canonical coordination state (docs/coordination.md): objectives, their tasks, bindings
// of a task to one agent run, a transition log the supervisor acknowledges, and the
// machine's scarce resources. Opt-in: an agent with no binding never sees any of it.
//
// Functions change the store in place. The caller runs them inside
// StateStore.updateCoord, which writes only when the function returns, so a refused
// write leaves nothing behind.

import { createHash, timingSafeEqual } from "node:crypto";
import { GatewayError } from "./config.ts";

export const TASK_STATUSES = ["queued", "executing", "waiting_dependency", "verifying", "blocked", "complete"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
// What a worker may say about its own task. complete is the supervisor's merge.
export const WORKER_STATUSES = ["executing", "waiting_dependency", "verifying", "blocked"] as const;
export const BLOCKER_KINDS = ["dependency", "resource", "defect", "human"] as const;
export type BlockerKind = (typeof BLOCKER_KINDS)[number];
export type TransitionKind = "ready" | "needs_acceptance" | "blocked_human" | "missing_report" | "worker_gone" | "resource_stale";

export const TASK_ID_RE = /^[#A-Za-z0-9][\w.#-]{0,63}$/;
export const OBJECTIVE_ID_RE = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
const RESOURCE_RE = /^[a-z0-9][a-z0-9_.:-]{0,63}$/;
const OWNER_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const REPORT_ID_RE = /^[\w.:-]{1,80}$/;
export const TOKEN_RE = /^wdt_[A-Za-z0-9_-]{20,80}$/;
const MAX_TASKS = 100;
const MAX_LIST = 50;
const MAX_TEXT = 1000;
const MAX_TRANSITIONS = 200;

export interface TaskResult { summary: string; commit: string | null; at: string }

// A task's tie to one agent run. The token is kept (the state directory is private, as
// for leases) so every prompt's slice can repeat it; checks compare its hash.
export interface Binding {
  id: string;
  token: string;
  token_hash: string;
  pane_id: string;
  session: string | null;
  generation: number;
  issued_at: string;
  prompted_at: string | null;
  last_report_at: string | null;
}

export interface Task {
  id: string;
  title: string;
  status: TaskStatus;
  // The agent by name, as planned; pane_id once that agent was seen or bound.
  owner: { name: string; pane_id: string | null } | null;
  deps: string[];
  acceptance: string[];
  evidence: string[];
  artifacts: string[];
  blocker: string | null;
  blocker_kind: BlockerKind | null;
  // Resources this task waits for: their release makes it ready.
  waiting_for: string[];
  next_action: string | null;
  result: TaskResult | null;
  // A bound run ended without reporting: recoverable, never complete.
  protocol: "missing_report" | "worker_gone" | null;
  binding: Binding | null;
  // Every binding of this task increments it, so an old token can't write.
  generation: number;
  report_ids: string[];
  version: number;
  created_at: string;
  updated_at: string;
}

export interface Transition { seq: number; at: string; task: string; kind: TransitionKind; detail: string | null }

export interface Objective {
  id: string;
  title: string;
  repo: string | null;
  // The thread that plans and merges (its lease); null with leases off.
  supervisor: string | null;
  tasks: Record<string, Task>;
  transitions: Transition[];
  next_seq: number;
  acked_seq: number;
  version: number;
  created_at: string;
  updated_at: string;
}

// One machine's resources, across objectives: a browser port is one port.
export interface ResourceLease {
  objective: string;
  task: string;
  pane_id: string | null;
  session: string | null;
  generation: number;
  acquired_at: string;
  renewed_at: string;
  // Its holder went away. Not free: the old process may still use it.
  stale_since: string | null;
}

export interface CoordStore {
  version: 2;
  objectives: Record<string, Objective>;
  resources: Record<string, ResourceLease>;
  resource_generations: Record<string, number>;
}

export const emptyStore = (): CoordStore => ({ version: 2, objectives: {}, resources: {}, resource_generations: {} });

export function normalizeStore(raw: unknown): CoordStore {
  const v = raw as any;
  if (v && v.version === 2 && v.objectives && typeof v.objectives === "object") {
    return { version: 2, objectives: v.objectives, resources: v.resources ?? {}, resource_generations: v.resource_generations ?? {} };
  }
  return emptyStore();
}

const fail = (code: string, message: string): never => { throw new GatewayError(code, message); };
export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

function text(v: unknown, what: string, max = MAX_TEXT): string {
  if (typeof v !== "string" || !v.trim() || v.length > max) fail("invalid_params", `${what} must be a non-empty string of at most ${max} characters`);
  return (v as string).trim();
}
const textOrNull = (v: unknown, what: string) => (v === null ? null : text(v, what));
function list(v: unknown, what: string, re?: RegExp): string[] {
  if (!Array.isArray(v) || v.length > MAX_LIST) fail("invalid_params", `${what} must be a list of at most ${MAX_LIST} strings`);
  return (v as unknown[]).map((x) => {
    const s = text(x, what, re ? 64 : MAX_TEXT);
    if (re && !re.test(s)) fail("invalid_params", `${what}: ${s} is not a valid id`);
    return s;
  });
}
function status(v: unknown, allowed: readonly string[], who: string): TaskStatus {
  if (typeof v !== "string" || !allowed.includes(v)) {
    fail(who === "worker" && v === "complete" ? "not_allowed" : "invalid_params",
      `${who} status must be one of ${allowed.join(", ")}${v === "complete" && who === "worker" ? "; complete is the supervisor's merge: publish result instead" : ""}`);
  }
  return v as TaskStatus;
}
function kind(v: unknown): BlockerKind | null {
  if (v === null) return null;
  if (typeof v !== "string" || !(BLOCKER_KINDS as readonly string[]).includes(v)) fail("invalid_params", `blocker_kind must be one of ${BLOCKER_KINDS.join(", ")}`);
  return v as BlockerKind;
}
// Appends, keeping order and dropping repeats, so a retried report changes nothing.
const merge = (cur: string[], add: string[]) => [...cur, ...add.filter((x) => !cur.includes(x))].slice(-MAX_LIST);

export function getObjective(store: CoordStore, id: string): Objective {
  return store.objectives[id] ?? fail("unknown_objective", `no objective ${id} on this machine`);
}

export function ensureObjective(store: CoordStore, id: string, title: string | undefined, now: string): Objective {
  if (!OBJECTIVE_ID_RE.test(id)) fail("invalid_params", "objective must be a short lowercase id, e.g. relay-pwc");
  return store.objectives[id] ??= {
    id, title: title ? text(title, "title", 200) : id, repo: null, supervisor: null, tasks: {},
    transitions: [], next_seq: 1, acked_seq: 0, version: 0, created_at: now, updated_at: now,
  };
}

function newTask(id: string, now: string): Task {
  return {
    id, title: "", status: "queued", owner: null, deps: [], acceptance: [], evidence: [], artifacts: [],
    blocker: null, blocker_kind: null, waiting_for: [], next_action: null, result: null, protocol: null,
    binding: null, generation: 0, report_ids: [], version: 0, created_at: now, updated_at: now,
  };
}

function touchTask(o: Objective, t: Task, now: string) {
  t.version++;
  t.updated_at = now;
  o.version++;
  o.updated_at = now;
}

// One transition per task and kind until the supervisor acknowledges it, so a retried
// pass or a second report never surfaces the same readiness twice.
function transition(o: Objective, task: string, k: TransitionKind, detail: string | null, now: string): Transition | null {
  if (o.transitions.some((x) => x.seq > o.acked_seq && x.task === task && x.kind === k)) return null;
  const tr = { seq: o.next_seq++, at: now, task, kind: k, detail };
  o.transitions = [...o.transitions, tr].slice(-MAX_TRANSITIONS);
  return tr;
}

export interface Change { objective: string; transitions: Transition[] }

// Dependencies form a DAG over this objective's tasks.
function checkGraph(tasks: Record<string, Task>) {
  for (const t of Object.values(tasks)) for (const d of t.deps) if (!tasks[d]) fail("unknown_dependency", `${t.id} depends on ${d}, which is not a task of this objective`);
  const state = new Map<string, 1 | 2>();
  const visit = (id: string, path: string[]) => {
    if (state.get(id) === 2) return;
    if (state.get(id) === 1) fail("dependency_cycle", `dependency cycle: ${[...path, id].join(" -> ")}`);
    state.set(id, 1);
    for (const d of tasks[id]!.deps) visit(d, [...path, id]);
    state.set(id, 2);
  };
  for (const id of Object.keys(tasks)) visit(id, []);
}

function freeHeldBy(store: CoordStore, objective: string, task: string) {
  for (const [r, l] of Object.entries(store.resources)) if (l.objective === objective && l.task === task) delete store.resources[r];
}

// Waits whose prerequisite cleared: dependencies all complete, or every awaited resource
// free. Each goes back to queued with one ready transition.
function propagateReady(store: CoordStore, now: string): Transition[] {
  const out: Transition[] = [];
  for (const o of Object.values(store.objectives)) {
    for (const t of Object.values(o.tasks)) {
      if (t.status !== "waiting_dependency") continue;
      const depsDone = t.deps.every((d) => o.tasks[d]?.status === "complete");
      const resourcesFree = t.waiting_for.every((r) => !store.resources[r]);
      const k = t.blocker_kind;
      const cleared = k === "resource" ? t.waiting_for.length > 0 && resourcesFree && depsDone
        : (k === "dependency" || k === null) && t.deps.length > 0 && depsDone && resourcesFree;
      if (!cleared) continue;
      t.status = "queued";
      t.blocker = null;
      t.blocker_kind = null;
      t.waiting_for = [];
      touchTask(o, t, now);
      const tr = transition(o, t.id, "ready", t.next_action, now);
      if (tr) out.push(tr);
    }
  }
  return out;
}

function grant(store: CoordStore, r: string, objective: string, t: Task, now: string) {
  const held = store.resources[r];
  if (held && held.objective === objective && held.task === t.id && !held.stale_since) { held.renewed_at = now; return; }
  const generation = (store.resource_generations[r] ?? 0) + 1;
  store.resource_generations[r] = generation;
  store.resources[r] = {
    objective, task: t.id, pane_id: t.binding?.pane_id ?? t.owner?.pane_id ?? null, session: t.binding?.session ?? null,
    generation, acquired_at: now, renewed_at: now, stale_since: null,
  };
}

export interface TaskPatch {
  id: string;
  title?: string;
  status?: string;
  owner?: string | null;
  deps?: string[];
  acceptance?: string[];
  evidence?: string[];
  artifacts?: string[];
  blocker?: string | null;
  blocker_kind?: string | null;
  next_action?: string | null;
  expected_version?: number;
  remove?: boolean;
}

// The supervisor's plan and merges for one objective. Lists replace, except evidence and
// artifacts, which append. resources maps a name to one of this objective's tasks, or
// null to free it: the explicit reconciliation a stale lease needs.
export function planTasks(store: CoordStore, objectiveId: string, patches: unknown, resources: unknown, now: string): Change {
  const o = getObjective(store, objectiveId);
  if (patches !== undefined && (!Array.isArray(patches) || patches.length > MAX_TASKS)) fail("invalid_params", `tasks must be a list of at most ${MAX_TASKS}`);
  for (const raw of (patches ?? []) as any[]) {
    if (!raw || typeof raw !== "object") fail("invalid_params", "each task must be an object");
    const id = text(raw.id, "task id", 64);
    if (!TASK_ID_RE.test(id)) fail("invalid_params", `task id ${id} is not valid`);
    const cur = o.tasks[id];
    if (raw.expected_version !== undefined && (cur?.version ?? 0) !== raw.expected_version) {
      fail("version_conflict", `task ${id} is at version ${cur?.version ?? 0}, not ${raw.expected_version}: read the snapshot and merge again`);
    }
    if (raw.remove === true) {
      delete o.tasks[id];
      freeHeldBy(store, o.id, id);
      o.version++;
      continue;
    }
    if (!cur && raw.title === undefined) fail("invalid_params", `new task ${id} needs a title`);
    if (!cur && Object.keys(o.tasks).length >= MAX_TASKS) fail("invalid_params", `an objective holds at most ${MAX_TASKS} tasks`);
    const t: Task = cur ?? newTask(id, now);
    if (raw.title !== undefined) t.title = text(raw.title, "title", 200);
    if (raw.status !== undefined) t.status = status(raw.status, TASK_STATUSES, "task");
    if (raw.owner !== undefined) {
      const name = raw.owner === null ? null : text(raw.owner, "owner", 32);
      if (name !== null && !OWNER_RE.test(name)) fail("invalid_params", "owner is an agent name (lowercase, as spawn_agent named it)");
      if (t.owner?.name !== name) {
        // Reassigned: the old run's token stops working.
        t.owner = name === null ? null : { name, pane_id: null };
        if (t.binding) { t.binding = null; t.generation++; }
        t.protocol = null;
      }
    }
    if (raw.deps !== undefined) t.deps = list(raw.deps, "deps", TASK_ID_RE);
    if (raw.acceptance !== undefined) t.acceptance = list(raw.acceptance, "acceptance");
    if (raw.evidence !== undefined) t.evidence = merge(t.evidence, list(raw.evidence, "evidence"));
    if (raw.artifacts !== undefined) t.artifacts = merge(t.artifacts, list(raw.artifacts, "artifacts"));
    if (raw.blocker !== undefined) t.blocker = textOrNull(raw.blocker, "blocker");
    if (raw.blocker_kind !== undefined) t.blocker_kind = kind(raw.blocker_kind);
    if (raw.next_action !== undefined) t.next_action = textOrNull(raw.next_action, "next_action");
    if (t.status === "complete") {
      t.blocker = null;
      t.blocker_kind = null;
      t.protocol = null;
      t.waiting_for = [];
      freeHeldBy(store, o.id, id);
    }
    o.tasks[id] = t;
    touchTask(o, t, now);
  }
  checkGraph(o.tasks);
  if (resources !== undefined) {
    if (!resources || typeof resources !== "object" || Array.isArray(resources)) fail("invalid_params", "resources maps a resource name to a task id, or null to free it");
    for (const [r, holder] of Object.entries(resources as Record<string, unknown>)) {
      if (!RESOURCE_RE.test(r)) fail("invalid_params", `resource ${r} is not a valid name`);
      const held = store.resources[r];
      // Another objective's live lease is not this supervisor's to take or free.
      if (held && held.objective !== o.id && !held.stale_since) fail("resource_busy", `${r} is held by objective ${held.objective} task ${held.task}`);
      if (holder === null) { delete store.resources[r]; o.version++; continue; }
      const task = o.tasks[text(holder, "resource holder", 64)] ?? fail("unknown_task", `resource ${r}: no task ${String(holder)}`);
      if (held?.stale_since && !(held.objective === o.id && held.task === task.id)) {
        fail("resource_stale", `${r} is held by a run that went away (objective ${held.objective}, task ${held.task}); free it with null first, once that process is surely stopped`);
      }
      grant(store, r, o.id, task, now);
      o.version++;
    }
  }
  const out = propagateReady(store, now);
  o.updated_at = now;
  return { objective: o.id, transitions: out };
}

// Binds a task to one agent run: assigns the pane, bumps the generation (an older token
// stops working) and keeps the new token's hash. The caller makes the token.
export function bindTask(store: CoordStore, objectiveId: string, taskId: string, run: { pane_id: string; session: string | null; name: string | null }, token: string, bindingId: string, now: string): Task {
  const o = getObjective(store, objectiveId);
  const t = o.tasks[taskId] ?? fail("unknown_task", `no task ${taskId} in objective ${objectiveId}`);
  if (t.status === "complete") fail("task_complete", `${taskId} is complete; reopen it with coord_update before binding a run`);
  for (const other of Object.values(store.objectives).flatMap((x) => Object.values(x.tasks))) {
    if (other !== t && other.binding?.pane_id === run.pane_id && other.status !== "complete" && other.status !== "verifying") {
      fail("pane_busy", `${run.pane_id} is bound to task ${other.id}; one current slice per worker: finish, reassign or complete it first`);
    }
  }
  if (!TOKEN_RE.test(token)) fail("invalid_params", "binding token has the wrong shape");
  t.generation++;
  t.binding = { id: bindingId, token, token_hash: hashToken(token), pane_id: run.pane_id, session: run.session, generation: t.generation, issued_at: now, prompted_at: null, last_report_at: null };
  t.owner = { name: run.name && OWNER_RE.test(run.name) ? run.name : t.owner?.name ?? "unnamed", pane_id: run.pane_id };
  t.protocol = null;
  if (t.status === "queued") t.status = "executing";
  touchTask(o, t, now);
  return t;
}

export function notePrompted(store: CoordStore, objectiveId: string, taskId: string, now: string) {
  const t = store.objectives[objectiveId]?.tasks[taskId];
  if (t?.binding) t.binding.prompted_at = now;
}

// The task a token speaks for. Unknown or superseded tokens are stale, without saying
// which task they once named.
export function byToken(store: CoordStore, token: string): { o: Objective; t: Task } {
  if (!TOKEN_RE.test(token)) fail("stale_binding", "that task token is not valid");
  const want = Buffer.from(hashToken(token), "hex");
  for (const o of Object.values(store.objectives)) {
    for (const t of Object.values(o.tasks)) {
      if (!t.binding) continue;
      const have = Buffer.from(t.binding.token_hash, "hex");
      if (have.length === want.length && timingSafeEqual(have, want)) return { o, t };
    }
  }
  return fail("stale_binding", "that task token is no longer valid: the task was reassigned, rebound or removed");
}

// The tasks a pane owns: bound to it, or planned for its agent's name.
export function ownedBy(o: Objective, paneId: string, name: string | null): Task[] {
  return Object.values(o.tasks).filter((t) => t.binding ? t.binding.pane_id === paneId
    : t.owner && (t.owner.pane_id ? t.owner.pane_id === paneId : t.owner.name === name));
}

export interface WorkerReport {
  report_id?: string;
  status?: string;
  evidence?: string[];
  artifacts?: string[];
  blocker?: string | null;
  blocker_kind?: string | null;
  wait_for?: string[];
  next_action?: string | null;
  result?: { summary: string; commit?: string | null };
  acquire?: string[];
  release?: string[];
}
const WORKER_FIELDS = new Set(["report_id", "status", "evidence", "artifacts", "blocker", "blocker_kind", "wait_for", "next_action", "result", "acquire", "release"]);

// One worker's delta to its own task. Never owner, deps, acceptance, title, complete, or
// a resource another run holds. A repeated report_id changes nothing.
export function reportTask(store: CoordStore, objectiveId: string, taskId: string, raw: WorkerReport, now: string): Change & { duplicate: boolean } {
  const o = getObjective(store, objectiveId);
  const t = o.tasks[taskId] ?? fail("unknown_task", `no task ${taskId} in objective ${objectiveId}`);
  for (const k of Object.keys(raw)) if (!WORKER_FIELDS.has(k)) fail("not_allowed", `a worker cannot set ${k}; only ${[...WORKER_FIELDS].join(", ")}`);
  if (raw.report_id !== undefined) {
    if (typeof raw.report_id !== "string" || !REPORT_ID_RE.test(raw.report_id)) fail("invalid_params", "report_id is a short id of letters, digits, _ . : -");
    if (t.report_ids.includes(raw.report_id)) return { objective: o.id, transitions: [], duplicate: true };
  }
  if (t.status === "complete") fail("task_complete", `${taskId} is complete; the supervisor reopens it if more is needed`);
  const out: Transition[] = [];
  const explicitBlocker = raw.blocker !== undefined || raw.blocker_kind !== undefined;
  if (raw.status !== undefined) t.status = status(raw.status, WORKER_STATUSES, "worker");
  if (raw.evidence !== undefined) t.evidence = merge(t.evidence, list(raw.evidence, "evidence"));
  if (raw.artifacts !== undefined) t.artifacts = merge(t.artifacts, list(raw.artifacts, "artifacts"));
  if (raw.blocker !== undefined) t.blocker = textOrNull(raw.blocker, "blocker");
  if (raw.blocker_kind !== undefined) t.blocker_kind = kind(raw.blocker_kind);
  if (raw.next_action !== undefined) t.next_action = textOrNull(raw.next_action, "next_action");
  if (raw.wait_for !== undefined) {
    t.waiting_for = list(raw.wait_for, "wait_for", RESOURCE_RE);
    t.status = "waiting_dependency";
    t.blocker_kind = "resource";
  }
  if (raw.result !== undefined) {
    const r = raw.result as any;
    if (!r || typeof r !== "object") fail("invalid_params", "result is {summary, commit?}");
    const commit = r.commit === undefined || r.commit === null ? null : text(r.commit, "result.commit", 64);
    t.result = { summary: text(r.summary, "result.summary"), commit, at: now };
    if (commit) t.artifacts = merge(t.artifacts, [commit]);
    // Done from the worker's side; acceptance and pushing are the supervisor's.
    t.status = "verifying";
    const tr = transition(o, t.id, "needs_acceptance", t.result.summary.slice(0, 200), now);
    if (tr) out.push(tr);
  }
  // Only an explicit report clears a blocker; a result alone never erases one.
  if (!explicitBlocker && raw.status === "executing" && t.blocker_kind !== "human") { t.blocker = null; t.blocker_kind = null; }
  if (t.status === "blocked" && !t.blocker_kind) t.blocker_kind = "defect";
  if (t.status === "blocked" && t.blocker_kind === "defect" && !t.next_action) fail("invalid_params", "a defect blocker needs next_action: what fixes it");
  if (t.status === "blocked" && t.blocker_kind === "human") {
    const tr = transition(o, t.id, "blocked_human", t.blocker, now);
    if (tr) out.push(tr);
  }
  for (const r of raw.release ?? []) {
    const held = store.resources[r];
    if (held && held.objective === o.id && held.task === t.id) delete store.resources[r];
  }
  for (const r of raw.acquire ?? []) {
    if (!RESOURCE_RE.test(r)) fail("invalid_params", `resource ${r} is not a valid name`);
    const held = store.resources[r];
    if (held && !(held.objective === o.id && held.task === t.id)) {
      if (held.stale_since) fail("resource_stale", `${r} is still held by a run that went away (objective ${held.objective}, task ${held.task}); the supervisor frees it once that process is surely stopped. Report wait_for to wait for it`);
      fail("resource_busy", `${r} is held by objective ${held.objective} task ${held.task} since ${held.acquired_at}; report wait_for to wait for it`);
    }
    grant(store, r, o.id, t, now);
  }
  // Every report from the holder renews what it holds.
  for (const l of Object.values(store.resources)) if (l.objective === o.id && l.task === t.id) l.renewed_at = now;
  t.protocol = null;
  if (t.binding) t.binding.last_report_at = now;
  if (raw.report_id) t.report_ids = [...t.report_ids, raw.report_id].slice(-20);
  touchTask(o, t, now);
  out.push(...propagateReady(store, now));
  return { objective: o.id, transitions: out, duplicate: false };
}

// A bound run's turn ended, or its agent went away. Without a report since its last
// prompt the task is recoverable protocol state, never complete. A gone holder's
// resources go stale: still held, never handed on by a timer.
export function runEnded(store: CoordStore, paneId: string, how: "finished" | "gone", now: string): Change[] {
  const changes: Change[] = [];
  for (const o of Object.values(store.objectives)) {
    const out: Transition[] = [];
    for (const t of Object.values(o.tasks)) {
      if (t.binding?.pane_id !== paneId || t.status === "complete" || t.status === "verifying") continue;
      const unreported = t.binding.prompted_at !== null && (t.binding.last_report_at === null || t.binding.last_report_at < t.binding.prompted_at);
      const k = how === "gone" ? "worker_gone" : unreported ? "missing_report" : null;
      if (!k || t.protocol === k) continue;
      t.protocol = k;
      touchTask(o, t, now);
      const tr = transition(o, t.id, k, how === "gone" ? "the bound agent exited or its pane closed" : "the bound agent finished its turn without workdone-task", now);
      if (tr) out.push(tr);
    }
    if (how === "gone") {
      for (const [r, l] of Object.entries(store.resources)) {
        if (l.objective !== o.id || l.pane_id !== paneId || l.stale_since) continue;
        l.stale_since = now;
        o.version++;
        const tr = transition(o, l.task, "resource_stale", r, now);
        if (tr) out.push(tr);
      }
    }
    if (out.length) changes.push({ objective: o.id, transitions: out });
  }
  return changes;
}

export function ack(o: Objective, seq: unknown) {
  if (typeof seq !== "number" || !Number.isInteger(seq) || seq < 0) fail("invalid_params", "ack_seq is the seq of the last transition you handled");
  if ((seq as number) >= o.next_seq) fail("invalid_params", `ack_seq ${seq} is beyond the last transition (${o.next_seq - 1})`);
  o.acked_seq = Math.max(o.acked_seq, seq as number);
}

// Pins owners planned by name to the pane of the one live agent with that name. Two
// agents with the name leave it unresolved and say so; a pane ID is never guessed.
export function resolveOwners(o: Objective, agents: Array<{ pane_id: string; name?: string | null }>): string[] {
  const ambiguous: string[] = [];
  for (const t of Object.values(o.tasks)) {
    if (!t.owner || t.owner.pane_id) continue;
    const hits = agents.filter((a) => a.name === t.owner!.name);
    if (hits.length === 1) t.owner = { ...t.owner, pane_id: hits[0]!.pane_id };
    else if (hits.length > 1) ambiguous.push(t.owner.name);
  }
  return [...new Set(ambiguous)];
}
