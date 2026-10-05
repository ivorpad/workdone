// Canonical coordination state: an objective, its tasks and the scarce resources they
// hold. The supervisor (a ChatGPT thread, by its lease) plans and merges; a worker
// agent reports only the task it owns, from its own pane. Nobody restates ownership,
// dependencies, evidence or resource holders in prose: they live here.
//
// Pure functions over plain data. The caller supplies the clock and persists the result
// (coord.json in the gateway's state directory, see StateStore.updateCoord).

import { GatewayError } from "./config.ts";

export const TASK_STATUSES = ["queued", "executing", "waiting_dependency", "verifying", "blocked", "complete"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
// What a worker may say about its own task. complete is the supervisor's merge.
export const WORKER_STATUSES = ["executing", "waiting_dependency", "verifying", "blocked"] as const;

export const TASK_ID_RE = /^[#A-Za-z0-9][\w.#-]{0,63}$/;
export const OBJECTIVE_ID_RE = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
const RESOURCE_RE = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
const OWNER_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const MAX_TASKS = 100;
const MAX_LIST = 50;
const MAX_TEXT = 1000;

export interface TaskResult {
  summary: string;
  commit: string | null;
  at: string;
}

export interface Task {
  id: string;
  title: string;
  status: TaskStatus;
  // The agent by name, as planned; pane_id once that agent reported or was seen.
  owner: { name: string; pane_id: string | null } | null;
  deps: string[];
  acceptance: string[];
  evidence: string[];
  artifacts: string[];
  blocker: string | null;
  next_action: string | null;
  result: TaskResult | null;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface ResourceLease {
  task: string;
  pane_id: string | null;
  acquired_at: string;
}

export interface Objective {
  id: string;
  title: string;
  repo: string | null;
  // The thread that plans and merges (its lease); null with leases off.
  supervisor: string | null;
  tasks: Record<string, Task>;
  resources: Record<string, ResourceLease>;
  version: number;
  created_at: string;
  updated_at: string;
}

const fail = (code: string, message: string): never => { throw new GatewayError(code, message); };

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
  if (typeof v !== "string" || !allowed.includes(v)) fail(who === "worker" && v === "complete" ? "not_allowed" : "invalid_params", `${who} status must be one of ${allowed.join(", ")}${v === "complete" && who === "worker" ? "; complete is the supervisor's merge: publish result instead" : ""}`);
  return v as TaskStatus;
}
// Appends, keeping order and dropping repeats, so a retried report changes nothing.
const merge = (cur: string[], add: string[]) => [...cur, ...add.filter((x) => !cur.includes(x))].slice(-MAX_LIST);

export function newObjective(id: string, title: string, now: string): Objective {
  if (!OBJECTIVE_ID_RE.test(id)) fail("invalid_params", "objective must be a short lowercase id");
  return { id, title: text(title, "title", 200), repo: null, supervisor: null, tasks: {}, resources: {}, version: 0, created_at: now, updated_at: now };
}

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

function releaseHeld(o: Objective, taskId: string) {
  for (const [r, l] of Object.entries(o.resources)) if (l.task === taskId) delete o.resources[r];
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
  next_action?: string | null;
  remove?: boolean;
}

// The supervisor's plan and merges: create or change tasks (all fields), assign or free
// resources. Lists given here replace, except evidence and artifacts, which append.
export function planTasks(o: Objective, patches: unknown, resources: unknown, now: string): Objective {
  const next: Objective = structuredClone(o);
  if (patches !== undefined && (!Array.isArray(patches) || patches.length > MAX_TASKS)) fail("invalid_params", `tasks must be a list of at most ${MAX_TASKS}`);
  for (const raw of (patches ?? []) as any[]) {
    if (!raw || typeof raw !== "object") fail("invalid_params", "each task must be an object");
    const id = text(raw.id, "task id", 64);
    if (!TASK_ID_RE.test(id)) fail("invalid_params", `task id ${id} is not valid`);
    if (raw.remove === true) {
      delete next.tasks[id];
      releaseHeld(next, id);
      continue;
    }
    const cur = next.tasks[id];
    if (!cur && raw.title === undefined) fail("invalid_params", `new task ${id} needs a title`);
    if (!cur && Object.keys(next.tasks).length >= MAX_TASKS) fail("invalid_params", `an objective holds at most ${MAX_TASKS} tasks`);
    const t: Task = cur ? { ...cur } : {
      id, title: "", status: "queued", owner: null, deps: [], acceptance: [], evidence: [], artifacts: [],
      blocker: null, next_action: null, result: null, version: 0, created_at: now, updated_at: now,
    };
    if (raw.title !== undefined) t.title = text(raw.title, "title", 200);
    if (raw.status !== undefined) t.status = status(raw.status, TASK_STATUSES, "task");
    if (raw.owner !== undefined) {
      if (raw.owner === null) t.owner = null;
      else {
        const name = text(raw.owner, "owner", 32);
        if (!OWNER_RE.test(name)) fail("invalid_params", "owner is an agent name (lowercase, as spawn_agent named it)");
        if (t.owner?.name !== name) t.owner = { name, pane_id: null };
      }
    }
    if (raw.deps !== undefined) t.deps = list(raw.deps, "deps", TASK_ID_RE);
    if (raw.acceptance !== undefined) t.acceptance = list(raw.acceptance, "acceptance");
    if (raw.evidence !== undefined) t.evidence = merge(t.evidence, list(raw.evidence, "evidence"));
    if (raw.artifacts !== undefined) t.artifacts = merge(t.artifacts, list(raw.artifacts, "artifacts"));
    if (raw.blocker !== undefined) t.blocker = textOrNull(raw.blocker, "blocker");
    if (raw.next_action !== undefined) t.next_action = textOrNull(raw.next_action, "next_action");
    if (t.status === "complete") { t.blocker = null; releaseHeld(next, id); }
    t.version++;
    t.updated_at = now;
    next.tasks[id] = t;
  }
  checkGraph(next.tasks);
  if (resources !== undefined) {
    if (!resources || typeof resources !== "object" || Array.isArray(resources)) fail("invalid_params", "resources maps a resource name to a task id, or null to free it");
    for (const [r, holder] of Object.entries(resources as Record<string, unknown>)) {
      if (!RESOURCE_RE.test(r)) fail("invalid_params", `resource ${r} is not a valid name`);
      if (holder === null) { delete next.resources[r]; continue; }
      const task = next.tasks[text(holder, "resource holder", 64)];
      if (!task) fail("unknown_task", `resource ${r}: no task ${String(holder)}`);
      next.resources[r] = { task: task!.id, pane_id: task!.owner?.pane_id ?? null, acquired_at: now };
    }
  }
  next.version++;
  next.updated_at = now;
  return next;
}

// The tasks a pane owns: by pane ID once known, else by its agent's name.
export function ownedBy(o: Objective, paneId: string, name: string | null): Task[] {
  return Object.values(o.tasks).filter((t) => t.owner && (t.owner.pane_id ? t.owner.pane_id === paneId : t.owner.name === name));
}

export interface WorkerReport {
  task?: string;
  status?: string;
  evidence?: string[];
  artifacts?: string[];
  blocker?: string | null;
  next_action?: string | null;
  result?: { summary: string; commit?: string | null };
  acquire?: string[];
  release?: string[];
}

// One worker's delta to the task it owns. Never owner, deps, acceptance, title,
// complete, or a resource another task holds.
export function reportTask(o: Objective, taskId: string, paneId: string, raw: WorkerReport, now: string): Objective {
  const next: Objective = structuredClone(o);
  const t = next.tasks[taskId];
  if (!t) fail("unknown_task", `no task ${taskId} in objective ${o.id}`);
  const task = t!;
  if (task.owner?.pane_id !== paneId) fail("not_your_task", `${taskId} is owned by ${task.owner?.name ?? "nobody"}: report only your own task`);
  if (task.status === "complete") fail("task_complete", `${taskId} is complete; the supervisor reopens it if more is needed`);
  const known = new Set(["task", "status", "evidence", "artifacts", "blocker", "next_action", "result", "acquire", "release"]);
  for (const k of Object.keys(raw)) if (!known.has(k)) fail("not_allowed", `a worker cannot set ${k}; only status, evidence, artifacts, blocker, next_action, result, acquire and release`);
  if (raw.status !== undefined) task.status = status(raw.status, WORKER_STATUSES, "worker");
  if (raw.evidence !== undefined) task.evidence = merge(task.evidence, list(raw.evidence, "evidence"));
  if (raw.artifacts !== undefined) task.artifacts = merge(task.artifacts, list(raw.artifacts, "artifacts"));
  if (raw.blocker !== undefined) task.blocker = textOrNull(raw.blocker, "blocker");
  if (raw.next_action !== undefined) task.next_action = textOrNull(raw.next_action, "next_action");
  if (raw.result !== undefined) {
    const r = raw.result as any;
    if (!r || typeof r !== "object") fail("invalid_params", "result is {summary, commit?}");
    const commit = r.commit === undefined || r.commit === null ? null : text(r.commit, "result.commit", 64);
    task.result = { summary: text(r.summary, "result.summary"), commit, at: now };
    if (commit) task.artifacts = merge(task.artifacts, [commit]);
    // Done from the worker's side: the supervisor checks acceptance and merges complete.
    task.status = "verifying";
    task.blocker = null;
  }
  for (const r of raw.release ?? []) {
    if (next.resources[r]?.task === taskId) delete next.resources[r];
  }
  for (const r of raw.acquire ?? []) {
    if (!RESOURCE_RE.test(r)) fail("invalid_params", `resource ${r} is not a valid name`);
    const held = next.resources[r];
    if (held && held.task !== taskId && next.tasks[held.task]?.status !== "complete") {
      fail("resource_busy", `${r} is held by task ${held.task}${next.tasks[held.task]?.owner ? ` (${next.tasks[held.task]!.owner!.name})` : ""} since ${held.acquired_at}`);
    }
    next.resources[r] = { task: taskId, pane_id: paneId, acquired_at: held?.task === taskId ? held.acquired_at : now };
  }
  task.version++;
  task.updated_at = now;
  next.version++;
  next.updated_at = now;
  return next;
}

// The longest chain of unfinished tasks, following dependencies from the first one
// that has to happen to the last. Ties keep task order.
export function criticalPath(o: Objective): string[] {
  const open = Object.values(o.tasks).filter((t) => t.status !== "complete");
  const memo = new Map<string, string[]>();
  const chain = (id: string): string[] => {
    const hit = memo.get(id);
    if (hit) return hit;
    let best: string[] = [];
    for (const d of o.tasks[id]!.deps) {
      if (o.tasks[d]?.status === "complete") continue;
      const c = chain(d);
      if (c.length > best.length) best = c;
    }
    const out = [...best, id];
    memo.set(id, out);
    return out;
  };
  let longest: string[] = [];
  for (const t of open) {
    const c = chain(t.id);
    if (c.length > longest.length) longest = c;
  }
  return longest;
}

// The supervisor's one read: every task with what it waits on, what is ready to start,
// the critical path and who holds which resource. live maps a pane to its Herdr status.
export function snapshotView(o: Objective, live: Record<string, { status: string; name: string | null }> = {}) {
  const tasks = Object.values(o.tasks).map((t) => {
    const unmet = t.deps.filter((d) => o.tasks[d]?.status !== "complete");
    const holds = Object.entries(o.resources).filter(([, l]) => l.task === t.id).map(([r]) => r);
    const agent = t.owner?.pane_id ? live[t.owner.pane_id] : undefined;
    return {
      ...t,
      unmet_deps: unmet,
      holds,
      // The task's word wins over the terminal's: an agent waiting on a dependency is
      // not working, whatever its pane shows.
      owner_status: agent ? agent.status : t.owner?.pane_id ? "gone" : t.owner ? "unresolved" : null,
      activity: t.status === "executing" && agent && agent.status !== "working" ? `executing (agent ${agent.status})` : t.status,
    };
  });
  return {
    id: o.id, title: o.title, repo: o.repo, version: o.version, updated_at: o.updated_at,
    supervisor: o.supervisor ? "…" + o.supervisor.slice(-4) : null,
    tasks,
    ready: tasks.filter((t) => t.status === "queued" && t.unmet_deps.length === 0).map((t) => t.id),
    waiting: tasks.filter((t) => t.status === "waiting_dependency" || (t.status !== "complete" && t.unmet_deps.length > 0)).map((t) => ({ id: t.id, on: t.unmet_deps, blocker: t.blocker })),
    blocked: tasks.filter((t) => t.status === "blocked").map((t) => ({ id: t.id, blocker: t.blocker })),
    critical_path: criticalPath(o),
    resources: o.resources,
    complete: tasks.length > 0 && tasks.every((t) => t.status === "complete"),
  };
}

// Pins owners planned by name to the pane of the one live agent with that name. Two
// agents with the name leave it unresolved and say so; a pane ID is never guessed.
export function resolveOwners(o: Objective, agents: Array<{ pane_id: string; name?: string | null }>): { objective: Objective; ambiguous: string[] } {
  const next: Objective = structuredClone(o);
  const ambiguous: string[] = [];
  for (const t of Object.values(next.tasks)) {
    if (!t.owner || t.owner.pane_id) continue;
    const hits = agents.filter((a) => a.name === t.owner!.name);
    if (hits.length === 1) t.owner = { ...t.owner, pane_id: hits[0]!.pane_id };
    else if (hits.length > 1) ambiguous.push(t.owner.name);
  }
  // A resource assigned before its holder's owner was known gets the pane now.
  for (const l of Object.values(next.resources)) if (!l.pane_id) l.pane_id = next.tasks[l.task]?.owner?.pane_id ?? null;
  return { objective: next, ambiguous: [...new Set(ambiguous)] };
}
