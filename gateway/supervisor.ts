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
}

export const SUPERVISOR_ACTIONS = ["continue", "nudge_ship_slice", "lower_or_change_model_effort", "handoff", "verify_checkpoint", "ask_owner", "prune_close"] as const;
export type SupervisorAction = (typeof SUPERVISOR_ACTIONS)[number];
export type SupervisorState = "progressing" | "stalled" | "repetitive_loop" | "blocked" | "checkpoint_ready" | "landed" | "unknown";
export interface SupervisorDiagnosis {
  state: SupervisorState;
  recommendations: Array<{ action: SupervisorAction; reasons: string[]; evidence: string[] }>;
}

const SETTLED = new Set(["idle", "done"]);
const short = (s: string | undefined) => (s && /^[a-f0-9]{40,64}$/.test(s) ? s.slice(0, 12) : s ?? "unknown");

export function supervise(current: SupervisorObservation, history: readonly SupervisorObservation[] = [], opts: SupervisorOptions = {}): SupervisorDiagnosis {
  const role = opts.role ?? "worker";
  const result = (state: SupervisorState, action: SupervisorAction, reason: string, evidence: string[]): SupervisorDiagnosis =>
    ({ state, recommendations: [{ action, reasons: [reason], evidence }] });
  if (current.status === "blocked" || current.attention) {
    return result("blocked", current.owner_required === true ? "ask_owner" : "handoff",
      current.owner_required === true ? "An explicit owner decision is required." : "Resolve the question or dialog with the existing coordinator and authority.",
      [`status=${current.status}`, `attention=${current.attention ?? "dialog"}`, `owner_required=${current.owner_required === true}`]);
  }

  // Never compare across restarts or unknown session identities.
  const prior = current.session ? history.filter((o) => o.session === current.session) : [];
  const recorded = prior.filter((o) => o.turn !== undefined);
  const last = recorded.at(-1);
  // The current observation can itself be a turn record (the one that just ended).
  const turns = current.turn !== undefined && current.turn !== last?.turn ? [...recorded, current] : recorded;
  const nudge = current.session ? opts.nudges?.filter((n) => n.session === current.session).at(-1) : undefined;
  const known = (o: SupervisorObservation) => o.commit !== undefined && o.diff !== undefined;
  const differs = (a: SupervisorObservation, b: SupervisorObservation) =>
    (["commit", "diff"] as const).filter((k) => a[k] !== undefined && b[k] !== undefined && a[k] !== b[k]);

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
    && window.every((o) => o.commit === window[2]!.commit && o.diff === window[2]!.diff)
    && (!live || (live.commit === window[2]!.commit && live.diff === window[2]!.diff));
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
    // A baseline from another session (an agent restarted in the pane) says nothing about this one.
    const ours = opts.baseline && (opts.baseline.session == null || opts.baseline.session === current.session);
    const base = ours ? opts.baseline!.commit : undefined;
    const head = current.commit ?? last?.commit;
    const clean = current.clean ?? last?.clean;
    const evidence = [`status=${current.status}`, "prompt_running=false", `baseline=${short(base)}`, `commit=${short(head)}`, `clean=${clean ?? "unknown"}`,
      ...(current.upstream ? [`upstream=${current.upstream} ahead=${current.ahead ?? "unknown"}`] : current.commit ? ["upstream=none"] : [])];
    if (base && head && head !== base && clean === true && !opts.result_pending) {
      return result("landed", "prune_close", "A commit beyond the start landed and the working tree is clean: the bounded unit is done. Check it, then close the agent (prunable_agents gives what to close).", evidence);
    }
    const why = !base || !head ? "no baseline or commit to compare" : head === base ? "no commit beyond the start yet" : clean !== true ? "uncommitted changes remain" : "a reply: true result is still owed";
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
