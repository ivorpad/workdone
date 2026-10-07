// Work started through WorkDone, kept in work.json until someone records how it ended.
// A spawn, a start, or a first prompt or steer from a ChatGPT chat to an agent with no
// open work opens one. Only the user's word closes it: settle_work (accepted or
// dropped). A turn's end, an error turn, the agent exiting, a lapsed lease, a dropped
// watch or its coordination task merged complete (the supervisor's check against the
// task's acceptance, not the user's) change what it shows, never whether it is open.
// Notifications play no part: owed_work reads this file.

import { randomBytes } from "node:crypto";
import { GatewayError, TARGET_RE } from "./config.ts";
import { currentTaskBinding } from "./coord.ts";
import type { Gateway } from "./gateway.ts";
import { live as leaseLive } from "./leases.ts";
import { optStr, str, type Op, type Params } from "./params.ts";
import type { StateStore } from "./state.ts";

export type WorkOp = "spawn_agent" | "start_agent" | "prompt_agent" | "steer_agent";
export type TurnType = "finished" | "failed" | "question" | "blocked" | "gone";

export interface Work {
  id: string;
  pane_id: string;
  session: string | null;
  agent: string | null;
  kind: string | null;
  // The whole lease of the call that opened it; views show only its tail.
  lease: string | null;
  title: string;
  started_at: string;
  started_by: WorkOp;
  status: "open" | "accepted" | "dropped";
  closed_at?: string;
  closed_by?: string;
  note?: string;
  coord?: { objective: string; id: string };
  // The last turn end the watcher saw, and the inbox entry and result it wrote for it.
  last_turn?: { at: string; type: TurnType; inbox_id?: string; result_id?: string };
}

export const WORK_ID_RE = /^wk_[a-f0-9]{16}$/;
export const WORK_OPS = new Set<string>(["spawn_agent", "start_agent", "prompt_agent", "steer_agent"]);
export const NO_TITLE = "no task prompt yet";
// A pane ID as Herdr writes it (w3T:pJR), as opposed to an agent name.
const PANE_RE = /^[A-Za-z0-9]+:[A-Za-z0-9]+$/;

const newId = () => `wk_${randomBytes(8).toString("hex")}`;
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

// The first non-empty line of what the chat asked, as the work's title.
export function workTitle(text: unknown): string {
  const line = typeof text === "string" ? text.split("\n").map((l) => l.trim()).find(Boolean) : undefined;
  return line ? clip(line, 160) : NO_TITLE;
}

// A turn that ended on an API or transport error rather than an answer: Claude Code's
// "API Error…" (after the "[status]" prefix a Cursor turn's end gets, if any).
const API_ERROR_RE = /^(?:\[[^\]\n]*\]\s*)?API Error\b/;
export const apiError = (text: string | null | undefined) => !!text && API_ERROR_RE.test(text.trim());

export function openWork(all: Record<string, Work>, paneId: string): Work | undefined {
  return Object.values(all).find((w) => w.status === "open" && w.pane_id === paneId);
}

// What a chat sees of a record: never the whole lease.
export function workView(w: Work) {
  return {
    id: w.id, pane_id: w.pane_id, agent: w.agent, title: w.title, started_at: w.started_at, started_by: w.started_by, status: w.status,
    ...(w.closed_at ? { closed_at: w.closed_at, closed_by: w.closed_by ?? null } : {}), ...(w.note ? { note: w.note } : {}),
    ...(w.coord ? { coord: w.coord } : {}), last_turn: w.last_turn ?? null,
  };
}

function taskParam(v: unknown): { objective: string; id: string } | null {
  const t = v as { objective?: unknown; id?: unknown } | null;
  return t && typeof t === "object" && typeof t.objective === "string" && typeof t.id === "string" ? { objective: t.objective, id: t.id } : null;
}

// After a ChatGPT call to spawn_agent, start_agent, prompt_agent or steer_agent went
// through (Gateway.request only: the console opens none, and spawn's own first prompt
// is not a second piece of work). Opens work for the pane, or joins the open one, and
// adds work_id to the result. agent: Herdr's agent for a prompt or steer target.
// Watches stay as the op left them: a prompt's turn watch reports this turn's end to
// workTurn; the work record, not a watch, is what keeps it owed.
export function trackWork(g: Gateway, op: string, params: Params, result: any, lease: string | null, agent: any): void {
  if (!WORK_OPS.has(op) || params.origin === "console" || !result || typeof result !== "object" || Array.isArray(result)) return;
  // A replayed command_id sent nothing.
  if (result.duplicate === true || result.result?.duplicate === true) return;
  // A prompt's target is a name or a pane ID; with the agent gone by now, only the ID says where.
  const target = typeof params.target === "string" && PANE_RE.test(params.target) ? params.target : undefined;
  const paneId: unknown = op === "spawn_agent" ? result.pane?.pane_id : op === "start_agent" ? params.pane_id : (agent?.pane_id ?? target);
  if (typeof paneId !== "string") return;
  const starts = op === "spawn_agent" || op === "start_agent";
  const text = starts ? params.prompt : params.text;
  const now = new Date().toISOString();
  const id = g.state.transaction(() => {
    // spawn_agent and start_agent stored the new agent in its watch entry.
    const w = g.state.watched()[paneId];
    const session: string | null = agent?.agent_session?.value ?? w?.session ?? null;
    const named = (starts && typeof params.name === "string" ? params.name : null) ?? agent?.name ?? w?.name ?? null;
    const kind = (starts ? (result.launched?.kind ?? result.kind) : null) ?? agent?.agent ?? w?.kind ?? null;
    const bound = currentTaskBinding(g.state.coord(), paneId, session);
    // The task asked for counts only when it was bound: a spawn that bound it, or a prompt
    // or steer that carried its slice. A refused bind (deps_unmet, another objective's
    // supervisor) must not tie this work to that task.
    const took = op === "spawn_agent" ? !!(result.task_bound || result.prompt?.dispatch) : !!(result.dispatch || result.result?.dispatch);
    const coord = (took ? taskParam(params.task) : null) ?? (bound ? { objective: bound.o.id, id: bound.t.id } : null);
    return g.state.updateWork((all) => {
      const cur = openWork(all, paneId);
      if (cur) {
        // One open piece of work per pane. A follow-up joins it; a new agent started in
        // the pane takes it over, since nobody said how the earlier one ended.
        if (!cur.title || cur.title === NO_TITLE) cur.title = workTitle(text);
        if (!cur.coord && coord) cur.coord = coord;
        if (starts) Object.assign(cur, { agent: named, kind, session });
        return cur.id;
      }
      const wk: Work = {
        id: newId(), pane_id: paneId, session, agent: named, kind, lease, title: workTitle(text),
        started_at: now, started_by: op as WorkOp, status: "open", ...(coord ? { coord } : {}),
      };
      all[wk.id] = wk;
      return wk.id;
    });
  });
  result.work_id = id;
}

// The watcher, inside its own transaction: the end of a turn on the pane's open work.
export function workTurn(state: StateStore, paneId: string, turn: NonNullable<Work["last_turn"]>) {
  state.updateWork((all) => {
    const w = openWork(all, paneId);
    if (w) w.last_turn = turn;
  });
}

export function workOps(g: Gateway): Record<string, Op> {
  return {
    // The user's word on one piece of work: by work_id, or by target (an agent name or
    // pane ID) for the pane's open work, or, with none, for what the agent told the owner.
    // Allowed from the console, for the lease that holds the pane, or for any live lease
    // when no live lease holds it (its chat is gone). Works for agents that are gone or
    // out of scope: only records change. The agent, its pane and its worktree stay as they are.
    async settle_work(params) {
      const workId = optStr(params, "work_id", WORK_ID_RE);
      const target = workId ? undefined : optStr(params, "target", TARGET_RE);
      if (!workId && !target) throw new GatewayError("invalid_params", "pass work_id, or target (an agent name or pane ID), as owed_work's settle gives them");
      const outcome = str(params, "outcome");
      if (outcome !== "accepted" && outcome !== "dropped") throw new GatewayError("invalid_params", "outcome must be accepted or dropped");
      const note = optStr(params, "note")?.trim().slice(0, 500);
      const fromConsole = params.origin === "console";
      // Before the transaction: requireLive takes the state lock itself, and a name is
      // looked up in Herdr. A name Herdr no longer knows is looked up in the records.
      const lease = fromConsole ? null : g.leases.requireLive(params);
      const named = target && !PANE_RE.test(target) ? ((await g.scopedAgent(target).catch(() => null))?.pane_id as string | undefined) : undefined;
      const now = new Date();
      return g.state.transaction(() => {
        const leases = g.state.leases();
        const by = fromConsole ? "console"
          : lease ? `lease …${lease.slice(-4)} "${(leases[lease]?.label ?? "").replace(/["\n]/g, "").slice(0, 60)}"`
          : "caller without a lease";
        const authorize = (paneId: string) => {
          if (!lease) return;
          const holder = Object.entries(leases).find(([, l]) => leaseLive(l, now.getTime()) && l.panes.includes(paneId));
          if (holder && holder[0] !== lease) {
            throw new GatewayError("not_your_agent", `${paneId} belongs to another thread ("${holder[1].label}"): only that thread, or the owner at the console, settles its work`);
          }
        };
        const r = g.state.updateWork((all) => {
          let paneId = target && PANE_RE.test(target) ? target : named;
          if (target && !paneId) {
            paneId = Object.values(all).find((x) => x.status === "open" && x.agent === target)?.pane_id
              ?? g.state.inbox().filter((e) => e.status === "unanswered" && e.agent === target && e.pane_id).at(-1)?.pane_id ?? undefined;
            if (!paneId) throw new GatewayError("agent_not_found", `no agent, open work or unanswered message for ${target}`);
          }
          const w = workId ? (Object.hasOwn(all, workId) ? all[workId]! : null) : openWork(all, paneId!) ?? null;
          if (workId && !w) throw new GatewayError("work_not_found", `no work ${workId} on this machine: owed_work lists what is open`);
          if (w && w.status !== "open") throw new GatewayError("work_closed", `${w.id} was already ${w.status} at ${w.closed_at ?? "an earlier time"} by ${w.closed_by ?? "someone"}`);
          const pane = w?.pane_id ?? paneId!;
          authorize(pane);
          if (w) Object.assign(w, { status: outcome, closed_at: now.toISOString(), closed_by: by, ...(note ? { note } : {}) });
          return { pane, work: w ? { ...w } : null };
        });
        // What the agent told the owner about it is answered by this.
        const answered = g.state.inboxResolve({ target: r.pane }, "answered", by, now);
        if (r.work) return { settled: true, work: workView(r.work), inbox_answered: answered, note: "recorded; the agent, its pane and any worktree are left as they are" };
        return { settled: false, pane_id: r.pane, resolved: answered, note: "no open work on this pane: its unanswered messages are marked answered; nothing else changed" };
      });
    },
  };
}
