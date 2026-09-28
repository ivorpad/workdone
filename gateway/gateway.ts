// Gateway operations. Each op validates its params, checks that the Herdr pane or
// agent it touches lives under an allowed root, then makes one typed socket call.
// Layout, agent orchestration and host ops live in their own modules.

import { hostname } from "node:os";
import {
  AGENT_NAME_RE, AGENT_STATUSES, ALLOWED_KEYS, BRANCH_RE, GATEWAY_VERSION, GatewayError, READ_SOURCES, TARGET_RE,
  canonical, paneInScope, withinRoots,
  type GatewayConfig, type HerdrCall, type RepoConfig,
} from "./config.ts";
import { agentOps, lifecycle } from "./agent-ops.ts";
import { openDialog } from "./attention.ts";
import { hostOps } from "./host-ops.ts";
import { layoutOps } from "./layout-ops.ts";
import { optBool, optEnum, optInt, str, type Op, type Params } from "./params.ts";
import { StateStore } from "./state.ts";
import { agentReply } from "./transcript.ts";
import { agentView, paneView, textOf, watchInfo } from "./views.ts";

const SETTLED = new Set(["idle", "done", "blocked"]);

export class Gateway {
  readonly state: StateStore;
  private extra: Record<string, Op>;

  constructor(readonly cfg: GatewayConfig, readonly herdr: HerdrCall) {
    this.state = new StateStore(cfg.stateDir);
    this.extra = { ...hostOps(cfg, (key) => this.repo(key).path), ...layoutOps(this), ...agentOps(this) };
  }

  async scopedAgent(target: string) {
    const res = await this.herdr("agent.get", { target });
    const agent = res.agent ?? res;
    // Out-of-scope agents are reported as missing so their existence does not leak.
    if (!paneInScope(agent, this.cfg.allowedRoots)) throw new GatewayError("agent_not_found", `agent ${target} not found`);
    return agent;
  }

  async scopedPane(paneId: string) {
    const res = await this.herdr("pane.get", { pane_id: paneId });
    const pane = res.pane ?? res;
    if (!paneInScope(pane, this.cfg.allowedRoots)) throw new GatewayError("pane_not_found", `pane ${paneId} not found`);
    return pane;
  }

  async shellPane(paneId: string) {
    const pane = await this.scopedPane(paneId);
    if (pane.agent) throw new GatewayError("pane_busy", `pane ${paneId} is running ${pane.agent}; use the agent tools instead`);
    return pane;
  }

  repo(key: string): RepoConfig {
    const repo = this.cfg.repos[key];
    if (!repo) throw new GatewayError("unknown_repo", `repo ${key} is not configured`);
    return repo;
  }

  // A directory for new panes: a configured repo, an explicit path inside the roots, or the fallback.
  cwdFrom(params: Params, fallback?: string): string {
    if (params.repo !== undefined && params.repo !== null) return this.repo(str(params, "repo")).path;
    if (params.cwd !== undefined && params.cwd !== null) {
      const p = canonical(str(params, "cwd"));
      if (!withinRoots(p, this.cfg.allowedRoots)) throw new GatewayError("path_not_allowed", `${p} is outside the allowed roots`);
      return p;
    }
    if (fallback) return fallback;
    throw new GatewayError("invalid_params", "pass repo or cwd");
  }

  waitMs(params: Params, dflt: number) {
    return optInt(params, "timeout_ms", 1000, this.cfg.maxWaitMs) ?? Math.min(dflt, this.cfg.maxWaitMs);
  }

  async handle(op: string, params: Params): Promise<unknown> {
    const extra = Object.hasOwn(this.extra, op) ? this.extra[op] : undefined;
    if (extra) return await extra(params);
    const cfg = this.cfg;
    switch (op) {
      case "bridge_status": {
        const pong = await this.herdr("ping", {});
        return {
          gateway_version: GATEWAY_VERSION,
          host: hostname(),
          platform: process.platform,
          herdr_version: pong.version,
          herdr_protocol: pong.protocol,
          allowed_roots: cfg.allowedRoots,
          repos: Object.keys(cfg.repos),
          agent_kinds: cfg.agentKinds,
          capabilities: {
            exec: cfg.allowExec,
            file_read: cfg.allowFileRead,
            file_write: cfg.allowFileWrite,
            raw_pane_run: cfg.allowRawPaneRun,
            close_any: cfg.allowCloseAny,
            worktree_remove: cfg.allowWorktreeRemove,
            documents: cfg.documentConverter !== null,
          },
        };
      }

      case "list_agents": {
        const res = await this.herdr("agent.list", {});
        return { agents: (res.agents ?? []).filter((a: any) => paneInScope(a, cfg.allowedRoots)).map(agentView) };
      }

      case "get_agent": {
        const agent = await this.scopedAgent(str(params, "target", TARGET_RE));
        return { ...agentView(agent), ...(await lifecycle(this, agent, this.state.watched())) };
      }

      case "read_agent": {
        const agent = await this.scopedAgent(str(params, "target", TARGET_RE));
        const source = optEnum(params, "source", [...READ_SOURCES, "reply"] as const, "recent_unwrapped");
        // For the reply source the transcript is the answer; for the others it only feeds attention.
        const reply = await agentReply(cfg, agent).catch((err) => {
          if (source === "reply") throw err;
          return null;
        });
        if (source === "reply") {
          if (!reply) throw new GatewayError("reply_unavailable", "no transcript for this agent (reply works for Claude and Cursor agents); read with source recent_unwrapped");
          return { agent: { ...agentView(agent), ...(await lifecycle(this, agent, this.state.watched(), { reply })) }, reply };
        }
        const res = await this.herdr("agent.read", {
          target: agent.pane_id,
          source,
          lines: optInt(params, "lines", 1, cfg.maxReadLines) ?? 120,
          format: "text",
          strip_ansi: true,
        });
        const view = { ...agentView(agent), ...(await lifecycle(this, agent, this.state.watched(), { reply, screen: textOf(res) })) };
        return { agent: view, text: res.text ?? res.read?.text ?? res };
      }

      case "prompt_agent": {
        const agent = await this.scopedAgent(str(params, "target", TARGET_RE));
        const text = str(params, "text");
        if (text.length > cfg.maxPromptChars) throw new GatewayError("invalid_params", `text exceeds ${cfg.maxPromptChars} characters`);
        const wait = params.wait === true;
        const timeout = this.waitMs(params, 60_000);
        // Herdr refuses to prompt a blocked agent itself, but it does not flag Cursor's
        // workspace trust prompt. Without the screen there is no telling, so a failed read fails the prompt.
        if (agent.agent === "cursor" && agent.agent_status !== "blocked") {
          const screen = await this.herdr("agent.read", { target: agent.pane_id, source: "visible", lines: 60, format: "text", strip_ansi: true });
          const dialog = openDialog(textOf(screen));
          if (dialog) throw new GatewayError("agent_blocked", `the agent is showing a dialog Herdr does not flag: ${dialog}. Show the user and let them decide before answering it`);
        }
        let res: any;
        try {
          res = await this.herdr(
            "agent.prompt",
            { target: agent.pane_id, text, wait: wait ? { timeout_ms: timeout } : null },
            wait ? timeout + 10_000 : undefined,
          );
        } catch (err) {
          // A wait that times out still delivered the prompt: report on it when it finishes.
          if (err instanceof GatewayError && (err.code === "timeout" || err.code === "herdr_timeout")) this.state.prompted(agent.pane_id, watchInfo(agent), null, false);
          throw err;
        }
        const status = res?.agent?.agent_status ?? res?.agent_status ?? res?.status;
        const settled = wait && SETTLED.has(status);
        this.state.prompted(agent.pane_id, watchInfo(agent), res?.agent ?? { agent_status: status }, settled);
        const out: Record<string, unknown> = { submitted: true, waited: wait, status: status ?? null, result: res };
        if (settled && status !== "blocked") {
          const reply = await agentReply(cfg, agent, { freshFor: text });
          if (reply) out.reply = reply;
        }
        return out;
      }

      case "wait_agent": {
        const agent = await this.scopedAgent(str(params, "target", TARGET_RE));
        const until = params.until === undefined ? [] : params.until;
        if (!Array.isArray(until) || !until.every((s) => AGENT_STATUSES.includes(s))) {
          throw new GatewayError("invalid_params", `until must be a list of ${AGENT_STATUSES.join(", ")}`);
        }
        const timeout = this.waitMs(params, 60_000);
        return await this.herdr("agent.wait", { target: agent.pane_id, until, timeout_ms: timeout }, timeout + 10_000);
      }

      case "send_agent_keys": {
        const agent = await this.scopedAgent(str(params, "target", TARGET_RE));
        const keys = params.keys;
        if (!Array.isArray(keys) || keys.length === 0 || keys.length > 10 || !keys.every((k) => ALLOWED_KEYS.has(k))) {
          throw new GatewayError("invalid_params", `keys must be 1-10 of: ${[...ALLOWED_KEYS].join(" ")}`);
        }
        return await this.herdr("agent.send_keys", { target: agent.pane_id, keys });
      }

      case "list_panes": {
        const res = await this.herdr("pane.list", {});
        return { panes: (res.panes ?? []).filter((p: any) => paneInScope(p, cfg.allowedRoots)).map(paneView) };
      }

      case "read_pane": {
        const pane = await this.scopedPane(str(params, "pane_id", TARGET_RE));
        const res = await this.herdr("pane.read", {
          pane_id: pane.pane_id,
          source: optEnum(params, "source", READ_SOURCES, "recent_unwrapped"),
          lines: optInt(params, "lines", 1, cfg.maxReadLines) ?? 120,
          format: "text",
          strip_ansi: true,
        });
        return { pane: paneView(pane), text: res.text ?? res.read?.text ?? res };
      }

      case "split_pane": {
        const pane = await this.scopedPane(str(params, "pane_id", TARGET_RE));
        const res = await this.herdr("pane.split", {
          target_pane_id: pane.pane_id,
          direction: optEnum(params, "direction", ["right", "down"] as const, "right"),
          cwd: this.cwdFrom(params, pane.foreground_cwd ?? pane.cwd),
          focus: false,
        });
        const created = res.pane ?? res;
        if (created?.pane_id) this.state.remember("panes", created.pane_id);
        return { pane: paneView(created) };
      }

      case "start_agent": {
        const pane = await this.shellPane(str(params, "pane_id", TARGET_RE));
        const kind = str(params, "kind");
        if (!cfg.agentKinds.includes(kind)) throw new GatewayError("invalid_params", `kind must be one of ${cfg.agentKinds.join(", ")}`);
        const name = str(params, "name", AGENT_NAME_RE);
        const args = this.agentArgs(params);
        // A shell pane has no agent, so anything still watched there is left over from one that exited.
        this.state.unwatch(pane.pane_id);
        const manage = (agent: any) => {
          if (optBool(params, "watch", true)) this.state.manage(pane.pane_id, { ...watchInfo(pane), name, kind }, agent, true);
        };
        try {
          const res = await this.herdr("agent.start", { pane_id: pane.pane_id, kind, name, args, timeout_ms: 30_000 }, 45_000);
          manage(res?.agent ?? { agent_status: "unknown" });
          return res;
        } catch (err) {
          // agent_not_ready: it started but sits at a dialog, e.g. folder trust.
          if (err instanceof GatewayError && err.code === "agent_not_ready") manage({ agent_status: "blocked" });
          throw err;
        }
      }

      case "list_repos": {
        return {
          repos: Object.entries(cfg.repos).map(([key, r]) => ({ repo: key, path: r.path, tasks: r.tasks ?? {} })),
        };
      }

      case "run_repo_task": {
        const repo = this.repo(str(params, "repo"));
        const taskName = str(params, "task");
        const command = repo.tasks?.[taskName];
        if (!command) throw new GatewayError("unknown_task", `task ${taskName} is not configured for this repo`);
        const pane = await this.shellPane(str(params, "pane_id", TARGET_RE));
        const cwd = canonical(pane.foreground_cwd ?? pane.cwd);
        if (!withinRoots(cwd, [repo.path])) {
          throw new GatewayError("pane_outside_repo", `pane cwd ${cwd} is not inside ${repo.path}; split a pane with repo set first`);
        }
        await this.herdr("pane.send_input", { pane_id: pane.pane_id, text: command, keys: ["enter"] });
        return { started: true, pane_id: pane.pane_id, command };
      }

      case "run_command_in_pane": {
        if (!cfg.allowRawPaneRun) throw new GatewayError("capability_disabled", "raw pane execution is disabled in the gateway config");
        const pane = await this.shellPane(str(params, "pane_id", TARGET_RE));
        const command = str(params, "command");
        if (command.includes("\n") || command.length > 4000) throw new GatewayError("invalid_params", "command must be a single line under 4000 characters");
        await this.herdr("pane.send_input", { pane_id: pane.pane_id, text: command, keys: ["enter"] });
        return { started: true, pane_id: pane.pane_id };
      }

      case "list_worktrees": {
        const repo = this.repo(str(params, "repo"));
        return await this.herdr("worktree.list", { cwd: repo.path });
      }

      case "create_worktree": {
        const repo = this.repo(str(params, "repo"));
        const branch = str(params, "branch", BRANCH_RE);
        const res = await this.herdr("worktree.create", { cwd: repo.path, branch, focus: false }, 60_000);
        if (res?.workspace?.workspace_id) this.state.remember("workspaces", res.workspace.workspace_id);
        if (res?.tab?.tab_id) this.state.remember("tabs", res.tab.tab_id);
        if (res?.root_pane?.pane_id) this.state.remember("panes", res.root_pane.pane_id);
        return res;
      }

      case "remove_worktree": {
        if (!cfg.allowWorktreeRemove) throw new GatewayError("capability_disabled", "worktree removal is disabled in the gateway config");
        const workspaceId = str(params, "workspace_id", TARGET_RE);
        const panes = (await this.herdr("pane.list", { workspace_id: workspaceId })).panes ?? [];
        if (panes.length === 0 || !panes.every((p: any) => paneInScope(p, cfg.allowedRoots))) {
          throw new GatewayError("workspace_not_found", `workspace ${workspaceId} not found`);
        }
        return await this.herdr("worktree.remove", { workspace_id: workspaceId, force: false }, 60_000);
      }

      default:
        throw new GatewayError("unknown_operation", `unknown operation: ${String(op).slice(0, 64)}`);
    }
  }

  // Extra command-line arguments for a new agent. They can do anything a shell can
  // (e.g. skip permission prompts), so they need the exec capability.
  agentArgs(params: Params): string[] {
    const args = params.args;
    if (args === undefined || args === null) return [];
    if (!this.cfg.allowExec) throw new GatewayError("capability_disabled", "agent args need the exec capability");
    if (!Array.isArray(args) || args.length > 20 || !args.every((a) => typeof a === "string" && a.length <= 500)) {
      throw new GatewayError("invalid_params", "args must be at most 20 strings");
    }
    return args as string[];
  }
}
