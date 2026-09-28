// MCP tool surface. Each tool forwards to the gateway op of the same name on one
// machine; the gateway on that machine is the authority for scope and capability
// checks. Listing tools called without a machine ask every machine at once.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { CallGateway, GatewayResponse } from "./gateway-client.ts";

const target = z.string().describe("Agent name or pane ID (e.g. w3T:pJR) from list_agents or overview.");
const paneId = z.string().describe("Pane ID from list_panes, list_workspaces or list_agents (e.g. w3T:pJR).");
const repo = z.string().describe("Repo key from list_repos.");
const path = z.string().describe("Absolute path or ~/..., inside the machine's allowed roots (see bridge_status).");
const cwd = z.string().optional().describe("Directory inside the allowed roots. Use this or repo.");
const label = z.string().max(80).optional();
const lines = z.number().int().min(1).max(400).optional().describe("How many recent lines to read (default 120).");
const source = z
  .enum(["recent_unwrapped", "recent", "visible", "detection"])
  .optional()
  .describe("Which snapshot to read. recent_unwrapped (default) suits transcripts and logs.");
const timeoutMs = z.number().int().min(1000).max(110_000).optional().describe("Wait budget in ms, at most 110000.");
const layoutKind = z.enum(["pane", "tab", "workspace"]);
const agentKind = z.string().describe("Agent kind, one of bridge_status agent_kinds for that machine.");
const effort = z.string().optional().describe("Reasoning effort, one of bridge_status agents[kind].efforts (default: agents[kind].effort).");
const watch = z.boolean().optional().describe("Notify the owner's phone whenever it finishes a turn, asks something, stops at a dialog or exits (default true).");

const READ = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, openWorldHint: false };
const SHELL = { readOnlyHint: false, destructiveHint: true, openWorldHint: true };

interface ToolDef {
  title: string;
  description: string;
  input: z.ZodRawShape;
  annotations: typeof READ;
}

// Called without a machine, these ask every machine and key the answer by machine name.
export const FANOUT = new Set(["bridge_status", "overview", "list_agents", "list_panes", "list_workspaces", "list_repos"]);

export const TOOLS: Record<string, ToolDef> = {
  bridge_status: {
    title: "Bridge status",
    description: "Check each machine's gateway: Herdr version, allowed roots, repos, agent kinds and which capabilities (exec, file reads and writes, raw pane input, closing anything) are on. Tools behind a capability that is off return capability_disabled.",
    input: {},
    annotations: READ,
  },
  overview: {
    title: "Overview of agents",
    description:
      "One call for 'what are my agents doing?': every agent with status, directory, git branch and changed-file count, the start of its last reply, the running prompt if any, and the dialog text when it is blocked. attention is dialog (a menu is up: an approval, a question, folder trust; choices lists its numbered options for answer_agent) or question (stopped and its last reply asks the owner something); watch says whether WorkDone notifies the owner about it and what it last reported.",
    input: {},
    annotations: READ,
  },
  list_agents: {
    title: "List agents",
    description: "List coding agents running in Herdr panes, with status (idle, working, blocked, done, unknown) and working directory.",
    input: {},
    annotations: READ,
  },
  get_agent: {
    title: "Get agent",
    description: "Show one agent's status, location, attention (dialog or question, else null), choices (the numbered options of a menu that is up, for answer_agent) and watch (whether WorkDone notifies the owner about it, and its last report).",
    input: { target },
    annotations: READ,
  },
  read_agent: {
    title: "Read agent output",
    description:
      "Read an agent. source=reply returns its last complete answer as clean text from its transcript (agents that keep one), plus the prompt it is working on now. The other sources return terminal text; use recent_unwrapped or detection to see a dialog.",
    input: { target, lines, source: z.enum(["reply", "recent_unwrapped", "recent", "visible", "detection"]).optional().describe("reply, or a terminal snapshot (default recent_unwrapped).") },
    annotations: READ,
  },
  prompt_agent: {
    title: "Prompt agent",
    description:
      "Submit a prompt to an idle agent. With wait=true, blocks until the agent settles (idle, done or blocked) or the timeout passes, and returns its reply for agents that keep a transcript (check reply.matches_prompt). If it is still working, the owner gets a phone notification when it finishes. Fails with agent_blocked if the agent shows a menu: answer it with answer_agent first. For an agent that is working, use steer_agent.",
    input: {
      target,
      text: z.string().min(1).describe("The prompt text."),
      wait: z.boolean().optional().describe("Wait for the agent to settle before returning (default false)."),
      timeout_ms: timeoutMs,
    },
    annotations: WRITE,
  },
  wait_agent: {
    title: "Wait for agent",
    description: "Wait until an agent reaches one of the given states (default: any settled state).",
    input: {
      target,
      until: z.array(z.enum(["idle", "working", "blocked", "done", "unknown"])).optional(),
      timeout_ms: timeoutMs,
    },
    annotations: READ,
  },
  watch_agent: {
    title: "Watch agent",
    description:
      "Notify the owner's phone every time this agent finishes a turn, asks a question, stops at an approval dialog or exits, with a short excerpt, until it exits or you call again with stop=true. Use it for agents started outside WorkDone, e.g. typed into a pane; start_agent and spawn_agent already watch the agents they start.",
    input: { target, stop: z.boolean().optional().describe("Stop notifying about this agent.") },
    annotations: WRITE,
  },
  answer_agent: {
    title: "Answer agent menu",
    description:
      "Answer the menu an agent is showing (approval, question, folder trust, update notice) with the option the user chose. Take the numbers from choices in get_agent, read_agent or overview; WorkDone presses the right keys for that agent. Only after the user has seen the question and the options and decided: never approve or pick on your own. option is one number; a multi-select menu takes options, a list, and then shows a review step to answer with another call. text goes with an option marked free_text (Claude's 'Type something', 'tell the agent what to do instead'); passing only text picks that option. Returns the agent's status and the next menu if one follows (dialog), else the end of its screen.",
    input: {
      target,
      option: z.number().int().min(1).optional().describe("The chosen option's n."),
      options: z.array(z.number().int().min(1)).optional().describe("Multi-select only: every option that should end up checked."),
      text: z.string().optional().describe("For an option marked free_text: what to type."),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  },
  steer_agent: {
    title: "Steer working agent",
    description:
      "Send a message to an agent while it works, e.g. a correction or 'stop after this step'. WorkDone types it the way that agent takes a mid-turn message: most queue it until the current tool call ends; some send it at once (delivery says which). An idle agent gets it as a normal prompt. Fails with agent_blocked when a menu is up, so a message never answers one.",
    input: { target, text: z.string().min(1).describe("The message.") },
    annotations: WRITE,
  },
  send_agent_keys: {
    title: "Send keys to agent",
    description:
      "Send a few raw keys to an agent's UI, e.g. esc or ctrl+c to interrupt. To answer a menu use answer_agent, which knows each agent's keys. Allowed: enter esc tab shift+tab up down left right space backspace ctrl+c y n 1-9. Confirm with the user before approving anything.",
    input: { target, keys: z.array(z.string()).min(1).max(10) },
    annotations: WRITE,
  },
  spawn_agent: {
    title: "Spawn agent",
    description:
      "Start a new agent in one call: make a place for it, start it, wait until it is ready, and optionally send a first prompt. Placement: worktree_branch (with repo) makes a new git worktree; split_from splits that pane; workspace_id adds a tab; otherwise a new workspace. The owner is notified whenever it finishes or needs them (watch). If it comes back blocked, it is usually the folder trust dialog: read_agent and ask the user.",
    input: {
      kind: agentKind,
      effort,
      name: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/).describe("Unique lowercase name for the agent."),
      repo: repo.optional(),
      cwd,
      worktree_branch: z.string().optional().describe("Create a git worktree for this branch of repo and start the agent there."),
      split_from: z.string().optional().describe("Pane ID to split."),
      workspace_id: z.string().optional().describe("Workspace to add a tab to."),
      label: label.describe("Label for a new workspace or tab (default: the agent name)."),
      prompt: z.string().optional().describe("First prompt to send once the agent is ready."),
      wait: z.boolean().optional().describe("Wait for the first prompt's answer (default false)."),
      args: z.array(z.string()).max(20).optional().describe("Extra command-line arguments for the agent (needs exec)."),
      watch,
    },
    annotations: WRITE,
  },
  start_agent: {
    title: "Start agent",
    description: "Start a coding agent in an existing idle shell pane and give it a name. spawn_agent does placement, start and first prompt in one call.",
    input: {
      pane_id: paneId,
      kind: agentKind,
      effort,
      name: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/).describe("Unique lowercase name for the agent."),
      args: z.array(z.string()).max(20).optional().describe("Extra command-line arguments for the agent (needs exec)."),
      watch,
    },
    annotations: WRITE,
  },
  list_panes: {
    title: "List panes",
    description: "List Herdr panes in allowed directories, including plain shell panes (agent is null).",
    input: {},
    annotations: READ,
  },
  list_workspaces: {
    title: "List workspaces",
    description: "The Herdr layout: workspaces, their tabs, and the panes in each, with labels and focus.",
    input: {},
    annotations: READ,
  },
  read_pane: {
    title: "Read pane output",
    description: "Read recent terminal output from any allowed pane, e.g. after run_repo_task or run_command_in_pane.",
    input: { pane_id: paneId, lines, source },
    annotations: READ,
  },
  split_pane: {
    title: "Split pane",
    description:
      "Split an existing pane to create a new shell pane without stealing focus. Pass repo or cwd to start the shell there; otherwise it inherits the source pane's directory.",
    input: { pane_id: paneId, direction: z.enum(["right", "down"]).optional(), repo: repo.optional(), cwd },
    annotations: WRITE,
  },
  create_workspace: {
    title: "Create workspace",
    description: "Create a Herdr workspace with one shell pane in a directory (repo or cwd).",
    input: { repo: repo.optional(), cwd, label, focus: z.boolean().optional().describe("Switch the Herdr window to it (default false).") },
    annotations: WRITE,
  },
  create_tab: {
    title: "Create tab",
    description: "Add a tab with one shell pane to a workspace. Directory: repo or cwd, else the workspace's.",
    input: { workspace_id: z.string(), repo: repo.optional(), cwd, label, focus: z.boolean().optional() },
    annotations: WRITE,
  },
  rename: {
    title: "Rename",
    description: "Rename a pane, tab, workspace or agent. Agent names must be lowercase (a-z, 0-9, _ -). Omit label to clear a pane label or agent name.",
    input: { kind: z.enum(["pane", "tab", "workspace", "agent"]), id: z.string().describe("Pane, tab or workspace ID, or agent name."), label },
    annotations: WRITE,
  },
  focus: {
    title: "Focus",
    description: "Bring a pane, tab, workspace or agent to the front in the Herdr window on that machine.",
    input: { kind: z.enum(["pane", "tab", "workspace", "agent"]), id: z.string() },
    annotations: WRITE,
  },
  move_pane: {
    title: "Move pane",
    description: "Move a pane into another tab (split right or down), into a new tab, or into a new workspace. A pane that changes workspace gets a new ID, returned here.",
    input: {
      pane_id: paneId,
      to: z.enum(["tab", "new_tab", "new_workspace"]),
      tab_id: z.string().optional().describe("Destination tab when to=tab."),
      workspace_id: z.string().optional().describe("Workspace for to=new_tab (default: the pane's own)."),
      direction: z.enum(["right", "down"]).optional(),
      label,
    },
    annotations: WRITE,
  },
  close: {
    title: "Close",
    description: "Close a pane, tab or workspace. Kills what runs in it. Without the close_any capability, only things this bridge created.",
    input: { kind: layoutKind, id: z.string() },
    annotations: DESTRUCTIVE,
  },
  send_pane_input: {
    title: "Send input to pane",
    description: "Type text and/or keys into any pane, e.g. answer a prompt in a shell, stop a server with ctrl+c, or quit a pager with q. Keys use Herdr names: enter, esc, tab, up, ctrl+c, ctrl+d, f5, pageup. Needs raw pane input.",
    input: { pane_id: paneId, text: z.string().optional(), keys: z.array(z.string()).max(20).optional() },
    annotations: DESTRUCTIVE,
  },
  list_repos: {
    title: "List repos",
    description: "List configured repos and the named tasks each one allows.",
    input: {},
    annotations: READ,
  },
  run_repo_task: {
    title: "Run repo task",
    description:
      "Run one of a repo's configured tasks in a shell pane whose directory is inside that repo. Returns immediately; use read_pane to follow output. exec returns output and exit code directly.",
    input: { repo, task: z.string().describe("Task name from list_repos."), pane_id: paneId },
    annotations: WRITE,
  },
  run_command_in_pane: {
    title: "Run command in pane",
    description: "Type a shell command into a shell pane and press enter, visible in Herdr. Use for servers, watchers and anything long-running; use exec when you want the output back.",
    input: { pane_id: paneId, command: z.string().min(1) },
    annotations: SHELL,
  },
  exec: {
    title: "Run shell command",
    description:
      "Run a shell command (login shell) and return exit code, stdout and stderr. Runs in cwd, repo, or the first allowed root. Output keeps its start and end when long. Pass stdin to feed input, e.g. command 'python3 -' with a script in stdin. Not for interactive or never-ending commands.",
    input: {
      command: z.string().min(1),
      cwd,
      repo: repo.optional(),
      timeout_ms: timeoutMs.describe("Kill it after this many ms (default 60000, max 110000)."),
      stdin: z.string().optional(),
    },
    annotations: SHELL,
  },
  browse: {
    title: "Browser run",
    description:
      "Start a Jev browser run in the persistent signed-in browser (machine ovh, where browser is on in bridge_status; the user watches it at https://ovh-vps.your-tailnet.ts.net) and return its id at once. Goals run in order in one tab; give each one outcome and a stop rule. The owner gets a phone notification when the run ends, so say that and stop instead of polling. Every step is a paid model call. DONE is the model's claim: check the final URL and page text with browse_status before telling the user it worked.",
    input: {
      url: z.string().describe("http(s) page to open first."),
      goals: z.array(z.string().min(1)).min(1).max(10).describe("One outcome per goal, e.g. 'Open the latest order. As soon as the order page is showing you are DONE.'"),
      label: z.string().max(80).optional().describe("Short name for the run in notifications."),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
  browse_status: {
    title: "Browser run status",
    description:
      "With id: a browser run's state (running, done, blocked, failed, stopped, lost), the summary with each goal's status and final URL, the end of its step log and the trace file path (read_file it for page text). Without id: the last 10 runs.",
    input: { id: z.string().optional() },
    annotations: READ,
  },
  browse_stop: {
    title: "Stop browser run",
    description: "Stop a running browser run. The tab stays where it was.",
    input: { id: z.string() },
    annotations: WRITE,
  },
  list_dir: {
    title: "List directory",
    description: "List a directory: names, types, sizes and modified times, folders first.",
    input: { path, include_hidden: z.boolean().optional(), limit: z.number().int().min(1).max(2000).optional() },
    annotations: READ,
  },
  read_file: {
    title: "Read file",
    description:
      "Read a file. Text comes back as text, paged with offset and next_offset. PDF, Word, PowerPoint, Excel, OpenDocument, RTF and EPUB are converted to Markdown. Images (png, jpg, gif, webp, up to 3 MB) come back as images. Other binaries are described; as=base64 returns raw bytes.",
    input: {
      path,
      as: z.enum(["auto", "text", "document", "image", "base64"]).optional(),
      offset: z.number().int().min(0).optional().describe("Byte offset (characters for documents)."),
      max_bytes: z.number().int().min(1).optional().describe("Window size (default 200000)."),
    },
    annotations: READ,
  },
  write_file: {
    title: "Write file",
    description: "Write a file. mode=create (default) fails if it exists; overwrite replaces it; append adds to the end. Creates missing folders. Use content for text or content_base64 for bytes.",
    input: {
      path,
      content: z.string().optional(),
      content_base64: z.string().optional(),
      mode: z.enum(["create", "overwrite", "append"]).optional(),
      make_parents: z.boolean().optional(),
    },
    annotations: DESTRUCTIVE,
  },
  move_path: {
    title: "Move or rename path",
    description: "Move or rename a file or folder within the allowed roots. Refuses to replace an existing target unless overwrite=true.",
    input: { from: path, to: path, overwrite: z.boolean().optional(), make_parents: z.boolean().optional() },
    annotations: DESTRUCTIVE,
  },
  delete_path: {
    title: "Delete path",
    description: "Delete a file or folder by moving it into the gateway's trash folder (~/.local/state/herdr-chatgpt/trash), so it can be recovered.",
    input: { path },
    annotations: DESTRUCTIVE,
  },
  search_files: {
    title: "Search files",
    description: "Search file contents under a folder with ripgrep (respects .gitignore). Returns path, line and text for each match.",
    input: {
      path,
      pattern: z.string().min(1).describe("Regular expression, or a literal with fixed_strings=true."),
      glob: z.string().optional().describe("Limit to files matching this glob, e.g. *.py or !tests/**."),
      fixed_strings: z.boolean().optional(),
      case_insensitive: z.boolean().optional(),
      include_hidden: z.boolean().optional(),
      max_results: z.number().int().min(1).max(1000).optional(),
    },
    annotations: READ,
  },
  list_worktrees: {
    title: "List worktrees",
    description: "List Git worktree workspaces for a configured repo.",
    input: { repo },
    annotations: READ,
  },
  create_worktree: {
    title: "Create worktree",
    description: "Create a Git worktree and Herdr workspace for a branch of a configured repo. spawn_agent with worktree_branch also starts an agent in it.",
    input: { repo, branch: z.string().describe("Branch name to create or check out.") },
    annotations: WRITE,
  },
  remove_worktree: {
    title: "Remove worktree",
    description: "Remove a worktree workspace. Needs the worktree_remove capability.",
    input: { workspace_id: z.string() },
    annotations: DESTRUCTIVE,
  },
};

type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

// Images from read_file travel as MCP image content; everything else as JSON text.
function render(res: GatewayResponse): { content: Content[]; isError: boolean } {
  if (!res.ok) return { content: [{ type: "text", text: JSON.stringify({ error: res.error }, null, 2) }], isError: true };
  const r = res.result as any;
  if (r && typeof r === "object" && typeof r.image?.data === "string") {
    const { image, ...meta } = r;
    return {
      content: [
        { type: "text", text: JSON.stringify({ ...meta, image: { mime: image.mime } }, null, 2) },
        { type: "image", data: image.data, mimeType: image.mime },
      ],
      isError: false,
    };
  }
  return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }], isError: false };
}

// Tools that can put an agent or a browser run on its machine's watch list.
const WATCHES = new Set(["prompt_agent", "spawn_agent", "start_agent", "watch_agent", "browse"]);

// onWatch tells the notifier which machine to poll after an agent may have been put on its watch list.
export function buildServer(call: CallGateway, machines: string[], defaultMachine: string, onWatch?: (machine: string) => void): McpServer {
  const server = new McpServer(
    { name: "herdr-remote", version: "0.5.1" },
    {
      instructions:
        `Controls Herdr terminal panes, coding agents, files and shell commands on the owner's machines (${machines.join(", ")}). ` +
        "Start with overview (every agent everywhere) or list_workspaces. IDs are per machine: pass the same machine to follow-up calls. " +
        "For agent work prefer prompt_agent with wait=true, which returns the reply, and spawn_agent for new agents (kind from bridge_status agent_kinds). " +
        "Agents started another way get phone notifications after watch_agent. " +
        "exec runs a command and returns its output; long-running processes belong in a pane (run_command_in_pane). " +
        "The Mac is often asleep: machine_offline means that machine did not answer, so carry on with the others and pass machine on every action.",
    },
  );
  // A plain string rather than an enum: ChatGPT caches tool schemas, and an enum
  // would hide a newly added machine until someone refreshes the app.
  for (const [name, def] of Object.entries(TOOLS)) {
    const fanout = FANOUT.has(name) && machines.length > 1;
    const machine = z
      .string()
      .optional()
      .describe(
        fanout
          ? `Machine to ask (${machines.join(", ")} when this was written). Omit to ask every machine; the answer is keyed by machine name.`
          : `Machine to act on (${machines.join(", ")} when this was written; default ${defaultMachine}). bridge_status without machine lists every machine.`,
      );
    server.registerTool(
      name,
      { title: def.title, description: def.description, inputSchema: { ...def.input, machine }, annotations: def.annotations },
      async (args: Record<string, unknown>) => {
        const { machine: chosen, ...params } = args ?? {};
        if (typeof chosen === "string" && !machines.includes(chosen)) {
          return render({ ok: false, error: { code: "unknown_machine", message: `machine ${chosen} is not configured; machines: ${machines.join(", ")}` } });
        }
        if (fanout && chosen === undefined) {
          const results = await Promise.all(machines.map(async (m) => [m, await call(m, name, params)] as const));
          const payload = Object.fromEntries(results.map(([m, r]) => [m, r.ok ? r.result : { error: r.error }]));
          return {
            content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
            isError: results.every(([, r]) => !r.ok),
          };
        }
        const target = typeof chosen === "string" ? chosen : defaultMachine;
        const res = await call(target, name, params);
        if (WATCHES.has(name)) onWatch?.(target);
        return render(res);
      },
    );
  }
  return server;
}
