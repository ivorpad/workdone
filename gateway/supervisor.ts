// Pure orchestration policy. Callers supply observations oldest first, from one
// agent session: the turn records the watcher kept (commit, tree, diff digest per
// finished turn) and the live state now. No clocks, model tables or repository rules.
//
// Bounded by construction: at most one nudge per agent session, then the advice is a
// handoff or a model/effort change, never a second nudge, a retry or a new reviewer.
export interface SupervisorObservation {
  status: string;
  session?: string | null;
  seq?: number;
  // Distinct completed turns, not poll timestamps or status transitions.
  turn?: string;
  at?: string;
  // Comparable evidence tokens: commit ID, its tree and digest of the actual diff/status.
  // Omit unavailable evidence; an empty diff digest is still a known checkpoint.
  commit?: string;
  tree?: string;
  diff?: string;
  clean?: boolean;
  ahead?: number | null;
  upstream?: string | null;
  activity?: string;
  // A bound worker's coordination task (coord.ts): progress moves only on substantive
  // work; version is merge metadata and moves on heartbeats too, so it is never progress.
  task_progress?: number;
  task_version?: number;
  // Which task and binding the turn belonged to: progress counters of different tasks or
  // runs are not comparable.
  task_identity?: { objective: string; id: string; binding: string };
  attention?: "question" | "dialog" | null;
  owner_required?: boolean;
  prompt_running?: boolean;
}

export interface SupervisorOptions {
  role?: "worker" | "reviewer";
  // Nudges already sent, from supervisor_nudge.
  nudges?: ReadonlyArray<{ at: string; session: string | null; after_turn?: string | null }>;
  // Where the agent started: a commit beyond it is work that landed.
  baseline?: { commit?: string; session?: string | null } | null;
  // A reply: true result has not been delivered yet.
  result_pending?: boolean;
  // The coordination task this agent owns (coord.ts), if any.
  // commit: the worker's result commit, which makes it a coding task whose publication
  // has to show before its agent is prunable.
  task?: { id: string; status: string; version?: number; progress?: number; blocker: string | null; unmet_deps: string[]; commit?: string | null };
}

export const SUPERVISOR_ACTIONS = ["continue", "nudge_ship_slice", "lower_or_change_model_effort", "handoff", "verify_checkpoint", "ask_owner", "prune_close"] as const;
export type SupervisorAction = (typeof SUPERVISOR_ACTIONS)[number];
export type SupervisorState = "progressing" | "stalled" | "repetitive_loop" | "blocked" | "waiting_dependency" | "checkpoint_ready" | "accepted" | "landed" | "unknown";
export interface SupervisorDiagnosis {
  state: SupervisorState;
  recommendations: Array<{ action: SupervisorAction; reasons: string[]; evidence: string[] }>;
}

const SETTLED = new Set(["idle", "done"]);
const short = (s: string | number | undefined) => (typeof s === "string" && /^[a-f0-9]{40,64}$/.test(s) ? s.slice(0, 12) : String(s ?? "unknown"));

export function supervise(current: SupervisorObservation, history: readonly SupervisorObservation[] = [], opts: SupervisorOptions = {}): SupervisorDiagnosis {
  const role = opts.role ?? "worker";
  const result = (state: SupervisorState, action: SupervisorAction, reason: string, evidence: string[]): SupervisorDiagnosis =>
    ({ state, recommendations: [{ action, reasons: [reason], evidence }] });
  if (current.status === "blocked" || current.attention) {
    return result("blocked", current.owner_required === true ? "ask_owner" : "handoff",
      current.owner_required === true ? "An explicit owner decision is required." : "Resolve the question or dialog with the existing coordinator and authority.",
      [`status=${current.status}`, `attention=${current.attention ?? "dialog"}`, `owner_required=${current.owner_required === true}`]);
  }

  // Waiting on another task is not a stall: no nudge, no handoff, until it unblocks.
  if (opts.task && (opts.task.status === "waiting_dependency" || opts.task.status === "blocked")) {
    return result("waiting_dependency", "continue", opts.task.status === "blocked"
      ? "Its coordination task is blocked; the supervisor resolves the blocker, not the agent."
      : "Its coordination task waits on a dependency; it is not working and not stalled.",
    [`task=${opts.task.id}`, `task_status=${opts.task.status}`, `unmet_deps=${opts.task.unmet_deps.join(",") || "none"}`, ...(opts.task.blocker ? [`blocker=${opts.task.blocker}`] : [])]);
  }

  // Never compare across restarts or unknown session identities, nor, for a bound worker,
  // across tasks or runs: a new task's first turns are not a stall of the old one's.
  const same_task = (o: SupervisorObservation) => !opts.task || (!!o.task_identity && !!current.task_identity
    && o.task_identity.objective === current.task_identity.objective && o.task_identity.id === current.task_identity.id && o.task_identity.binding === current.task_identity.binding);
  const prior = current.session ? history.filter((o) => o.session === current.session && same_task(o)) : [];
  const recorded = prior.filter((o) => o.turn !== undefined);
  const last = recorded.at(-1);
  // The current observation can itself be a turn record (the one that just ended).
  const turns = current.turn !== undefined && current.turn !== last?.turn ? [...recorded, current] : recorded;
  const nudge = current.session ? opts.nudges?.filter((n) => n.session === current.session).at(-1) : undefined;
  // A bound worker shares its repo with others, so HEAD and the tree move for all of them:
  // its own task progress is the evidence (history without it is unknown, never HEAD or
  // version). Everyone else keeps commit and diff.
  const keys = opts.task ? (["task_progress"] as const) : (["commit", "diff"] as const);
  const known = (o: SupervisorObservation) => keys.every((k) => o[k] !== undefined);
  const same = (a: SupervisorObservation, b: SupervisorObservation) => keys.every((k) => a[k] === b[k]);
  const differs = (a: SupervisorObservation, b: SupervisorObservation) =>
    keys.filter((k) => a[k] !== undefined && b[k] !== undefined && a[k] !== b[k]);

  // Files are changing under a working agent: progress in flight.
  if (current.turn === undefined && last && current.status === "working") {
    const moved = differs(last, current);
    if (moved.length) return result("progressing", "continue", "The working tree changed since the last finished turn.", moved.map((k) => `${k}: ${short(last[k])} -> ${short(current[k])}`));
  }

  // Two finished turns in a row that left commit and diff exactly where they were.
  const window = turns.slice(-3);
  const live = current.turn === undefined && known(current) ? current : null;
  const noCheckpoint = window.length === 3 && window.every(known)
    && new Set(window.map((o) => o.turn)).size === 3
    && window.every((o) => same(o, window[2]!))
    && (!live || same(live, window[2]!));
  if (noCheckpoint) {
    const head = window[2]!;
    const repeated = !!head.activity && window.every((o) => o.activity === head.activity);
    const state: SupervisorState = repeated ? "repetitive_loop" : "stalled";
    const evidence = [`turns=${window.map((o) => o.turn).join(",")}`, `unchanged commit=${short(head.commit)}`, `unchanged tree=${short(head.tree)}`, `unchanged diff=${head.diff}`,
      ...(repeated ? [`repeated answer digest=${head.activity}`] : [])];
    if (role === "reviewer") return result(state, "handoff", "Return the review to the coordinator; do not nudge a reviewer or create another review.", evidence);
    if (!nudge) {
      return result(state, "nudge_ship_slice", repeated
        ? "Three turns gave the same answer and left the checkpoint unchanged. This session's one nudge: ask for the smallest verifiable slice or the blocker."
        : "Two finished turns produced no new commit or diff. This session's one nudge: ask for the smallest verifiable slice or the blocker.", evidence);
    }
    const since = Date.parse(nudge.at);
    const after = turns.filter((o) => o.at !== undefined && Date.parse(o.at) > since);
    const nudged = `nudged at ${nudge.at}${nudge.after_turn ? ` after turn ${nudge.after_turn}` : ""}`;
    if (!after.length) return result(state, "continue", "This session's one nudge was sent; wait for the turn it started before deciding again.", [...evidence, nudged]);
    return result(state, repeated ? "lower_or_change_model_effort" : "handoff", repeated
      ? "The answer still repeats after this session's one nudge. Change model or effort, or take the task back; there is no second nudge."
      : "Still no new commit or diff after this session's one nudge. Hand the task off or take it back; there is no second nudge.",
    [...evidence, nudged, `turns since nudge=${after.map((o) => o.turn).join(",")}`]);
  }

  if (SETTLED.has(current.status) && !current.prompt_running) {
    const upstream = current.upstream ?? last?.upstream;
    const ahead = current.upstream ? current.ahead : last?.upstream ? last.ahead : undefined;
    const publication = upstream ? `upstream=${upstream} ahead=${ahead ?? "unknown"}` : "upstream=none";
    // Published: the branch has an upstream and nothing on it is ahead of it.
    const unpublished = !upstream ? "no upstream, so publication is unknown" : typeof ahead !== "number" ? "ahead of upstream is unknown" : ahead > 0 ? `${ahead} commit${ahead > 1 ? "s" : ""} not pushed to ${upstream}` : null;
    if (opts.task) {
      const t = opts.task;
      const evidence = [`task=${t.id}`, `task_status=${t.status}`, `status=${current.status}`, ...(t.commit ? [`task_commit=${short(t.commit)}`, publication] : [])];
      if (t.status !== "complete") {
        return result("checkpoint_ready", "verify_checkpoint", `The agent has settled; its task is ${t.status}, not accepted. Not prunable until the supervisor accepts it complete.`, evidence);
      }
      if (opts.result_pending) return result("accepted", "verify_checkpoint", "Its task was accepted, but a reply: true result is still owed. Not prunable yet.", evidence);
      // Accepted is not published: a task that produced a commit needs that shown too.
      if (t.commit && unpublished) {
        return result("accepted", "verify_checkpoint", `Its task was accepted complete, but its commit is not shown published: ${unpublished}. Not prunable until it is pushed (or the supervisor closes it deliberately).`, evidence);
      }
      return t.commit
        ? result("landed", "prune_close", "Its task was accepted complete and its branch is published. Leave the agent open unless the owner asks to close or clean it up, or it was spawned disposable (prunable_agents gives what to close).", evidence)
        : result("accepted", "prune_close", "Its task was accepted complete; it produced no commit, so there is nothing to publish. Leave the agent open unless the owner asks to close or clean it up, or it was spawned disposable (prunable_agents gives what to close).", evidence);
    }
    // A baseline from another session (an agent restarted in the pane) says nothing about this one.
    const ours = opts.baseline && (opts.baseline.session == null || opts.baseline.session === current.session);
    const base = ours ? opts.baseline!.commit : undefined;
    const head = current.commit ?? last?.commit;
    const clean = current.clean ?? last?.clean;
    const evidence = [`status=${current.status}`, "prompt_running=false", `baseline=${short(base)}`, `commit=${short(head)}`, `clean=${clean ?? "unknown"}`, ...(head ? [publication] : [])];
    if (base && head && head !== base && clean === true && !opts.result_pending && !unpublished) {
      return result("landed", "prune_close", "A commit beyond the start landed, is pushed, and the working tree is clean: the bounded unit is done. Check it. Leave the agent open unless the owner asks to close or clean it up, or it was spawned disposable (prunable_agents gives what to close).", evidence);
    }
    const why = !base || !head ? "no baseline or commit to compare" : head === base ? "no commit beyond the start yet" : clean !== true ? "uncommitted changes remain" : opts.result_pending ? "a reply: true result is still owed" : `not published: ${unpublished}`;
    return result("checkpoint_ready", "verify_checkpoint", `The agent has settled; verify its checkpoint before assigning more work. Not prunable: ${why}.`, evidence);
  }

  const lastTwo = turns.slice(-2);
  if (lastTwo.length === 2) {
    const moved = differs(lastTwo[0]!, lastTwo[1]!);
    if (moved.length) return result("progressing", "continue", "Checkpoint evidence changed between the last two turns.", moved.map((k) => `${k}: ${short(lastTwo[0]![k])} -> ${short(lastTwo[1]![k])}`));
  }
  const previous = prior.at(-1);
  if (previous && ((current.seq !== undefined && previous.seq !== undefined && current.seq > previous.seq) || current.status !== previous.status || (current.turn !== undefined && previous.turn !== undefined && current.turn !== previous.turn))) {
    return result("progressing", "continue", "Status or turn progression is visible; there is insufficient evidence of a stall.",
      [`status: ${previous.status} -> ${current.status}`, `seq: ${previous.seq ?? "unknown"} -> ${current.seq ?? "unknown"}`, `turn: ${previous.turn ?? "unknown"} -> ${current.turn ?? "unknown"}`]);
  }
  return result("unknown", "verify_checkpoint", "Insufficient comparable progress evidence; elapsed time alone cannot establish a stall.", [`status=${current.status}`, `comparable_history=${prior.length}`]);
}
