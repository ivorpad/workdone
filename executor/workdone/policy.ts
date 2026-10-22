// Which WorkDone tools an Executor connection may see and call, for each access level the
// owner picks in Executor. No framework imports, so the repo's tests can run it.

export type Level = "read_only" | "approved_writes" | "everything";
export type Decision = "approved" | "denied" | "user-approval";
export interface Annotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  openWorldHint?: boolean;
}

/** The access-level account's method, as `providers.ts` names them, to its level. */
export function levelOfMethod(method: string): Level | undefined {
  if (method === "readOnly") return "read_only";
  if (method === "approvedWrites") return "approved_writes";
  if (method === "everything") return "everything";
  return undefined;
}

/** The tool names each tier holds. Exported so a test can hold them to WorkDone's own registry. */
export const TIERS = {
  /** Agent state, no side effects. */
  look: [
    "bridge_status", "overview", "supervisor_status", "owed_work", "coord_snapshot", "prunable_agents",
    "get_agent", "read_agent", "wait_agent", "list_panes", "list_workspaces", "read_pane",
    "list_repos", "list_worktrees", "get_profile",
  ],
  /** Leases, watches, layout and bookkeeping. They start no work on a machine. */
  bookkeeping: [
    "claim_agents", "release_agents", "watch_agent", "coord_update", "rename", "focus", "move_pane",
    "split_pane", "create_workspace", "create_tab", "create_worktree",
  ],
  /** Starts, prompts or answers an agent, which runs code on a machine, or records the owner's acceptance. */
  drive: [
    "spawn_agent", "start_agent", "prompt_agent", "steer_agent", "supervisor_nudge", "send_agent_keys",
    "answer_agent", "settle_work", "wake_machine",
  ],
  /** ChatGPT's approval and link cards, its event hooks and WorkDone's own wake test. They do nothing here. */
  chatgptOnly: [
    "request_confirmation", "confirm_pending", "watch_here", "watch_next", "watch_stop", "wake_test", "wake_test_log",
  ],
} as const;

const LOOK = new Set<string>(TIERS.look);
const BOOKKEEPING = new Set<string>(TIERS.bookkeeping);
const DRIVE = new Set<string>(TIERS.drive);
const CHATGPT_ONLY = new Set<string>(TIERS.chatgptOnly);

/** Asked about at every level that can call them: settling is the owner's word, waking a box costs money. */
const ALWAYS_ASK = new Set(["settle_work", "wake_machine"]);

// Anything else is host-level: exec, raw pane input, files, close, browser runs, OpenClaw,
// set_agent_approval. Only the top level sees it, and a tool added later lands here.

export function visible(level: Level, name: string): boolean {
  if (CHATGPT_ONLY.has(name)) return false;
  if (LOOK.has(name)) return true;
  if (BOOKKEEPING.has(name) || DRIVE.has(name)) return level !== "read_only";
  return level === "everything";
}

export function decide(level: Level, name: string, annotations: Annotations | undefined, input: unknown): Decision {
  if (!visible(level, name)) return "denied";
  // `confirm: true` is the caller saying the owner already approved a gated operation.
  // Executor asks the owner itself instead of taking that on trust.
  if (typeof input === "object" && input !== null && (input as { confirm?: unknown }).confirm === true) return "user-approval";
  if (LOOK.has(name) || BOOKKEEPING.has(name)) return "approved";
  if (DRIVE.has(name)) {
    const ask = level === "approved_writes" || ALWAYS_ASK.has(name) || annotations?.destructiveHint === true;
    return ask ? "user-approval" : "approved";
  }
  return annotations?.readOnlyHint === true ? "approved" : "user-approval";
}
