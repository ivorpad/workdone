// Canonical coordination state (docs/coordination.md): objectives, their tasks, bindings
// of a task to one agent run, a transition log the supervisor acknowledges, and the
// machine's scarce resources. Opt-in: an agent with no binding never sees any of it.
//
// Functions change the store in place. The caller runs them inside
// StateStore.updateCoord, which writes only when the function returns, so a refused
// write leaves nothing behind.

import { createHash, timingSafeEqual } from "node:crypto";
import { GatewayError } from "./config.ts";

// Bindings live in coord-bindings.ts; re-exported here, where callers import them from.
import { resolveDispatch } from "./coord-bindings.ts";
export { bindTask, byToken, currentTaskBinding, notePrompted, paneDispatch, prepareDispatch, resolveDispatch, runEnded, settleDispatch, taskIdentity, type Prepared, type Run, type TaskIdentity } from "./coord-bindings.ts";

export const TASK_STATUSES = ["queued", "executing", "waiting_dependency", "verifying", "blocked", "complete"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
// What a worker may say about its own task. complete is the supervisor's merge.
export const WORKER_STATUSES = ["executing", "waiting_dependency", "verifying", "blocked"] as const;
export const BLOCKER_KINDS = ["dependency", "resource", "defect", "human"] as const;
export type BlockerKind = (typeof BLOCKER_KINDS)[number];
export type TransitionKind = "ready" | "needs_acceptance" | "blocked_human" | "missing_report" | "worker_gone" | "resource_stale" | "dispatch_unknown";

export const TASK_ID_RE = /^[#A-Za-z0-9][\w.#-]{0,63}$/;
export const OBJECTIVE_ID_RE = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
const RESOURCE_RE = /^[a-z0-9][a-z0-9_.:-]{0,63}$/;
export const OWNER_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const REPORT_ID_RE = /^[\w.:-]{1,80}$/;
export const TOKEN_RE = /^wdt_[A-Za-z0-9_-]{20,80}$/;
const MAX_TASKS = 100;
const MAX_LIST = 50;
const MAX_TEXT = 1000;
const MAX_TRANSITIONS = 200;
// Receipts an attempt keeps, all of them for its whole life: a retry of any report it
// sent is recognised. A run that reaches the cap is refused before anything changes and
// gets rebound, rather than forgetting old ids.
export const MAX_RECEIPTS = 1000;

export interface TaskResult { summary: string; commit: string | null; at: string }

// What the gateway knows about the prompt that carried a binding's slice. sending: on its
// way (prev is what to restore if Herdr refuses it). unknown: the transport failed after
// sending, so the worker may or may not have it. Both hold the pane: nothing more is sent
// to it until a report from that run or the supervisor (coord_update dispatch: delivered
// or lost) settles it. lost: the supervisor said it never arrived.
export interface Dispatch { command_id: string; state: "sending" | "delivered" | "unknown" | "lost"; at: string; prev?: Dispatch | null }

// One bound prompt by its command_id (the caller's, or one the gateway made): a retry with
// the same id and payload gets this outcome back instead of a second send.
export interface CommandReceipt {
  pane_id: string;
  objective: string;
  task: string;
  binding_id: string;
  hash: string;
  state: "sending" | "delivered" | "refused" | "unknown" | "lost" | "superseded";
  at: string;
}
// Command receipts an attempt may hold. They are kept for the attempt's whole life (its
// retry lifetime) and never evicted; past this the next new command is refused before
// anything changes, and the supervisor rebinds.
export const MAX_COMMANDS = 1000;

// A report this attempt already applied: a retry with the same payload gets it back.
export interface Receipt { hash: string | null; at: string; version: number; status: TaskStatus }

// A task's tie to one agent run (an attempt). The token is kept (the state directory is
// private, as for leases) so every prompt's slice can repeat it; checks compare its hash.
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
  dispatch?: Dispatch | null;
  receipts?: Record<string, Receipt>;
}

// A binding whose prompt is being sent. It becomes the task's binding when the prompt is
// delivered (or its token reports, which proves delivery); a definitive refusal drops it
// and nothing else changed.
export interface PendingDispatch { command_id: string; binding: Binding; at: string; name?: string | null }

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
  // A bound run ended without reporting, or its prompt's delivery is unknown:
  // recoverable, never complete.
  protocol: "missing_report" | "worker_gone" | "dispatch_unknown" | null;
  binding: Binding | null;
  pending?: PendingDispatch | null;
  // Every binding of this task increments it, so an old token can't write.
  generation: number;
  // Receipts of reports made without a binding (an owner reporting from its pane).
  receipts?: Record<string, Receipt>;
  // version moves on every change a supervisor merge could conflict with; progress only
  // on substantive work (status, evidence, artifacts, result, blocker, waits). A
  // heartbeat moves neither.
  version: number;
  progress?: number;
  created_at: string;
  updated_at: string;
}

export interface Transition { seq: number; at: string; task: string; kind: TransitionKind; detail: string | null; objective?: string }

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

// One machine's resources, across objectives: a browser port is one port. binding is the
// attempt holding it: a later run of the same task is a different holder.
export interface ResourceLease {
  objective: string;
  task: string;
  binding?: string | null;
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
  // Each pane's current binding (its id). Only that one gets slices and supervision; an
  // earlier binding on the pane is history, and never becomes current again by itself.
  current?: Record<string, string>;
  commands?: Record<string, CommandReceipt>;
}

export const emptyStore = (): CoordStore => ({ version: 2, objectives: {}, resources: {}, resource_generations: {}, current: {}, commands: {} });

// Stores written before attempts were explicit: report_ids become receipts of the
// binding (any retry of them stays a duplicate), each pane's latest binding becomes
// current, and a lease is tied to the holder's binding only when its pane and session
// match; otherwise it stays unattributed, so only the supervisor can free it.
export function normalizeStore(raw: unknown): CoordStore {
  const v = raw as any;
  if (!(v && v.version === 2 && v.objectives && typeof v.objectives === "object")) return emptyStore();
  const store: CoordStore = { version: 2, objectives: v.objectives, resources: v.resources ?? {}, resource_generations: v.resource_generations ?? {}, current: v.current };
  const latest: Record<string, Binding> = {};
  for (const o of Object.values(store.objectives)) {
    for (const t of Object.values(o.tasks) as Array<Task & { report_ids?: string[] }>) {
      t.progress ??= 0;
      t.pending ??= null;
      t.receipts ??= {};
      if (t.report_ids) {
        const into = t.binding ? (t.binding.receipts ??= {}) : t.receipts;
        for (const id of t.report_ids) into[id] ??= { hash: null, at: t.updated_at, version: t.version, status: t.status };
        delete t.report_ids;
      }
      if (t.binding) {
        t.binding.receipts ??= {};
        const cur = latest[t.binding.pane_id];
        if (!cur || cur.issued_at <= t.binding.issued_at) latest[t.binding.pane_id] = t.binding;
      }
    }
  }
  store.current ??= Object.fromEntries(Object.entries(latest).map(([p, b]) => [p, b.id]));
  store.commands = v.commands ?? {};
  for (const l of Object.values(store.resources)) {
    if (l.binding !== undefined) continue;
    const b = store.objectives[l.objective]?.tasks[l.task]?.binding;
    l.binding = b && b.pane_id === l.pane_id && b.session === l.session ? b.id : null;
  }
  return store;
}

// Ids used as object keys in coord.json: a name Object.prototype already has
// (__proto__, constructor, toString, ...) would hit the prototype instead of an own key,
// so it is refused before anything changes.
export const protoKey = (s: string) => s in Object.prototype;
// An own entry only, never something inherited from Object.prototype.
export const own = <T>(o: Record<string, T> | undefined, k: string): T | undefined => (o && Object.hasOwn(o, k) ? o[k] : undefined);

export const fail = (code: string, message: string): never => { throw new GatewayError(code, message); };
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
    if (re && (!re.test(s) || protoKey(s))) fail("invalid_params", `${what}: ${s} is not a valid id`);
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

// Keys sorted at every level, so the same report hashes the same however it was written.
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as any)[k])}`).join(",")}}`;
  return JSON.stringify(v ?? null);
}

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
    binding: null, pending: null, generation: 0, receipts: {}, version: 0, progress: 0, created_at: now, updated_at: now,
  };
}

function touchTask(o: Objective, t: Task, now: string) {
  t.version++;
  t.updated_at = now;
  o.version++;
  o.updated_at = now;
}

const held = (store: CoordStore, o: Objective, t: Task) =>
  Object.entries(store.resources).filter(([, l]) => l.objective === o.id && l.task === t.id).map(([r, l]) => `${r}:${l.generation}:${l.stale_since ?? ""}`).sort();
// Substantive work: what moves progress. next_action and protocol are bookkeeping.
const workPrint = (store: CoordStore, o: Objective, t: Task) =>
  canonical([t.status, t.evidence, t.artifacts, t.result, t.blocker, t.blocker_kind, t.waiting_for, held(store, o, t)]);
const viewPrint = (store: CoordStore, o: Objective, t: Task) => canonical([workPrint(store, o, t), t.next_action, t.protocol]);

// Bumps version when anything a merge could conflict with changed, progress when the
// work itself did. Returns whether the task changed at all.
export function settle(store: CoordStore, o: Objective, t: Task, before: { work: string; view: string }, now: string, force = false): boolean {
  const work = workPrint(store, o, t);
  if (work !== before.work) t.progress = (t.progress ?? 0) + 1;
  if (!force && work === before.work && viewPrint(store, o, t) === before.view) return false;
  touchTask(o, t, now);
  return true;
}
export const prints = (store: CoordStore, o: Objective, t: Task) => ({ work: workPrint(store, o, t), view: viewPrint(store, o, t) });

// One transition per task and kind until the supervisor acknowledges it, so a retried
// pass or a second report never surfaces the same readiness twice. It names its own
// objective: a change in one objective can wake another's supervisor.
export function transition(o: Objective, task: string, k: TransitionKind, detail: string | null, now: string): Transition | null {
  if (o.transitions.some((x) => x.seq > o.acked_seq && x.task === task && x.kind === k)) return null;
  const tr: Transition = { seq: o.next_seq++, at: now, task, kind: k, detail, objective: o.id };
  o.transitions = [...o.transitions, tr].slice(-MAX_TRANSITIONS);
  return tr;
}

// objective is the initiating one; transitions can belong to other objectives too (a
// released resource wakes another objective's waiter): each carries its own objective.
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

export const unmetDeps = (o: Objective, t: Task) => t.deps.filter((d) => o.tasks[d]?.status !== "complete");

// The task's current attempt holds this lease, and it is not stale. A task with no
// binding (an owner reporting from its pane) holds what was granted to no run.
function holds(l: ResourceLease, o: Objective, t: Task): boolean {
  return l.objective === o.id && l.task === t.id && !l.stale_since && (l.binding ?? null) === (t.binding?.id ?? null);
}
// Granted by the supervisor before any run held it: no process can be using it.
export const unheld = (l: ResourceLease) => !l.binding && l.pane_id === null && l.session === null;

export function markStale(store: CoordStore, r: string, l: ResourceLease, now: string): Transition | null {
  l.stale_since = now;
  const o = store.objectives[l.objective];
  if (!o) return null;
  o.version++;
  return transition(o, l.task, "resource_stale", r, now);
}

// The task closes (complete or removed). The current run's live leases are freed;
// anything held by another, unreconciled process goes stale and stays until the
// supervisor frees it.
function closeLeases(store: CoordStore, o: Objective, t: Task, now: string): Transition[] {
  const out: Transition[] = [];
  for (const [r, l] of Object.entries(store.resources)) {
    if (l.objective !== o.id || l.task !== t.id) continue;
    if (holds(l, o, t) || unheld(l)) { delete store.resources[r]; continue; }
    if (!l.stale_since) {
      const tr = markStale(store, r, l, now);
      if (tr) out.push(tr);
    }
  }
  return out;
}

// Waits whose prerequisite cleared: dependencies all complete, or every awaited resource
// free. Each goes back to queued with one ready transition, in its own objective.
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
      const before = prints(store, o, t);
      t.status = "queued";
      t.blocker = null;
      t.blocker_kind = null;
      t.waiting_for = [];
      settle(store, o, t, before, now, true);
      const tr = transition(o, t.id, "ready", t.next_action, now);
      if (tr) out.push(tr);
    }
  }
  return out;
}

function grant(store: CoordStore, r: string, o: Objective, t: Task, now: string) {
  const cur = store.resources[r];
  if (cur && holds(cur, o, t)) { cur.renewed_at = now; return; }
  const generation = (store.resource_generations[r] ?? 0) + 1;
  store.resource_generations[r] = generation;
  store.resources[r] = {
    objective: o.id, task: t.id, binding: t.binding?.id ?? null, pane_id: t.binding?.pane_id ?? null, session: t.binding?.session ?? null,
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
  dispatch?: "delivered" | "lost";
}

// The supervisor's plan and merges for one objective. Lists replace, except evidence and
// artifacts, which append. resources maps a name to one of this objective's tasks, or
// null to free it: the explicit reconciliation a stale lease needs. {task,
// expected_generation} fences the change to the lease the supervisor read.
export function planTasks(store: CoordStore, objectiveId: string, patches: unknown, resources: unknown, now: string): Change {
  const o = getObjective(store, objectiveId);
  const out: Transition[] = [];
  if (patches !== undefined && (!Array.isArray(patches) || patches.length > MAX_TASKS)) fail("invalid_params", `tasks must be a list of at most ${MAX_TASKS}`);
  for (const raw of (patches ?? []) as any[]) {
    if (!raw || typeof raw !== "object") fail("invalid_params", "each task must be an object");
    const id = text(raw.id, "task id", 64);
    if (!TASK_ID_RE.test(id) || protoKey(id)) fail("invalid_params", `task id ${id} is not valid`);
    const cur = o.tasks[id];
    if (raw.expected_version !== undefined && (cur?.version ?? 0) !== raw.expected_version) {
      fail("version_conflict", `task ${id} is at version ${cur?.version ?? 0}, not ${raw.expected_version}: read the snapshot and merge again`);
    }
    if (raw.remove === true) {
      if (cur) out.push(...closeLeases(store, o, cur, now));
      delete o.tasks[id];
      o.version++;
      continue;
    }
    if (!cur && raw.title === undefined) fail("invalid_params", `new task ${id} needs a title`);
    if (!cur && Object.keys(o.tasks).length >= MAX_TASKS) fail("invalid_params", `an objective holds at most ${MAX_TASKS} tasks`);
    const t: Task = cur ?? newTask(id, now);
    const before = prints(store, o, t);
    const was = cur?.status;
    // Accepting over an open blocker needs the blocker cleared in this same merge: a
    // deliberate resolution, not an oversight. Checked before anything changes.
    const blockerAfter = raw.blocker !== undefined ? raw.blocker : t.blocker;
    if (raw.status === "complete" && was !== "complete" && blockerAfter !== null) {
      fail("unresolved_blocker", `${id} has an unresolved ${t.blocker_kind ?? "unspecified"} blocker (${String(blockerAfter).slice(0, 120)}); resolve it, or pass blocker: null with complete to accept deliberately`);
    }
    if (raw.title !== undefined) t.title = text(raw.title, "title", 200);
    if (raw.status !== undefined) t.status = status(raw.status, TASK_STATUSES, "task");
    if (raw.owner !== undefined) {
      const name = raw.owner === null ? null : text(raw.owner, "owner", 32);
      if (name !== null && !OWNER_RE.test(name)) fail("invalid_params", "owner is an agent name (lowercase, as spawn_agent named it)");
      if (t.owner?.name !== name) {
        // Reassigned: the old run's token stops working, and a prompt on its way with
        // a new one never becomes current.
        t.owner = name === null ? null : { name, pane_id: null };
        if (t.binding) { t.binding = null; t.generation++; }
        t.pending = null;
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
    // The supervisor read the agent and says whether a prompt in doubt arrived.
    if (raw.dispatch !== undefined) {
      if (raw.dispatch !== "delivered" && raw.dispatch !== "lost") fail("invalid_params", "dispatch is delivered or lost: whether the prompt in doubt reached the agent");
      out.push(...resolveDispatch(store, o, t, raw.dispatch, now));
    }
    if (t.status === "complete" && was !== "complete") {
      t.blocker = null;
      t.blocker_kind = null;
      t.protocol = null;
      t.waiting_for = [];
      t.pending = null;
      out.push(...closeLeases(store, o, t, now));
    }
    o.tasks[id] = t;
    settle(store, o, t, before, now, true);
  }
  checkGraph(o.tasks);
  if (resources !== undefined) {
    if (!resources || typeof resources !== "object" || Array.isArray(resources)) fail("invalid_params", "resources maps a resource name to a task id, null to free it, or {task, expected_generation}");
    for (const [r, value] of Object.entries(resources as Record<string, unknown>)) {
      if (!RESOURCE_RE.test(r) || protoKey(r)) fail("invalid_params", `resource ${r} is not a valid name`);
      const fenced = value !== null && typeof value === "object";
      const holder = fenced ? (value as any).task : value;
      const expected = fenced ? (value as any).expected_generation : undefined;
      if (fenced && (typeof expected !== "number" || !Number.isInteger(expected) || (holder !== null && typeof holder !== "string"))) {
        fail("invalid_params", `resource ${r}: {task: id or null, expected_generation: the lease generation you read}`);
      }
      const cur = store.resources[r];
      if (expected !== undefined && (cur?.generation ?? 0) !== expected) {
        fail("resource_conflict", `${r} is at generation ${cur?.generation ?? 0} (${cur ? `objective ${cur.objective} task ${cur.task}` : "free"}), not ${expected}: read the snapshot again`);
      }
      // Another objective's live lease is not this supervisor's to take or free.
      if (cur && cur.objective !== o.id && !cur.stale_since) fail("resource_busy", `${r} is held by objective ${cur.objective} task ${cur.task}`);
      if (holder === null) { delete store.resources[r]; o.version++; continue; }
      const task = o.tasks[text(holder, "resource holder", 64)] ?? fail("unknown_task", `resource ${r}: no task ${String(holder)}`);
      if (cur?.stale_since) {
        fail("resource_stale", `${r} is held by a run that went away (objective ${cur.objective}, task ${cur.task}, generation ${cur.generation}); free it with null first, once that process is surely stopped`);
      }
      // Moving a live lease off the run that holds it needs the generation you read.
      if (cur && !holds(cur, o, task) && !unheld(cur) && expected === undefined) {
        fail("resource_busy", `${r} is held by task ${cur.task} (generation ${cur.generation}); pass {task, expected_generation: ${cur.generation}} to move it`);
      }
      grant(store, r, o, task, now);
      o.version++;
    }
  }
  out.push(...propagateReady(store, now));
  o.updated_at = now;
  return { objective: o.id, transitions: out };
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
// a resource another run holds. Receipts are per attempt: the same report_id with the
// same payload returns the first receipt and changes nothing; with another payload it is
// a conflict. Once a result put the task in verifying, only the supervisor reopens it.
export function reportTask(store: CoordStore, objectiveId: string, taskId: string, raw: WorkerReport, now: string): Change & { duplicate: boolean; receipt: Receipt | null } {
  const o = getObjective(store, objectiveId);
  const t = o.tasks[taskId] ?? fail("unknown_task", `no task ${taskId} in objective ${objectiveId}`);
  for (const k of Object.keys(raw)) if (!WORKER_FIELDS.has(k)) fail("not_allowed", `a worker cannot set ${k}; only ${[...WORKER_FIELDS].join(", ")}`);
  const receipts = t.binding ? (t.binding.receipts ??= {}) : (t.receipts ??= {});
  const { report_id: rid, ...payload } = raw;
  const hash = createHash("sha256").update(canonical(payload)).digest("hex");
  if (rid !== undefined) {
    if (typeof rid !== "string" || !REPORT_ID_RE.test(rid) || protoKey(rid)) fail("invalid_params", "report_id is a short id of letters, digits, _ . : - (and not a built-in name such as __proto__)");
    const seen = own(receipts, rid);
    if (seen) {
      if (seen.hash !== null && seen.hash !== hash) fail("report_conflict", `report_id ${rid} was already used in this run for a different report; use a new report_id for new content`);
      return { objective: o.id, transitions: [], duplicate: true, receipt: seen };
    }
    if (Object.keys(receipts).length >= MAX_RECEIPTS) fail("receipts_full", `this run of ${taskId} already used ${MAX_RECEIPTS} report ids; nothing was applied. The supervisor rebinds the task for a fresh run`);
  }
  if (t.status === "complete") fail("task_complete", `${taskId} is complete; the supervisor reopens it if more is needed`);
  if (raw.status !== undefined) status(raw.status, WORKER_STATUSES, "worker");
  const regress = (raw.status !== undefined && raw.status !== "verifying") || raw.wait_for !== undefined;
  if (t.status === "verifying" && regress && raw.result === undefined) {
    fail("regressive_report", `${taskId} is verifying after its result; it does not go back to ${raw.status ?? "waiting_dependency"} from a worker report (a late or replayed one). Report evidence or a blocker, or the supervisor reopens it with coord_update`);
  }
  const out: Transition[] = [];
  const before = prints(store, o, t);
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
  if (t.blocker_kind === "defect" && (t.status === "blocked" || explicitBlocker) && t.blocker && !t.next_action) fail("invalid_params", "a defect blocker needs next_action: what fixes it");
  // A person has to act, whatever the status: a partial result does not hide it.
  if (t.blocker_kind === "human" && (t.blocker || t.status === "blocked") && (explicitBlocker || raw.status === "blocked")) {
    const tr = transition(o, t.id, "blocked_human", t.blocker, now);
    if (tr) out.push(tr);
  }
  // name@generation releases only that grant: a late release can't free a lease this
  // run acquired again since.
  for (const entry of raw.release ?? []) {
    const [r, gen] = String(entry).split("@") as [string, string | undefined];
    if (!RESOURCE_RE.test(r) || protoKey(r) || (gen !== undefined && !/^\d+$/.test(gen))) fail("invalid_params", `release ${entry}: a resource name, or name@generation`);
    const l = store.resources[r];
    if (!l) continue;
    if (gen !== undefined && l.generation !== Number(gen)) {
      if (holds(l, o, t)) fail("resource_conflict", `${r} is at generation ${l.generation} now, not ${gen}: that grant was already released; nothing was applied`);
      continue;
    }
    if (holds(l, o, t)) { delete store.resources[r]; continue; }
    if (l.objective === o.id && l.task === t.id) fail("resource_stale", `${r} (generation ${l.generation}) belongs to ${l.stale_since ? "a run that went away" : "another run"} of ${t.id}, not this one; the supervisor frees it`);
    fail("not_holder", `${r} is held by objective ${l.objective} task ${l.task}, not by this run`);
  }
  for (const r of raw.acquire ?? []) {
    if (!RESOURCE_RE.test(r) || protoKey(r)) fail("invalid_params", `resource ${r} is not a valid name`);
    const l = store.resources[r];
    if (l && !holds(l, o, t) && !(unheld(l) && !l.stale_since && l.objective === o.id && l.task === t.id)) {
      if (l.stale_since || (l.objective === o.id && l.task === t.id)) fail("resource_stale", `${r} is still held by a run that went away or an earlier run (objective ${l.objective}, task ${l.task}, generation ${l.generation}); the supervisor frees it once that process is surely stopped. Report wait_for to wait for it`);
      fail("resource_busy", `${r} is held by objective ${l.objective} task ${l.task} since ${l.acquired_at}; report wait_for to wait for it`);
    }
    grant(store, r, o, t, now);
  }
  // Liveness, not progress: every report from the holder renews what it holds.
  for (const l of Object.values(store.resources)) if (holds(l, o, t)) l.renewed_at = now;
  t.protocol = null;
  if (t.binding) {
    t.binding.last_report_at = now;
    // A report from this run is the proof a prompt in doubt arrived.
    const d = t.binding.dispatch;
    if (d?.state === "unknown") {
      t.binding.dispatch = { command_id: d.command_id, state: "delivered", at: now };
      const rec = own(store.commands, d.command_id);
      if (rec) rec.state = "delivered";
    }
  }
  settle(store, o, t, before, now);
  const receipt: Receipt = { hash, at: now, version: t.version, status: t.status };
  if (rid !== undefined) receipts[rid] = receipt;
  out.push(...propagateReady(store, now));
  return { objective: o.id, transitions: out, duplicate: false, receipt };
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
