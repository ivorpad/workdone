// An agent's last answer as clean text, read from its transcript instead of scraped
// from the terminal. Herdr reports the session ID of each Claude and Cursor agent.
// Claude Code writes <root>/<project-slug>/<session-id>.jsonl under a transcript root;
// the Cursor CLI writes <root>/<project-slug>/agent-transcripts/<id>/<id>.jsonl under
// ~/.cursor/projects.

import { closeSync, existsSync, fstatSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import type { GatewayConfig } from "./config.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FINAL_STOPS = new Set(["end_turn", "stop_sequence", "max_tokens"]);
const REPLY_CHARS = 12_000;

export interface Reply {
  text: string;
  at: string | null;
  in_reply_to: string | null;
  truncated: boolean;
  in_progress: { prompt: string; latest_text: string | null; at: string | null; interrupted: boolean } | null;
  // Cursor only: how the last turn ended when it was not a normal answer.
  ended?: string;
}

function sessionId(agent: any, kind: string): string | null {
  const s = agent?.agent_session;
  if (agent?.agent !== kind || s?.kind !== "id" || typeof s.value !== "string") return null;
  return UUID_RE.test(s.value) ? s.value : null;
}

export const claudeSessionId = (agent: any) => sessionId(agent, "claude");
export const cursorSessionId = (agent: any) => sessionId(agent, "cursor");

// <root>/<slug>/<rel> for the slug guessed from cwd, else the first project directory that has it.
function findUnder(roots: string[], rel: string, slug: string | null): string | null {
  for (const root of roots) {
    if (slug) {
      const guess = join(root, slug, rel);
      if (existsSync(guess)) return guess;
    }
  }
  for (const root of roots) {
    let dirs: string[];
    try {
      dirs = readdirSync(root);
    } catch {
      continue;
    }
    for (const d of dirs) {
      const p = join(root, d, rel);
      if (existsSync(p)) return p;
    }
  }
  return null;
}

// Claude Code names a project directory after its cwd with every non-alphanumeric
// character replaced by "-". Try that first, then scan every project directory.
export function findTranscript(roots: string[], sessionId: string, cwd?: string): string | null {
  return findUnder(roots, `${sessionId}.jsonl`, cwd ? cwd.replace(/[^A-Za-z0-9]/g, "-") : null);
}

// Cursor collapses each run of other characters into one "-" and trims the ends.
export function findCursorTranscript(roots: string[], sessionId: string, cwd?: string): string | null {
  const slug = cwd ? cwd.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "") : null;
  return findUnder(roots, join("agent-transcripts", sessionId, `${sessionId}.jsonl`), slug);
}

function readTail(path: string, maxBytes: number): { text: string; whole: boolean } {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    let text = buf.toString("utf8");
    // Drop the partial first line of a tail window.
    if (start > 0) text = text.slice(text.indexOf("\n") + 1);
    return { text, whole: start === 0 };
  } finally {
    closeSync(fd);
  }
}

function contentText(content: unknown): string[] {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  return content.filter((b: any) => b?.type === "text" && typeof b.text === "string").map((b: any) => b.text);
}

function userText(e: any): string | null {
  if (e?.type !== "user" || e.isMeta || e.isSidechain) return null;
  const c = e.message?.content;
  if (typeof c === "string") return c.trimStart();
  if (!Array.isArray(c) || c.some((b: any) => b?.type === "tool_result")) return null;
  const t = contentText(c);
  return t.length ? t.join("\n").trimStart() : null;
}

// Claude Code records Esc as a user entry with this text.
function isInterruption(e: any): boolean {
  return userText(e)?.startsWith("[Request interrupted by user") ?? false;
}

// Input that starts a turn: a typed or pasted prompt, a teammate message or a task
// notification. Not tool results, meta entries, interruptions or slash-command echoes.
function isPrompt(e: any): boolean {
  const t = userText(e);
  if (t === null || t.startsWith("[Request interrupted by user")) return false;
  return !t.startsWith("<local-command-") && !t.startsWith("<command-");
}

function clip(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "…" : s;
}

function clipStart(text: string, max: number): { text: string; truncated: boolean } {
  return text.length > max ? { text: "…" + text.slice(text.length - max), truncated: true } : { text, truncated: false };
}

function parseLines(text: string): any[] {
  const out: any[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      out.push(null);
    }
  }
  return out;
}

export function lastReply(path: string, maxChars: number, find: (entries: any[], maxChars: number) => Reply | null = findReply): Reply | null {
  for (const window of [4_000_000, 64_000_000]) {
    const { text, whole } = readTail(path, window);
    const reply = find(parseLines(text), maxChars);
    if (reply || whole) return reply;
  }
  return null;
}

export function findReply(entries: any[], maxChars: number): Reply | null {
  // The newest assistant entry that ends a turn marks the last complete answer.
  let end = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e?.type === "assistant" && !e.isSidechain && FINAL_STOPS.has(e.message?.stop_reason) && contentText(e.message?.content).length) {
      end = i;
      break;
    }
  }

  // A prompt newer than that answer means a turn is running, or was interrupted.
  let inProgress: Reply["in_progress"] = null;
  let interrupted = false;
  for (let i = entries.length - 1; i > end; i--) {
    if (isInterruption(entries[i])) interrupted = true;
    if (!isPrompt(entries[i])) continue;
    let latest: string | null = null;
    let at: string | null = null;
    for (let j = entries.length - 1; j > i; j--) {
      const e = entries[j];
      if (e?.type !== "assistant" || e.isSidechain) continue;
      const t = contentText(e.message?.content);
      if (t.length) {
        latest = clip(t.join("\n\n"), 1500);
        at = e.timestamp ?? null;
        break;
      }
    }
    inProgress = { prompt: clip(userText(entries[i]) ?? "", 300), latest_text: latest, at, interrupted };
    break;
  }
  if (end < 0) return inProgress ? { text: "", at: null, in_reply_to: null, truncated: false, in_progress: inProgress } : null;

  // Claude Code writes one entry per content block; gather the final message's text blocks.
  const msgId = entries[end].message?.id;
  const parts: string[] = [];
  let promptIdx = -1;
  for (let i = end; i >= 0; i--) {
    const e = entries[i];
    if (isPrompt(e)) {
      promptIdx = i;
      break;
    }
    if (e?.type === "assistant" && (i === end || (msgId && e.message?.id === msgId))) parts.unshift(...contentText(e.message?.content));
  }
  const { text, truncated } = clipStart(parts.join("\n\n").trim(), maxChars);
  return {
    text,
    at: entries[end].timestamp ?? null,
    in_reply_to: promptIdx >= 0 ? clip(userText(entries[promptIdx]) ?? "", 300) : null,
    truncated,
    in_progress: inProgress,
  };
}

// ---------- Cursor ----------

// Cursor wraps what the user typed: <timestamp>…</timestamp> <user_query>…</user_query>.
function cursorPrompt(e: any): string {
  const t = contentText(e?.message?.content).join("\n");
  const q = t.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/);
  return (q ? q[1]! : t.replace(/<timestamp>[\s\S]*?<\/timestamp>/g, "")).trim();
}

// The text of the newest assistant entry in entries[from, to) that has any.
function cursorText(entries: any[], from: number, to: number): string | null {
  for (let i = to - 1; i >= from; i--) {
    const e = entries[i];
    if (e?.role !== "assistant") continue;
    const t = contentText(e.message?.content).join("\n\n").trim();
    if (t) return t;
  }
  return null;
}

// A finished turn ends with a {"type":"turn_ended","status":...} entry, which Cursor
// drops again when the next prompt arrives. So a prompt with no turn_ended after it is
// the turn in progress, and the answer before that prompt is the last complete one.
// What the user typed is the user entry with <user_query>; Cursor also writes user
// entries holding only a timestamp or a tool catalog.
export function findCursorReply(entries: any[], maxChars: number): Reply | null {
  const users = entries.flatMap((e, i) => (e?.role === "user" ? [i] : []));
  const queries = users.filter((i) => contentText(entries[i].message?.content).some((t) => t.includes("<user_query>")));
  const prompts = queries.length ? queries : users;
  const last = prompts.at(-1);
  if (last === undefined) return null;
  // A turn can end twice, e.g. success and then "User aborted request": success wins.
  const ends = entries.flatMap((e, i) => (i > last && e?.type === "turn_ended" ? [i] : []));
  const end = ends.find((i) => entries[i].status === "success") ?? ends.at(-1) ?? -1;
  // The answered turn: the last one if it ended, else the one before it.
  const answered = end >= 0 ? last : prompts.at(-2);
  const inProgress: Reply["in_progress"] = end >= 0 ? null : {
    prompt: clip(cursorPrompt(entries[last]), 300),
    latest_text: ((t) => t && clip(t, 1500))(cursorText(entries, last + 1, entries.length)),
    at: null,
    interrupted: false,
  };
  if (answered === undefined) return { text: "", at: null, in_reply_to: null, truncated: false, in_progress: inProgress };
  const { text, truncated } = clipStart(cursorText(entries, answered + 1, end >= 0 ? end : last) ?? "", maxChars);
  const reply: Reply = { text, at: null, in_reply_to: clip(cursorPrompt(entries[answered]), 300), truncated, in_progress: inProgress };
  const turn = end >= 0 ? entries[end] : null;
  if (turn?.status && turn.status !== "success") reply.ended = typeof turn.error === "string" ? `${turn.status}: ${clip(turn.error, 200)}` : String(turn.status);
  return reply;
}

// Cursor entries carry no timestamps; while no newer turn runs, the file's last write is when the answer landed.
export function lastCursorReply(path: string, maxChars: number): Reply | null {
  const reply = lastReply(path, maxChars, findCursorReply);
  if (reply && !reply.in_progress) reply.at = statSync(path).mtime.toISOString();
  return reply;
}

// ---------- any agent ----------

// The agent's last complete answer, or null when it has no readable transcript.
// With freshFor, retries briefly until the answer is to that prompt: an agent can
// report idle a moment before the final entry reaches the file.
export async function agentReply(
  cfg: Pick<GatewayConfig, "transcriptRoots" | "cursorTranscriptRoots">,
  agent: any,
  opts: { freshFor?: string } = {},
): Promise<(Reply & { matches_prompt?: boolean }) | null> {
  let read: (() => Reply | null) | null = null;
  const claude = claudeSessionId(agent);
  const cursor = cursorSessionId(agent);
  if (claude) {
    const file = findTranscript(cfg.transcriptRoots, claude, agent.cwd);
    if (file) read = () => lastReply(file, REPLY_CHARS);
  } else if (cursor) {
    const file = findCursorTranscript(cfg.cursorTranscriptRoots, cursor, agent.cwd);
    if (file) read = () => lastCursorReply(file, REPLY_CHARS);
  }
  if (!read) return null;
  for (let attempt = 0; ; attempt++) {
    const reply = read();
    if (!opts.freshFor) return reply;
    const matches = !!reply?.text && samePrompt(opts.freshFor, reply.in_reply_to);
    if (matches || attempt >= 4) return reply ? { ...reply, matches_prompt: matches } : null;
    await Bun.sleep(400);
  }
}

// Does a transcript prompt look like the text we sent? Compares a whitespace-normalised prefix.
export function samePrompt(sent: string, recorded: string | null): boolean {
  if (!recorded) return false;
  const norm = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, 80).replace(/…$/, "");
  const a = norm(sent);
  const b = norm(recorded);
  return a.length > 0 && (a.startsWith(b) || b.startsWith(a));
}
