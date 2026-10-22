// The agent side of a message from ChatGPT, through Claude Code hooks (scripts/hook.sh).
// Text WorkDone types into a pane reaches the agent as if the owner typed it, so it used
// to end with a footer naming the chat it came from. Where the agent's hooks have said
// hello for its current session, the footer is left off instead: the gateway records a
// marker for the exact text it types, UserPromptSubmit (hook_prompt) matches it and
// hands the agent the same provenance as hidden context, and Stop (hook_stop) keeps the
// exact final answer for the watcher. Anything the owner types matches no marker and
// gets nothing. Agents without hooks (Codex, Cursor, pi, opencode) keep the footer.
//
// Probed on Claude Code 2.1.308 (2026-10-22): hooks get HERDR_PANE_ID; session_id is
// Herdr's agent_session.value; a multi-line prompt arrives wrapped in <pasted_content>
// lines, a steer collapsed to one line; a steer mid-turn fires UserPromptSubmit with the
// running turn's prompt_id; Stop carries the same prompt_id as its UserPromptSubmit; a
// background task that finishes starts a turn whose prompt is <task-notification>.

import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { GatewayError, TARGET_RE } from "./config.ts";
import type { Gateway } from "./gateway.ts";
import { keepMessage, readMessage } from "./messages.ts";
import { optStr, str, type Params } from "./params.ts";
import { seenState } from "./state.ts";
import { watchInfo } from "./views.ts";

// Set by stamped() on the params of a call from outside: who sent the text and the footer
// it carries, so the send can leave the footer off where a hook will say it instead.
export const PROVENANCE = Symbol("provenance");
export interface Provenance {
  sig: string;
  op: string;
  lease: string | null;
  label: string | null;
  console: boolean;
  chat: string | null;
}

export interface Marker {
  id: string;
  hash: string;
  lease: string | null;
  label: string | null;
  op: string;
  console: boolean;
  chat: string | null;
  at: string;
}
// A prompt the agent got from WorkDone, by Claude's prompt_id. inherited counts the
// background-task turns that continued it.
export interface Matched {
  prompt_id: string;
  marker: string;
  lease: string | null;
  label: string | null;
  op: string;
  console: boolean;
  chat: string | null;
  at: string;
  inherited: number;
}
export interface Final { prompt_id: string; text_id: string; at: string }
export interface HookPane {
  session: string;
  kind: string;
  hello_at: string;
  pending: Marker[];
  recent: Matched[];
  finals: Final[];
  // The last prompt the hook saw, WorkDone's or not: a kept answer older than it is not this turn's.
  last_prompt_at?: string;
  // A marker went unmatched: the hook is not working in this session, so the footer is back until the next hello.
  failed_at?: string;
}

// A marker never matched is dropped after this (the prompt was mangled, or never submitted).
const MARKER_MS = 3600_000;
// A background-task turn continues a WorkDone prompt only this soon after it, and only
// this many times per prompt (docs/loop-risks.md).
export const INHERIT_MS = 30 * 60_000;
export const INHERIT_MAX = 3;
const KEEP = 20;
const STALE_MS = 14 * 24 * 3600_000;

// What the hook's prompt and the typed text have in common: no <pasted_content> wrapper,
// whitespace collapsed.
export function normalizePrompt(s: string): string {
  return s.replace(/^\s*<\/?pasted_content(?: id="[^"]*")?>\s*$/gm, " ").replace(/\s+/g, " ").trim();
}
const hashOf = (s: string) => createHash("sha256").update(normalizePrompt(s)).digest("hex");

// The text with its footer taken off, when it ends with it.
export function unstamp(text: string, sig: string): string {
  const tail = `\n\n${sig}`;
  return text.endsWith(tail) ? text.slice(0, -tail.length) : text;
}

const flagDir = (stateDir: string) => resolve(stateDir, "hook-panes");

// A file per pane the hook script checks before it starts anything: present while the
// pane has a marker waiting or a WorkDone prompt recent enough to be continued.
function syncFlag(stateDir: string, paneId: string, h: HookPane | undefined, now: number) {
  const file = resolve(flagDir(stateDir), paneId);
  const live = !!h && (h.pending.length > 0 || h.recent.some((m) => now - Date.parse(m.at) < INHERIT_MS));
  try {
    if (live) {
      mkdirSync(flagDir(stateDir), { recursive: true, mode: 0o700 });
      writeFileSync(file, h!.session, { mode: 0o600 });
    } else rmSync(file, { force: true });
  } catch { /* the hook then just calls through, or finds nothing */ }
}

// How long a send waits for the hook to match its marker, and how old an unmatched one
// (a queued steer's) may get before the hook counts as broken. Tests shorten them.
export const HOOK_TIMING = { confirmMs: 3000, staleMs: 15_000 };

// Whether this pane's agent has hooks running in its current session, and working: a
// marker left unmatched means the agent got WorkDone's text with no sender note.
export function hooked(g: Gateway, agent: any): boolean {
  const h = g.state.hooks()[agent?.pane_id];
  const session = seenState(agent).session;
  if (!h || !session || h.session !== session || h.kind !== agent?.agent || h.failed_at) return false;
  const now = Date.now();
  return !h.pending.some((p) => now - Date.parse(p.at) > HOOK_TIMING.staleMs);
}

// After the text went in: did the hook match it? If not, the footer comes back for this
// pane until its next hello, and an agent still at work gets the footer line as a
// follow-up message, so it learns who sent what it is working on.
export async function confirmSend(g: Gateway, paneId: string, markerId: string, prov: Provenance): Promise<"hook" | "footer_followup" | "missing"> {
  const deadline = Date.now() + HOOK_TIMING.confirmMs;
  for (;;) {
    const h = g.state.hooks()[paneId];
    if (!h?.pending.some((p) => p.id === markerId)) return "hook";
    if (Date.now() >= deadline) break;
    await Bun.sleep(150);
  }
  const h = g.state.updateHooks((all) => {
    const cur = all[paneId];
    if (cur) {
      cur.failed_at = new Date().toISOString();
      cur.pending = cur.pending.filter((p) => p.id !== markerId);
    }
    return cur;
  });
  syncFlag(g.cfg.stateDir, paneId, h, Date.now());
  const agent = await g.scopedAgent(paneId).catch(() => null);
  let out: "footer_followup" | "missing" = "missing";
  if (agent?.agent_status === "working") {
    try {
      await g.handle("steer_agent", { target: paneId, text: prov.sig });
      out = "footer_followup";
    } catch { /* the reply still reaches the chat; only the agent's view of the sender is missing */ }
  }
  g.state.audit({ op: "hook_fallback", ok: false, args: { pane_id: paneId, marker: markerId, outcome: out } });
  return out;
}

// Right before the text goes in: where a hook will tell the agent who sent it, record the
// marker for the exact text and say so; otherwise the footer stays. undo drops the marker
// when the send fails.
export function markSend(g: Gateway, agent: any, prov: Provenance | undefined): { hooked: boolean; mark: (sent: string) => () => void; id: () => string | null } {
  let marked: string | null = null;
  const none = { hooked: false, mark: () => () => {}, id: () => null };
  if (!prov || !hooked(g, agent)) return none;
  return {
    hooked: true,
    id: () => marked,
    mark: (sent: string) => {
      const id = `prm_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
      marked = id;
      const now = Date.now();
      const m: Marker = { id, hash: hashOf(sent), lease: prov.lease, label: prov.label, op: prov.op, console: prov.console, chat: prov.chat, at: new Date(now).toISOString() };
      const h = g.state.updateHooks((all) => {
        const cur = all[agent.pane_id];
        if (!cur) return undefined;
        cur.pending = [...cur.pending.filter((p) => now - Date.parse(p.at) < MARKER_MS), m].slice(-KEEP);
        return cur;
      });
      syncFlag(g.cfg.stateDir, agent.pane_id, h, now);
      return () => {
        const after = g.state.updateHooks((all) => {
          const cur = all[agent.pane_id];
          if (cur) cur.pending = cur.pending.filter((p) => p.id !== id);
          return cur;
        });
        syncFlag(g.cfg.stateDir, agent.pane_id, after, Date.now());
      };
    },
  };
}

const at16 = (iso: string) => `${iso.slice(0, 16)}Z`;
function sender(m: Pick<Matched, "lease" | "label" | "chat">): string {
  const chat = m.chat ? ` ${m.chat}` : "";
  const label = m.label ? ` "${m.label.replace(/["\n]/g, "").slice(0, 60)}"` : "";
  return m.lease ? `the owner's ChatGPT chat${chat}${label} (lease …${m.lease.slice(-4)})` : "a WorkDone caller with no chat";
}
export function contextFor(m: Matched): string {
  if (m.console) return `WorkDone: the owner sent this from the WorkDone console (${m.op}, ${at16(m.at)}). No ChatGPT chat is waiting on it; answer here as usual.`;
  if (m.inherited) return `WorkDone: this turn started because a background task finished. It continues what ${sender(m)} sent you, so your final answer goes back to that chat by itself.`;
  return `WorkDone: this message came from ${sender(m)}, through ${m.op} at ${at16(m.at)}. Your final answer goes back to that chat by itself. Use workdone-tell only for something you want to send it on your own before then.`;
}

// The exact final answer a hook kept for the turn the watcher is reporting: in this
// session, after the WorkDone prompt (since) and after any later prompt, such as one the
// owner typed, which the watcher's turn would then be answering instead.
export function hookFinal(stateDir: string, h: HookPane | undefined, session: string | null | undefined, since: number): string | null {
  if (!h || !session || h.session !== session) return null;
  const f = h.finals.at(-1);
  if (!f) return null;
  const at = Date.parse(f.at);
  if (at < since || (h.last_prompt_at && at < Date.parse(h.last_prompt_at))) return null;
  return readMessage(stateDir, f.text_id)?.text ?? null;
}

export function hookOps(g: Gateway) {
  const pane = (params: Params) => str(params, "pane_id", TARGET_RE);
  const session = (params: Params) => str(params, "session_id", /^[\w.-]{1,128}$/);

  // The entry for this session, made on the spot when SessionStart's hello was missed
  // (hooks installed while the agent ran).
  const entry = (all: Record<string, HookPane>, paneId: string, sid: string, kind: string, hello = false): HookPane => {
    const cur = all[paneId];
    if (cur && cur.session === sid) {
      // A hello is the hook working again (restarted, or the setup fixed): the footer can go.
      if (hello) delete cur.failed_at;
      return cur;
    }
    return (all[paneId] = { session: sid, kind, hello_at: new Date().toISOString(), pending: [], recent: [], finals: [] });
  };

  return {
    // SessionStart: this pane's agent has hooks, for this session.
    async hook_hello(params: Params) {
      const paneId = pane(params);
      const sid = session(params);
      const kind = optStr(params, "kind") ?? "claude";
      const now = Date.now();
      const { h, gone } = g.state.updateHooks((all) => {
        // Panes quiet this long are closed or idle for good (Herdr never reuses a pane ID).
        const gone = Object.keys(all).filter((p) => p !== paneId && now - Math.max(Date.parse(all[p]!.hello_at), Date.parse(all[p]!.last_prompt_at ?? "") || 0) > STALE_MS);
        for (const p of gone) delete all[p];
        return { h: entry(all, paneId, sid, kind, true), gone };
      });
      for (const p of gone) syncFlag(g.cfg.stateDir, p, undefined, now);
      syncFlag(g.cfg.stateDir, paneId, h, now);
      return { ok: true };
    },

    // UserPromptSubmit: who sent this text, as context for the agent, when WorkDone typed it.
    async hook_prompt(params: Params) {
      const paneId = pane(params);
      const sid = session(params);
      const promptId = str(params, "prompt_id", /^[\w.:-]{1,128}$/);
      const prompt = typeof params.prompt === "string" ? params.prompt : "";
      const kind = optStr(params, "kind") ?? "claude";
      const now = Date.now();
      const hash = hashOf(prompt);
      const notification = /^\s*<task-notification>/.test(prompt);
      const out = g.state.updateHooks((all) => {
        const h = entry(all, paneId, sid, kind);
        h.pending = h.pending.filter((p) => now - Date.parse(p.at) < MARKER_MS);
        const i = h.pending.findIndex((p) => p.hash === hash);
        let m: Matched | null = null;
        if (i >= 0) {
          const p = h.pending.splice(i, 1)[0]!;
          m = { prompt_id: promptId, marker: p.id, lease: p.lease, label: p.label, op: p.op, console: p.console, chat: p.chat, at: p.at, inherited: 0 };
        } else if (notification) {
          // A background task the agent started finished: the turn carries on the last
          // WorkDone prompt's work, a few times and not for long.
          const last = h.recent.at(-1);
          if (last && !last.console && last.lease && now - Date.parse(last.at) < INHERIT_MS && last.inherited < INHERIT_MAX) {
            m = { ...last, prompt_id: promptId, inherited: last.inherited + 1 };
          }
        }
        // A steer queued mid-turn shares the turn's prompt_id: keep both senders, drop only a hook that fired twice.
        if (m) h.recent = [...h.recent.filter((r) => !(r.prompt_id === promptId && r.marker === m!.marker && r.inherited === m!.inherited)), m].slice(-KEEP);
        h.last_prompt_at = new Date(now).toISOString();
        return { h, m };
      });
      syncFlag(g.cfg.stateDir, paneId, out.h, now);
      if (!out.m) return { context: null };
      // A continued turn is owed to that chat like the prompt was.
      if (out.m.inherited && out.m.lease) {
        const agent = await g.scopedAgent(paneId).catch(() => null);
        if (agent) g.state.owe(paneId, out.m.lease, watchInfo(agent), agent);
      }
      g.state.audit({ op: "hook_prompt", ok: true, args: { pane_id: paneId, marker: out.m.marker, inherited: out.m.inherited } });
      return { context: contextFor(out.m) };
    },

    // Stop: the exact final answer of a turn WorkDone started, for the watcher's report.
    async hook_stop(params: Params) {
      const paneId = pane(params);
      const sid = session(params);
      const promptId = str(params, "prompt_id", /^[\w.:-]{1,128}$/);
      const text = typeof params.text === "string" ? params.text : "";
      const h = g.state.hooks()[paneId];
      if (!h || h.session !== sid || !text.trim()) return { kept: false };
      // By prompt_id; failing that (a Stop that names another id), the newest WorkDone
      // prompt this session has no answer for yet.
      const lastFinal = Math.max(0, ...h.finals.map((f) => Date.parse(f.at)));
      const m = h.recent.find((r) => r.prompt_id === promptId) ?? [...h.recent].reverse().find((r) => Date.parse(r.at) > lastFinal);
      if (!m) return { kept: false };
      const at = new Date().toISOString();
      // One file per Stop, last writer wins: a Stop hook elsewhere can block and continue the same prompt.
      const textId = `fin_${createHash("sha256").update(`${sid}:${promptId}:${at}`).digest("hex").slice(0, 24)}`;
      try {
        keepMessage(g.cfg.stateDir, { id: textId, at, kind: "reply", pane_id: paneId, agent: null, text });
      } catch (err) {
        throw new GatewayError("state_error", `could not keep the answer: ${(err as Error).message}`);
      }
      g.state.updateHooks((all) => {
        const cur = all[paneId];
        if (!cur || cur.session !== sid) return;
        cur.finals = [...cur.finals.filter((f) => f.prompt_id !== promptId), { prompt_id: promptId, text_id: textId, at }].slice(-KEEP);
      });
      return { kept: true };
    },
  };
}
