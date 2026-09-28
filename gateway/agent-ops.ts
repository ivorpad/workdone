// Agent orchestration: a one-call overview of every agent, a one-call spawn (place,
// start, wait for ready, first prompt), watches that report every turn of an agent,
// and what each agent needs from its owner.

import { attentionOf, openDialog, screenReply } from "./attention.ts";
import { AGENT_NAME_RE, BRANCH_RE, GatewayError, TARGET_RE, paneInScope } from "./config.ts";
import type { Gateway } from "./gateway.ts";
import { optBool, optStr, str, type Op } from "./params.ts";
import { gitSummary } from "./process.ts";
import type { Watched } from "./state.ts";
import { agentReply, type Reply } from "./transcript.ts";
import { pollWatched, sendNotification } from "./watcher.ts";
import { agentView, lastLines, paneView, textOf, watchInfo, watchView } from "./views.ts";

const SETTLED = new Set(["idle", "done"]);
const SHELL_STARTING = new Set(["agent_pane_busy", "agent_pane_unavailable"]);

function clip(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "…" : s;
}

// Beyond Herdr's status: attention is "dialog" when a dialog is up and "question" when
// the agent stopped and its latest text asks the owner something; watch says whether
// the bridge reports on it. Pass what the caller already read to skip reading it again.
export async function lifecycle(g: Gateway, agent: any, watched: Record<string, Watched>, known: { reply?: Reply | null; screen?: string } = {}) {
  let text: string | null = null;
  if (SETTLED.has(agent.agent_status)) {
    const reply = known.reply !== undefined ? known.reply : await agentReply(g.cfg, agent).catch(() => null);
    if (reply) {
      // A prompt newer than the last answer makes that answer stale.
      text = reply.in_progress ? reply.in_progress.latest_text : reply.text;
    } else {
      const screen = known.screen ?? textOf(
        await g.herdr("agent.read", { target: agent.pane_id, source: "recent_unwrapped", lines: 60, format: "text", strip_ansi: true }).catch(() => null),
      );
      if (agent.agent === "cursor" && openDialog(screen)) return { attention: "dialog" as const, watch: watchView(watched[agent.pane_id]) };
      text = screenReply(screen);
    }
  }
  return { attention: attentionOf(agent.agent_status, text), watch: watchView(watched[agent.pane_id]) };
}

export function agentOps(g: Gateway): Record<string, Op> {
  return {
    // Internal, used by the MCP server's notifier rather than by ChatGPT.
    async watch_poll() {
      return await pollWatched(g.cfg, g.herdr, Date.now());
    },

    async notify(params) {
      const message = str(params, "message");
      if (message.length > 500 || message.includes("\n")) throw new GatewayError("invalid_params", "message must be one line under 500 characters");
      return await sendNotification(g.cfg, message);
    },

    // Report every turn of an agent until it exits, for agents the bridge did not
    // start, e.g. cursor-agent typed into a pane. stop=true ends the reports.
    async watch_agent(params) {
      const agent = await g.scopedAgent(str(params, "target", TARGET_RE));
      if (optBool(params, "stop", false)) {
        g.state.unwatch(agent.pane_id);
        return { watching: false, agent: agentView(agent) };
      }
      g.state.manage(agent.pane_id, watchInfo(agent), agent);
      return { watching: true, agent: { ...agentView(agent), ...(await lifecycle(g, agent, g.state.watched())) } };
    },

    async overview() {
      const res = await g.herdr("agent.list", {});
      const agents = (res.agents ?? []).filter((a: any) => paneInScope(a, g.cfg.allowedRoots));
      const watched = g.state.watched();
      const git = new Map<string, ReturnType<typeof gitSummary>>();
      const items = await Promise.all(
        agents.map(async (a: any) => {
          const view: Record<string, unknown> = agentView(a);
          const cwd: string = a.foreground_cwd ?? a.cwd;
          if (!git.has(cwd)) git.set(cwd, gitSummary(g.cfg, cwd));
          const blocked = a.agent_status === "blocked";
          const [gitInfo, reply] = await Promise.all([git.get(cwd)!, agentReply(g.cfg, a).catch(() => null)]);
          if (gitInfo) view.git = gitInfo;
          if (reply) {
            view.last_reply = {
              text: clip(reply.text, 500),
              at: reply.at,
              in_progress: reply.in_progress
                ? {
                  prompt: clip(reply.in_progress.prompt, 160),
                  latest_text: reply.in_progress.latest_text && clip(reply.in_progress.latest_text, 300),
                  interrupted: reply.in_progress.interrupted,
                }
                : null,
            };
          }
          // Without a transcript, or when a dialog is up, the screen is the only source.
          // Herdr can only scroll back through a working agent's screen while it is idle.
          let screen = "";
          if (blocked || !reply) {
            const src = blocked ? "detection" : a.agent_status === "working" ? "visible" : "recent_unwrapped";
            const read = await g.herdr("agent.read", { target: a.pane_id, source: src, lines: 60, format: "text", strip_ansi: true }).catch(() => null);
            if (read) {
              screen = textOf(read);
              view[blocked ? "dialog" : "screen_tail"] = lastLines(screen, blocked ? 25 : 12);
            }
          }
          Object.assign(view, await lifecycle(g, a, watched, { reply, screen }));
          return view;
        }),
      );
      const counts: Record<string, number> = {};
      for (const i of items) counts[String(i.status)] = (counts[String(i.status)] ?? 0) + 1;
      // Watched agents Herdr can't see because they run in the background of their pane.
      const seen = new Set(agents.map((a: any) => a.pane_id));
      const background = Object.entries(watched)
        .filter(([id, w]) => !seen.has(id) && (w.last_status === "background" || w.last_status === "stopped"))
        .map(([id, w]) => ({ pane_id: id, name: w.name, agent: w.kind ?? null, status: w.last_status, cwd: w.cwd, watch: watchView(w) }));
      return background.length ? { counts, agents: items, background } : { counts, agents: items };
    },

    // Where the agent goes: a new worktree (worktree_branch + repo), a split of an
    // existing pane (split_from), a new tab (workspace_id), or else a new workspace.
    async spawn_agent(params) {
      const { kind, alias, args } = g.agentKind(params);
      const name = str(params, "name", AGENT_NAME_RE);
      const watch = optBool(params, "watch", true);
      const prompt = optStr(params, "prompt");
      if (prompt && prompt.length > g.cfg.maxPromptChars) throw new GatewayError("invalid_params", `prompt exceeds ${g.cfg.maxPromptChars} characters`);
      const deadline = Date.now() + g.cfg.maxWaitMs - 5000;
      const left = () => deadline - Date.now();

      const branch = optStr(params, "worktree_branch", BRANCH_RE);
      const splitFrom = optStr(params, "split_from", TARGET_RE);
      const workspaceId = optStr(params, "workspace_id", TARGET_RE);
      const place = { repo: params.repo, cwd: params.cwd, label: params.label ?? name };
      let placed: any;
      if (branch) {
        const repo = g.repo(str(params, "repo"));
        const res = await g.herdr("worktree.create", { cwd: repo.path, branch, label: name, focus: false }, 60_000);
        for (const [k, id] of [["workspaces", res.workspace?.workspace_id], ["tabs", res.tab?.tab_id], ["panes", res.root_pane?.pane_id]] as const) {
          if (id) g.state.remember(k, id);
        }
        placed = { pane: paneView(res.root_pane), workspace_id: res.workspace?.workspace_id, worktree: res.worktree ?? null };
      } else if (splitFrom) {
        placed = await g.handle("split_pane", { pane_id: splitFrom, repo: params.repo, cwd: params.cwd });
      } else if (workspaceId) {
        placed = await g.handle("create_tab", { workspace_id: workspaceId, ...place });
      } else {
        placed = await g.handle("create_workspace", place);
      }
      const paneId: string | undefined = placed?.pane?.pane_id;
      if (!paneId) throw new GatewayError("spawn_failed", "Herdr did not return a pane for the new agent");

      // A new pane's shell can take a few seconds to reach its prompt, and Herdr won't
      // start an agent before that. agent_not_ready means the agent started but sits at
      // a dialog (e.g. folder trust).
      for (let attempt = 0; ; attempt++) {
        try {
          await g.herdr("agent.start", { pane_id: paneId, kind, name, args, timeout_ms: Math.min(30_000, left()) }, 45_000);
          break;
        } catch (err) {
          if (!(err instanceof GatewayError)) throw err;
          if (err.code === "agent_not_ready") break;
          if (SHELL_STARTING.has(err.code) && attempt < 20 && left() > 40_000) {
            await Bun.sleep(500);
            continue;
          }
          throw new GatewayError(err.code, `${err.message}; the new pane is ${paneId}: start_agent there, or close it`);
        }
      }
      g.mask.started(paneId, name, alias);
      const waited = await g.herdr(
        "agent.wait", { target: paneId, until: ["idle", "done", "blocked"], timeout_ms: Math.max(1000, Math.min(45_000, left())) }, 55_000,
      ).catch(() => null);
      const started = waited?.agent ?? (await g.herdr("agent.get", { target: paneId }).catch(() => null))?.agent ?? { agent_status: "unknown" };
      const status: string = started.agent_status ?? "unknown";
      if (watch) g.state.manage(paneId, { name, cwd: placed.pane.cwd ?? null, kind }, started, true);
      const out: Record<string, unknown> = { ...placed, name, kind, status, watching: watch };
      if (status === "blocked") {
        out.note = "the agent is showing a dialog, often the folder trust prompt: read_agent to see it and ask the user before answering";
      } else if (prompt && status !== "idle" && status !== "done") {
        out.note = "the agent is not ready yet: wait_agent, then prompt_agent";
      } else if (prompt && left() < 5000) {
        out.note = "no time left to send the prompt: call prompt_agent";
      } else if (prompt) {
        const wait = optBool(params, "wait", false);
        try {
          out.prompt = await g.handle("prompt_agent", { target: paneId, text: prompt, wait, timeout_ms: Math.max(1000, left()) });
        } catch (err) {
          // Started, but at a dialog Herdr does not flag, e.g. Cursor's workspace trust prompt.
          if (!(err instanceof GatewayError && err.code === "agent_blocked")) throw err;
          Object.assign(out, { status: "blocked", note: `${err.message}; the prompt was not sent: prompt_agent once the user has answered` });
        }
      }
      return out;
    },
  };
}
