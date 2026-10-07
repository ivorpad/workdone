// Reports on watched agents: when one finishes a turn, asks its owner something,
// stops at a dialog or disappears. prompt_agent watches the turn it started when the
// call returns before the agent settles. A managed agent (watch_agent, or started by
// start_agent or spawn_agent) is reported on every turn until it exits. A dialog that
// only asks for a go-ahead (a permission, folder trust) is answered, not reported.
//
// Normally the MCP server on OVH polls each gateway's watch_poll op and sends the
// messages through the gateway whose notifyCommand reaches the phone, so it keeps
// working when the Mac is asleep. Run as a script, this file is the standalone
// alternative for a single machine: poll every 5 s and run notifyCommand itself.

import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, resolve } from "node:path";
import { approveMenus, dialogView, menuScreen, type Approval } from "./answer-ops.ts";
import { parseDialog, type Dialog } from "./dialog.ts";
import { asksOwner, dialogExcerpt, replyExcerpt, screenReply } from "./attention.ts";
import { activityDigest, checkpoint } from "./checkpoint.ts";
import { currentTaskBinding, runEnded } from "./coord.ts";
import { notifyTransitions } from "./coord-ops.ts";
import { GatewayError, loadConfig, paneInScope, type GatewayConfig, type HerdrCall } from "./config.ts";
import { subscriberOf, type Subscription } from "./herdr-events.ts";
import { herdrSocket } from "./herdr-socket.ts";
import { showWatched } from "./sidebar.ts";
import { childEnv, childProcesses, runProcess } from "./process.ts";
import { StateStore, seenState, type Watched } from "./state.ts";
import { agentReply } from "./transcript.ts";
import { textOf } from "./views.ts";
import { apiError, workTurn } from "./work.ts";

const POLL_MS = 5000;
// An agent that reads idle this soon after the prompt may not have started yet.
const START_GRACE_MS = 15_000;
const MAX_AGE_MS = 24 * 3600_000;
const SETTLED = new Set(["idle", "done"]);
const ACTIVE = new Set(["working", "blocked"]);

function log(event: string, extra: Record<string, unknown> = {}) {
  console.error(JSON.stringify({ ts: new Date().toISOString(), event, ...extra }));
}

export type WatchEvent = "finished" | "blocked" | "gone" | "background";

export interface Decision {
  event?: WatchEvent;
  drop?: boolean;
  set?: Partial<Watched>;
}

// What to do with one watched agent: report an event, drop the entry, record new
// state, or nothing. Events fire on edges: a settled or blocked agent that stays
// that way is reported once.
export function decide(w: Watched, agent: any, now: number): Decision {
  if (!w.managed && now - Date.parse(w.since) > MAX_AGE_MS) return { drop: true };
  // Another kind of agent in the pane: the watched one exited between two polls.
  if (!agent || (w.kind && agent.agent && agent.agent !== w.kind)) return { event: "gone", drop: true };
  const seen = seenState(agent);
  const status = seen.last_status!;
  if (w.managed && seen.session && w.session && seen.session !== w.session) {
    // A new session: the agent was restarted, or started a new chat. Count turns from here.
    return { set: { ...seen, busy: status === "working", prompted_at: undefined } };
  }
  // The status changed at least once since the last look, even if it reads the same.
  const moved = seen.seq !== undefined && w.seq !== undefined && seen.seq !== w.seq;
  if (SETTLED.has(status)) {
    // A turn watch exists because a turn is running; a managed entry keeps track in busy.
    const busy = w.managed ? w.busy === true : true;
    const started = w.managed ? w.prompted_at : w.since;
    if (busy) {
      if (!ACTIVE.has(w.last_status ?? "") && !moved && started && now - Date.parse(started) <= START_GRACE_MS) return {};
      return { event: "finished", drop: !w.managed, set: { ...seen, busy: false, prompted_at: undefined } };
    }
    // A turn ran between two polls. done is a completion nobody has looked at yet; idle
    // with a new seq left idle and came back. done to idle alone is someone looking.
    if (status === "done" && (w.last_status !== "done" || moved)) return { event: "finished", set: seen };
    if (status === "idle" && w.last_status === "idle" && moved) return { event: "finished", set: seen };
    return status !== w.last_status || moved || seen.session !== w.session ? { set: seen } : {};
  }
  if (status === "blocked") return w.last_status === "blocked" && !moved ? {} : { event: "blocked", set: seen };
  // Only work starts a turn. A dialog can come up without one, e.g. folder trust at startup.
  const turn = w.managed && status === "working" ? { busy: true, prompted_at: undefined } : {};
  if (status !== w.last_status || moved || (w.managed && status === "working" && !w.busy)) return { set: { ...seen, ...turn } };
  return {};
}

export interface Note {
  type: "finished" | "question" | "blocked" | "gone" | "background" | "stopped";
  excerpt: string | null;
  pid?: number;
  // The whole final answer, for the RESULT: line and the supervisor's turn record.
  text?: string | null;
  // gone because Herdr still runs the agent, but outside the allowed roots.
  left?: boolean;
  // A finished turn that ended on an API or transport error, not an answer. Recorded on
  // the pane's open work only; reports and results don't carry it.
  failed?: boolean;
}

// The final result a caller asked for with reply: true. Metadata and a one-line
// summary; the full answer stays with read_agent.
export interface TurnResult {
  result_id: string;
  requested_at: string;
  status: "finished" | "interrupted" | "gone";
  // The agent's last line starting RESULT:, or null when it wrote none.
  summary: string | null;
  commit: string | null;
  tree: string | null;
  clean: boolean | null;
  changed: number | null;
  branch: string | null;
  kind: string | null;
  model: string | null;
  model_id: string | null;
  effort: string | null;
}

// The last line of a final answer that starts with RESULT: (bold or not).
export function resultLine(text: string | null | undefined): string | null {
  if (!text) return null;
  let found: string | null = null;
  for (const m of text.matchAll(/^[ \t>*_-]*RESULT:\**[ \t]*(.+?)[ \t*_]*$/gm)) found = m[1]!.trim();
  return found ? clip(found, 1000) : null;
}

// The same event as a message, for code: the MCP server wakes the ChatGPT thread whose
// lease holds the agent, so it can answer a question without the owner relaying it.
export interface Report {
  // Stable within this occurrence, including duplicates and webhook retries.
  // Optional for gateways from before native MCP Events.
  event_id?: string;
  occurred_at?: string;
  pane_id: string | null;
  objective?: string;
  recipient_lease?: string;
  transition?: { task: string; seq: number; kind: string };
  // "message": an agent wrote to its thread with tell.
  type: Note["type"] | "message";
  agent: string | null;
  kind: string | null;
  cwd: string | null;
  excerpt: string | null;
  lease: string | null;
  // The thread this turn answers (see Watched.reply_to), when a thread asked for it.
  reply_to: string | null;
  message: string;
  // "owner": a note the owner typed in the console. Set by the gateway only; an agent's tell never carries it.
  origin?: "owner";
  // Menu data for agent.asks. The receiver must re-read before answering it.
  choices?: ReturnType<typeof dialogView>;
  // Present once, on the turn end that resolves a reply: true request.
  result?: TurnResult;
}

// An inbox entry's identity for a result, from what the watcher already holds (it runs inside the state lock, with no Herdr call).
function inboxContext2(store: StateStore, paneId: string, agent: any, w: Watched, leases: Record<string, { panes: string[]; used: string }>, now: number) {
  const session = seenState(agent).session ?? w.session ?? null;
  const bound = currentTaskBinding(store.coord(), paneId, session ?? undefined);
  return {
    pane_id: paneId, agent: (agent?.name ?? w.name ?? null) as string | null, agent_kind: (agent?.agent ?? w.kind ?? null) as string | null, cwd: (w.cwd ?? agent?.cwd ?? null) as string | null,
    session: session as string | null, lease: leaseOf(leases, paneId, now), task: bound ? { objective: bound.o.id, id: bound.t.id } : null,
  };
}

// The live lease holding a pane (leases lapse a day after their last use, as in leases.ts).
function leaseOf(leases: Record<string, { panes: string[]; used: string }>, paneId: string, now: number): string | null {
  for (const [id, l] of Object.entries(leases)) if (now - Date.parse(l.used) < 24 * 3600_000 && l.panes.includes(paneId)) return id;
  return null;
}

// A watched agent Herdr stopped seeing may still be alive. A job that is stopped and
// then continued from outside (SIGSTOP and SIGCONT from a memory guard, or ctrl+z then
// bg) runs on in the background while its shell holds the terminal, and Herdr only
// looks at the foreground. So look among the pane shell's own children.
const AGENT_PROCESS: Record<string, RegExp> = { cursor: /cursor-agent/, claude: /\bclaude\b/, codex: /\bcodex\b/ };

export async function backgroundAgent(cfg: GatewayConfig, herdr: HerdrCall, paneId: string, kind: string): Promise<{ pid: number; stopped: boolean } | null> {
  const pane = (await herdr("pane.get", { pane_id: paneId }))?.pane;
  if (!pane || !paneInScope(pane, cfg.allowedRoots)) return null;
  const info = (await herdr("pane.process_info", { pane_id: paneId }))?.process_info;
  if (typeof info?.shell_pid !== "number") return null;
  const re = AGENT_PROCESS[kind] ?? new RegExp(`\\b${kind.replace(/[^a-z0-9_-]/gi, "")}\\b`);
  const jobs = (await childProcesses(cfg, info.shell_pid)).filter((j) => re.test(j.args));
  const job = jobs.find((j) => !j.stat.includes("T")) ?? jobs[0];
  return job ? { pid: job.pid, stopped: job.stat.includes("T") } : null;
}

// Reported once per state, and the entry stays: the agent is still there.
export function decideBackground(w: Watched, bg: { pid: number; stopped: boolean }, now: number): Decision {
  if (!w.managed && now - Date.parse(w.since) > MAX_AGE_MS) return { drop: true };
  const status = bg.stopped ? "stopped" : "background";
  return w.last_status === status ? {} : { event: "background", set: { last_status: status } };
}

function clip(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1).trimEnd() + "…" : s;
}

// What WorkDone answered for an agent: each menu and the option it took.
export function approvedExcerpt(approved: Approval[]): string {
  return clip(approved.map((a) => `${a.menu} → ${a.option}`).join("; "), 450);
}

const LEFT = "left the allowed roots, so WorkDone stopped watching it";

// One line for the phone: who, what happened, where, and an excerpt.
export function message(w: Watched, agent: any, paneId: string, note: Note): string {
  const name = agent?.name ?? w.name;
  const title = agent?.terminal_title_stripped;
  const who = name ?? `${agent?.agent ?? w.kind ?? "agent"}${title ? ` "${clip(title, 40)}"` : ""} (${paneId})`;
  const where = w.cwd ? ` in ${basename(w.cwd)}` : "";
  const head = {
    finished: `${who} finished${where}`,
    question: `${who} asks${where}`,
    blocked: `${who}${where} is waiting for an answer`,
    gone: note.left ? `${who}${where} ${LEFT}` : `${who}${where} is gone (pane closed or agent exited)`,
    background: `${who}${where} is running in the background of its pane (pid ${note.pid}), out of Herdr's sight and unable to take input; fg in that shell brings it back`,
    stopped: `${who}${where} is stopped in the background of its pane (pid ${note.pid}); fg in that shell resumes it`,
  }[note.type];
  return clip((note.excerpt ? `${head}: ${note.excerpt}` : head).replace(/\s+/g, " "), 450);
}

const read = (herdr: HerdrCall, paneId: string, source: string) =>
  herdr("agent.read", { target: paneId, source, lines: 60, format: "text", strip_ansi: true }).then(textOf);

// The answer that ended the turn. A transcript can close the turn a couple of seconds
// after Herdr shows the agent idle, so give it that long. Without a transcript, the
// bottom of the screen. ended: a Cursor turn that ended other than success.
async function finalText(cfg: GatewayConfig, herdr: HerdrCall, agent: any): Promise<{ text: string | null; ended: boolean }> {
  for (let attempt = 0; ; attempt++) {
    const reply = await agentReply(cfg, agent);
    if (!reply) break;
    const p = reply.in_progress;
    if (!p) return { text: reply.ended ? `[${reply.ended}] ${reply.text}` : reply.text, ended: !!reply.ended };
    if (p.interrupted) return { text: `[interrupted] ${p.latest_text ?? ""}`, ended: false };
    if (attempt >= 5) return { text: p.latest_text, ended: false };
    await Bun.sleep(500);
  }
  return { text: screenReply(await read(herdr, agent.pane_id, "recent_unwrapped")) || null, ended: false };
}

// An excerpt is a bonus: when it cannot be read, the event is still reported.
export async function describe(cfg: GatewayConfig, herdr: HerdrCall, event: WatchEvent, agent: any): Promise<Note> {
  try {
    if (event === "gone" || event === "background") return { type: "gone", excerpt: null };
    if (event === "blocked") return { type: "blocked", excerpt: dialogExcerpt(await read(herdr, agent.pane_id, "detection")) || null };
    const { text, ended } = await finalText(cfg, herdr, agent);
    const failed = ended || apiError(text) ? { failed: true } : {};
    if (!text?.trim()) return { type: "finished", excerpt: null, ...failed };
    const asks = asksOwner(text);
    return { type: asks ? "question" : "finished", excerpt: replyExcerpt(text, asks) || null, text, ...failed };
  } catch {
    return { type: event, excerpt: null };
  }
}

// One pass over the watch list: returns the messages to send and how many agents are
// still watched, and records drops, state changes and the last event of each agent.
export async function pollWatched(cfg: GatewayConfig, herdr: HerdrCall, now: number, reliable = false): Promise<Found> {
  const store = new StateStore(cfg.stateDir);
  const initial = store.transaction(() => ({ watched: store.watched(), queued: reliable ? store.outbox() : [], told: store.told() }));
  const watched = initial.watched;
  if (initial.queued.length) return { messages: [], remaining: Object.keys(watched).length, reports: initial.queued };
  // A tell is collected even with nothing watched: a chat subscribed to agent.message
  // may be listening without holding a watch.
  if (Object.keys(watched).length === 0 && !initial.told.length) return { messages: [], remaining: 0, reports: [] };
  // Objective-only transitions need no worker or live Herdr session.
  const needsAgents = Object.keys(watched).length > 0 || initial.told.some(t => !t.objective);
  const agents: any[] = needsAgents ? (await herdr("agent.list", {})).agents ?? [] : [];
  // An agent that moved outside the allowed roots is gone, as it is for every other op.
  const byPane = new Map(agents.filter((a) => paneInScope(a, cfg.allowedRoots)).map((a) => [a.pane_id, a]));
  // The kind of every agent Herdr lists, in scope or not, so one that moved out can be
  // told apart from one that exited. Nothing else of an out-of-scope agent is kept.
  const listed = new Map(agents.map((a) => [a.pane_id, a.agent]));
  const decided: Array<{ paneId: string; w: Watched; agent: any; d: Decision; menu: Dialog | null; approved: Approval[]; bg: { pid: number; stopped: boolean } | null; left: boolean }> = [];
  for (const [paneId, w] of Object.entries(watched)) {
    let agent = byPane.get(paneId);
    const left = !agent && listed.has(paneId) && (!w.kind || listed.get(paneId) === w.kind);
    const workingBeforeApproval = agent?.agent_status === "working";
    const bg = !agent && !left && w.kind ? await backgroundAgent(cfg, herdr, paneId, w.kind).catch(() => null) : null;
    // Permission UIs sometimes read idle or working. Inspect the current screen,
    // rather than relying on a status edge to notice an unanswered menu.
    let menu = agent ? parseDialog(await menuScreen(herdr, paneId).catch(() => "")) : null;
    let d = bg ? decideBackground(w, bg, now) : decide(w, menu ? { ...agent, agent_status: "blocked" } : agent, now);
    const menuId = menu ? dialogView(menu).dialog_id : undefined;
    if (menu && !d.drop) {
      if (menuId !== w.dialog_id) d.event = "blocked";
      d.set = { ...d.set, dialog_id: menuId };
      if (w.managed && agent?.agent_status === "working") d.set.busy = true;
    } else if (w.dialog_id && !d.drop) d.set = { ...d.set, dialog_id: undefined };
    let approved: Approval[] = [];
    if (agent && !d.drop && (menu || agent.agent_status === "blocked")) {
      const got = await approveMenus(cfg, herdr, paneId, "watch_poll", { waitMs: 0 }).catch(() => ({ approved: [] as Approval[], busy: false }));
      approved = got.approved;
      // Keep the edge pending while another process owns the answer lock.
      if (got.busy) { decided.push({ paneId, w, agent, bg, d: {}, menu: null, approved, left }); continue; }
      if (approved.length) {
        agent = (await herdr("agent.get", { target: paneId }).catch(() => null))?.agent ?? agent;
        menu = parseDialog(await menuScreen(herdr, paneId).catch(() => ""));
        const busy = w.managed && (w.busy || workingBeforeApproval || agent?.agent_status === "working") ? { busy: true } : {};
        if (menu) d = { event: "blocked", set: { last_status: "blocked", dialog_id: dialogView(menu).dialog_id, ...busy } };
        else d = { set: { ...seenState(agent), dialog_id: undefined, ...busy } };
      }
    }
    decided.push({ paneId, w, agent, bg, d, menu, approved, left });
  }
  // Read transcripts/checkpoints before the commit; no network wait holds the
  // state lock. A concurrent prompt or poll fences these decisions by revision.
  const prepared = await Promise.all(decided.map(async entry => {
    const { w, agent, d, bg, menu, left } = entry;
    const note: Note | null = !d.event ? null : left && d.event === "gone" ? { type: "gone", excerpt: null, left: true } : bg ? { type: bg.stopped ? "stopped" : "background", excerpt: null, pid: bg.pid } : menu ? { type: "blocked", excerpt: dialogExcerpt(menu.text) || null } : await describe(cfg, herdr, d.event, agent);
    const ended = note?.type === "finished" || note?.type === "question";
    const resolves = !!w.result_request && (note?.type === "finished" || note?.type === "gone");
    const cp = (ended && w.managed) || resolves ? await checkpoint(cfg, agent?.foreground_cwd ?? agent?.cwd ?? w.cwd).catch(() => null) : null;
    return { ...entry, note, ended, resolves, cp };
  }));
  const hidden: string[] = [];
  const found = store.transaction(() => {
    const messages: string[] = [];
    const reports: Report[] = [];
    const leases = store.leases();
    const told = store.takeTold();
    const dropped: string[] = [];
    const remaining = store.updateWatched(fresh => {
      for (const { paneId, w, agent, d, menu, approved, note, ended, resolves, cp } of prepared) {
        const cur = fresh[paneId];
        if (!cur || cur.rev !== w.rev) continue;
        if (d.drop) {
          delete fresh[paneId];
          if (d.event === "gone") dropped.push(paneId);
          if (cur.managed) hidden.push(paneId);
        } else if (d.set || d.event || approved.length) fresh[paneId] = { ...cur, ...d.set, rev: randomUUID() };
        if (approved.length && fresh[paneId]) fresh[paneId]!.last_event = { type: "approved", at: new Date(now).toISOString(), excerpt: approvedExcerpt(approved) };
        if (!note) continue;
        const text = message(w, agent, paneId, note);
        const eventId = randomUUID();
        if (note.type === "finished" || note.type === "question" || note.type === "gone") {
          const ran = store.updateCoord(c => ({ changes: runEnded(c, paneId, note.type as "finished" | "question" | "gone", new Date(now).toISOString()), store: c }));
          if (ran.changes.length) notifyTransitions(store, ran.store, ran.changes);
        }
        if (ended && w.managed) {
          const bound = currentTaskBinding(store.coord(), paneId, seenState(agent).session ?? w.session);
          store.recordTurn(paneId, {
            turn: eventId, at: new Date(now).toISOString(), session: seenState(agent).session ?? null, status: note.type,
            ...(bound?.t.binding ? { task_version: bound.t.version, task_progress: bound.t.progress ?? 0,
              task_identity: { objective: bound.o.id, id: bound.t.id, binding: bound.t.binding.id } } : {}),
            ...(cp ? { commit: cp.commit, tree: cp.tree, diff: cp.diff, clean: cp.clean, changed: cp.changed, ahead: cp.ahead, upstream: cp.upstream } : {}),
            activity: activityDigest(note.text ?? note.excerpt),
          });
        }
        const result: TurnResult | undefined = resolves ? {
          result_id: w.result_request!.id, requested_at: w.result_request!.at,
          status: note.type === "gone" ? "gone" : note.text?.startsWith("[interrupted]") ? "interrupted" : "finished",
          summary: resultLine(note.text), commit: cp?.commit ?? null, tree: cp?.tree ?? null, clean: cp?.clean ?? null,
          changed: cp?.changed ?? null, branch: cp?.branch ?? null, kind: w.launch?.kind ?? agent?.agent ?? w.kind ?? null,
          model: w.launch?.model ?? null, model_id: w.launch?.model_id ?? null, effort: w.launch?.effort ?? null,
        } : undefined;
                // Every turn end, exit or question goes in the owner's inbox from here, whichever chat is or isn't listening:
        // the watcher is the one place that sees all of them.
        const kept = !!result || note.type === "finished" || note.type === "gone" || note.type === "question";
        if (kept) {
          const ctx = inboxContext2(store, paneId, agent, w, leases, now);
          store.inboxAdd({ id: eventId, kind: result ? "result" : (note.type as "finished" | "gone" | "question"), at: new Date(now).toISOString(), ...ctx, text: (result?.summary ?? note.excerpt ?? (note.left ? LEFT : note.type)).slice(0, 1000), ...(result ? { result } : {}), status: "unanswered" });
        }
        // The pane's open work records how its turn ended; it stays open (work.ts).
        if (note.type === "finished" || note.type === "question" || note.type === "blocked" || note.type === "gone") {
          workTurn(store, paneId, {
            at: new Date(now).toISOString(), type: note.type === "finished" && note.failed ? "failed" : note.type,
            ...(kept ? { inbox_id: eventId } : {}), ...(result ? { result_id: result.result_id } : {}),
          });
        }
        reports.push({ event_id: eventId, occurred_at: new Date(now).toISOString(), pane_id: paneId, type: note.type, agent: agent?.name ?? w.name ?? null, kind: agent?.agent ?? w.kind ?? null, cwd: w.cwd ?? null, excerpt: note.excerpt, lease: leaseOf(leases, paneId, now), reply_to: w.reply_to ?? null, message: text, ...(menu ? { choices: dialogView(menu) } : {}), ...(result ? { result } : {}) });
        messages.push(text);
        if (fresh[paneId]) {
          if (result && fresh[paneId]!.result_request?.id === result.result_id) delete fresh[paneId]!.result_request;
          if (result) fresh[paneId]!.last_result = result;
          fresh[paneId]!.last_event = { type: note.type, at: new Date(now).toISOString(), excerpt: note.excerpt };
          if (note.type !== "blocked") delete fresh[paneId]!.reply_to;
        }
      }
      return Object.keys(fresh).length;
    });
    store.clearSupervision(dropped);
    // takeTold is safe here: queue consumption and report enqueue are one commit.
    for (const t of told) {
      const w = t.pane_id ? watched[t.pane_id] : undefined;
      const agent = t.pane_id ? byPane.get(t.pane_id) : undefined;
      const name = agent?.name ?? w?.name ?? null;
      reports.push({ event_id: t.event_id ?? randomUUID(), occurred_at: t.at, pane_id: t.pane_id, type: "message", agent: name, kind: agent?.agent ?? w?.kind ?? null, cwd: w?.cwd ?? agent?.cwd ?? null, excerpt: t.text, lease: t.recipient_lease ?? (t.pane_id ? leaseOf(leases, t.pane_id, now) : null), reply_to: null, message: t.origin === "owner" ? `Owner note from the console about ${name ?? t.pane_id}: ${clip(t.text, 400)}` : `${name ?? t.pane_id ?? t.objective ?? "coordination"} says: ${clip(t.text, 400)}`, ...(t.origin === "owner" ? { origin: "owner" as const } : {}), ...(t.objective ? { objective: t.objective } : {}), ...(t.recipient_lease ? { recipient_lease: t.recipient_lease } : {}), ...(t.transition ? { transition: t.transition } : {}) });
    }
    if (reliable) {
      store.enqueueReports(reports);
      return { messages, remaining, reports: store.outbox() };
    }
    return { messages, remaining, reports };
  });
  for (const paneId of hidden) showWatched(herdr, paneId, false);
  return found;
}

export interface Found {
  messages: string[];
  remaining: number;
  reports?: Report[];
}

// watch_poll's result carries reports only when there are some.
export function withReports(found: { messages: string[]; remaining: number }, reports: Report[] | undefined): Found {
  return reports?.length ? { ...found, reports } : found;
}

// While waiting, how often browser runs (files, no events) and the watch list are looked at.
const WAIT_TICK_MS = 2000;

// Herdr events that can change what a pass reports. Status changes are subscribed per
// pane; exits, closes and agents appearing or leaving are server-wide, so they are
// filtered by pane when they arrive. Seen from Herdr 0.9.1:
//   {"event":"pane.agent_status_changed","data":{"agent":"claude","agent_status":"done","pane_id":"w8Z:p1","workspace_id":"w8Z"}}
//   {"event":"pane_agent_detected","data":{"agent":"cursor","pane_id":"w95:p1","type":"pane_agent_detected","workspace_id":"w95"}}
export function watchSubscriptions(paneIds: string[]): Array<Record<string, unknown>> {
  return [
    ...paneIds.map((pane_id) => ({ type: "pane.agent_status_changed", pane_id })),
    { type: "pane.exited" },
    { type: "pane.closed" },
    { type: "pane.agent_detected" },
  ];
}

// watch_poll with wait_ms: a pass, and while passes find nothing, wait for Herdr to
// report a change on a watched pane and pass again, until waitMs is up. The
// subscription is open before the first pass, so a change during a pass wakes the
// wait; one between two calls is caught by state_change_seq, as without waiting.
// Without a subscription (nothing watched, a Herdr without events) it is one pass and
// the caller keeps to its interval, unless `tells` asks it to wait for a tell anyway:
// the MCP server does that while a chat is subscribed to agent.message.
export async function pollWaiting(cfg: GatewayConfig, herdr: HerdrCall, waitMs: number, agents: () => Promise<Found>, jobs: () => Found, tells = false): Promise<Found> {
  const subscribe = subscriberOf(herdr);
  const deadline = Date.now() + waitMs;
  const watchedIds = () => Object.keys(new StateStore(cfg.stateDir).watched()).sort().join("\n");
  let sub: Subscription | null = null;
  let subscribed = "";
  try {
    for (;;) {
      // A watch added or dropped meanwhile (prompt_agent in another process) changes what to hear.
      const ids = watchedIds();
      if (ids !== subscribed) {
        sub?.close();
        sub = null;
        subscribed = ids;
        if (subscribe && ids) sub = await subscribe(watchSubscriptions(ids.split("\n"))).catch(() => null);
      }
      const a = await agents();
      const j = jobs();
      const found = withReports({ messages: [...a.messages, ...j.messages], remaining: a.remaining + j.remaining }, a.reports);
      if ((!sub && !tells) || found.messages.length || found.reports?.length || (found.remaining === 0 && !tells) || Date.now() >= deadline) return found;
      const panes = new Set(subscribed.split("\n"));
      for (;;) {
        const left = deadline - Date.now();
        if (left <= 0) break;
        let event: any;
        try {
          if (sub) event = await sub.next(Math.min(WAIT_TICK_MS, left));
          else await Bun.sleep(Math.min(WAIT_TICK_MS, left));
        } catch {
          // Herdr went away: one last pass says what is known.
          sub = null;
          break;
        }
        if (event) {
          if (!panes.has(event.data?.pane_id)) continue;
          // The next pass sees everything that already happened: skip the queued events.
          while (sub && await sub.next(0).catch(() => null));
          break;
        }
        const runs = jobs();
        if (runs.messages.length) return { messages: runs.messages, remaining: a.remaining + runs.remaining };
        // A tell waiting: pass again now rather than at the deadline.
        if (new StateStore(cfg.stateDir).hasTold()) break;
        if (watchedIds() !== subscribed) break;
      }
    }
  } finally {
    sub?.close();
  }
}

export async function sendNotification(cfg: GatewayConfig, message: string): Promise<{ exit_code: number | null }> {
  if (!cfg.notifyCommand) throw new GatewayError("capability_disabled", "no notifyCommand is configured on this machine");
  const res = await runProcess([...cfg.notifyCommand, message], {
    cwd: process.env.HOME ?? "/", env: childEnv(cfg), timeoutMs: 20_000, maxBytes: 10_000,
  });
  if (res.exit_code !== 0) throw new GatewayError("notify_failed", res.stderr.trim().slice(-300) || `notifyCommand exited ${res.exit_code}`);
  return { exit_code: res.exit_code };
}

function loadGatewayConfig(): GatewayConfig {
  const path = process.env.HERDR_GATEWAY_CONFIG ?? resolve(process.env.HOME ?? "/", ".config/herdr-chatgpt/gateway.json");
  return loadConfig(JSON.parse(readFileSync(path, "utf8")));
}

if (import.meta.main) {
  log("started", { pid: process.pid });
  let lastError = "";
  for (;;) {
    try {
      const cfg = loadGatewayConfig();
      const { messages } = await pollWatched(cfg, herdrSocket(cfg.herdrSocketPath), Date.now());
      for (const m of messages) {
        await sendNotification(cfg, m).then(
          () => log("notified", { message: m }),
          (e) => log("notify_failed", { message: m, error: (e as Error).message }),
        );
      }
      lastError = "";
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      if (msg !== lastError) log("tick_failed", { error: msg });
      lastError = msg;
    }
    await Bun.sleep(POLL_MS);
  }
}
