// The coordinator note at the head of a spawned agent's first prompt: delegate big,
// separable work to subagents, using the agent's own mechanism. Only spawn_agent adds
// it, to its own first prompt. prompt_agent and steer_agent text is never touched.

// What each harness offers, in a line or two. A kind not listed here gets GENERIC:
// it is told to use a subagent feature only if it has one.
const HOW: Record<string, string> = {
  claude: "Use your Agent (Task) tool; custom subagents are defined under .claude/agents.",
  codex: "If your Codex build has subagents, ask for them (custom ones are defined under .codex/agents).",
  cursor: "If your Cursor build has subagents, use them (custom ones are defined under .cursor/agents).",
  opencode: "Use your Task tool to run a subagent (custom ones are defined under .opencode/agents).",
};
const GENERIC = "Use a subagent or task tool only if you have one.";

const LIMITS = [
  "Delegate only work that is large and splits into parts, and give each subagent its own files so two never edit the same one.",
  "One level: tell each subagent not to start subagents or other agents.",
  "If a subagent fails, change the step or report it. Don't rerun the same step.",
  "If the task is small, or you have no subagent feature, do it yourself. Don't start another agent process from the shell to get around that.",
  "You alone answer the owner and report on any task.",
].join(" ");

export function coordinatorNote(kind: string): string {
  return `You are the coordinator for this task. ${HOW[kind] ?? GENERIC} ${LIMITS}`;
}

// The first prompt with the note ahead of it, or null when it should go unchanged: off,
// a reviewer (never asked to fan out, docs/loop-risks.md), or no room under the limit.
export function withCoordinator(
  kind: string, prompt: string, opts: { enabled: boolean; role: string; max: number },
): string | null {
  if (!opts.enabled || opts.role === "reviewer") return null;
  const text = `${coordinatorNote(kind)}\n\n${prompt}`;
  return text.length > opts.max ? null : text;
}
