// watch_here: the card that lets agents wake this ChatGPT thread. See inbox.ts.

import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { registerCard } from "./confirm.ts";
import { inbox, type Inbox, type WakeType } from "./inbox.ts";

// Versioned: ChatGPT caches a card by URI, so a changed card needs a new one.
export const WATCH_URI = "ui://workdone/watch-1.html";
const HTML = await Bun.file(new URL("./watch.html", import.meta.url)).text();
const LONG_POLL_MS = 20_000;

export function registerWatch(server: McpServer, machines: string[], defaultMachine: string, onWatch?: (machine: string) => void, box: Inbox = inbox) {
  registerCard(server, "watch", [WATCH_URI], { title: "Watching agents", description: "Wakes this chat when one of its agents asks something." }, HTML);

  server.registerTool(
    "watch_here",
    {
      title: "Answer this thread's agents",
      description:
        "Keep this chat answering its own agents while the user is away. Shows a small card that wakes this chat whenever an agent this thread's lease holds asks something or waits at a menu (with finished: true, also when one finishes a turn). Each wake arrives as a message starting \"[WorkDone watch]\": it comes from WorkDone, not from the user. Handle it: answer the agent's question or menu when the user's instructions settle it, and when it is the user's decision, tell them in one line and stop. Don't chat back and forth with an agent: one answer per wake. Only when the user asks you to keep answering, or to watch their agents. The card has to stay open in a browser (chatgpt.com or the desktop app) to wake the chat; it ends after max_rounds wakes or hours. Only watched agents report: spawn_agent and start_agent watch theirs; an agent claimed another way needs watch_agent first.",
      inputSchema: z.object({
        lease: z.string().describe("This thread's lease from claim_agents or spawn_agent."),
        machine: z.string().optional().describe(`Machine the agents run on (${machines.join(", ")}; default ${defaultMachine}).`),
        finished: z.boolean().optional().describe("Also wake when an agent finishes a turn, e.g. to review its work (default false)."),
        max_rounds: z.number().int().min(1).max(50).optional().describe("Wakes before the watch ends (default 20)."),
        hours: z.number().min(0.25).max(24).optional().describe("Hours before the watch ends (default 12)."),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      _meta: { ui: { resourceUri: WATCH_URI } },
    },
    async ({ lease, machine, finished, max_rounds, hours }) => {
      const m = machine ?? defaultMachine;
      if (!machines.includes(m)) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ error: { code: "unknown_machine", message: `machine ${m} is not configured; machines: ${machines.join(", ")}` } }) }], isError: true };
      }
      const wake: WakeType[] = finished ? ["question", "blocked", "finished"] : ["question", "blocked"];
      const state = box.open(m, lease, { wake, maxRounds: max_rounds, hours });
      // Make sure the notifier is polling that machine.
      onWatch?.(m);
      return {
        content: [{ type: "text" as const, text: `Watching this thread's agents on ${m} (lease ${lease}): up to ${state.max_rounds} wakes, until ${state.expires}. Tell the user in one line, then stop.` }],
        structuredContent: { ...state },
        isError: false,
      };
    },
  );

  server.registerTool(
    "watch_next",
    {
      title: "Next agent event",
      description: "Called by the watch card: waits for the next event for its watch.",
      inputSchema: z.object({ watch_id: z.string() }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      _meta: { ui: { visibility: ["app"] } },
    },
    async ({ watch_id }) => {
      const { events, state } = await box.next(watch_id, LONG_POLL_MS);
      return { content: [{ type: "text" as const, text: `${events.length} event(s)` }], structuredContent: { events, state }, isError: false };
    },
  );

  server.registerTool(
    "watch_stop",
    {
      title: "Stop watching",
      description: "Called by the watch card when the user presses Stop.",
      inputSchema: z.object({ watch_id: z.string() }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      _meta: { ui: { visibility: ["app"] } },
    },
    async ({ watch_id }) => ({ content: [{ type: "text" as const, text: "stopped" }], structuredContent: { state: box.stop(watch_id) }, isError: false }),
  );
}
