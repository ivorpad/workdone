// Gateway ops for the canonical coordination state (coord.ts). coord_snapshot is the
// supervisor's one read; coord_update its plan and merges, under its lease; coord_report
// is run by a worker agent in its own pane (workdone-task) and touches only its task.

import { GatewayError, TARGET_RE, paneInScope } from "./config.ts";
import { checkpoint } from "./checkpoint.ts";
import { OBJECTIVE_ID_RE, newObjective, ownedBy, planTasks, reportTask, resolveOwners, snapshotView, type Objective, type Task } from "./coord.ts";
import type { Gateway } from "./gateway.ts";
import { optBool, optStr, str, type Op, type Params } from "./params.ts";

function objectiveId(params: Params): string {
  const id = str(params, "objective");
  if (!OBJECTIVE_ID_RE.test(id)) throw new GatewayError("invalid_params", "objective must be a short lowercase id, e.g. relay-pwc");
  return id;
}

// Live agents in scope, for resolving owners and showing each owner's Herdr status.
async function liveAgents(g: Gateway) {
  const agents: any[] = ((await g.herdr("agent.list", {}).catch(() => null))?.agents ?? []).filter((a: any) => paneInScope(a, g.cfg.allowedRoots));
  return agents;
}

// The task a pane owns, for agent views: what tells a waiting agent from a working one.
export function paneTask(g: Gateway, paneId: string, name: string | null): { objective: string; id: string; status: Task["status"]; blocker: string | null; unmet_deps: string[] } | null {
  for (const o of Object.values(g.state.coord())) {
    const t = ownedBy(o, paneId, name).find((x) => x.status !== "complete");
    if (t) return { objective: o.id, id: t.id, status: t.status, blocker: t.blocker, unmet_deps: t.deps.filter((d) => o.tasks[d]?.status !== "complete") };
  }
  return null;
}

export function coordOps(g: Gateway): Record<string, Op> {
  return {
    async coord_snapshot(params) {
      const all = g.state.coord();
      const want = optStr(params, "objective");
      const ids = want ? [want] : Object.keys(all);
      if (want && !all[want]) throw new GatewayError("unknown_objective", `no objective ${want} on this machine`);
      const agents = await liveAgents(g);
      const live = Object.fromEntries(agents.map((a: any) => [a.pane_id, { status: a.agent_status ?? "unknown", name: a.name ?? null }]));
      const objectives = await Promise.all(ids.map(async (id) => {
        // Resolved for the view only: a read changes nothing.
        const { objective, ambiguous } = resolveOwners(all[id]!, agents);
        const view: Record<string, unknown> = snapshotView(objective, live);
        if (ambiguous.length) view.ambiguous_owners = ambiguous;
        if (objective.repo) {
          const cp = await checkpoint(g.cfg, objective.repo);
          view.git = cp ? { branch: cp.branch, commit: cp.commit ?? null, upstream: cp.upstream, ahead: cp.ahead, clean: cp.clean } : null;
        }
        return view;
      }));
      return { objectives };
    },

    // The supervisor's plan and canonical merges for one objective.
    async coord_update(params) {
      const id = objectiveId(params);
      const lease = g.leases.requireLive(params);
      const takeOver = optBool(params, "take_over", false);
      const expected = params.expected_version;
      if (expected !== undefined && (typeof expected !== "number" || !Number.isInteger(expected) || expected < 0)) throw new GatewayError("invalid_params", "expected_version is the version a snapshot returned");
      const repo = optStr(params, "repo");
      if (repo !== undefined) g.cwdFrom({ cwd: repo });
      const agents = await liveAgents(g);
      const now = new Date().toISOString();
      const out = g.state.updateCoord((all) => {
        const cur: Objective = all[id] ?? newObjective(id, typeof params.title === "string" ? params.title : id, now);
        if (expected !== undefined && cur.version !== expected) throw new GatewayError("version_conflict", `objective ${id} is at version ${cur.version}, not ${expected}: read coord_snapshot and merge again`);
        if (lease && cur.supervisor && cur.supervisor !== lease && !takeOver) {
          throw new GatewayError("not_your_objective", `objective ${id} is supervised by another thread (lease …${cur.supervisor.slice(-4)}); take_over: true only when the user moves it here`);
        }
        let next = planTasks(cur, params.tasks, params.resources, now);
        if (typeof params.title === "string" && all[id]) next.title = params.title.trim().slice(0, 200) || next.title;
        if (repo !== undefined) next.repo = g.cwdFrom({ cwd: repo });
        next.supervisor = lease ?? next.supervisor;
        next = resolveOwners(next, agents).objective;
        all[id] = next;
        return next;
      });
      g.state.audit({ op: "coord_update", ok: true, args: { objective: id, version: out.version, tasks: Array.isArray(params.tasks) ? params.tasks.map((t: any) => t?.id) : [] } });
      return snapshotView(out, Object.fromEntries(agents.map((a: any) => [a.pane_id, { status: a.agent_status ?? "unknown", name: a.name ?? null }])));
    },

    // Internal, run by a worker in its own pane ($HERDR_PANE_ID) with workdone-task.
    // No fields: the worker's own task slice and its dependencies' status.
    async coord_report(params) {
      const paneId = str(params, "pane_id", TARGET_RE);
      const agents = await liveAgents(g);
      const me = agents.find((a: any) => a.pane_id === paneId);
      if (!me) throw new GatewayError("not_found", `agent ${paneId} not found`);
      const name: string | null = me.name ?? null;
      const want = optStr(params, "objective");
      const fields = Object.keys(params).filter((k) => !["pane_id", "objective", "task", "id"].includes(k));
      const now = new Date().toISOString();
      return g.state.updateCoord((all) => {
        // Pin owners planned by name to this pane first, so the report can be checked.
        const mine: Array<{ o: Objective; t: Task }> = [];
        for (const [oid, o] of Object.entries(all)) {
          if (want && oid !== want) continue;
          all[oid] = resolveOwners(o, agents).objective;
          for (const t of ownedBy(all[oid]!, paneId, name)) mine.push({ o: all[oid]!, t });
        }
        const view = (o: Objective, t: Task) => ({
          objective: o.id, objective_version: o.version, task: t,
          deps: t.deps.map((d) => ({ id: d, status: o.tasks[d]?.status ?? "missing", owner: o.tasks[d]?.owner?.name ?? null })),
          holds: Object.entries(o.resources).filter(([, l]) => l.task === t.id).map(([r]) => r),
        });
        const taskId = optStr(params, "task");
        const open = mine.filter((m) => m.t.status !== "complete");
        const pick = taskId ? mine.find((m) => m.t.id === taskId) : open.length === 1 ? open[0] : undefined;
        if (!fields.length) {
          if (taskId && !pick) throw new GatewayError("not_your_task", `you own no task ${taskId}`);
          return { tasks: (pick ? [pick] : mine).map((m) => view(m.o, m.t)) };
        }
        if (!pick) {
          if (taskId) {
            const other = Object.values(all).find((o) => o.tasks[taskId]);
            throw new GatewayError(other ? "not_your_task" : "unknown_task", other ? `${taskId} is owned by ${other.tasks[taskId]!.owner?.name ?? "nobody"}: report only your own task` : `no task ${taskId}`);
          }
          throw new GatewayError(open.length ? "task_required" : "no_task", open.length ? `you own ${open.map((m) => m.t.id).join(", ")}: pass task` : "no coordination task is assigned to this agent");
        }
        const { task: _t, objective: _o, pane_id: _p, ...delta } = params;
        const next = reportTask(pick.o, pick.t.id, paneId, delta as any, now);
        all[pick.o.id] = next;
        g.state.audit({ op: "coord_report", ok: true, args: { objective: next.id, task: pick.t.id, pane_id: paneId, status: next.tasks[pick.t.id]!.status, version: next.version } });
        return view(next, next.tasks[pick.t.id]!);
      });
    },
  };
}
