// owed_work: the work started through WorkDone on this machine that the user is still owed,
// read from the gateway's own state (work.json first, then watch.json, inbox.json,
// leases.json, coord.json) and one Herdr agent list. Read-only. A delivered event or a
// card that showed it changes nothing here: open work stays until it is settled, and
// anything else until the agent gets a follow-up or the owner dismisses it.
// owedDigest is the same derivation from state alone, small enough to ride on other results.

import { paneInScope } from "./config.ts";
import { currentTaskBinding, type CoordStore } from "./coord.ts";
import { resumeView, type Live } from "./coord-views.ts";
import type { Gateway } from "./gateway.ts";
import { live as leaseLive } from "./leases.ts";
import type { Op } from "./params.ts";
import type { InboxEntry, Lease, StateStore, Watched } from "./state.ts";
import { agentReply } from "./transcript.ts";
import type { TurnResult } from "./watcher.ts";
import type { Work } from "./work.ts";

export interface OwedState {
  watched: Record<string, Watched>;
  inbox: InboxEntry[];
  leases: Record<string, Lease>;
  coord: CoordStore;
  work: Record<string, Work>;
}

// One Herdr read: agents in scope by pane, and panes with a live agent outside the roots,
// which are left out as every other op leaves them out.
export interface LiveAgents {
  agents: Map<string, any>;
  hidden: Set<string>;
}

// A pane owed regardless of what the watch and inbox say. Open work records come in
// here, ahead of the derived sources.
export interface OwedSeed {
  pane_id: string;
  agent?: string | null;
  kind?: string | null;
  cwd?: string | null;
}

export type ItemState = "needs_you" | "failed" | "unread_result" | "gone" | "working" | "open";
const ORDER: ItemState[] = ["needs_you", "failed", "unread_result", "gone", "working", "open"];

// One line each, inside docs/loop-risks.md: nothing here asks for a resend or a second prompt.
export const NEXT: Record<ItemState | "held" | "left", string> = {
  needs_you: "It is waiting on the user: get_agent shows the menu or question. Ask the user, then answer it once.",
  failed: "Its last turn failed: tell the user what failed and ask how to go on. It stays open until they accept or drop it (settle_work with settle).",
  unread_result: "Tell the user its result (last_result, or read_agent source reply). When they accept or drop it, settle_work with settle.",
  gone: "The agent exited or is out of reach (status gone): tell the user its last_result and unanswered messages. Start no new agent unless they ask; settle_work with settle when they accept or drop the work.",
  working: "Still working: its turn end shows here whether or not an event reaches this chat. Send it nothing meanwhile unless the user asks.",
  open: "Idle with nothing unread: ask the user whether it is done (settle_work with settle, accepted), no longer wanted (dropped) or what comes next.",
  left: "Its agent moved outside the allowed roots, so WorkDone can no longer reach it: tell the user, and settle_work with settle once they decide.",
  held: "Another conversation holds it: tell the user its holder, and take it over (claim_agents take_over) only on their word.",
};

const UNREAD = new Set(["result", "finished", "tell"]);
// What makes a pane with no open work owed: something the agent told, asked or returned
// for a reply: true. A turn's end or an exit alone is not: nobody asked for it.
const OWED_KINDS = new Set(["tell", "question", "result"]);
const BACKGROUND = new Set(["background", "stopped"]);
const tail = (id: string) => "…" + id.slice(-4);
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

// One consistent read of the five files, under the state lock and outside any Herdr call.
export function readOwed(state: StateStore): OwedState {
  return state.transaction(() => ({ watched: state.watched(), inbox: state.inbox(), leases: state.leases(), coord: state.coord(), work: state.work() }));
}

// The lease that holds a pane, lapsed ones included (a live one first). With none, the
// lease that asked for its result or its last turn, which may have lapsed and been pruned.
function holderOf(leases: Record<string, Lease>, paneId: string, now: number, recorded: Array<string | null | undefined>): [string, Lease | undefined] | null {
  let best: [string, Lease] | null = null;
  for (const [id, l] of Object.entries(leases)) {
    if (!l.panes.includes(paneId)) continue;
    const better = !best || (leaseLive(l, now) ? !leaseLive(best[1], now) || Date.parse(l.used) > Date.parse(best[1].used) : !leaseLive(best[1], now) && Date.parse(l.used) > Date.parse(best[1].used));
    if (better) best = [id, l];
  }
  if (best) return best;
  const id = recorded.find((x): x is string => typeof x === "string" && x.length > 0);
  return id ? [id, leases[id]] : null;
}

export function deriveOwed(s: OwedState, opts: { roots: string[]; live: LiveAgents | null; lease?: string | null; now?: number; seeds?: OwedSeed[] }) {
  const now = opts.now ?? Date.now();
  const live = opts.live;
  const mine = opts.lease ?? null;
  const unanswered = new Map<string, InboxEntry[]>();
  for (const e of s.inbox) {
    if (e.status !== "unanswered" || !e.pane_id) continue;
    const list = unanswered.get(e.pane_id) ?? [];
    list.push(e);
    unanswered.set(e.pane_id, list);
  }
  // Open work by pane (one each).
  const work = new Map<string, Work>();
  for (const wk of Object.values(s.work ?? {})) if (wk.status === "open") work.set(wk.pane_id, wk);
  const seeds = new Map((opts.seeds ?? []).map((x) => [x.pane_id, x]));
  for (const wk of work.values()) if (!seeds.has(wk.pane_id)) seeds.set(wk.pane_id, { pane_id: wk.pane_id, agent: wk.agent, kind: wk.kind });
  // A pane is owed something when it has open work. Without open work: a result or a
  // turn's end still due to a thread, something the agent told, asked or returned that is
  // unanswered, or a menu up on an agent WorkDone watches (gone once answered). Panes
  // with open work count everything below.
  const panes = new Set<string>(seeds.keys());
  for (const [paneId, w] of Object.entries(s.watched)) {
    if (w.result_request || w.reply_to) panes.add(paneId);
    // Without a live read, a managed entry stands for its agent: the watcher drops it once the agent is gone.
    else if (w.managed && (w.last_status === "blocked" || w.dialog_id) && (!live || live.agents.has(paneId))) panes.add(paneId);
  }
  for (const [paneId, list] of unanswered) if (list.some((e) => OWED_KINDS.has(e.kind))) panes.add(paneId);

  const items = [];
  for (const paneId of panes) {
    const wk = work.get(paneId);
    // Out of scope now: nothing of the live agent is shown, its open work still is.
    const left = !!live?.hidden.has(paneId);
    if (left && !wk) continue;
    const w = s.watched[paneId];
    const entries = unanswered.get(paneId) ?? [];
    const last = entries.at(-1);
    const seed = seeds.get(paneId);
    const a = left ? undefined : live?.agents.get(paneId);
    const cwd: string | null = left ? null : a ? (a.foreground_cwd ?? a.cwd ?? null) : (w?.cwd ?? last?.cwd ?? seed?.cwd ?? null);
    // Stored directories were in scope when written; the roots may have narrowed since.
    if (!a && cwd && !paneInScope({ cwd }, opts.roots)) continue;
    const status: string = left ? "left"
      : a ? String(a.agent_status ?? "unknown")
      : w && BACKGROUND.has(w.last_status ?? "") ? w.last_status!
      : live ? "gone"
      : w ? (w.last_status ?? "unknown")
      : last?.kind === "gone" || wk?.last_turn?.type === "gone" ? "gone" : "unknown";
    const asks = entries.some((e) => e.kind === "question");
    const menu = status === "blocked" || (status !== "gone" && !!w?.dialog_id);
    // A failed last turn stands until the agent is at work again.
    const failed = wk?.last_turn?.type === "failed" && status !== "working" && status !== "background" && !w?.busy;
    const state: ItemState = left ? "gone"
      : asks || menu ? "needs_you"
      : failed ? "failed"
      : entries.some((e) => UNREAD.has(e.kind)) ? "unread_result"
      : status === "gone" ? "gone"
      : status === "working" || status === "background" ? "working"
      : "open";
    const found = holderOf(s.leases, paneId, now, [w?.result_request?.lease, w?.reply_to, ...[...entries].reverse().map((e) => e.lease), wk?.lease]);
    const holder = found && {
      lease: tail(found[0]), label: found[1]?.label ?? null, origin: found[1]?.origin ?? null, created_at: found[1]?.created ?? null,
      live: !!found[1] && found[1].panes.includes(paneId) && leaseLive(found[1], now),
    };
    const yours = !!mine && found?.[0] === mine;
    const session: string | null = a?.agent_session?.value ?? w?.session ?? last?.session ?? wk?.session ?? null;
    const bound = currentTaskBinding(s.coord, paneId, session);
    const said = [...entries].reverse().find((e) => e.task)?.task;
    const named = said ?? wk?.coord;
    const task = bound ? { objective: bound.o.id, id: bound.t.id, status: bound.t.status }
      : named ? { objective: named.objective, id: named.id, status: s.coord.objectives[named.objective]?.tasks[named.id]?.status ?? null } : null;
    const lastResult: TurnResult | null = w?.last_result ?? [...entries].reverse().find((e) => e.result)?.result ?? null;
    items.push({
      pane_id: paneId,
      agent: (a?.name ?? w?.name ?? last?.agent ?? seed?.agent ?? null) as string | null,
      kind: (a?.agent ?? w?.kind ?? last?.agent_kind ?? seed?.kind ?? null) as string | null,
      cwd, status, holder, yours, state,
      result_pending: w?.result_request?.id ?? null,
      last_result: lastResult,
      unanswered: entries.slice(-5).reverse().map((e) => ({ id: e.id, kind: e.kind, at: e.at, text: clip(e.text, 200) })),
      ...(entries.length > 5 ? { unanswered_total: entries.length } : {}),
      task,
      work: wk ? { id: wk.id, title: wk.title, started_at: wk.started_at, started_by: wk.started_by, last_turn: wk.last_turn ?? null } : null,
      // What settle_work takes for this item.
      settle: wk ? { work_id: wk.id } : { target: paneId },
      next: mine && holder?.live && !yours ? NEXT.held : left ? NEXT.left : NEXT[state],
      // For ordering only; dropped below.
      _at: Date.parse(last?.at ?? w?.last_event?.at ?? wk?.last_turn?.at ?? w?.since ?? wk?.started_at ?? "") || 0,
    });
  }
  items.sort((x, y) => ORDER.indexOf(x.state) - ORDER.indexOf(y.state) || y._at - x._at || x.pane_id.localeCompare(y.pane_id));
  const out = items.map(({ _at, ...i }) => i);

  const liveMap: Live = Object.fromEntries([...(live?.agents ?? [])].map(([p, a]) => [p, { status: a.agent_status ?? "unknown", name: a.name ?? null, session: a.agent_session?.value ?? null }]));
  const objectives = Object.values(s.coord.objectives).map((o) => {
    const r = resumeView(s.coord, o, liveMap);
    const sup = o.supervisor ? s.leases[o.supervisor] : undefined;
    return {
      id: o.id, supervisor: r.supervisor, supervisor_live: !!sup && leaseLive(sup, now), yours: !!mine && o.supervisor === mine,
      pending_transitions: r.pending_transitions.length,
      needs_acceptance: r.needs_acceptance.map((t) => t.id), blocked_human: r.blocked_human.map((t) => t.id), ready: r.ready.map((t) => t.id),
    };
  }).filter((o) => o.pending_transitions || o.needs_acceptance.length || o.blocked_human.length || o.ready.length);

  return {
    counts: { open: out.length, needs_you: out.filter((i) => i.state === "needs_you").length, unread: out.filter((i) => i.state === "unread_result").length },
    items: out,
    objectives,
  };
}

export type OwedItem = ReturnType<typeof deriveOwed>["items"][number];

function oneLine(i: OwedItem): string {
  const who = i.agent ? `${i.agent} (${i.pane_id})` : i.pane_id;
  const said = i.state === "needs_you" ? (i.unanswered.find((e) => e.kind === "question")?.text ?? "a menu is up")
    : i.state === "unread_result" || i.state === "failed" ? (i.unanswered.find((e) => UNREAD.has(e.kind))?.text ?? i.state)
    : i.result_pending ? `result ${i.result_pending} pending`
    : i.work ? `${i.status}, ${i.work.title}` : i.status;
  return clip(`${who} ${i.state}: ${said.replace(/\s+/g, " ").trim()}`, 120);
}

// From state files only, no Herdr call: what other results carry as owed. Without a live
// read it can't see scope changes since a watch was written; owed_work can.
export function owedDigest(state: StateStore, roots: string[], now = Date.now()) {
  const { counts, items } = deriveOwed(readOwed(state), { roots, live: null, now });
  return { ...counts, top: items.slice(0, 5).map(oneLine) };
}

export function owedOps(g: Gateway): Record<string, Op> {
  return {
    // lease marks which items are this conversation's; nothing here needs one or touches one.
    async owed_work(params) {
      const lease = typeof params.lease === "string" ? params.lease : null;
      const now = Date.now();
      const snap = readOwed(g.state);
      let live: LiveAgents | null = null;
      let herdrError: string | null = null;
      try {
        const agents: any[] = (await g.herdr("agent.list", {})).agents ?? [];
        live = { agents: new Map(), hidden: new Set() };
        for (const a of agents) {
          if (typeof a?.pane_id !== "string") continue;
          if (paneInScope(a, g.cfg.allowedRoots)) live.agents.set(a.pane_id, a);
          else live.hidden.add(a.pane_id);
        }
      } catch (err) {
        // The state still says what is owed; statuses are then the watcher's last look.
        herdrError = String((err as { code?: unknown })?.code ?? "herdr_error");
      }
      const owed = deriveOwed(snap, { roots: g.cfg.allowedRoots, live, lease, now });
      // Herdr's "done" (finished, nobody looked yet) on agents no item covers, as the console's
      // derived inbox entries: an entry stored at or after the reply stands in for it.
      const covered = new Set(owed.items.map((i) => i.pane_id));
      const done = [...(live?.agents.values() ?? [])].filter((a) => a.agent_status === "done" && !covered.has(a.pane_id)).slice(0, 20);
      const unwatched = await Promise.all(done.map(async (a) => {
        const reply = await agentReply(g.cfg, a).catch(() => null);
        const said = Date.parse(reply?.at ?? "") || 0;
        if (snap.inbox.some((e) => e.pane_id === a.pane_id && Date.parse(e.at) >= said - 60_000)) return null;
        return { pane_id: a.pane_id as string, agent: (a.name ?? null) as string | null, kind: (a.agent ?? null) as string | null, cwd: (a.foreground_cwd ?? a.cwd ?? null) as string | null, last_reply_at: reply?.at ?? null };
      }));
      return { ...owed, unwatched_done: unwatched.filter((x) => x !== null), ...(herdrError ? { herdr_error: herdrError } : {}) };
    },
  };
}
