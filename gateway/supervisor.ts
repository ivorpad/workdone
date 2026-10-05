// Pure orchestration policy. Callers supply observations oldest first, from one
// agent session. No clocks, model tables, repository rules or review spawning.
export interface SupervisorObservation {
  status: string;
  session?: string | null;
  seq?: number;
  // Distinct completed turns, not poll timestamps or status transitions.
  turn?: string;
  // Comparable evidence tokens: commit ID and digest of the actual diff/status.
  // Omit unavailable evidence; an empty diff digest is still a known checkpoint.
  commit?: string;
  diff?: string;
  activity?: string;
  attention?: "question" | "dialog" | null;
  owner_required?: boolean;
  prompt_running?: boolean;
}

export type SupervisorAction = "continue" | "nudge_ship_slice" | "lower_or_change_model_effort" | "handoff" | "verify_checkpoint" | "ask_owner";
export type SupervisorState = "progressing" | "stalled" | "repetitive_loop" | "blocked" | "checkpoint_ready" | "unknown";
export interface SupervisorDiagnosis {
  state: SupervisorState;
  recommendations: Array<{ action: SupervisorAction; reasons: string[]; evidence: string[] }>;
}

export function supervise(current: SupervisorObservation, history: readonly SupervisorObservation[] = [], role: "worker" | "reviewer" = "worker"): SupervisorDiagnosis {
  const result = (state: SupervisorState, action: SupervisorAction, reason: string, evidence: string[]): SupervisorDiagnosis =>
    ({ state, recommendations: [{ action, reasons: [reason], evidence }] });
  if (current.status === "blocked" || current.attention) {
    return result("blocked", current.owner_required === true ? "ask_owner" : "handoff",
      current.owner_required === true ? "An explicit owner decision is required." : "Resolve the question or dialog with the existing coordinator and authority.",
      [`status=${current.status}`, `attention=${current.attention ?? "dialog"}`, `owner_required=${current.owner_required === true}`]);
  }
  if (["idle", "done"].includes(current.status) && !current.prompt_running) {
    return result("checkpoint_ready", "verify_checkpoint", "The agent has settled; verify its checkpoint before assigning more work.", [`status=${current.status}`, "prompt_running=false"]);
  }

  // Never compare across restarts or unknown session identities.
  const prior = current.session ? history.filter((o) => o.session === current.session) : [];
  const previous = prior.at(-1);
  const changed = (key: "commit" | "diff") => previous?.[key] !== undefined && current[key] !== undefined && previous[key] !== current[key];
  const progress = (["commit", "diff"] as const).filter(changed);
  if (progress.length) return result("progressing", "continue", "Checkpoint evidence changed.", progress.map((key) => `${key}: ${previous![key]} -> ${current[key]}`));

  const window = [...prior, current].slice(-3);
  const noCheckpoint = window.length === 3 && window.every((o) => o.commit !== undefined && o.diff !== undefined && o.turn !== undefined)
    && new Set(window.map((o) => o.turn)).size === 3
    && window.every((o) => o.commit === current.commit && o.diff === current.diff);
  if (noCheckpoint) {
    const evidence = [`turns=${window.map((o) => o.turn).join(",")}`, `unchanged commit=${current.commit}`, `unchanged diff=${current.diff}`];
    const repeated = !!current.activity && window.every((o) => o.activity === current.activity);
    if (repeated) return result("repetitive_loop", role === "reviewer" ? "handoff" : "lower_or_change_model_effort",
      role === "reviewer" ? "Return the repeated review to the coordinator; do not create another review." : "Repeated activity across three turns produced no changed checkpoint; consider changing effort or approach.",
      [...evidence, `repeated activity=${current.activity}`]);
    return result("stalled", role === "reviewer" ? "handoff" : "nudge_ship_slice", "Three distinct turns produced no changed checkpoint; request a concrete slice or handoff.", evidence);
  }
  if (previous && ((current.seq !== undefined && previous.seq !== undefined && current.seq > previous.seq) || current.status !== previous.status || (current.turn !== undefined && previous.turn !== undefined && current.turn !== previous.turn))) {
    return result("progressing", "continue", "Status or turn progression is visible; there is insufficient evidence of a stall.",
      [`status: ${previous.status} -> ${current.status}`, `seq: ${previous.seq ?? "unknown"} -> ${current.seq ?? "unknown"}`, `turn: ${previous.turn ?? "unknown"} -> ${current.turn ?? "unknown"}`]);
  }
  return result("unknown", "verify_checkpoint", "Insufficient comparable progress evidence; elapsed time alone cannot establish a stall.", [`status=${current.status}`, `comparable_history=${prior.length}`]);
}
