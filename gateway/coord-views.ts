// Read side of the coordination state (coord.ts): the supervisor's snapshot and resume
// views, the critical path, and the bounded slice a bound worker gets with each prompt.

import { humanBlocked, type Binding, type CoordStore, type Objective, type ResourceLease, type Task } from "./coord.ts";

// The longest chain of unfinished tasks, from the first that has to happen to the last.
export function criticalPath(o: Objective): string[] {
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
  for (const t of Object.values(o.tasks)) {
    if (t.status === "complete") continue;
    const c = chain(t.id);
    if (c.length > longest.length) longest = c;
  }
  return longest;
}

export type Live = Record<string, { status: string; name: string | null; session: string | null }>;

// A resource's state for views: held, or stale because its holder is gone or restarted.
export function resourceView(l: ResourceLease, live: Live) {
  const agent = l.pane_id ? live[l.pane_id] : undefined;
  const gone = l.stale_since !== null || (l.pane_id !== null && (!agent || (l.session !== null && agent.session !== null && agent.session !== l.session)));
  return { ...l, state: gone ? "stale" as const : "held" as const };
}

function taskView(store: CoordStore, o: Objective, t: Task, live: Live) {
  const unmet = t.deps.filter((d) => o.tasks[d]?.status !== "complete");
  const holds = Object.entries(store.resources).filter(([, l]) => l.objective === o.id && l.task === t.id).map(([r]) => r);
  const pane = t.binding?.pane_id ?? t.owner?.pane_id ?? null;
  const agent = pane ? live[pane] : undefined;
  const { binding, receipts: _r, pending, ...rest } = t;
  return {
    ...rest,
    progress: t.progress ?? 0,
    binding: binding ? { id: binding.id, pane_id: binding.pane_id, generation: binding.generation, prompted_at: binding.prompted_at, last_report_at: binding.last_report_at, dispatch: binding.dispatch ? { command_id: binding.dispatch.command_id, state: binding.dispatch.state, at: binding.dispatch.at } : null, current: store.current?.[binding.pane_id] === binding.id } : null,
    pending_dispatch: pending ? { command_id: pending.command_id, pane_id: pending.binding.pane_id, at: pending.at } : null,
    unmet_deps: unmet,
    holds,
    owner_status: agent ? agent.status : pane ? "gone" : t.owner ? "unresolved" : null,
    // The task's word wins over the terminal's: an agent waiting on a dependency is not
    // working, whatever its pane shows.
    activity: t.status === "executing" && agent && agent.status !== "working" ? `executing (agent ${agent.status})` : t.status,
  };
}

// The supervisor's full read of one objective.
export function snapshotView(store: CoordStore, o: Objective, live: Live = {}) {
  const tasks = Object.values(o.tasks).map((t) => taskView(store, o, t, live));
  return {
    id: o.id, title: o.title, repo: o.repo, version: o.version, updated_at: o.updated_at,
    supervisor: o.supervisor ? "…" + o.supervisor.slice(-4) : null,
    tasks,
    ready: tasks.filter((t) => t.status === "queued" && t.unmet_deps.length === 0).map((t) => t.id),
    waiting: tasks.filter((t) => t.status === "waiting_dependency").map((t) => ({ id: t.id, kind: t.blocker_kind, on: t.unmet_deps, resources: t.waiting_for, blocker: t.blocker })),
    blocked: tasks.filter((t) => t.status !== "complete" && t.status !== "waiting_dependency" && (t.status === "blocked" || t.blocker !== null)).map((t) => ({ id: t.id, status: t.status, kind: t.blocker_kind, blocker: t.blocker, next_action: t.next_action })),
    critical_path: criticalPath(o),
    resources: Object.fromEntries(Object.entries(store.resources).filter(([, l]) => l.objective === o.id).map(([r, l]) => [r, resourceView(l, live)])),
    pending_transitions: o.transitions.filter((x) => x.seq > o.acked_seq),
    acked_seq: o.acked_seq,
    complete: tasks.length > 0 && tasks.every((t) => t.status === "complete"),
  };
}

// The coordinator's bounded resume view: what needs a decision now. Evidence by count.
export function resumeView(store: CoordStore, o: Objective, live: Live = {}) {
  const tasks = Object.values(o.tasks).map((t) => taskView(store, o, t, live));
  const brief = (t: ReturnType<typeof taskView>) => ({ id: t.id, title: t.title, status: t.status, owner: t.owner?.name ?? null, owner_status: t.owner_status, next_action: t.next_action, evidence_count: t.evidence.length, version: t.version, progress: t.progress });
  // A blocker is open until it is cleared, whatever the status: a worker's partial result
  // (verifying) next to a human blocker still needs that person, and so does a task that
  // also waits on a resource. Other waits are listed apart.
  const open = tasks.filter((t) => t.status !== "complete" && (t.blocker !== null || t.status === "blocked") && t.status !== "waiting_dependency");
  return {
    id: o.id, version: o.version, supervisor: o.supervisor ? "…" + o.supervisor.slice(-4) : null,
    pending_transitions: o.transitions.filter((x) => x.seq > o.acked_seq),
    needs_acceptance: tasks.filter((t) => t.status === "verifying").map((t) => ({ ...brief(t), result: t.result, acceptance: t.acceptance, blocker: t.blocker, blocker_kind: t.blocker_kind })),
    protocol: tasks.filter((t) => t.protocol).map((t) => ({ ...brief(t), protocol: t.protocol })),
    blocked_human: tasks.filter((t) => humanBlocked(t)).map((t) => ({ ...brief(t), blocker: t.blocker })),
    blocked_other: open.filter((t) => t.blocker_kind !== "human").map((t) => ({ ...brief(t), kind: t.blocker_kind, blocker: t.blocker })),
    waiting: tasks.filter((t) => t.status === "waiting_dependency").map((t) => ({ ...brief(t), kind: t.blocker_kind, on: t.unmet_deps, resources: t.waiting_for })),
    ready: tasks.filter((t) => t.status === "queued" && t.unmet_deps.length === 0).map(brief),
    executing: tasks.filter((t) => t.status === "executing").map(brief),
    stale_resources: Object.entries(store.resources).filter(([, l]) => l.objective === o.id).map(([r, l]) => ({ resource: r, ...resourceView(l, live) })).filter((x) => x.state === "stale"),
    critical_path: criticalPath(o),
  };
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

// The bounded slice a bound worker gets with each prompt: identity, acceptance,
// dependencies, resources, the last evidence, the next action and how to report.
// b is the binding the slice goes out with: a new one is still pending at that point.
export function taskSlice(store: CoordStore, o: Objective, t: Task, cli: string, token: string, b: Binding | null = t.binding): string {
  const deps = t.deps.map((d) => `${d} (${o.tasks[d]?.status ?? "missing"})`).join(", ");
  const holds = Object.entries(store.resources).filter(([, l]) => l.objective === o.id && l.task === t.id && !l.stale_since
    // A pending binding on the same pane and session takes over what the current one holds.
    && ((l.binding ?? null) === (b?.id ?? null) || (!!b && !!l.binding && l.binding === t.binding?.id && l.pane_id === b.pane_id && l.session === b.session))).map(([r, l]) => `${r}@${l.generation}`);
  const earlier = t.evidence.length - 3;
  return [
    `[WorkDone task] objective ${o.id} v${o.version}: ${clip(o.title, 120)}`,
    `Task ${t.id} v${t.version}, run ${b?.id ?? "unbound"}, generation ${b?.generation ?? t.generation}, status ${t.status}: ${clip(t.title, 160)}`,
    ...(t.acceptance.length ? ["Acceptance:", ...t.acceptance.slice(0, 8).map((a) => `- ${clip(a, 200)}`)] : []),
    ...(deps ? [`Depends on: ${deps}`] : []),
    ...(holds.length ? [`You hold: ${holds.join(", ")} (release with name@generation)`] : []),
    ...(t.evidence.length ? [`Evidence so far${earlier > 0 ? ` (last 3 of ${t.evidence.length})` : ""}: ${t.evidence.slice(-3).map((e) => clip(e, 200)).join("; ")}`] : []),
    ...(t.blocker ? [`Blocker (${t.blocker_kind ?? "unspecified"}): ${clip(t.blocker, 200)}`] : []),
    ...(t.next_action ? [`Next action: ${clip(t.next_action, 300)}`] : []),
    `Report this task only, from your shell: ${cli} --token ${token} '<json>'`,
    "JSON fields: status (executing | waiting_dependency | blocked), evidence [..], artifacts [..], blocker + blocker_kind (dependency | resource | defect with next_action | human), wait_for [resource], acquire / release [resource or resource@generation], result {summary, commit}, report_id (new for new content; resend the same report with the same id). A result moves the task to verifying: not acceptance, not a push. A decision or answer only the owner can give goes in blocker with blocker_kind human; a question asked only in your reply is not tracked. Report before you end the turn.",
  ].join("\n");
}
