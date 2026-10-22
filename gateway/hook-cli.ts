// Run by scripts/hook.sh (workdone-hook) from a Claude Code or Codex hook, in the agent's own pane:
// passes what the hook got to this machine's gateway (hooks.ts) and, for
// UserPromptSubmit, prints the provenance as additionalContext. It never fails the
// hook: anything that goes wrong prints nothing, and the agent carries on as without it.
//
// usage: bun hook-cli.ts SessionStart|UserPromptSubmit|Stop [claude|codex]   (hook input JSON on stdin)
//
// Codex (0.163, probed 2026-10-22) sends the same fields with turn_id where Claude Code
// has prompt_id (a queued steer shares the turn's), the prompt unwrapped, and fires
// SessionStart with the first prompt rather than at startup. Its Stop takes JSON or
// nothing on stdout: nothing is printed there.

import { dirname, resolve } from "node:path";

const OPS: Record<string, string> = { SessionStart: "hook_hello", UserPromptSubmit: "hook_prompt", Stop: "hook_stop" };
// Herdr's name for the agent, which the gateway compares with the pane's agent.
const KINDS = new Set(["claude", "codex"]);

export function hookRequest(event: string, input: any, paneId: string, kind = "claude"): { op: string; params: Record<string, unknown> } | null {
  const op = OPS[event];
  if (!op || typeof input?.session_id !== "string" || !KINDS.has(kind)) return null;
  const params: Record<string, unknown> = { pane_id: paneId, session_id: input.session_id, kind };
  if (event !== "SessionStart") {
    const id = input.prompt_id ?? input.turn_id;
    if (typeof id !== "string") return null;
    params.prompt_id = id;
  }
  if (event === "UserPromptSubmit") params.prompt = typeof input.prompt === "string" ? input.prompt : "";
  if (event === "Stop") params.text = typeof input.last_assistant_message === "string" ? input.last_assistant_message : "";
  return { op, params };
}

// What the hook prints: additionalContext for a prompt WorkDone sent, else nothing.
export function hookOutput(event: string, reply: string): string {
  if (event !== "UserPromptSubmit") return "";
  try {
    const context = JSON.parse(reply.split("\n")[0] ?? "")?.result?.context;
    return typeof context === "string" && context ? JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: context } }) : "";
  } catch {
    return "";
  }
}

if (import.meta.main) {
  try {
    const event = process.argv[2] ?? "";
    const paneId = process.env.HERDR_PANE_ID ?? "";
    const req = hookRequest(event, JSON.parse((await Bun.stdin.text()) || "{}"), paneId, process.argv[3] || "claude");
    if (req) {
      const launcher = process.env.HERDR_GATEWAY_LAUNCHER ?? resolve(dirname(import.meta.path), "herdr-gateway-launcher.sh");
      const proc = Bun.spawn([launcher], { stdin: new Blob([JSON.stringify({ id: "hook", ...req }) + "\n"]), stdout: "pipe", stderr: "ignore" });
      const out = hookOutput(event, await new Response(proc.stdout).text());
      await proc.exited;
      if (out) process.stdout.write(out);
    }
  } catch { /* nothing printed: the agent goes on without provenance */ }
  process.exit(0);
}
