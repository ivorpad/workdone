// Reports on watched agents: when one finishes a turn, asks its owner something,
// stops at a dialog or disappears. prompt_agent watches the turn it started when the
// call returns before the agent settles. A managed agent (watch_agent, or started by
// start_agent or spawn_agent) is reported on every turn until it exits.
//
// Normally the MCP server on OVH polls each gateway's watch_poll op and sends the
// messages through the gateway whose notifyCommand reaches the phone, so it keeps
// working when the Mac is asleep. Run as a script, this file is the standalone
// alternative for a single machine: poll every 5 s and run notifyCommand itself.

import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { asksOwner, dialogExcerpt, replyExcerpt, screenReply } from "./attention.ts";
import { GatewayError, loadConfig, paneInScope, type GatewayConfig, type HerdrCall } from "./config.ts";
import { herdrSocket } from "./herdr-socket.ts";
import { childEnv, childProcesses, runProcess } from "./process.ts";
import { StateStore, seenState, type Watched } from "./state.ts";
import { agentReply } from "./transcript.ts";
import { textOf } from "./views.ts";

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
    gone: `${who}${where} is gone (pane closed or agent exited)`,
    background: `${who}${where} is running in the background of its pane (pid ${note.pid}), out of Herdr's sight and unable to take input; fg in that shell brings it back`,
    stopped: `${who}${where} is stopped in the background of its pane (pid ${note.pid}); fg in that shell resumes it`,
  }[note.type];
  return clip((note.excerpt ? `${head}: ${note.excerpt}` : head).replace(/\s+/g, " "), 450);
}

const read = (herdr: HerdrCall, paneId: string, source: string) =>
  herdr("agent.read", { target: paneId, source, lines: 60, format: "text", strip_ansi: true }).then(textOf);

// The answer that ended the turn. A transcript can close the turn a couple of seconds
// after Herdr shows the agent idle, so give it that long. Without a transcript, the
// bottom of the screen.
async function finalText(cfg: GatewayConfig, herdr: HerdrCall, agent: any): Promise<string | null> {
  for (let attempt = 0; ; attempt++) {
    const reply = await agentReply(cfg, agent);
    if (!reply) break;
    const p = reply.in_progress;
    if (!p) return reply.ended ? `[${reply.ended}] ${reply.text}` : reply.text;
    if (p.interrupted) return `[interrupted] ${p.latest_text ?? ""}`;
    if (attempt >= 5) return p.latest_text;
    await Bun.sleep(500);
  }
  return screenReply(await read(herdr, agent.pane_id, "recent_unwrapped")) || null;
}

// An excerpt is a bonus: when it cannot be read, the event is still reported.
export async function describe(cfg: GatewayConfig, herdr: HerdrCall, event: WatchEvent, agent: any): Promise<Note> {
  try {
    if (event === "gone" || event === "background") return { type: "gone", excerpt: null };
    if (event === "blocked") return { type: "blocked", excerpt: dialogExcerpt(await read(herdr, agent.pane_id, "detection")) || null };
    const text = await finalText(cfg, herdr, agent);
    if (!text?.trim()) return { type: "finished", excerpt: null };
    const asks = asksOwner(text);
    return { type: asks ? "question" : "finished", excerpt: replyExcerpt(text, asks) || null };
  } catch {
    return { type: event, excerpt: null };
  }
}

// One pass over the watch list: returns the messages to send and how many agents are
// still watched, and records drops, state changes and the last event of each agent.
export async function pollWatched(cfg: GatewayConfig, herdr: HerdrCall, now: number): Promise<{ messages: string[]; remaining: number }> {
  const store = new StateStore(cfg.stateDir);
  const watched = store.watched();
  if (Object.keys(watched).length === 0) return { messages: [], remaining: 0 };
  const agents: any[] = (await herdr("agent.list", {})).agents ?? [];
  // An agent that moved outside the allowed roots is gone, as it is for every other op.
  const byPane = new Map(agents.filter((a) => paneInScope(a, cfg.allowedRoots)).map((a) => [a.pane_id, a]));
  const decided: Array<{ paneId: string; w: Watched; agent: any; d: Decision; bg: { pid: number; stopped: boolean } | null }> = [];
  for (const [paneId, w] of Object.entries(watched)) {
    const agent = byPane.get(paneId);
    const bg = !agent && w.kind ? await backgroundAgent(cfg, herdr, paneId, w.kind).catch(() => null) : null;
    decided.push({ paneId, w, agent, bg, d: bg ? decideBackground(w, bg, now) : decide(w, agent, now) });
  }
  // Record decisions first, and only for entries nobody rewrote since the read above:
  // a prompt or a watch that landed meanwhile knows more than this pass.
  const remaining = store.updateWatched((fresh) => {
    for (const { paneId, w, d } of decided) {
      const cur = fresh[paneId];
      if (!cur || cur.rev !== w.rev) continue;
      if (d.drop) delete fresh[paneId];
      else if (d.set) fresh[paneId] = { ...cur, ...d.set };
    }
    return Object.keys(fresh).length;
  });
  // Excerpts can take a couple of seconds (a transcript trails the status), so they come after.
  const messages: string[] = [];
  const events: Array<[string, NonNullable<Watched["last_event"]>]> = [];
  for (const { paneId, w, agent, d, bg } of decided) {
    if (!d.event) continue;
    const note: Note = bg ? { type: bg.stopped ? "stopped" : "background", excerpt: null, pid: bg.pid } : await describe(cfg, herdr, d.event, agent);
    messages.push(message(w, agent, paneId, note));
    events.push([paneId, { type: note.type, at: new Date(now).toISOString(), excerpt: note.excerpt }]);
  }
  if (events.length) {
    store.updateWatched((fresh) => {
      for (const [id, e] of events) if (fresh[id]) fresh[id] = { ...fresh[id], last_event: e };
    });
  }
  return { messages, remaining };
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
