// Gateway ops for the coordination state (coord.ts, docs/coordination.md).
// coord_snapshot: the supervisor's read (view "resume" for the bounded one).
// coord_update: its plan, merges and acknowledgements, under its lease.
// coord_report: a worker's delta, authorized by its binding token (workdone-task).
// prompt_agent and steer_agent call bindAndSlice for the opt-in turn contract.

import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { GatewayError, TARGET_RE, paneInScope } from "./config.ts";
import { checkpoint } from "./checkpoint.ts";
import { ack, bindTask, byToken, ensureObjective, getObjective, notePrompted, OBJECTIVE_ID_RE, ownedBy, planTasks, reportTask, resolveOwners, type Change, type CoordStore, type Objective, type Task } from "./coord.ts";
import { resumeView, snapshotView, taskSlice, type Live } from "./coord-views.ts";
import type { Gateway } from "./gateway.ts";
import type { StateStore } from "./state.ts";
import { optBool, optStr, str, type Op, type Params } from "./params.ts";

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

// A transition is persisted before this runs. The tell route is the existing
// notification path, to the thread holding the worker's pane: a hint, not proof.
export function notifyTransitions(state: StateStore, store: CoordStore, changes: Change[]) {
  for (const c of changes) {
    const o = store.objectives[c.objective];
    for (const tr of c.transitions) {
      const pane = o?.tasks[tr.task]?.binding?.pane_id ?? o?.tasks[tr.task]?.owner?.pane_id;
      if (!pane) continue;
      state.addTold({ pane_id: pane, text: `[coord] ${c.objective} ${tr.task} ${tr.kind} (seq ${tr.seq})${tr.detail ? `: ${tr.detail.slice(0, 200)}` : ""}. coord_snapshot view=resume has the state.`, at: tr.at });
    }
  }
}

// The task a pane owns, for agent views: what tells a waiting agent from a working one.
export function paneTask(g: Gateway, paneId: string, name: string | null) {
  for (const o of Object.values(g.state.coord().objectives)) {
    const owned = ownedBy(o, paneId, name);
    // The open slice, else the last accepted one (it makes the agent prunable).
    const t = owned.find((x) => x.status !== "complete") ?? owned.filter((x) => x.status === "complete").sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0];
    if (t) return { objective: o.id, id: t.id, status: t.status, version: t.version, blocker: t.blocker, blocker_kind: t.blocker_kind, protocol: t.protocol, unmet_deps: t.deps.filter((d) => o.tasks[d]?.status !== "complete") };
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

// The opt-in turn contract at a prompt boundary. With task {objective, id}: bind that
// task to this agent's run under the objective's supervisor lease. Without it: a pane
// already bound to an open task gets its current slice; any other pane gets nothing,
// and its prompt goes in exactly as written. Read when the prompt is sent.
export function bindAndSlice(g: Gateway, agent: any, params: Params, prompting = true): string | null {
  const ask = params.task;
  if (ask !== undefined && ask !== null && (typeof ask !== "object" || typeof (ask as any).objective !== "string" || typeof (ask as any).id !== "string")) {
    throw new GatewayError("invalid_params", "task is {objective, id}");
  }
  const now = new Date().toISOString();
  const lease = ask ? g.leases.requireLive(params) : null;
  return g.state.updateCoord((store) => {
    let o: Objective | undefined;
    let t: Task | undefined;
    if (ask) {
      o = getObjective(store, (ask as any).objective);
      supervisorCheck(o, lease);
      t = bindTask(store, o.id, (ask as any).id, { pane_id: agent.pane_id, session: agent.agent_session?.value ?? null, name: agent.name ?? null }, newToken(), newRunId(), now);
    } else {
      for (const x of Object.values(store.objectives)) {
        const hit = Object.values(x.tasks).find((y) => y.binding?.pane_id === agent.pane_id && y.status !== "complete");
        if (hit) { o = x; t = hit; break; }
      }
    }
    if (!o || !t?.binding) return null;
    if (prompting) notePrompted(store, o.id, t.id, now);
    return taskSlice(store, o, t, cliPath(), t.binding.token);
  });
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
      const { change, store } = g.state.updateCoord((store) => {
        const o = ensureObjective(store, id, typeof params.title === "string" ? params.title : undefined, now);
        if (expected !== undefined && o.version !== expected) throw new GatewayError("version_conflict", `objective ${id} is at version ${o.version}, not ${expected}: read coord_snapshot and merge again (or pass a per-task expected_version)`);
        supervisorCheck(o, lease, optBool(params, "take_over", false));
        const change = planTasks(store, id, params.tasks, params.resources, now);
        if (typeof params.title === "string" && params.title.trim()) o.title = params.title.trim().slice(0, 200);
        if (repo !== undefined) o.repo = g.cwdFrom({ cwd: repo });
        if (params.ack_seq !== undefined) ack(o, params.ack_seq);
        o.supervisor = lease ?? o.supervisor;
        resolveOwners(o, agents);
        return { change, store: structuredClone(store) };
      });
      notifyTransitions(g.state, store, [change]);
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
      const { out, store, changes } = g.state.updateCoord((store) => {
        let o: Objective;
        let t: Task;
        if (token) {
          ({ o, t } = byToken(store, token));
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
        const view = () => ({ objective: o.id, objective_version: o.version, task: { ...t, binding: undefined, report_ids: undefined }, deps: t.deps.map((d) => ({ id: d, status: o.tasks[d]?.status ?? "missing" })) });
        if (!Object.keys(delta).length) return { out: view(), store, changes: [] };
        const change = reportTask(store, o.id, t.id, delta as any, now);
        return { out: { ...view(), ...(change.duplicate ? { duplicate: true } : {}) }, store: structuredClone(store), changes: [change] };
      });
      // Persisted above; only then the notification.
      notifyTransitions(g.state, store, changes);
      if (changes.length && !(out as any).duplicate) g.state.audit({ op: "coord_report", ok: true, args: { objective: (out as any).objective, task: (out as any).task?.id, status: (out as any).task?.status } });
      return out;
    },
  };
}
