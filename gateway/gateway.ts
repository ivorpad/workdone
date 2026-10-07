// Gateway operations. Each op validates its params, checks that the Herdr pane or
// agent it touches lives under an allowed root, then makes one typed socket call.
// Layout, agent orchestration and host ops live in their own modules.

import { hostname } from "node:os";
import {
  AGENT_NAME_RE, ALLOWED_KEYS, BRANCH_RE, GATEWAY_VERSION, GatewayError, READ_SOURCES, TARGET_RE,
  canonical, paneInScope, withinRoots, worktreePath,
  type GatewayConfig, type HerdrCall, type RepoConfig,
} from "./config.ts";
import { agentOps, lifecycle } from "./agent-ops.ts";
import { coordOps, dispatchSlice, INTENT, paneTask, sendOutcome } from "./coord-ops.ts";
import { answerOps, approveMenus, menuScreen, type Approval } from "./answer-ops.ts";
import { parseDialog } from "./dialog.ts";
import { gatedBy } from "./gated.ts";
import { clearNote, showWatched } from "./sidebar.ts";
import { hostOps } from "./host-ops.ts";
import { jobOps } from "./jobs.ts";
import { paneExecOps } from "./pane-exec.ts";
import { layoutOps, ownerMayClose } from "./layout-ops.ts";
import { leaseOps } from "./leases.ts";
import { findModel, modelArgs } from "./models.ts";
import { optBool, optEnum, optInt, optStr, str, type Op, type Params } from "./params.ts";
import { StateStore, seenState, type Launch } from "./state.ts";
import { checkpoint } from "./checkpoint.ts";
import { raiseTerminal } from "./raise.ts";
import { consoleOps } from "./console-ops.ts";
import { owedDigest, owedOps } from "./owed.ts";
import { trackWork, workOps } from "./work.ts";
import { agentReply } from "./transcript.ts";
import { agentView, paneView, resultView, textOf, watchInfo, withWatch } from "./views.ts";

const SETTLED = new Set(["idle", "done", "blocked"]);
// Results that carry the owed-work digest.
const DIGESTED = new Set(["overview", "get_agent", "wait_agent", "spawn_agent", "start_agent", "prompt_agent", "steer_agent", "supervisor_status"]);

// agent.explain answers with evidence for every rule (about 8 KB for Claude). Keep the verdict,
// the rules that matched, the skip and fallback reasons, and a clipped preview of the winning region.
function explainView(e: any) {
  const rules: any[] = Array.isArray(e?.evaluated_rules) ? e.evaluated_rules : [];
  const won = e?.matched_rule ?? null;
  const preview = rules.find((r) => r.id === won?.id)?.evidence?.region_preview;
  return {
    state: e?.state ?? null,
    matched_rule: won && { id: won.id, state: won.state, region: won.region, priority: won.priority },
    region_preview: typeof preview === "string" ? preview.slice(0, 300) : null,
    also_matched: rules.filter((r) => r.matched && r.id !== won?.id).map((r) => `${r.id} (${r.state})`),
    visible: { blocker: e?.visible_blocker ?? null, working: e?.visible_working ?? null, idle: e?.visible_idle ?? null },
    skip_state_update: e?.skip_state_update ?? null,
    skipped_update_reason: e?.skipped_update_reason ?? null,
    fallback_reason: e?.fallback_reason ?? null,
    screen_detection_skipped: e?.screen_detection_skipped ?? null,
    screen_detection_skip_reason: e?.screen_detection_skip_reason ?? null,
    manifest: e?.manifest_source ? `${e.manifest_source} ${e.manifest_version ?? ""}`.trim() : null,
    warning: e?.warning ?? e?.remote_update_error ?? null,
  };
}

const spoken = (s: string) => s.trim().toLowerCase().replace(/[\s_]+/g, "-").replace(/[^a-z0-9.-]/g, "").replace(/^[-.]+|[-.]+$/g, "");
const EFFORT_WORDS: Record<string, string> = {
  "extra-high": "xhigh", "x-high": "xhigh", "extrahigh": "xhigh", "maximum": "max", "med": "medium", "extra-high-fast": "xhigh-fast",
};

export class Gateway {
  readonly state: StateStore;
  private extra: Record<string, Op>;
  readonly leases: ReturnType<typeof leaseOps>;
  // Brings the terminal app that hosts Herdr to the front; replaceable so tests never touch the desktop.
  raiser: typeof raiseTerminal = raiseTerminal;

  constructor(readonly cfg: GatewayConfig, readonly herdr: HerdrCall) {
    this.state = new StateStore(cfg.stateDir);
    this.leases = leaseOps(this);
    this.extra = { claim_agents: this.leases.claim_agents, release_agents: this.leases.release_agents, lease_check: this.leases.lease_check, lease_list: this.leases.lease_list, ...hostOps(cfg, (key) => this.repo(key).path), ...layoutOps(this), ...agentOps(this), ...consoleOps(this), ...owedOps(this), ...workOps(this), ...coordOps(this), ...answerOps(this), ...jobOps(cfg), ...(cfg.execInPane ? paneExecOps(this) : {}) };
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
    if (pane.agent) throw new GatewayError("pane_busy", `pane ${paneId} has an agent running; use the agent tools instead`);
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

  // From an agent Herdr reports blocked: gives the go-ahead to each menu that only wants
  // one and waits again, until the agent settles, stops at a question, or deadline.
  // agent is Herdr's agent as last seen, null when the wait ran out while it worked.
  async settleThrough(paneId: string, via: string, deadline: number, agent: any): Promise<{ agent: any; approved: Approval[] }> {
    const approved: Approval[] = [];
    while (agent?.agent_status === "blocked" && approved.length < 20) {
      const got = await approveMenus(this.cfg, this.herdr, paneId, via, { waitMs: 20_000 });
      if (got.approved.length === 0) {
        // A question, or a menu another process answered while this one waited for it.
        agent = (await this.herdr("agent.get", { target: paneId })).agent;
        if (agent?.agent_status === "blocked") break;
      }
      approved.push(...got.approved);
      const left = deadline - Date.now();
      if (left < 1000) {
        agent = (await this.herdr("agent.get", { target: paneId })).agent;
        break;
      }
      agent = await this.herdr("agent.wait", { target: paneId, until: ["idle", "done", "blocked"], timeout_ms: left }, left + 10_000).then(
        (r) => r?.agent ?? r,
        (err) => {
          if (err instanceof GatewayError && (err.code === "timeout" || err.code === "herdr_timeout")) return null;
          throw err;
        },
      );
    }
    return { agent, approved };
  }

  // A call from outside (ChatGPT through the MCP server): the thread's lease is checked
  // first, and what the op made joins the lease. Calls between ops use handle.
  async request(op: string, params: Params): Promise<unknown> {
    let lease = await this.leases.check(op, params);
    let created: string | null = null;
    // A thread that spawns without a lease gets one, so it can drive what it started.
    // Minted before the spawn: the first prompt's provenance line names it.
    if (this.cfg.leases && op === "spawn_agent" && !lease) {
      created = ((await this.leases.claim_agents({ label: typeof params.name === "string" ? params.name : undefined, targets: [] }, "spawn")) as any).lease;
      lease = created;
    }
    const sent = stamped(op, created ? { ...params, lease: created } : params, lease, lease ? this.state.leases()[lease]?.label : undefined);
    // What the caller asked, before the stamp: a bound prompt's idempotency is about this.
    const key = STAMPED[op];
    if (key && typeof params[key] === "string") (sent as any)[INTENT] = { op, text: params[key] };
    let result: any;
    try {
      result = await this.handle(op, sent);
    } catch (err) {
      // The spawn failed and its caller never saw the lease: don't leave it behind empty.
      if (created) {
        try { this.leases.dropIfEmpty(created); } catch { /* the spawn's own error matters more */ }
      }
      throw err;
    }
    // The op has happened: a prompt went in, an agent started. Bookkeeping that fails from
    // here must not fail the call, or the chat would send it again (docs/loop-risks.md).
    // Each step is audited and said in the result instead.
    const isObject = !!result && typeof result === "object" && !Array.isArray(result);
    const keep = (stage: string, fn: () => void) => {
      try { fn(); } catch (err) {
        const code = String((err as { code?: unknown })?.code ?? "state_error");
        this.state.audit({ op: "after_op_failed", ok: false, of: op, stage, code });
        if (!isObject) return;
        if (stage === "work") Object.assign(result, { work_id: null, work_error: code });
        else result.state_error ??= code;
      }
    };
    // A new agent joins the caller's lease, tried twice: without it the chat's next call to
    // the agent is refused, so a failure says how to join it by hand.
    keep("lease", () => {
      try {
        this.leases.after(op, lease, params, result);
      } catch {
        try {
          this.leases.after(op, lease, params, result);
        } catch (err) {
          const pane = op === "spawn_agent" ? result?.pane?.pane_id : op === "start_agent" ? params.pane_id : undefined;
          if (lease && isObject && typeof pane === "string") {
            result.lease_error = {
              code: String((err as { code?: unknown })?.code ?? "state_error"),
              message: `the new agent did not join this conversation's lease: call claim_agents with this lease and targets ["${pane}"] (nobody holds it, so the claim goes through), then go on`,
            };
          }
          throw err;
        }
      }
    });
    // A follow-up to an agent answers what it told the owner: whoever sent it, console or thread.
    if ((op === "prompt_agent" || op === "steer_agent" || op === "supervisor_nudge") && typeof params.target === "string") {
      keep("inbox", () => {
        if (!this.state.hasOpenInbox()) return;
        const by = params.origin === "console" ? "console" : lease ? `thread "${(this.state.leases()[lease]?.label ?? "").slice(0, 60)}"` : "caller without a lease";
        this.state.inboxResolve({ target: params.target as string }, "answered", by);
      });
    }
    // The thread asked something and didn't wait: the agent's answer is owed to it.
    const answered = op === "prompt_agent" && (result?.reply || (result?.waited && SETTLED.has(result?.status)));
    const owes = !!lease && (op === "prompt_agent" || op === "steer_agent" || op === "supervisor_nudge") && !!result && !answered;
    // One read of the agent, for the reply owed and for its work.
    const works = (op === "prompt_agent" || op === "steer_agent") && params.origin !== "console";
    const agent = owes || works ? await this.scopedAgent(String(params.target)).catch(() => null) : null;
    if (owes && agent) keep("owe", () => this.state.owe(agent.pane_id, lease!, watchInfo(agent), agent));
    // Work this chat started or continued stays owed until settled (work.ts).
    keep("work", () => trackWork(this, op, params, result, lease, agent));
    if (created && isObject) result.lease = created;
    // Views say which thread holds each agent.
    if (this.cfg.leases && (op === "overview" || op === "get_agent" || op === "wait_agent")) {
      keep("held_by", () => {
        const held = this.leases.labels();
        const mark = (a: any) => {
          if (a && typeof a.pane_id === "string" && held.has(a.pane_id)) a.held_by = held.get(a.pane_id);
        };
        if (op === "get_agent") mark(result);
        else for (const a of result?.agents ?? []) mark(a);
      });
    }
    // What is still owed on this machine, read from state alone, on the calls a chat
    // makes before it decides what to do with its agents. owed_work has the detail.
    if (DIGESTED.has(op) && params.origin !== "console" && result && typeof result === "object" && !Array.isArray(result)) {
      try {
        const owed = owedDigest(this.state, this.cfg.allowedRoots);
        if (owed.open || owed.needs_you || owed.unread) result.owed = owed;
      } catch { /* a digest never fails the call it rides on */ }
    }
    return result;
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
          // Per CLI, the models spawn_agent can name, each its family's newest version.
          agents: Object.fromEntries(cfg.agentKinds.map((kind) => {
            const families = cfg.agentModels[kind] ?? {};
            return [kind, {
              default_model: Object.entries(families).find(([, m]) => m.default)?.[0] ?? null,
              models: Object.fromEntries(Object.entries(families).map(([name, m]) => [name, { model: m.model, efforts: Object.keys(m.efforts), effort: m.effort }])),
            }];
          })),
          capabilities: {
            exec: cfg.allowExec,
            file_read: cfg.allowFileRead,
            file_write: cfg.allowFileWrite,
            raw_pane_run: cfg.allowRawPaneRun,
            close_any: cfg.allowCloseAny,
            worktree_remove: cfg.allowWorktreeRemove,
            documents: cfg.documentConverter !== null,
            browser: cfg.browser !== null && cfg.allowExec,
            auto_approve: cfg.autoApprove,
          },
        };
      }

      case "list_agents": {
        const res = await this.herdr("agent.list", {});
        return { agents: (res.agents ?? []).filter((a: any) => paneInScope(a, cfg.allowedRoots)).map(agentView) };
      }

      case "get_agent": {
        const agent = await this.scopedAgent(str(params, "target", TARGET_RE));
        const task = paneTask(this, agent.pane_id, agent.name ?? null, agent.agent_session?.value ?? null);
        const view = { ...agentView(agent), ...(await lifecycle(this, agent, this.state.watched())), ...(task ? { task } : {}) };
        if (!optBool(params, "explain", false)) return view;
        // Herdr's own reasoning for the status, to tell its detection apart from ours. Servers
        // before agent.explain reject the method: get_agent still answers.
        const explain = await this.herdr("agent.explain", { target: agent.pane_id })
          .then((res) => explainView(res?.explain ?? res))
          .catch((err) => ({ error: (err as GatewayError).code ?? "herdr_error" }));
        return "error" in explain ? { ...view, explain: null, explain_error: explain.error } : { ...view, explain };
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
          if (!reply) throw new GatewayError("reply_unavailable", "no transcript for this agent; read with source recent_unwrapped");
          return { agent: { ...agentView(agent), ...(await lifecycle(this, agent, this.state.watched(), { reply })) }, reply };
        }
        const lines = optInt(params, "lines", 1, cfg.maxReadLines) ?? 120;
        const read = (src: string) => this.herdr("agent.read", { target: agent.pane_id, source: src, lines, format: "text", strip_ansi: true });
        let used: string = source;
        // Herdr only scrolls back through an idle agent's screen: show a working one's visible screen.
        const res = await read(source).catch(async (err) => {
          if (!(err instanceof GatewayError && err.code === "agent_not_idle") || source === "visible") throw err;
          used = "visible";
          return await read("visible");
        });
        const view = { ...agentView(agent), ...(await lifecycle(this, agent, this.state.watched(), { reply, screen: textOf(res) })) };
        const out: Record<string, unknown> = { agent: view, text: res.text ?? res.read?.text ?? res };
        if (used !== source) Object.assign(out, { source: used, note: "the agent is working, so this is its visible screen; scrollback reads work once it is idle" });
        if (reply?.in_progress) out.in_progress = reply.in_progress;
        return out;
      }

      case "prompt_agent": {
        const agent = await this.scopedAgent(str(params, "target", TARGET_RE));
        const text = str(params, "text");
        if (text.length > cfg.maxPromptChars) throw new GatewayError("invalid_params", `text exceeds ${cfg.maxPromptChars} characters`);
        const wait = params.wait === true;
        const timeout = this.waitMs(params, 60_000);
        const deadline = Date.now() + timeout;
        const approved: Approval[] = [];
        // Herdr refuses to prompt a blocked agent itself, but it does not flag every menu:
        // Cursor's and Codex's folder trust, Codex's update and model notices. Typed text
        // would land in the menu. Without the screen there is no telling, so a failed read fails the prompt.
        if (agent.agent_status !== "blocked") {
          let dialog = parseDialog(await menuScreen(this.herdr, agent.pane_id));
          // Those only want a go-ahead: give it, and prompt once the agent is ready.
          if (dialog) {
            const got = await approveMenus(cfg, this.herdr, agent.pane_id, "prompt_agent", { waitMs: 20_000, kinds: ["trust", "notice"] });
            if (got.approved.length) {
              approved.push(...got.approved);
              await this.herdr("agent.wait", { target: agent.pane_id, until: ["idle", "done"], timeout_ms: 15_000 }, 25_000).catch(() => null);
              dialog = parseDialog(await menuScreen(this.herdr, agent.pane_id));
            }
          }
          if (dialog) {
            throw new GatewayError(
              "agent_blocked",
              `the agent is showing a menu Herdr does not flag: ${dialog.text.replace(/\s*\n\s*/g, " / ")}. Answer it with answer_agent first`,
            );
          }
        }
        // The opt-in turn contract: a bound task's current slice, read now. An unbound
        // agent's prompt goes in exactly as written. A new binding is pending until the
        // prompt is known to be delivered.
        // reply: true, asked before the prompt goes in so a quick turn can't end unclaimed.
        const asked = this.askResult(agent.pane_id, agent, params);
        let prepared: ReturnType<typeof dispatchSlice>;
        try {
          prepared = dispatchSlice(this, agent, params, text);
        } catch (err) {
          if (asked && !asked.already_pending) this.state.dropResult(agent.pane_id, asked.result_id);
          throw err;
        }
        // The same command_id and prompt again, already delivered: say so, send nothing.
        if (prepared && "replay" in prepared) {
          if (asked && !asked.already_pending) this.state.dropResult(agent.pane_id, asked.result_id);
          return { submitted: true, duplicate: true, dispatch: prepared.replay, note: "this command_id was already delivered; nothing was sent again" };
        }
        const dispatch = prepared;
        const sent = dispatch ? `${text}\n\n${dispatch.slice}` : text;
        let res: any;
        try {
          res = await this.herdr(
            "agent.prompt",
            { target: agent.pane_id, text: sent, wait: wait ? { timeout_ms: Math.max(1000, deadline - Date.now()) } : null },
            wait ? timeout + 10_000 : undefined,
          );
        } catch (err) {
          // A wait that times out still delivered the prompt (unless it never left whole): report
          // on it when it finishes, and tell the caller it is working rather than failing the call.
          if (!(wait && err instanceof GatewayError && (err.code === "timeout" || (err.code === "herdr_timeout" && sendOutcome(err) === "unknown")))) {
            if (asked && !asked.already_pending) this.state.dropResult(agent.pane_id, asked.result_id);
            // Refused: the pending binding is dropped. Unknown: kept for reconciliation,
            // never resent from here.
            dispatch?.settle(sendOutcome(err));
            throw err;
          }
          // Herdr's own wait expired after it took the prompt; no answer at all from the
          // socket leaves delivery unknown.
          const sentState = dispatch?.settle((err as GatewayError).code === "timeout" ? "delivered" : "unknown");
          // A bound prompt in doubt is not reported as started: no turn is expected of it.
          if (sentState?.state === "unknown") {
            const out: Record<string, unknown> = {
              submitted: null, waited: true, timed_out: true, status: "unknown", dispatch: sentState,
              note: "Herdr did not answer: whether the prompt went in is unknown, and it is not resent. The task shows protocol dispatch_unknown; read the agent, then coord_update the task with dispatch: delivered or lost",
            };
            if (approved.length) out.auto_approved = approved;
            if (asked) out.result_request = resultView(asked);
            return out;
          }
          this.state.prompted(agent.pane_id, watchInfo(agent), null, false);
          clearNote(this.herdr, agent.pane_id);
          const out: Record<string, unknown> = {
            submitted: true, waited: true, timed_out: true, status: "working",
            note: "the prompt went in and the agent is still working: don't resend; owed_work shows when it finishes",
          };
          if (approved.length) out.auto_approved = approved;
          if (asked) out.result_request = resultView(asked);
          if (sentState) out.dispatch = sentState;
          return out;
        }
        const sentState = dispatch?.settle("delivered");
        let status = res?.agent?.agent_status ?? res?.agent_status ?? res?.status;
        // Stopped at a menu mid-turn: a go-ahead is given and the wait goes on.
        if (wait && status === "blocked") {
          const through = await this.settleThrough(agent.pane_id, "prompt_agent", deadline, res?.agent ?? { agent_status: status });
          if (through.approved.length) {
            approved.push(...through.approved);
            res = { ...res, agent: through.agent ?? (await this.herdr("agent.get", { target: agent.pane_id })).agent };
            status = res.agent?.agent_status;
          }
        }
        const settled = wait && SETTLED.has(status);
        this.state.prompted(agent.pane_id, watchInfo(agent), res?.agent ?? { agent_status: status }, settled);
        clearNote(this.herdr, agent.pane_id);
        const out: Record<string, unknown> = { submitted: true, waited: wait, status: status ?? null, result: res, ...(sentState ? { task_slice: true, dispatch: sentState } : {}) };
        if (approved.length) out.auto_approved = approved;
        if (settled && status !== "blocked") {
          const reply = await agentReply(cfg, agent, { freshFor: sent });
          if (reply) out.reply = reply;
          // The turn ended inside this call: its answer is the result, so nothing is owed.
          if (asked) {
            this.state.dropResult(agent.pane_id, asked.result_id);
            out.result_request = { result_id: asked.result_id, delivered: "inline" };
          }
        } else if (asked) out.result_request = resultView(asked);
        return out;
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
        const watched = this.state.watched();
        return { panes: (res.panes ?? []).filter((p: any) => paneInScope(p, cfg.allowedRoots)).map((p: any) => withWatch(paneView(p), watched)) };
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
        return { pane: withWatch(paneView(pane), this.state.watched()), text: res.text ?? res.read?.text ?? res };
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
        const { kind, args, launch } = this.agentKind(params);
        const name = str(params, "name", AGENT_NAME_RE);
        const role = optEnum(params, "role", ["worker", "reviewer"] as const, "worker");
        // A shell pane has no agent, so anything still watched there is left over from one that exited.
        this.state.unwatch(pane.pane_id);
        const watch = optBool(params, "watch", true);
        showWatched(this.herdr, pane.pane_id, false);
        const manage = async (agent: any) => {
          if (!watch) return;
          this.state.manage(pane.pane_id, { ...watchInfo(pane), name, kind, launch, role }, agent, true);
          await this.startSupervision(pane.pane_id, pane.foreground_cwd ?? pane.cwd, agent);
          showWatched(this.herdr, pane.pane_id, true);
        };
        this.recordLaunch("start_agent", pane.pane_id, name, launch);
        let res: any = null;
        let notReady: GatewayError | null = null;
        try {
          res = await this.herdr("agent.start", { pane_id: pane.pane_id, kind, name, args, timeout_ms: 30_000 }, 45_000);
        } catch (err) {
          // agent_not_ready: it started but sits at a dialog, e.g. folder trust.
          if (!(err instanceof GatewayError && err.code === "agent_not_ready")) throw err;
          notReady = err;
        }
        // A new agent can open on menus that only want a go-ahead: folder trust, an update notice.
        const got = await approveMenus(cfg, this.herdr, pane.pane_id, "start_agent", { waitMs: 20_000 });
        if (got.approved.length) {
          const ready = await this.herdr("agent.wait", { target: pane.pane_id, until: ["idle", "done", "blocked"], timeout_ms: 30_000 }, 40_000).catch(() => null);
          res = { ...res, agent: ready?.agent ?? (await this.herdr("agent.get", { target: pane.pane_id }).catch(() => null))?.agent, auto_approved: got.approved };
        } else if (notReady) {
          await manage({ agent_status: "blocked" });
          throw notReady;
        }
        await manage(res?.agent ?? { agent_status: "unknown" });
        const asked = this.askResult(pane.pane_id, res?.agent ?? pane, params);
        return { ...res, launched: launch, ...(asked ? { result_request: resultView(asked) } : {}) };
      }

      case "list_repos": {
        return {
          repos: Object.entries(cfg.repos).map(([key, r]) => ({ repo: key, path: r.path })),
        };
      }

      case "run_command_in_pane": {
        if (!cfg.allowRawPaneRun) throw new GatewayError("capability_disabled", "raw pane execution is disabled in the gateway config");
        const pane = await this.shellPane(str(params, "pane_id", TARGET_RE));
        const command = str(params, "command");
        if (command.includes("\n") || command.length > 4000) throw new GatewayError("invalid_params", "command must be a single line under 4000 characters");
        const gated = gatedBy(command);
        if (gated && params.confirm !== true) {
          throw new GatewayError("needs_confirmation", `this command runs a ${gated}, which is the owner's call: ask them, then call again with confirm: true`);
        }
        await this.herdr("pane.send_input", { pane_id: pane.pane_id, text: command, keys: ["enter"] });
        return { started: true, pane_id: pane.pane_id };
      }

      case "list_worktrees": {
        const repo = this.repo(str(params, "repo"));
        return await this.herdr("worktree.list", { cwd: repo.path });
      }

      case "create_worktree": {
        const key = str(params, "repo");
        const repo = this.repo(key);
        const branch = str(params, "branch", BRANCH_RE);
        const path = worktreePath(key, repo, branch, cfg);
        const res = await this.herdr("worktree.create", { cwd: repo.path, branch, path, focus: false }, 60_000);
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
        const disposable = ownerMayClose(this, `worktree workspace ${workspaceId}`, panes, params);
        const res = await this.herdr("worktree.remove", { workspace_id: workspaceId, force: false }, 60_000);
        for (const p of disposable) this.state.forget("disposable", p);
        return res;
      }

      default:
        throw new GatewayError("unknown_operation", `unknown operation: ${String(op).slice(0, 64)}`);
    }
  }

  // The Herdr kind and args for a new agent: the CLI (kind), then a model family from
  // agentModels at the effort asked for, else the CLI's default model there, else the
  // CLI on its own default with no model args.
  // Every agent WorkDone starts is recorded with the model and effort that launched,
  // defaults included. The audit line has no prompt text.
  recordLaunch(via: string, paneId: string, name: string, launch: Launch) {
    this.state.audit({ op: "agent_launch", ok: true, via, args: { pane_id: paneId, name, ...launch } });
  }

  // The supervisor's baseline: where a new agent's work starts.
  async startSupervision(paneId: string, cwd: string | null | undefined, agent: any) {
    const cp = await checkpoint(this.cfg, cwd);
    this.state.setBaseline(paneId, {
      at: new Date().toISOString(), session: seenState(agent).session ?? null,
      ...(cp?.commit ? { commit: cp.commit } : {}), ...(cp ? { clean: cp.clean } : {}),
    });
  }

  // reply: true on prompt_agent, steer_agent, spawn_agent or start_agent: the agent's
  // next final result is owed to the caller. null when the caller did not ask.
  askResult(paneId: string, agent: any, params: Params): { result_id: string; already_pending: boolean } | null {
    if (params.reply === undefined || params.reply === null) return null;
    if (typeof params.reply !== "boolean") throw new GatewayError("invalid_params", "reply must be true or false");
    if (!params.reply) return null;
    const lease = typeof params.lease === "string" && params.lease ? params.lease : null;
    return this.state.requestResult(paneId, watchInfo(agent), agent, lease);
  }

  // launch says what actually starts: the model family and ID, the effective effort, and
  // whether each was asked for or came from a default.
  agentKind(params: Params): { kind: string; model: string | null; args: string[]; launch: Launch } {
    // Names often arrive through dictation: "Claude.", "Gemini Flash", "Extra High".
    const kind = spoken(str(params, "kind"));
    const asked = optStr(params, "model");
    const e = optStr(params, "effort");
    const effort = e === undefined ? undefined : (EFFORT_WORDS[spoken(e)] ?? spoken(e));
    const extra = this.agentArgs(params);
    if (!this.cfg.agentKinds.includes(kind)) throw new GatewayError("invalid_params", `kind must be one of ${this.cfg.agentKinds.join(", ")}`);
    const families = this.cfg.agentModels[kind] ?? {};
    let name: string | undefined;
    if (asked !== undefined) {
      name = findModel(families, spoken(asked)) ?? undefined;
      if (!name) {
        const offered = Object.keys(families);
        throw new GatewayError("invalid_params", offered.length ? `${kind} model must be one of ${offered.join(", ")}` : `no models are listed for ${kind} on this machine; omit model to use its default`);
      }
    } else name = Object.entries(families).find(([, m]) => m.default)?.[0];
    if (!name) {
      if (effort !== undefined) throw new GatewayError("invalid_params", `${kind} has no model list here, so it takes no effort`);
      return { kind, model: null, args: extra, launch: { kind, model: null, model_id: null, effort: null, model_source: "cli_default", effort_source: "none" } };
    }
    try {
      const m = families[name]!;
      const args = [...modelArgs(m, effort), ...extra];
      const used = effort ?? m.effort;
      return {
        kind, model: name, args,
        launch: {
          kind, model: name, model_id: m.model, effort: used,
          model_source: asked !== undefined ? "requested" : "default",
          effort_source: effort !== undefined ? "requested" : used !== null ? "model_default" : "none",
        },
      };
    } catch (err) {
      throw new GatewayError("invalid_params", `${kind} ${name}: ${(err as Error).message}`);
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

// Text an outside caller sends an agent ends with who sent it: the owner's ChatGPT chat
// by the tail of its lease and its label (and ChatGPT's own chat ID when the MCP server
// got one), the op and the time. An agent, or the owner reading its pane, can then trace
// any message. It is a closing line that names the owner, not a header: a header saying
// "from ChatGPT" made agents treat the owner's request as forwarded third-party text and
// refuse to answer with workdone-tell. Only the lease's tail: pane text is readable
// without a lease, and the whole lease would let any chat drive this one's agents.
const STAMPED: Record<string, string> = { prompt_agent: "text", steer_agent: "text", spawn_agent: "prompt" };

export function stamped(op: string, params: Params, lease: string | null, label: string | undefined, now = new Date()): Params {
  const key = STAMPED[op];
  if (!key || typeof params[key] !== "string" || !params[key]) return params;
  const chat = typeof params.origin_chat === "string" && /^[\w.:-]{1,80}$/.test(params.origin_chat) ? ` ${params.origin_chat}` : "";
  const who = lease ? `lease …${lease.slice(-4)}${label ? ` "${label.replace(/["\n]/g, "").slice(0, 60)}"` : ""}` : "no lease";
  // The console has no chat to answer: its lease is its own, and the owner reads the reply there.
  const sig = params.origin === "console"
    ? `[Sent by the owner from the WorkDone console through WorkDone ${op}, ${now.toISOString().slice(0, 16)}Z. No ChatGPT chat is waiting on this; reply here as usual.]`
    : `[Sent by the owner from their ChatGPT chat${chat} (${who}) through WorkDone ${op}, ${now.toISOString().slice(0, 16)}Z. workdone-tell answers that chat.]`;
  return { ...params, [key]: `${params[key]}\n\n${sig}` };
}
