// Agent orchestration: a one-call overview of every agent, a one-call spawn (place,
// start, wait for ready, first prompt), watches that report every turn of an agent,
// and what each agent needs from its owner.

import { approveMenus, dialogView, menuScreen } from "./answer-ops.ts";
import { approvalPolicy } from "./approval-policy.ts";
import { attentionOf, screenReply } from "./attention.ts";
import { parseDialog } from "./dialog.ts";
import { AGENT_NAME_RE, AGENT_STATUSES, BRANCH_RE, GatewayError, TARGET_RE, paneInScope } from "./config.ts";
import { subscriberOf, type Subscription } from "./herdr-events.ts";
import type { Gateway } from "./gateway.ts";
import { optBool, optInt, optStr, str, type Op, type Params } from "./params.ts";
import { childProcesses, gitSummary } from "./process.ts";
import { showDone, showWatched } from "./sidebar.ts";
import type { Watched } from "./state.ts";
import { agentReply, type Reply } from "./transcript.ts";
import { pollJobs } from "./jobs.ts";
import { pollWaiting, pollWatched, sendNotification, withReports } from "./watcher.ts";
import { agentView, lastLines, paneView, textOf, watchInfo, watchView } from "./views.ts";

const SETTLED = new Set(["idle", "done"]);
const SHELL_STARTING = new Set(["agent_pane_busy", "agent_pane_unavailable"]);
// Below the MCP server's ssh request timeout, with room for the passes around the wait.
const WATCH_WAIT_MAX_MS = 25_000;

function clip(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "…" : s;
}

// Agents and panes from one consistent read. A Herdr without session.snapshot (before
// 0.9) answers the two lists instead. Its records are the same AgentInfo and PaneInfo.
async function agentsAndPanes(g: Gateway): Promise<{ agents: any[]; panes: any[] }> {
  const snap = (await g.herdr("session.snapshot", {}).catch(() => null))?.snapshot;
  if (Array.isArray(snap?.agents) && Array.isArray(snap?.panes)) return { agents: snap.agents, panes: snap.panes };
  const [agentRes, paneRes] = await Promise.all([g.herdr("agent.list", {}), g.herdr("pane.list", {})]);
  return { agents: agentRes.agents ?? [], panes: paneRes.panes ?? [] };
}

// What to close to get rid of one pane and nothing else: the workspace or tab the
// bridge made for it when the pane is alone there, else the pane. null when the bridge
// did not make the pane and close_any is off.
function closeFor(g: Gateway, pane: any, all: any[]): { kind: "pane" | "tab" | "workspace"; id: string } | null {
  const alone = (key: "workspace_id" | "tab_id") => all.every((p) => p.pane_id === pane.pane_id || p[key] !== pane[key]);
  if (g.state.created("workspaces").includes(pane.workspace_id) && alone("workspace_id")) return { kind: "workspace", id: pane.workspace_id };
  if (g.state.created("tabs").includes(pane.tab_id) && alone("tab_id")) return { kind: "tab", id: pane.tab_id };
  if (g.state.created("panes").includes(pane.pane_id) || g.cfg.allowCloseAny) return { kind: "pane", id: pane.pane_id };
  return null;
}

// Beyond Herdr's status: attention is "dialog" when a menu is up and "question" when
// the agent stopped and its latest text asks the owner something; choices is the menu
// read into options for answer_agent; watch says whether the bridge reports on it.
// Pass what the caller already read to skip reading it again.
export async function lifecycle(g: Gateway, agent: any, watched: Record<string, Watched>, known: { reply?: Reply | null; screen?: string } = {}) {
  const originalWatch = watchView(watched[agent.pane_id]);
  const watch = originalWatch ? { ...originalWatch, approval_policy: approvalPolicy(g.state, agent.pane_id, agent) } : null;
  const read = async (source: string) =>
    source === "visible" ? await menuScreen(g.herdr, agent.pane_id).catch(() => "")
      : known.screen || textOf(await g.herdr("agent.read", { target: agent.pane_id, source, lines: 60, format: "text", strip_ansi: true }).catch(() => null));
  const visibleMenu = parseDialog(await read("visible"));
  if (agent.agent_status === "blocked" || visibleMenu) {
    const menu = visibleMenu;
    return { attention: "dialog" as const, ...(menu ? { choices: dialogView(menu) } : {}), watch };
  }
  let text: string | null = null;
  if (SETTLED.has(agent.agent_status)) {
    const reply = known.reply !== undefined ? known.reply : await agentReply(g.cfg, agent).catch(() => null);
    if (reply) {
      // A prompt newer than the last answer makes that answer stale.
      text = reply.in_progress ? reply.in_progress.latest_text : reply.text;
    } else {
      // No transcript: the screen, where a menu Herdr does not flag can be up.
      const screen = await read("recent_unwrapped");
      const menu = parseDialog(screen);
      if (menu) return { attention: "dialog" as const, choices: dialogView(menu), watch };
      text = screenReply(screen);
    }
  }
  return { attention: attentionOf(agent.agent_status, text), watch };
}

// One line on what an agent is doing or last said, for wait_agent's summary.
async function progressLine(g: Gateway, agent: any): Promise<string | null> {
  const reply = await agentReply(g.cfg, agent).catch(() => null);
  const text = reply?.in_progress ? reply.in_progress.latest_text : reply?.text;
  if (text) return clip(text.replace(/\s+/g, " ").trim(), 200);
  const screen = textOf(await g.herdr("agent.read", { target: agent.pane_id, source: "visible", lines: 20, format: "text", strip_ansi: true }).catch(() => null));
  const last = screen.split("\n").map((l) => l.trim()).filter(Boolean).at(-1);
  return last ? clip(last, 200) : null;
}

// wait_agent: until one of the agents stops working (finished, asks something, sits at
// a menu, or is gone) or the time is up. Go-ahead menus are answered on the way and
// the wait goes on. Running out of time is an answer, not an error: every agent's
// status comes back either way, so the caller can report and decide what to do next.
async function waitAgents(g: Gateway, params: Params) {
  const list = params.targets === undefined ? [str(params, "target", TARGET_RE)] : params.targets;
  if (!Array.isArray(list) || list.length === 0 || list.length > 12 || !list.every((t) => typeof t === "string" && TARGET_RE.test(t))) {
    throw new GatewayError("invalid_params", "targets must be 1-12 agent names or pane IDs");
  }
  const until = params.until === undefined ? null : params.until;
  if (until !== null && (!Array.isArray(until) || !until.every((s) => AGENT_STATUSES.includes(s)))) {
    throw new GatewayError("invalid_params", `until must be a list of ${AGENT_STATUSES.join(", ")}`);
  }
  const agents = await Promise.all(list.map((t: string) => g.scopedAgent(t)));
  const timeout = g.waitMs(params, 60_000);
  const deadline = Date.now() + timeout;
  // until given: those states count; by default anything but working does.
  const ready = (status: string) => (until ? until.includes(status) : status !== "working" && status !== "unknown");
  const approved: Record<string, unknown[]> = {};
  const subscribe = subscriberOf(g.herdr);
  let sub: Subscription | null = null;
  if (subscribe) {
    sub = await subscribe([...agents.map((a: any) => ({ type: "pane.agent_status_changed", pane_id: a.pane_id })), { type: "pane.exited" }, { type: "pane.closed" }]).catch(() => null);
  }
  let now: any[] = [];
  try {
    for (;;) {
      now = await Promise.all(agents.map((a: any) => g.herdr("agent.get", { target: a.pane_id }).then((r) => r.agent ?? r, () => null)));
      // A go-ahead menu is not a reason to stop: answer it and keep waiting.
      if (!until || !until.includes("blocked")) {
        for (const [i, a] of now.entries()) {
          if (a?.agent_status !== "blocked") continue;
          const got = await approveMenus(g.cfg, g.herdr, a.pane_id, "wait_agent", { waitMs: 5000 });
          if (!got.approved.length) continue;
          (approved[a.name ?? a.pane_id] ??= []).push(...got.approved);
          now[i] = (await g.herdr("agent.get", { target: a.pane_id }).catch(() => null))?.agent ?? a;
        }
      }
      if (now.some((a) => !a || ready(a.agent_status)) || Date.now() >= deadline) break;
      const left = deadline - Date.now();
      if (sub) {
        try {
          // Also look again every few seconds: a status Herdr did not push still counts.
          if (await sub.next(Math.min(left, 5000))) while (await sub.next(0).catch(() => null));
        } catch {
          sub = null;
        }
      } else {
        await Bun.sleep(Math.min(left, 1000));
      }
    }
  } finally {
    sub?.close();
  }
  const watched = g.state.watched();
  const views = await Promise.all(
    agents.map(async (orig: any, i: number) => {
      const a = now[i];
      if (!a) return { name: orig.name ?? null, pane_id: orig.pane_id, status: "gone", ready: true };
      const life = await lifecycle(g, a, watched);
      const view: Record<string, unknown> = { ...agentView(a), ready: ready(a.agent_status), attention: life.attention };
      if ("choices" in life) view.choices = life.choices;
      const said = await progressLine(g, a);
      if (said) view[a.agent_status === "working" ? "doing" : "last_said"] = said;
      if (approved[a.name ?? a.pane_id]) view.auto_approved = approved[a.name ?? a.pane_id];
      return view;
    }),
  );
  const timedOut = !views.some((v) => v.ready);
  // One target keeps the old shape (agent) next to the list.
  return { timed_out: timedOut, ready: views.filter((v) => v.ready).map((v) => v.name ?? v.pane_id), agents: views, ...(views.length === 1 ? { agent: views[0] } : {}) };
}

export function agentOps(g: Gateway): Record<string, Op> {
  return {
    // Internal, run by an agent on its own machine: a message to the ChatGPT thread whose
    // lease holds its pane, delivered by that thread's watch card. pane_id is the
    // agent's own pane ($HERDR_PANE_ID).
    async tell(params) {
      const paneId = str(params, "pane_id", TARGET_RE);
      const text = str(params, "text").trim();
      if (!text) throw new GatewayError("invalid_params", "text is empty");
      // The agent must be one Herdr sees, inside the allowed roots, as for every other op.
      const agents: any[] = (await g.herdr("agent.list", {})).agents ?? [];
      if (!agents.some((x) => x.pane_id === paneId && paneInScope(x, g.cfg.allowedRoots))) throw new GatewayError("not_found", `agent ${paneId} not found`);
      const lease = Object.entries(g.state.leases()).find(([, l]) => l.panes.includes(paneId))?.[0];
      if (!lease) throw new GatewayError("no_thread", "no ChatGPT thread holds this agent: ask the owner to link a chat with it first");
      g.state.addTold({ pane_id: paneId, text, at: new Date().toISOString() });
      // Only the lease's tail: the agent prints this into its pane, which any chat can read,
      // and the whole lease would let that chat drive this one's agents.
      return { queued: true, lease: "…" + lease.slice(-4), note: "queued, not delivered yet: it reaches the chat (within about 20 s) only while that chat's link card is open, and is held up to an hour for one; if no reply comes, the chat is not listening" };
    },

    // Internal, used by the MCP server's notifier rather than by ChatGPT.
    // wait_ms: while nothing is found, wait up to that long for a watched agent to change
    // (Herdr events) or a browser run to end, so the notifier hears within a second or so.
    async watch_poll(params) {
      const waitMs = optInt(params, "wait_ms", 0, WATCH_WAIT_MAX_MS) ?? 0;
      const agents = () => pollWatched(g.cfg, g.herdr, Date.now());
      const jobs = () => pollJobs(g.cfg);
      if (waitMs > 0) return await pollWaiting(g.cfg, g.herdr, waitMs, agents, jobs);
      const found = await agents();
      const runs = jobs();
      return withReports({ messages: [...found.messages, ...runs.messages], remaining: found.remaining + runs.remaining }, found.reports);
    },

    async wait_agent(params) {
      return await waitAgents(g, params);
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
        showWatched(g.herdr, agent.pane_id, false);
        return { watching: false, agent: agentView(agent) };
      }
      g.state.manage(agent.pane_id, watchInfo(agent), agent);
      showWatched(g.herdr, agent.pane_id, true);
      // Watched agents never wait on a go-ahead, starting with a menu already up.
      const { approved } = await approveMenus(g.cfg, g.herdr, agent.pane_id, "watch_agent", { waitMs: 20_000 });
      const now = approved.length ? await g.scopedAgent(agent.pane_id) : agent;
      return {
        watching: true,
        agent: { ...agentView(now), ...(await lifecycle(g, now, g.state.watched())) },
        ...(approved.length ? { auto_approved: approved } : {}),
      };
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

    // Which agents are finished and safe to close, and what to close for each. Done
    // means settled, not asking anything, no prompt running, its last turn already
    // reported to the owner, and idle for min_idle_minutes. exited lists panes the
    // bridge made whose agent is gone and whose shell runs nothing. Changes nothing but
    // a "done" note in Herdr's sidebar on each done agent.
    async prunable_agents(params) {
      const minIdle = optInt(params, "min_idle_minutes", 0, 24 * 60) ?? 10;
      const now = Date.now();
      const { agents: allAgents, panes: allPanes } = await agentsAndPanes(g);
      const agents = allAgents.filter((a: any) => paneInScope(a, g.cfg.allowedRoots));
      const watched = g.state.watched();
      const done: Record<string, unknown>[] = [];
      const notDone: Record<string, unknown>[] = [];
      await Promise.all(
        agents.map(async (a: any) => {
          const who = { name: a.name ?? null, pane_id: a.pane_id, agent: a.agent };
          const skip = (reason: string) => void notDone.push({ ...who, reason });
          if (a.agent_status === "working") return skip("working");
          if (a.agent_status === "blocked") return skip("waiting on a menu");
          if (!SETTLED.has(a.agent_status)) return skip(`status ${a.agent_status}`);
          const w = watched[a.pane_id];
          if (w && (!w.managed || w.busy)) return skip("its last turn has not been reported to the owner yet");
          const reply = await agentReply(g.cfg, a).catch(() => null);
          if (reply?.in_progress) return skip(reply.in_progress.interrupted ? "its last prompt was interrupted" : "a prompt is running");
          const { attention } = await lifecycle(g, a, watched, { reply });
          if (attention) return skip(attention === "question" ? "asked the owner a question" : "a menu is up");
          const at = Date.parse(reply?.at ?? w?.last_event?.at ?? "");
          const idle = Number.isNaN(at) ? null : Math.floor((now - at) / 60_000);
          if (idle !== null && idle < minIdle) return skip(`idle ${idle} min, under min_idle_minutes`);
          done.push({
            ...who,
            cwd: a.foreground_cwd ?? a.cwd,
            idle_minutes: idle,
            last_reply: reply ? clip(reply.text, 300) : null,
            git: await gitSummary(g.cfg, a.foreground_cwd ?? a.cwd),
            close: closeFor(g, a, allPanes),
          });
          showDone(g.herdr, a.pane_id);
        }),
      );
      // A pane the bridge made that no agent holds: the agent exited, or went to the
      // background, which leaves a child of the shell.
      const withAgent = new Set(agents.map((a: any) => a.pane_id));
      const mine = new Set(g.state.created("panes"));
      const exited: Record<string, unknown>[] = [];
      for (const p of allPanes) {
        if (!mine.has(p.pane_id) || withAgent.has(p.pane_id) || p.agent || !paneInScope(p, g.cfg.allowedRoots)) continue;
        const info = (await g.herdr("pane.process_info", { pane_id: p.pane_id }).catch(() => null))?.process_info;
        if (typeof info?.shell_pid !== "number" || (await childProcesses(g.cfg, info.shell_pid)).length) continue;
        exited.push({ pane_id: p.pane_id, cwd: p.foreground_cwd ?? p.cwd, label: p.label ?? null, close: closeFor(g, p, allPanes) });
      }
      return { min_idle_minutes: minIdle, done, exited, not_done: notDone };
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
      const ready = async (ms: number) =>
        (await g.herdr("agent.wait", { target: paneId, until: ["idle", "done", "blocked"], timeout_ms: Math.max(1000, Math.min(ms, left())) }, ms + 10_000).catch(() => null))?.agent ??
        (await g.herdr("agent.get", { target: paneId }).catch(() => null))?.agent ?? { agent_status: "unknown" };
      let started = await ready(45_000);
      // A new agent can open on menus that only want a go-ahead: folder trust, an update
      // or model notice. Give it, then wait for the agent again.
      const { approved } = await approveMenus(g.cfg, g.herdr, paneId, "spawn_agent", { waitMs: 20_000 });
      if (approved.length) started = await ready(30_000);
      const status: string = started.agent_status ?? "unknown";
      if (watch) {
        g.state.manage(paneId, { name, cwd: placed.pane.cwd ?? null, kind }, started, true);
        showWatched(g.herdr, paneId, true);
      }
      const out: Record<string, unknown> = { ...placed, name, kind, status, watching: watch, ...(approved.length ? { auto_approved: approved } : {}) };
      if (status === "blocked") {
        out.note = "the agent is showing a menu WorkDone did not answer: get_agent shows it as choices";
      } else if (prompt && status !== "idle" && status !== "done") {
        out.note = "the agent is not ready yet: wait_agent, then prompt_agent";
      } else if (prompt && left() < 5000) {
        out.note = "no time left to send the prompt: call prompt_agent";
      } else if (prompt) {
        const wait = optBool(params, "wait", false);
        try {
          out.prompt = await g.handle("prompt_agent", { target: paneId, text: prompt, wait, timeout_ms: Math.max(1000, left()) });
        } catch (err) {
          // Started, but at a dialog Herdr does not flag that is not a go-ahead.
          if (!(err instanceof GatewayError && err.code === "agent_blocked")) throw err;
          Object.assign(out, { status: "blocked", note: `${err.message}; the prompt was not sent: prompt_agent once it is answered` });
        }
      }
      return out;
    },
  };
}
