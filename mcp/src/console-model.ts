// What the console shows, as pure functions over the gateways' own answers: who needs
// the owner, who steers which agent, and what each audit line or report means. Nothing
// here calls a gateway or holds state, so it is tested without one.

import type { Report } from "../../gateway/watcher.ts";

export interface MachineState {
  ok: boolean;
  error?: { code: string; message: string };
  agents: any[];
  counts: Record<string, number>;
  objectives: any[];
  claims: any[];
  leases: any[];
  // What agents told the owner (gateway inbox, plus derived finishes), with how each could be delivered.
  inbox: { entries: any[]; pending: any[]; unanswered: number };
  // The gateway has no console_snapshot yet: the console fell back to separate reads, and the inbox is empty.
  legacy?: boolean;
}

// How long to wait before the next look. Fast while the state is changing, doubling each
// look that finds nothing new, up to a ceiling. Anything that happens (a report, a click)
// resets it to fast.
export function pollDelay(unchanged: number, base = 4_000, max = 60_000): number {
  return Math.min(max, base * 2 ** Math.min(unchanged, 10));
}

// Where an inbox entry can go. The gateway keeps every entry; this says what could carry it
// to a chat, without claiming it arrived: an agent held by a thread is queued for that thread
// (its card or Events subscription may or may not be listening), an agent no thread holds
// reaches only a chat subscribed to agent.message events, and with neither nothing is woken.
export function deliveryOf(entry: { status: string; thread?: string | null; derived?: boolean }, eventsSubscribed: boolean): { route: "thread" | "events" | "none"; text: string } {
  if (entry.status === "answered") return { route: "none", text: "answered" };
  if (entry.status === "dismissed") return { route: "none", text: "dismissed" };
  if (entry.thread) return { route: "thread", text: `queued for thread “${entry.thread}”; delivery to the chat is not confirmed` };
  if (eventsSubscribed) return { route: "events", text: "no thread holds this agent; a chat subscribed to agent events may get it" };
  return { route: "none", text: "undelivered: no chat route for this agent. It waits here" };
}

export interface Need {
  id: string;
  level: "act" | "check";
  kind: "menu" | "approve" | "question" | "stalled" | "human" | "acceptance" | "machine" | "result" | "inbox";
  machine: string;
  pane_id?: string;
  name?: string | null;
  title: string;
  detail: string;
  menu?: { dialog_id?: string; kind?: string; go_ahead?: number | null; gated?: string; text: string; options: Array<{ n: number; label: string; free_text?: boolean }> };
  pending?: string;
}

export interface ConsoleEvent {
  id: number;
  at: string;
  machine: string | null;
  // agent: what Herdr's watcher reported. chatgpt: a call made under a ChatGPT thread's
  // lease. console: the owner here (its calls are published as they happen). gateway: a
  // call without a lease, or an automatic answer.
  source: "agent" | "chatgpt" | "console" | "gateway";
  kind: string;
  agent: string | null;
  text: string;
  // Worth a look: a refused steer, a takeover, a failed call.
  flag?: boolean;
}

const clip = (s: unknown, n: number) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
};

// Which ChatGPT thread holds a pane, by its lease label, or nobody. The console holds nothing:
// it acts over leases as the owner, so this only says who else is steering.
export function controlOf(paneId: string, leases: Array<{ label: string; panes: string[] }>) {
  const held = leases.find((l) => l.panes.includes(paneId));
  return held ? { by: "thread" as const, label: held.label } : { by: "none" as const, label: null };
}

export function buildNeeds(machines: Record<string, MachineState>, supervisor: Record<string, Record<string, any>>, pending: Array<{ pending: string; machine: string; op: string; reason: string; detail: string }>): Need[] {
  const needs: Need[] = [];
  for (const [machine, m] of Object.entries(machines)) {
    if (!m.ok) {
      needs.push({ id: `machine:${machine}`, level: "check", kind: "machine", machine, title: `${machine} is not answering`, detail: m.error?.message ?? "no answer" });
      continue;
    }
    for (const a of m.agents) {
      const base = { machine, pane_id: a.pane_id as string, name: (a.name ?? null) as string | null };
      const who = `${a.name ?? a.title ?? a.pane_id} (${a.pane_id})`;
      if (a.attention === "dialog" && a.choices) {
        const c = a.choices;
        needs.push({ ...base, id: `menu:${machine}:${a.pane_id}:${c.dialog_id ?? ""}`, level: "act", kind: "menu", title: `${who} shows a menu`, detail: clip(c.text, 400), menu: { dialog_id: c.dialog_id, kind: c.kind, go_ahead: c.go_ahead ?? null, gated: c.gated, text: String(c.text ?? ""), options: Array.isArray(c.options) ? c.options.map((o: any) => ({ n: o.n, label: String(o.label), ...(o.free_text ? { free_text: true } : {}) })) : [] } });
      } else if (a.attention === "question") {
        needs.push({ ...base, id: `question:${machine}:${a.pane_id}`, level: "check", kind: "question", title: `${who} is asking you something`, detail: clip(a.last_reply?.text, 400) });
      }
      const s = supervisor[machine]?.[a.pane_id];
      if (s && (s.state === "stalled" || s.state === "repetitive_loop")) {
        const rec = s.recommendations?.[0];
        needs.push({ ...base, id: `stalled:${machine}:${a.pane_id}`, level: "check", kind: "stalled", title: `${who} is ${s.state === "stalled" ? "stalled" : "looping"}`, detail: clip(rec ? `${rec.action}: ${(rec.reasons ?? []).join(" ")}` : "", 300) });
      }
      if (a.watch?.result_pending) {
        needs.push({ ...base, id: `result:${machine}:${a.pane_id}`, level: "check", kind: "result", title: `${who} owes a result`, detail: "A reply: true result has not been delivered yet. read_agent has what it said so far." });
      }
    }
    // One need per agent for what it said and nobody answered, newest first: the owner should not have to tell ChatGPT an agent is done.
    const byPane = new Map<string, any[]>();
    for (const e of m.inbox?.entries ?? []) if (e.status === "unanswered" && e.pane_id) byPane.set(e.pane_id, [...(byPane.get(e.pane_id) ?? []), e]);
    for (const [pane, list] of byPane) {
      const e = list[0];
      const who = `${e.agent ?? pane} (${pane})`;
      const verb = e.kind === "tell" ? "wrote to you" : e.kind === "gone" ? "exited" : e.kind === "question" ? "asked a question" : e.kind === "result" ? "returned a result" : "finished";
      needs.push({ id: `inbox:${machine}:${pane}`, level: "check", kind: "inbox", machine, pane_id: pane, name: e.agent ?? null, title: `${who} ${verb}${list.length > 1 ? ` (${list.length} unanswered)` : ""}`, detail: clip(e.text, 400) });
    }
    for (const o of m.objectives) {
      for (const t of o.blocked_human ?? []) needs.push({ id: `human:${machine}:${o.id}:${t.id}`, level: "act", kind: "human", machine, title: `${o.id} ${t.id} needs a person`, detail: clip(t.blocker, 300) });
      for (const t of o.needs_acceptance ?? []) needs.push({ id: `accept:${machine}:${o.id}:${t.id}`, level: "check", kind: "acceptance", machine, title: `${o.id} ${t.id} awaits acceptance`, detail: clip(t.result?.summary ?? t.title, 300) });
    }
  }
  for (const p of pending) {
    needs.push({ id: `approve:${p.pending}`, level: "act", kind: "approve", machine: p.machine, title: `Held ${p.op} on ${p.machine}: ${p.reason}`, detail: clip(p.detail, 600), pending: p.pending });
  }
  const rank: Record<Need["kind"], number> = { menu: 0, approve: 1, human: 2, question: 3, inbox: 4, stalled: 5, result: 6, acceptance: 7, machine: 8 };
  return needs.sort((x, y) => rank[x.kind] - rank[y.kind]);
}

// Gateway ops worth a line in the feed. Reads and the notifier's own polling are left out.
export const TOUCH = new Set(["prompt_agent", "steer_agent", "answer_agent", "claim_agents", "release_agents", "send_agent_keys", "spawn_agent", "start_agent", "close", "supervisor_nudge", "set_agent_approval", "owner_note", "auto_approve", "coord_update", "send_pane_input", "run_command_in_pane"]);

// One audit line as a feed event, or null. The console's own calls (audit args origin
// console) are published when they happen, so their audit copy is skipped.
export function auditToEvent(machine: string, e: Record<string, any>): Omit<ConsoleEvent, "id"> | null {
  const op = typeof e.op === "string" ? e.op : null;
  if (!op || !TOUCH.has(op)) return null;
  const args = e.args ?? {};
  if (args.origin === "console") return null;
  const lease: string | null = typeof args.lease === "string" ? args.lease : null;
  const target = args.target ?? args.pane_id ?? args.id ?? null;
  const source: ConsoleEvent["source"] = lease ? "chatgpt" : "gateway";
  const failed = e.ok === false;
  const verb: Record<string, string> = { prompt_agent: "prompted", steer_agent: "steered", answer_agent: "answered a menu on", claim_agents: args.take_over ? "took over" : "claimed", release_agents: "released", send_agent_keys: "sent keys to", spawn_agent: "spawned", start_agent: "started", close: "closed", supervisor_nudge: "nudged", set_agent_approval: "set approval policy on", owner_note: "left an owner note on", auto_approve: "auto-approved a menu on", coord_update: "updated coordination for", send_pane_input: "typed into", run_command_in_pane: "ran a command in" };
  const subject = target ?? args.name ?? args.objective ?? "";
  const text = `${failed ? `refused (${e.code ?? "error"}): ` : ""}${verb[op] ?? op} ${subject}${typeof args.text === "string" ? `: ${clip(args.text, 120)}` : ""}`.trim();
  return {
    at: String(e.ts ?? new Date().toISOString()), machine, source, kind: op, agent: typeof target === "string" ? target : null, text,
    // A takeover moves an agent between threads. A refusal for ownership or a stale menu is two controllers colliding.
    flag: failed && ["not_your_agent", "needs_lease", "stale_dialog", "lease_unknown", "agent_busy", "agent_blocked"].includes(String(e.code)) || (op === "claim_agents" && args.take_over === true),
  };
}

export function reportToEvent(machine: string, r: Report): Omit<ConsoleEvent, "id"> {
  const owner = r.origin === "owner";
  return {
    at: r.occurred_at ?? new Date().toISOString(), machine, source: owner ? "console" : "agent", kind: owner ? "owner_note" : r.type,
    agent: r.agent ?? r.pane_id, text: clip(r.excerpt ?? r.message, 240),
    flag: r.type === "blocked" || r.type === "gone" || r.type === "question",
  };
}
