// Bindings of coordination tasks to agent runs (docs/coordination.md): which binding is a
// pane's current one, binding and dispatch (a prompt carrying a slice is pending until
// delivered), the tokens workers report with, and what happens when a run ends.
// Same rules as coord.ts: functions change the store in place, inside updateCoord.

import { timingSafeEqual } from "node:crypto";
import {
  fail, getObjective, hashToken, markStale, MAX_COMMANDS, own, OWNER_RE, prints, protoKey, settle, TOKEN_RE, transition, unheld, unmetDeps,
  type Binding, type Change, type CommandReceipt, type CoordStore, type Objective, type Task, type Transition,
} from "./coord.ts";

// The task bound to this pane's current run: the pane's most recent binding, still
// held by that task. With a session, a binding issued to another session (the agent
// restarted) is not current. The task is returned whatever its status; callers decide.
export function currentTaskBinding(store: CoordStore, paneId: string, session?: string | null): { o: Objective; t: Task } | null {
  const id = store.current?.[paneId];
  if (!id) return null;
  for (const o of Object.values(store.objectives)) {
    for (const t of Object.values(o.tasks)) {
      if (t.binding?.id !== id || t.binding.pane_id !== paneId) continue;
      if (session != null && t.binding.session !== null && t.binding.session !== session) return null;
      return { o, t };
    }
  }
  return null;
}

export interface Run { pane_id: string; session: string | null; name: string | null }

function checkBindable(store: CoordStore, t: Task, run: Run) {
  if (t.status === "complete") fail("task_complete", `${t.id} is complete; reopen it with coord_update before binding a run`);
  for (const other of Object.values(store.objectives).flatMap((x) => Object.values(x.tasks))) {
    if (other !== t && other.binding?.pane_id === run.pane_id && other.status !== "complete" && other.status !== "verifying") {
      fail("pane_busy", `${run.pane_id} is bound to task ${other.id}; one current slice per worker: finish, reassign or complete it first`);
    }
  }
}

function newBinding(t: Task, run: Run, token: string, id: string, now: string): Binding {
  if (!TOKEN_RE.test(token)) fail("invalid_params", "binding token has the wrong shape");
  return { id, token, token_hash: hashToken(token), pane_id: run.pane_id, session: run.session, generation: t.generation + 1, issued_at: now, prompted_at: null, last_report_at: null, dispatch: null, receipts: {} };
}

// Makes b the task's binding and its pane's current one. Leases the previous attempt
// held move with it only when it is the same process (same pane and session); any other
// holder goes stale. executing: the prompt is known to have reached the run.
function commitBinding(store: CoordStore, o: Objective, t: Task, b: Binding, now: string, executing: boolean, name: string | null = null): Transition[] {
  const out: Transition[] = [];
  const before = prints(store, o, t);
  for (const [r, l] of Object.entries(store.resources)) {
    if (l.objective !== o.id || l.task !== t.id || l.stale_since) continue;
    if (unheld(l) || (l.pane_id === b.pane_id && l.session === b.session && (!l.binding || l.binding === t.binding?.id))) {
      Object.assign(l, { binding: b.id, pane_id: b.pane_id, session: b.session });
    } else {
      const tr = markStale(store, r, l, now);
      if (tr) out.push(tr);
    }
  }
  t.generation = Math.max(t.generation + 1, b.generation);
  b.generation = t.generation;
  t.binding = b;
  t.pending = null;
  (store.current ??= {})[b.pane_id] = b.id;
  t.owner = { name: name && OWNER_RE.test(name) ? name : t.owner?.name ?? "unnamed", pane_id: b.pane_id };
  t.protocol = null;
  if (executing && t.status === "queued" && unmetDeps(o, t).length === 0) t.status = "executing";
  settle(store, o, t, before, now, true);
  return out;
}

// Binds a task to one agent run without a prompt (spawn_agent with no prompt, tests):
// assigns the pane, bumps the generation (an older token stops working) and keeps the
// new token's hash. Nothing has run yet, so the status stays as it was.
export function bindTask(store: CoordStore, objectiveId: string, taskId: string, run: Run, token: string, bindingId: string, now: string): Task {
  const o = getObjective(store, objectiveId);
  const t = o.tasks[taskId] ?? fail("unknown_task", `no task ${taskId} in objective ${objectiveId}`);
  checkBindable(store, t, run);
  commitBinding(store, o, t, newBinding(t, run, token, bindingId, now), now, false, run.name);
  return t;
}

// The prompt carrying this binding's slice went in (tests and the delivered path).
export function notePrompted(store: CoordStore, objectiveId: string, taskId: string, now: string) {
  const o = store.objectives[objectiveId];
  const t = o?.tasks[taskId];
  if (!o || !t?.binding) return;
  t.binding.prompted_at = now;
  if (t.status === "queued" && unmetDeps(o, t).length === 0) {
    const before = prints(store, o, t);
    t.status = "executing";
    settle(store, o, t, before, now);
  }
}

// The dispatch that holds this pane: a prompt with a new binding on its way, or one to the
// pane's binding that is being sent or whose delivery is unknown. While one holds it,
// nothing else is sent to the pane through WorkDone, bound or not.
export function paneDispatch(store: CoordStore, paneId: string): { o: Objective; t: Task; command_id: string; state: "sending" | "unknown" } | null {
  for (const o of Object.values(store.objectives)) {
    for (const t of Object.values(o.tasks)) {
      if (t.pending?.binding.pane_id === paneId) return { o, t, command_id: t.pending.command_id, state: "sending" };
      const d = t.binding?.pane_id === paneId ? t.binding.dispatch : null;
      if (d && (d.state === "sending" || d.state === "unknown")) return { o, t, command_id: d.command_id, state: d.state };
    }
  }
  return null;
}

// The task's identity for supervision: one binding of one task. Turns of another task,
// or another run of this one, are not evidence about this one.
export interface TaskIdentity { objective: string; id: string; binding: string }
export const taskIdentity = (o: Objective, t: Task): TaskIdentity => ({ objective: o.id, id: t.id, binding: t.binding?.id ?? "unbound" });

// Whether a receipt still speaks for a live dispatch: its pending binding, or its
// binding's dispatch, is still there. Reassigning or removing the task ends it.
function live(store: CoordStore, id: string, rec: CommandReceipt): boolean {
  const t = store.objectives[rec.objective]?.tasks[rec.task];
  if (!t) return false;
  if (t.pending?.command_id === id) return true;
  return t.binding?.id === rec.binding_id && t.binding.dispatch?.command_id === id;
}

// A command receipt lives as long as its attempt: while its binding is still its task's
// binding, or still pending. That is the retry lifetime: a rebind or reassignment ends it.
function attemptAlive(store: CoordStore, rec: CommandReceipt): boolean {
  const t = store.objectives[rec.objective]?.tasks[rec.task];
  return !!t && (t.binding?.id === rec.binding_id || t.pending?.binding.id === rec.binding_id);
}

// Refused before anything changes once an attempt has used its receipts; nothing is
// dropped while its attempt lives.
function checkCapacity(store: CoordStore, bindingId: string, taskId: string) {
  const used = Object.values(store.commands ?? {}).filter((r) => r.binding_id === bindingId).length;
  if (used >= MAX_COMMANDS) fail("commands_full", `this run of ${taskId} already used ${MAX_COMMANDS} command ids; nothing was sent. Rebind the task (prompt with task) for a fresh run`);
}

function record(store: CoordStore, id: string, rec: CommandReceipt) {
  const all = (store.commands ??= {});
  for (const [k, r] of Object.entries(all)) if (!attemptAlive(store, r)) delete all[k];
  all[id] = rec;
}
const mark = (store: CoordStore, id: string, state: CommandReceipt["state"], now: string) => {
  const rec = own(store.commands, id);
  if (rec) Object.assign(rec, { state, at: now });
};

// transitions: what binding at once produced (an earlier run's lease going stale), for
// the caller to notify in the same transaction.
export interface Prepared { o: Objective; t: Task; binding: Binding; command_id: string; fresh: boolean; transitions?: Transition[] }
export interface Command { id: string; hash: string }

// The first half of a prompt to a bound run. command_id makes it idempotent: the same id
// and payload again returns what happened (no second send), another payload under that
// id is a conflict, and an id still sending or unknown is never sent again. With ask: a
// new binding for that task, pending until the prompt is delivered. Without: the pane's
// current binding, if its task is open and the session is the one it was issued to.
// Either way the task must be ready to execute, and nothing may be in flight or in doubt
// on the pane. prompting false binds at once with nothing sent (spawn's preallocation),
// and dependencies may still be open.
export function prepareDispatch(store: CoordStore, ask: { objective: string; id: string } | null, run: Run, cmd: Command, token: string, bindingId: string, now: string, prompting = true): Prepared | { replay: CommandReceipt } | null {
  if (protoKey(cmd.id)) fail("invalid_params", "command_id must not be a built-in name such as __proto__");
  const prior = own(store.commands, cmd.id);
  const seen = prior && attemptAlive(store, prior) ? prior : undefined;
  if (seen && prompting) {
    if (seen.hash !== cmd.hash) fail("command_conflict", `command_id ${cmd.id} was already used for a different prompt; use a new command_id for new content`);
    if (seen.state === "delivered") return { replay: seen };
    if ((seen.state === "sending" || seen.state === "unknown") && live(store, cmd.id, seen)) {
      fail(seen.state === "unknown" ? "dispatch_unknown" : "dispatch_in_flight", `command ${cmd.id} is ${seen.state === "unknown" ? "in doubt: the transport failed after sending" : "still being delivered"}; it is not sent again. Read the agent, then coord_update the task with dispatch: delivered or lost`);
    }
  }
  const held = paneDispatch(store, run.pane_id);
  if (held) {
    fail(held.state === "unknown" ? "dispatch_unknown" : "dispatch_in_flight", `${run.pane_id} has prompt ${held.command_id} for task ${held.t.id} ${held.state === "unknown" ? "in doubt (the transport failed after sending)" : "still on its way"}; nothing else goes to that pane until it settles. Read the agent, then coord_update objective ${held.o.id} task ${held.t.id} with dispatch: delivered or lost`);
  }
  // Any prompt to a bound run is an instruction to execute its task, so readiness holds
  // for the pane's current task exactly as for a task named in this call.
  const ready = (o: Objective, t: Task) => {
    const unmet = unmetDeps(o, t);
    if (unmet.length) fail("deps_unmet", `${t.id} depends on ${unmet.join(", ")}, which ${unmet.length > 1 ? "are" : "is"} not complete: it can't execute yet, and a prompt to its bound agent would start it. Wait for the ready transition (binding with no prompt, spawn_agent without prompt, is allowed)`);
  };
  if (!ask) {
    const cur = currentTaskBinding(store, run.pane_id, run.session);
    if (!cur || cur.t.status === "complete" || !cur.t.binding) return null;
    const b = cur.t.binding;
    if (!prompting) return { ...cur, binding: b, command_id: cmd.id, fresh: false };
    ready(cur.o, cur.t);
    checkCapacity(store, b.id, cur.t.id);
    b.dispatch = { command_id: cmd.id, state: "sending", at: now, prev: b.dispatch ?? null };
    record(store, cmd.id, { pane_id: run.pane_id, objective: cur.o.id, task: cur.t.id, binding_id: b.id, hash: cmd.hash, state: "sending", at: now });
    return { ...cur, binding: b, command_id: cmd.id, fresh: false };
  }
  const o = getObjective(store, ask.objective);
  const t = o.tasks[ask.id] ?? fail("unknown_task", `no task ${ask.id} in objective ${ask.objective}`);
  checkBindable(store, t, run);
  const other = t.pending ? t.pending.command_id : t.binding?.dispatch && ["sending", "unknown"].includes(t.binding.dispatch.state) ? t.binding.dispatch.command_id : null;
  if (other) fail("dispatch_unknown", `task ${t.id} has prompt ${other} on another pane still in flight or in doubt; coord_update it with dispatch: delivered or lost first`);
  const b = newBinding(t, run, token, bindingId, now);
  if (!prompting) {
    const transitions = commitBinding(store, o, t, b, now, false, run.name);
    return { o, t, binding: b, command_id: cmd.id, fresh: true, transitions };
  }
  ready(o, t);
  t.pending = { command_id: cmd.id, binding: b, at: now, name: run.name };
  record(store, cmd.id, { pane_id: run.pane_id, objective: o.id, task: t.id, binding_id: b.id, hash: cmd.hash, state: "sending", at: now });
  return { o, t, binding: b, command_id: cmd.id, fresh: true };
}

// Commits a pending binding unless the pane went to another open task meanwhile: a late
// settle never takes a pane back from the attempt that holds it now. delivered: the run
// has the prompt; sending: it may have (the unknown path settles it next).
function commitPending(store: CoordStore, o: Objective, t: Task, now: string, state: "delivered" | "sending" = "delivered"): Transition[] | null {
  const p = t.pending!;
  try {
    checkBindable(store, t, { pane_id: p.binding.pane_id, session: p.binding.session, name: p.name ?? null });
  } catch {
    t.pending = null;
    mark(store, p.command_id, "superseded", now);
    return null;
  }
  const out = commitBinding(store, o, t, p.binding, now, state === "delivered", p.name ?? null);
  p.binding.dispatch = { command_id: p.command_id, state, at: now };
  if (state === "delivered") {
    p.binding.prompted_at = p.at;
    mark(store, p.command_id, "delivered", now);
  }
  return out;
}

// The second half: what happened to the prompt. delivered commits a pending binding (or
// marks the current one prompted). refused: Herdr said no, nothing reached the run, so
// the pending binding is dropped (or the binding's dispatch restored) and nothing else
// is touched; whatever was written in between stays. unknown: the transport failed after
// sending; the binding becomes current (its run may hold the token) with protocol
// dispatch_unknown, not executing, and the pane is held until it is resolved. A settle
// for an attempt that was superseded meanwhile changes nothing.
export function settleDispatch(store: CoordStore, p: { objective: string; task: string; binding_id: string; command_id: string; fresh: boolean; sent_at: string }, outcome: "delivered" | "refused" | "unknown", now: string): Change[] {
  const o = store.objectives[p.objective];
  const t = o?.tasks[p.task];
  // Transitions from committing the binding come first and are never dropped.
  let carried: Transition[] = [];
  const done = (out: Transition[]) => (carried.length || out.length ? [{ objective: o!.id, transitions: [...carried, ...out] }] : []);
  if (!o || !t) { mark(store, p.command_id, "superseded", now); return []; }
  if (p.fresh) {
    if (t.pending?.command_id !== p.command_id) {
      // A report with its token already committed it, or the task was reassigned.
      if (t.binding?.id !== p.binding_id) mark(store, p.command_id, "superseded", now);
      return [];
    }
    if (outcome === "refused" || t.status === "complete") {
      t.pending = null;
      mark(store, p.command_id, outcome === "refused" ? "refused" : "superseded", now);
      return [];
    }
    if (outcome === "delivered") return done(commitPending(store, o, t, now) ?? []);
    // unknown: the run may hold this token, so it becomes the binding, in doubt.
    const committed = commitPending(store, o, t, now, "sending");
    if (!committed) return [];
    carried = committed;
  }
  const b = t.binding;
  if (!b || b.id !== p.binding_id || b.dispatch?.command_id !== p.command_id || b.dispatch.state !== "sending") {
    // Settled by a report or the supervisor already, or superseded: nothing to do.
    if (!b || b.id !== p.binding_id) mark(store, p.command_id, "superseded", now);
    return done([]);
  }
  const out: Transition[] = [];
  const before = prints(store, o, t);
  if (outcome === "refused") {
    b.dispatch = b.dispatch.prev ?? null;
    mark(store, p.command_id, "refused", now);
  } else if (outcome === "delivered") {
    b.dispatch = { command_id: p.command_id, state: "delivered", at: now };
    b.prompted_at = p.sent_at;
    if (t.protocol === "dispatch_unknown") t.protocol = null;
    if (t.status === "queued" && unmetDeps(o, t).length === 0) t.status = "executing";
    mark(store, p.command_id, "delivered", now);
  } else {
    b.dispatch = { command_id: p.command_id, state: "unknown", at: now };
    t.protocol = "dispatch_unknown";
    mark(store, p.command_id, "unknown", now);
    const tr = transition(o, t.id, "dispatch_unknown", `prompt ${p.command_id} to ${b.pane_id}: the transport failed after sending; read the agent, then coord_update dispatch: delivered or lost`, now);
    if (tr) out.push(tr);
  }
  settle(store, o, t, before, now);
  return done(out);
}

// The supervisor read the agent: the prompt in flight or in doubt did reach it
// (delivered), or did not (lost). Either frees the pane. lost keeps the binding but
// nothing is resent by itself; the next prompt is the supervisor's call.
export function resolveDispatch(store: CoordStore, o: Objective, t: Task, how: "delivered" | "lost", now: string): Transition[] {
  if (t.pending) {
    if (how === "delivered") return commitPending(store, o, t, now) ?? fail("pane_busy", `${t.pending?.binding.pane_id ?? "that pane"} went to another task meanwhile`);
    mark(store, t.pending.command_id, "lost", now);
    t.pending = null;
    return [];
  }
  const b = t.binding;
  const d = b?.dispatch;
  if (!b || !d || (d.state !== "unknown" && d.state !== "sending")) return fail("invalid_params", `task ${t.id} has no prompt in flight or in doubt to resolve`);
  if (how === "delivered") {
    b.dispatch = { command_id: d.command_id, state: "delivered", at: now };
    b.prompted_at ??= d.at;
    if (t.status === "queued" && unmetDeps(o, t).length === 0) t.status = "executing";
  } else {
    b.dispatch = { command_id: d.command_id, state: "lost", at: now };
  }
  if (t.protocol === "dispatch_unknown") t.protocol = null;
  mark(store, d.command_id, how, now);
  return [];
}

// The task a token speaks for: its binding, or a binding whose prompt is still on its
// way (a report with it proves delivery, so it becomes the task's binding now, unless
// the pane went to another task). A token of an earlier binding on a pane that moved on
// still names its task, but that task is never the pane's current one again. Unknown or
// superseded tokens are stale. transitions: what committing a pending binding produced,
// for the caller to notify with the report.
export function byToken(store: CoordStore, token: string, now = new Date().toISOString()): { o: Objective; t: Task; transitions: Transition[] } {
  if (!TOKEN_RE.test(token)) fail("stale_binding", "that task token is not valid");
  const want = Buffer.from(hashToken(token), "hex");
  const same = (hash: string) => {
    const have = Buffer.from(hash, "hex");
    return have.length === want.length && timingSafeEqual(have, want);
  };
  for (const o of Object.values(store.objectives)) {
    for (const t of Object.values(o.tasks)) {
      if (t.binding && same(t.binding.token_hash)) return { o, t, transitions: [] };
      if (t.pending && same(t.pending.binding.token_hash) && t.status !== "complete") {
        const transitions = commitPending(store, o, t, now);
        if (transitions) return { o, t, transitions };
      }
    }
  }
  return fail("stale_binding", "that task token is no longer valid: the task was reassigned, rebound or removed");
}

// A bound run's turn ended (finished, or with a question in prose), or its agent went
// away. Only the pane's current binding speaks for it. Without a report since its last
// prompt the task is recoverable protocol state, never complete: a question asked only in
// prose is not a human blocker until it is reported as one. A gone holder's resources go stale: still held, never handed on
// by a timer.
export function runEnded(store: CoordStore, paneId: string, how: "finished" | "question" | "gone", now: string): Change[] {
  const byObjective = new Map<string, Transition[]>();
  const add = (o: string, tr: Transition | null) => { if (tr) byObjective.set(o, [...(byObjective.get(o) ?? []), tr]); };
  const cur = currentTaskBinding(store, paneId);
  if (cur && cur.t.binding && cur.t.status !== "complete" && cur.t.status !== "verifying") {
    const { o, t } = cur;
    const b = t.binding!;
    const unreported = b.prompted_at !== null && (b.last_report_at === null || b.last_report_at < b.prompted_at);
    const k = how === "gone" ? "worker_gone" : unreported ? "missing_report" : null;
    if (k && t.protocol !== k) {
      const before = prints(store, o, t);
      t.protocol = k;
      settle(store, o, t, before, now);
      add(o.id, transition(o, t.id, k, how === "gone" ? "the bound agent exited or its pane closed"
        : how === "question" ? "the bound agent ended its turn with a question in prose and no workdone-task report; a decision for a person is reported as blocker_kind human"
        : "the bound agent finished its turn without workdone-task", now));
    }
  }
  if (how === "gone") {
    for (const [r, l] of Object.entries(store.resources)) {
      if (l.pane_id !== paneId || l.stale_since) continue;
      add(l.objective, markStale(store, r, l, now));
    }
  }
  return [...byObjective].map(([objective, transitions]) => ({ objective, transitions }));
}

