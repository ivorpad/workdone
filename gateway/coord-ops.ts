// Gateway ops for the coordination state (coord.ts, docs/coordination.md).
// coord_snapshot: the supervisor's read (view "resume" for the bounded one).
// coord_update: its plan, merges and acknowledgements, under its lease.
// coord_report: a worker's delta, authorized by its binding token (workdone-task).
// prompt_agent and steer_agent call dispatchSlice for the opt-in turn contract.

import { createHash, randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { GatewayError, TARGET_RE, paneInScope } from "./config.ts";
import { checkpoint } from "./checkpoint.ts";
import { ack, byToken, canonical, currentTaskBinding, protoKey, taskIdentity, ensureObjective, getObjective, OBJECTIVE_ID_RE, ownedBy, planTasks, prepareDispatch, reportTask, resolveOwners, settleDispatch, unmetDeps, type Change, type CoordStore, type Objective, type Task } from "./coord.ts";
import { resumeView, snapshotView, taskSlice, type Live } from "./coord-views.ts";
import type { Gateway } from "./gateway.ts";
import type { StateStore } from "./state.ts";
import { optBool, optStr, str, type Op, type Params } from "./params.ts";
import { closeCoordWork } from "./work.ts";

function objectiveId(params: Params): string {
  const id = str(params, "objective");
  if (!OBJECTIVE_ID_RE.test(id)) throw new GatewayError("invalid_params", "objective must be a short lowercase id, e.g. relay-pwc");
  return id;
}

async function liveAgents(g: Gateway): Promise<{ agents: any[]; live: Live }> {
  const agents: any[] = ((await g.herdr("agent.list", {}).catch(() => null))?.agents ?? []).filter((a: any) => paneInScope(a, g.cfg.allowedRoots));
  const live: Live = Object.fromEntries(agents.map((a: any) => [a.pane_id, { status: a.agent_status ?? "unknown", name: a.name ?? null, session: a.agent_session?.value ?? null }]));
  return { agents, live };
}

// The workdone-task path on this machine, as the gateway sees it: agents get an absolute
// path, so a shell without ~/.local/bin on PATH still finds it.
const cliPath = () => join(process.env.HOME ?? homedir(), ".local/bin/workdone-task");
const newToken = () => `wdt_${randomBytes(24).toString("base64url")}`;
const newRunId = () => `run_${randomBytes(6).toString("hex")}`;
const newCommandId = () => `cmd_${randomBytes(8).toString("hex")}`;

// A transition is persisted before this runs. It goes to the supervisor of the objective
// it belongs to (its lease), never to whichever worker pane touched it: a released
// resource can wake another objective's waiter, and a newly ready task has no worker.
// The event id is the transition's own identity, so a repeat is one delivery. A hint,
// not proof: coord_snapshot view=resume is the truth.
export function notifyTransitions(state: StateStore, store: CoordStore, changes: Change[]) {
  for (const c of changes) {
    for (const tr of c.transitions) {
      const objective = tr.objective ?? c.objective;
      const o = store.objectives[objective];
      const pane = o?.tasks[tr.task]?.binding?.pane_id ?? null;
      state.addTold({
        pane_id: pane, objective, event_id: `coord:${objective}:${tr.seq}`,
        ...(o?.supervisor ? { recipient_lease: o.supervisor } : {}),
        transition: { task: tr.task, seq: tr.seq, kind: tr.kind },
        text: `[coord] ${objective} ${tr.task} ${tr.kind} (seq ${tr.seq})${tr.detail ? `: ${tr.detail.slice(0, 200)}` : ""}. coord_snapshot view=resume has the state.`, at: tr.at,
      });
    }
  }
}

function taskBrief(o: Objective, t: Task) {
  return { objective: o.id, id: t.id, identity: taskIdentity(o, t), status: t.status, version: t.version, progress: t.progress ?? 0, blocker: t.blocker, blocker_kind: t.blocker_kind, protocol: t.protocol, unmet_deps: unmetDeps(o, t), commit: t.result?.commit ?? null };
}

// The task a pane works on, for agent views and supervision: its current binding (one
// resolver for slices, attribution and state), else a task planned for it by name that
// nobody bound. An earlier binding on the pane is history and never shows here.
export function paneTask(g: Gateway, paneId: string, name: string | null, session?: string | null) {
  const store = g.state.coord();
  const cur = currentTaskBinding(store, paneId, session);
  if (cur) return taskBrief(cur.o, cur.t);
  for (const o of Object.values(store.objectives)) {
    const owned = ownedBy(o, paneId, name).filter((t) => !t.binding);
    const t = owned.find((x) => x.status !== "complete") ?? owned.filter((x) => x.status === "complete").sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0];
    if (t) return taskBrief(o, t);
  }
  return null;
}

// lease comes from leases.requireLive, called before updateCoord: both take the state
// lock, and a nested take would wait out its timeout.
function supervisorCheck(o: Objective, lease: string | null, takeOver = false) {
  if (lease && o.supervisor && o.supervisor !== lease && !takeOver) {
    throw new GatewayError("not_your_objective", `objective ${o.id} is supervised by another thread (lease …${o.supervisor.slice(-4)}); take_over: true only when the user moves it here`);
  }
}

// How a send to Herdr failed. Herdr's own refusal (agent_busy, agent_not_ready, ...)
// means nothing went in. A transport failure after the request left (no answer, a closed
// or broken socket) may or may not have delivered it.
const AMBIGUOUS = new Set(["herdr_timeout", "herdr_closed", "herdr_bad_response", "herdr_unavailable"]);
export const sendOutcome = (err: unknown): "refused" | "unknown" =>
  err instanceof GatewayError && !AMBIGUOUS.has(err.code) ? "refused" : "unknown";

export interface SliceDispatch { slice: string; command_id: string; settle(outcome: "delivered" | "refused" | "unknown"): { command_id: string; state: string } }
// A retry of a bound prompt that was already delivered: nothing is sent again.
export interface ReplayedDispatch { replay: { command_id: string; state: string; task: string; objective: string } }
const COMMAND_ID_RE = /^[\w.:-]{1,80}$/;

// The caller's own intent, set by Gateway.request before it stamps the text with
// provenance (time, lease): a retry stamped a minute later is still the same command.
// A symbol, so no caller can supply it in JSON params.
export const INTENT = Symbol("dispatch intent");
export interface Intent { op: string; text: string }

// The opt-in turn contract at a prompt boundary, in two halves around the send. With task
// {objective, id}: a new binding of that task to this agent's run, under the
// objective's supervisor lease, pending until the prompt is delivered. Without it: a pane
// whose current binding is open gets its slice; any other pane gets nothing, and its
// prompt goes in exactly as written. Either way the task must be ready to execute.
// settle records what happened, under the lock, with notifications in the same commit.
// command_id (the caller's, else a new one) and the prompt text make the send
// idempotent: see prepareDispatch. prompting false (spawn with no prompt) binds at once
// and sends nothing.
export function dispatchSlice(g: Gateway, agent: any, params: Params, text: string, prompting = true, op = "prompt_agent"): SliceDispatch | ReplayedDispatch | null {
  const ask = params.task;
  if (ask !== undefined && ask !== null && (typeof ask !== "object" || typeof (ask as any).objective !== "string" || typeof (ask as any).id !== "string")) {
    throw new GatewayError("invalid_params", "task is {objective, id}");
  }
  const given = optStr(params, "command_id");
  if (given !== undefined && (!COMMAND_ID_RE.test(given) || protoKey(given))) throw new GatewayError("invalid_params", "command_id is a short id of letters, digits, _ . : - (and not a built-in name such as __proto__)");
  const intent: Intent = (params as any)[INTENT] ?? { op, text };
  const cmd = { id: given ?? newCommandId(), hash: createHash("sha256").update(canonical({ op: intent.op, pane: agent.pane_id, task: ask ?? null, text: intent.text })).digest("hex") };
  const sentAt = new Date().toISOString();
  const lease = ask ? g.leases.requireLive(params) : null;
  const run = { pane_id: agent.pane_id, session: agent.agent_session?.value ?? null, name: agent.name ?? null };
  type Ready = { objective: string; task: string; binding_id: string; command_id: string; fresh: boolean; slice: string };
  // Binding at once (no prompt) can make an earlier run's lease stale: that transition is
  // notified in the same commit.
  const p = g.state.transaction(() => g.state.updateCoord((store): Ready | ReplayedDispatch | null => {
    if (ask) supervisorCheck(getObjective(store, (ask as any).objective), lease);
    const p = prepareDispatch(store, ask ? (ask as any) : null, run, cmd, newToken(), newRunId(), sentAt, prompting);
    if (!p) return null;
    if (!("replay" in p) && p.transitions?.length) notifyTransitions(g.state, structuredClone(store), [{ objective: p.o.id, transitions: p.transitions }]);
    if ("replay" in p) return { replay: { command_id: cmd.id, state: p.replay.state, task: p.replay.task, objective: p.replay.objective } };
    return { objective: p.o.id, task: p.t.id, binding_id: p.binding.id, command_id: p.command_id, fresh: p.fresh, slice: taskSlice(store, p.o, p.t, cliPath(), p.binding.token, p.binding) };
  }));
  if (!p || "replay" in p) return p;
  let settled: { command_id: string; state: string } | null = null;
  return {
    slice: p.slice,
    command_id: p.command_id,
    settle(outcome) {
      if (settled) return settled;
      g.state.transaction(() => {
        const { changes, store } = g.state.updateCoord((store) => ({ changes: settleDispatch(store, { ...p, sent_at: sentAt }, outcome, new Date().toISOString()), store: structuredClone(store) }));
        notifyTransitions(g.state, store, changes);
      });
      return settled = { command_id: p.command_id, state: outcome };
    },
  };
}

export function coordOps(g: Gateway): Record<string, Op> {
  return {
    async coord_snapshot(params) {
      const store = g.state.coord();
      const want = optStr(params, "objective");
      const view = optStr(params, "view") ?? "full";
      if (view !== "full" && view !== "resume") throw new GatewayError("invalid_params", "view is full or resume");
      if (want && !store.objectives[want]) throw new GatewayError("unknown_objective", `no objective ${want} on this machine`);
      const { agents, live } = await liveAgents(g);
      const objectives = await Promise.all((want ? [want] : Object.keys(store.objectives)).map(async (id) => {
        // Owners resolved for the view only: a read changes nothing.
        const o: Objective = structuredClone(store.objectives[id]!);
        const ambiguous = resolveOwners(o, agents);
        const out: Record<string, unknown> = view === "resume" ? resumeView(store, o, live) : snapshotView(store, o, live);
        if (ambiguous.length) out.ambiguous_owners = ambiguous;
        if (o.repo && view === "full") {
          const cp = await checkpoint(g.cfg, o.repo);
          out.git = cp ? { branch: cp.branch, commit: cp.commit ?? null, upstream: cp.upstream, ahead: cp.ahead, clean: cp.clean } : null;
        }
        return out;
      }));
      return { objectives };
    },

    // The supervisor's plan, merges and acknowledgements for one objective.
    async coord_update(params) {
      const id = objectiveId(params);
      const expected = params.expected_version;
      if (expected !== undefined && (typeof expected !== "number" || !Number.isInteger(expected) || expected < 0)) throw new GatewayError("invalid_params", "expected_version is the version a snapshot returned");
      const repo = optStr(params, "repo");
      if (repo !== undefined) g.cwdFrom({ cwd: repo });
      const { agents, live } = await liveAgents(g);
      const now = new Date().toISOString();
      const lease = g.leases.requireLive(params);
      // The change, its notification and the work it accepts commit together.
      const { change, store } = g.state.transaction(() => {
        const r = g.state.updateCoord((store) => {
          const o = ensureObjective(store, id, typeof params.title === "string" ? params.title : undefined, now);
          if (expected !== undefined && o.version !== expected) throw new GatewayError("version_conflict", `objective ${id} is at version ${o.version}, not ${expected}: read coord_snapshot and merge again (or pass a per-task expected_version)`);
          supervisorCheck(o, lease, optBool(params, "take_over", false));
          const was = new Map(Object.values(o.tasks).map((t) => [t.id, t.status]));
          const change = planTasks(store, id, params.tasks, params.resources, now);
          const completed = Object.values(store.objectives[id]!.tasks).filter((t) => t.status === "complete" && was.get(t.id) !== "complete").map((t) => t.id);
          if (typeof params.title === "string" && params.title.trim()) o.title = params.title.trim().slice(0, 200);
          if (repo !== undefined) o.repo = g.cwdFrom({ cwd: repo });
          if (params.ack_seq !== undefined) ack(o, params.ack_seq);
          o.supervisor = lease ?? o.supervisor;
          resolveOwners(o, agents);
          return { change, store: structuredClone(store), completed };
        });
        notifyTransitions(g.state, r.store, [r.change]);
        // A task merged complete is the owner's acceptance of the work bound to it.
        closeCoordWork(g.state, id, r.completed, now);
        return r;
      });
      g.state.audit({ op: "coord_update", ok: true, args: { objective: id, version: store.objectives[id]!.version, tasks: Array.isArray(params.tasks) ? params.tasks.map((t: any) => t?.id) : [] } });
      return snapshotView(store, store.objectives[id]!, live);
    },

    // Internal, run by a worker with workdone-task. token authorizes one binding;
    // HERDR_PANE_ID (pane_id) is a convenience that works only for unbound owners.
    // No delta: the worker's own task slice.
    async coord_report(params) {
      const token = optStr(params, "token");
      const paneParam = optStr(params, "pane_id", TARGET_RE);
      if (!token && !paneParam) throw new GatewayError("invalid_params", "pass the --token from your task slice (or run inside your Herdr pane)");
      const { agents, live } = await liveAgents(g);
      const delta: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(params)) if (!["token", "pane_id", "objective", "task", "id"].includes(k)) delta[k] = v;
      const now = new Date().toISOString();
      const { out, changes } = g.state.transaction(() => {
        const r = g.state.updateCoord((store) => {
          let o: Objective;
          let t: Task;
          // A report with a pending binding's token commits it; what that produced goes out too.
          let early: Change[] = [];
          if (token) {
            const hit = byToken(store, token);
            ({ o, t } = hit);
            if (hit.transitions.length) early = [{ objective: o.id, transitions: hit.transitions }];
            const b = t.binding!;
            const agent = live[b.pane_id];
            // The run the token was issued to must still be there: same pane, same session.
            if (!agent || (b.session !== null && agent.session !== null && agent.session !== b.session)) {
              throw new GatewayError("stale_binding", `the run bound to ${t.id} is gone or restarted; the supervisor rebinds the task`);
            }
          } else {
            const me = agents.find((a: any) => a.pane_id === paneParam);
            if (!me) throw new GatewayError("not_found", `agent ${paneParam} not found`);
            const want = optStr(params, "objective");
            const mine: Array<{ o: Objective; t: Task }> = [];
            for (const x of Object.values(store.objectives)) {
              if (want && x.id !== want) continue;
              resolveOwners(x, agents);
              for (const y of ownedBy(x, paneParam!, me.name ?? null)) mine.push({ o: x, t: y });
            }
            const taskId = optStr(params, "task");
            const open = mine.filter((m) => m.t.status !== "complete");
            const pick = taskId ? mine.find((m) => m.t.id === taskId) : open.length === 1 ? open[0] : undefined;
            if (!pick) {
              if (!Object.keys(delta).length && !taskId) return { out: { tasks: mine.map((m) => ({ objective: m.o.id, task: m.t.id, status: m.t.status })) }, store, changes: [] };
              throw new GatewayError(taskId ? "not_your_task" : open.length ? "task_required" : "no_task", taskId ? `you own no task ${taskId}` : open.length ? `you own ${open.map((m) => m.t.id).join(", ")}: pass task` : "no coordination task is assigned to this agent");
            }
            ({ o, t } = pick);
            if (t.binding && Object.keys(delta).length) throw new GatewayError("token_required", `${t.id} is bound to a run: report with the --token from your task slice`);
          }
          // What this run holds, with the generation a fenced release (name@generation) names.
          const holds = () => Object.fromEntries(Object.entries(store.resources).filter(([, l]) => l.objective === o.id && l.task === t.id && !l.stale_since && (l.binding ?? null) === (t.binding?.id ?? null)).map(([r, l]) => [r, l.generation]));
          const view = () => ({ objective: o.id, objective_version: o.version, task: { ...t, binding: undefined, pending: undefined, receipts: undefined }, holds: holds(), deps: t.deps.map((d) => ({ id: d, status: o.tasks[d]?.status ?? "missing" })) });
          if (!Object.keys(delta).length) return { out: view(), store: structuredClone(store), changes: early };
          const change = reportTask(store, o.id, t.id, delta as any, now);
          return { out: { ...view(), receipt: change.receipt, ...(change.duplicate ? { duplicate: true } : {}) }, store: structuredClone(store), changes: [...early, change] };
        });
        // Written in the same commit as the report, never before it.
        notifyTransitions(g.state, r.store, r.changes);
        return r;
      });
      if (changes.length && !(out as any).duplicate) g.state.audit({ op: "coord_report", ok: true, args: { objective: (out as any).objective, task: (out as any).task?.id, status: (out as any).task?.status } });
      return out;
    },
  };
}
