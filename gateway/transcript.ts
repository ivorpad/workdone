// An agent's last answer as clean text, read from its transcript instead of scraped
// from the terminal. Herdr reports the session ID of each Claude and Cursor agent.
// Claude Code writes <root>/<project-slug>/<session-id>.jsonl under a transcript root;
// the Cursor CLI writes <root>/<project-slug>/agent-transcripts/<id>/<id>.jsonl under
// ~/.cursor/projects. Codex, opencode and pi are found by the pane's cwd (pi also by
// the session path Herdr reports): Codex rollouts under ~/.codex/sessions, opencode's
// sqlite database, pi's session files under ~/.pi/agent/sessions.

import { Database } from "bun:sqlite";
import { closeSync, existsSync, fstatSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import type { GatewayConfig } from "./config.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FINAL_STOPS = new Set(["end_turn", "stop_sequence", "max_tokens"]);
const REPLY_CHARS = 12_000;

// What one transcript says about the last turns.
export interface Turn {
  text: string;
  at: string | null;
  in_reply_to: string | null;
  truncated: boolean;
  in_progress: { prompt: string; latest_text: string | null; at: string | null; interrupted: boolean } | null;
  // Cursor, opencode and pi: how the last turn ended when it was not a normal answer.
  ended?: string;
}

// Where a reply was read: the transcript file (opencode: its database) and the session in it.
export interface ReplyRef {
  kind: "claude_jsonl" | "cursor_jsonl" | "codex_rollout" | "opencode_sqlite" | "pi_jsonl";
  path: string | null;
  session: string | null;
}

export type Reply = Turn & { ref: ReplyRef };

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

export function lastReply(path: string, maxChars: number, find: (entries: any[], maxChars: number) => Turn | null = findReply): Turn | null {
  for (const window of [4_000_000, 64_000_000]) {
    const { text, whole } = readTail(path, window);
    const reply = find(parseLines(text), maxChars);
    if (reply || whole) return reply;
  }
  return null;
}

export function findReply(entries: any[], maxChars: number): Turn | null {
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
  let inProgress: Turn["in_progress"] = null;
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
export function findCursorReply(entries: any[], maxChars: number): Turn | null {
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
  const inProgress: Turn["in_progress"] = end >= 0 ? null : {
    prompt: clip(cursorPrompt(entries[last]), 300),
    latest_text: ((t) => t && clip(t, 1500))(cursorText(entries, last + 1, entries.length)),
    at: null,
    interrupted: false,
  };
  if (answered === undefined) return { text: "", at: null, in_reply_to: null, truncated: false, in_progress: inProgress };
  const { text, truncated } = clipStart(cursorText(entries, answered + 1, end >= 0 ? end : last) ?? "", maxChars);
  const reply: Turn = { text, at: null, in_reply_to: clip(cursorPrompt(entries[answered]), 300), truncated, in_progress: inProgress };
  const turn = end >= 0 ? entries[end] : null;
  if (turn?.status && turn.status !== "success") reply.ended = typeof turn.error === "string" ? `${turn.status}: ${clip(turn.error, 200)}` : String(turn.status);
  return reply;
}

// Cursor entries carry no timestamps; while no newer turn runs, the file's last write is when the answer landed.
export function lastCursorReply(path: string, maxChars: number): Turn | null {
  const reply = lastReply(path, maxChars, findCursorReply);
  if (reply && !reply.in_progress) reply.at = statSync(path).mtime.toISOString();
  return reply;
}

// ---------- turns (Codex, opencode, pi) ----------

// One prompt and what followed it. end: "open" while it runs, "done" when it answered,
// "aborted" when the user stopped it, "error" when the model call failed.
export interface TurnRecord {
  prompt: string;
  answer: string | null;
  at: string | null;
  latest: string | null;
  latest_at: string | null;
  end: "open" | "done" | "aborted" | "error";
  error?: string;
}

// The newest answered turn, and the turn after it when that one is running or was stopped.
export function pickTurn(turns: TurnRecord[], maxChars: number): Turn | null {
  const last = turns.at(-1);
  if (!last) return null;
  const inProgress: Turn["in_progress"] = last.end === "open" || last.end === "aborted"
    ? { prompt: clip(last.prompt, 300), latest_text: last.latest && clip(last.latest, 1500), at: last.latest_at, interrupted: last.end === "aborted" }
    : null;
  const answered = turns.findLast((t) => t.end === "done" || t.end === "error");
  if (!answered) return inProgress ? { text: "", at: null, in_reply_to: null, truncated: false, in_progress: inProgress } : null;
  const { text, truncated } = clipStart((answered.answer ?? "").trim(), maxChars);
  const turn: Turn = { text, at: answered.at, in_reply_to: clip(answered.prompt, 300), truncated, in_progress: inProgress };
  if (answered.end === "error") turn.ended = answered.error ? `error: ${clip(answered.error, 200)}` : "error";
  return turn;
}

// ---------- Codex ----------

// Herdr reports no session for Codex (its hook is not wired, and Codex's shared app-server
// daemon hides it anyway), so the rollout is the newest one whose session_meta has the
// pane's cwd, or, when we know what was just sent, the one whose prompt is that text.
// Codex Desktop, `codex exec` and subagent threads (guardian reviews) write rollouts
// under the same root, often for the same cwd: they are skipped.
interface RolloutMeta { id: string | null; cwd: string | null; tui: boolean }
const rolloutMetas = new Map<string, RolloutMeta>();
const CODEX_DAYS = 30;

function rolloutMeta(path: string): RolloutMeta | null {
  const known = rolloutMetas.get(path);
  if (known) return known;
  let first: any;
  const fd = openSync(path, "r");
  try {
    // session_meta is the first line; it carries the base instructions, about 25 KB.
    const chunks: Buffer[] = [];
    for (let pos = 0, nl = -1; nl < 0; pos += 32_768) {
      const buf = Buffer.alloc(32_768);
      const n = readSync(fd, buf, 0, buf.length, pos);
      if (n === 0 || pos >= 1_000_000) return null;
      nl = buf.subarray(0, n).indexOf(10);
      chunks.push(buf.subarray(0, nl < 0 ? n : nl));
    }
    first = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
  if (first?.type !== "session_meta") return null;
  const p = first.payload ?? {};
  const tui = typeof p.source === "string" && p.source !== "exec"
    && (p.thread_source === undefined || p.thread_source === "user") && p.originator !== "Codex Desktop";
  const meta = { id: typeof p.id === "string" ? p.id : null, cwd: typeof p.cwd === "string" ? p.cwd : null, tui };
  rolloutMetas.set(path, meta);
  return meta;
}

const numericDesc = (dir: string) => {
  try {
    return readdirSync(dir).filter((d) => /^\d+$/.test(d)).sort((a, b) => Number(b) - Number(a));
  } catch {
    return [];
  }
};

// The rollouts for cwd from the last CODEX_DAYS day folders, newest write first.
export function codexRollouts(roots: string[], cwd: string): { path: string; id: string | null }[] {
  const found: { path: string; id: string | null; mtime: number }[] = [];
  for (const root of roots) {
    let days = 0;
    for (const y of numericDesc(root)) {
      for (const m of numericDesc(join(root, y))) {
        for (const d of numericDesc(join(root, y, m))) {
          if (days++ >= CODEX_DAYS) break;
          const dir = join(root, y, m, d);
          let names: string[];
          try {
            names = readdirSync(dir);
          } catch {
            continue;
          }
          for (const name of names) {
            if (!name.startsWith("rollout-") || !name.endsWith(".jsonl")) continue;
            const path = join(dir, name);
            const meta = rolloutMeta(path);
            if (!meta?.tui || meta.cwd !== cwd) continue;
            try {
              found.push({ path, id: meta.id, mtime: statSync(path).mtimeMs });
            } catch {}
          }
        }
      }
    }
  }
  return found.sort((a, b) => b.mtime - a.mtime).map(({ path, id }) => ({ path, id }));
}

// Text Codex adds to user items: AGENTS.md, environment context, skills, images, the
// answer to a question it asked, the note it leaves after an interrupt.
const CODEX_INJECTED = /^(# AGENTS\.md instructions|<\/?[A-Za-z][\w-]*[\s>])/;

function codexPrompt(p: any): string | null {
  if (p?.type !== "message" || p.role !== "user" || !Array.isArray(p.content)) return null;
  const t = p.content.filter((b: any) => b?.type === "input_text" && typeof b.text === "string" && !CODEX_INJECTED.test(b.text.trimStart())).map((b: any) => b.text);
  return t.length ? t.join("\n").trim() : null;
}

function codexText(p: any): string | null {
  if (p?.type !== "message" || p.role !== "assistant" || !Array.isArray(p.content)) return null;
  const t = p.content.filter((b: any) => b?.type === "output_text" && typeof b.text === "string").map((b: any) => b.text).join("\n\n").trim();
  return t || null;
}

// A turn runs from task_started to task_complete or turn_aborted; its answer is the
// final_answer message, else task_complete's last_agent_message. A prompt sent while a
// turn runs joins that turn.
export function findCodexReply(entries: any[], maxChars: number): Turn | null {
  const turns: TurnRecord[] = [];
  let cur: TurnRecord | null = null;
  const open = (prompt: string): TurnRecord => ({ prompt, answer: null, at: null, latest: null, latest_at: null, end: "open" });
  for (const e of entries) {
    const p = e?.payload;
    if (e?.type === "event_msg" && p?.type === "task_started") turns.push(cur = open(""));
    else if (e?.type === "response_item") {
      const prompt = codexPrompt(p);
      if (prompt !== null) {
        if (!cur || cur.end !== "open") turns.push(cur = open(prompt));
        else if (!cur.prompt) cur.prompt = prompt;
        continue;
      }
      const text = codexText(p);
      if (text && cur?.end === "open") {
        cur.latest = text;
        cur.latest_at = e.timestamp ?? null;
        if (p.phase === "final_answer") cur.answer = text;
      }
    } else if (e?.type === "event_msg" && cur?.end === "open" && (p?.type === "task_complete" || p?.type === "turn_aborted")) {
      if (p.type === "task_complete") {
        cur.end = "done";
        cur.answer ??= typeof p.last_agent_message === "string" ? p.last_agent_message : cur.latest;
        cur.at = e.timestamp ?? null;
      } else cur.end = "aborted";
    }
  }
  return pickTurn(turns, maxChars);
}

// ---------- opencode ----------

// opencode keeps every session in one sqlite database: session(directory, parent_id,
// time_updated), message(data: role, time, finish, error), part(data: type, text).
// The pane's session is the newest top-level one for its cwd (subagents have a parent),
// or the ses_… id when Herdr reports one.
const OPENCODE_ID_RE = /^ses_[A-Za-z0-9]+$/;
const OPENCODE_MESSAGES = 400;

// rejected: the error of a tool call the user refused, which ends the turn.
export interface OpencodeMessage {
  id: string; role: string; created: number; completed: number | null; finish: string | null;
  error: { name?: string; message?: string } | null; text: string; rejected?: string;
}

export function readOpencode(dbPath: string, agent: any): { session: string; messages: OpencodeMessage[] } | null {
  if (!existsSync(dbPath)) return null;
  const db = new Database(dbPath, { readonly: true });
  try {
    const s = agent?.agent_session;
    const byId = s?.kind === "id" && typeof s.value === "string" && OPENCODE_ID_RE.test(s.value) ? s.value : null;
    const row = byId
      ? db.query("SELECT id FROM session WHERE id = ?").get(byId) as { id: string } | null
      : db.query("SELECT id FROM session WHERE directory = ? AND parent_id IS NULL AND time_archived IS NULL ORDER BY time_updated DESC LIMIT 1")
        .get(agent?.foreground_cwd ?? agent?.cwd ?? "") as { id: string } | null;
    if (!row) return null;
    const rows = db.query("SELECT id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created DESC, id DESC LIMIT ?")
      .all(row.id, OPENCODE_MESSAGES) as { id: string; time_created: number; data: string }[];
    const texts = new Map<string, string[]>();
    const rejected = new Map<string, string>();
    if (rows.length) {
      const ids = rows.map(() => "?").join(",");
      const parts = db.query(
        `SELECT message_id, data FROM part WHERE session_id = ? AND message_id IN (${ids}) AND json_extract(data, '$.type') = 'text' ORDER BY id`,
      ).all(row.id, ...rows.map((r) => r.id)) as { message_id: string; data: string }[];
      for (const part of parts) {
        let d: any;
        try {
          d = JSON.parse(part.data);
        } catch {
          continue;
        }
        if (typeof d?.text !== "string" || d.synthetic || d.ignored) continue;
        texts.set(part.message_id, [...(texts.get(part.message_id) ?? []), d.text]);
      }
      const refused = db.query(
        `SELECT message_id, json_extract(data, '$.state.error') AS error FROM part WHERE session_id = ? AND message_id IN (${ids})
         AND json_extract(data, '$.type') = 'tool' AND json_extract(data, '$.state.status') = 'error' AND json_extract(data, '$.state.error') LIKE '%rejected permission%'`,
      ).all(row.id, ...rows.map((r) => r.id)) as { message_id: string; error: string }[];
      for (const r of refused) rejected.set(r.message_id, r.error);
    }
    const messages: OpencodeMessage[] = [];
    for (const r of rows.reverse()) {
      let d: any;
      try {
        d = JSON.parse(r.data);
      } catch {
        continue;
      }
      messages.push({
        id: r.id, role: d?.role, created: r.time_created,
        completed: typeof d?.time?.completed === "number" ? d.time.completed : null,
        finish: typeof d?.finish === "string" ? d.finish : null,
        error: d?.error ? { name: d.error.name, message: d.error.data?.message } : null,
        text: (texts.get(r.id) ?? []).join("\n\n").trim(),
        ...(rejected.has(r.id) ? { rejected: rejected.get(r.id) } : {}),
      });
    }
    return { session: row.id, messages };
  } finally {
    db.close();
  }
}

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

// A user message starts a turn; it is over when an assistant message completes with a
// finish other than tool-calls, or fails. Esc shows as a MessageAbortedError. A refused
// permission leaves a completed tool-calls message and nothing after it: opencode stops there.
export function findOpencodeReply(messages: OpencodeMessage[], maxChars: number): Turn | null {
  const turns: TurnRecord[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      turns.push({ prompt: m.text, answer: null, at: null, latest: null, latest_at: null, end: "open" });
      continue;
    }
    const cur = turns.at(-1);
    if (m.role !== "assistant" || !cur) continue;
    if (m.text) {
      cur.latest = cur.answer = m.text;
      cur.latest_at = iso(m.completed ?? m.created);
    }
    if (m.error) {
      cur.end = m.error.name === "MessageAbortedError" ? "aborted" : "error";
      if (cur.end === "error") cur.error = m.error.message ?? m.error.name;
      cur.at = iso(m.completed ?? m.created);
    } else if (m.completed !== null && m.finish && m.finish !== "tool-calls") {
      cur.end = "done";
      cur.at = iso(m.completed);
    } else if (m.completed !== null && m.rejected) {
      cur.end = "error";
      cur.error = m.rejected;
      cur.at = iso(m.completed);
    } else cur.end = "open";
  }
  return pickTurn(turns, maxChars);
}

// ---------- pi ----------

// pi writes <root>/<slug>/<ISO ts>_<id>.jsonl, the slug being the cwd without its leading
// "/", every "/" (and "\\", ":") turned into "-", wrapped in "--". Herdr reports the file
// itself as a path session; trust it only under a configured root.
export function piSlug(cwd: string): string {
  return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

export function findPiSession(roots: string[], agent: any): string | null {
  const s = agent?.agent_session;
  if (agent?.agent === "pi" && s?.kind === "path" && typeof s.value === "string" && s.value.endsWith(".jsonl")) {
    const p = resolve(s.value);
    const inside = roots.some((r) => {
      const rel = relative(r, p);
      return rel !== "" && !rel.startsWith("..") && !rel.startsWith("/");
    });
    if (inside && existsSync(p)) return p;
  }
  const cwd = agent?.foreground_cwd ?? agent?.cwd;
  if (typeof cwd !== "string") return null;
  let best: { path: string; mtime: number } | null = null;
  for (const root of roots) {
    const dir = join(root, piSlug(cwd));
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      try {
        const st = statSync(join(dir, name));
        if (st.isFile() && (!best || st.mtimeMs > best.mtime)) best = { path: join(dir, name), mtime: st.mtimeMs };
      } catch {}
    }
  }
  return best?.path ?? null;
}

export const piSessionId = (path: string) => basename(path).match(/_([^_]+)\.jsonl$/)?.[1] ?? null;

// Message entries only: a user message starts a turn; an assistant message with
// stopReason stop (or length) answers it, toolUse continues it, aborted and error end it.
export function findPiReply(entries: any[], maxChars: number): Turn | null {
  const turns: TurnRecord[] = [];
  for (const e of entries) {
    if (e?.type !== "message") continue;
    const m = e.message;
    if (m?.role === "user") {
      turns.push({ prompt: contentText(m.content).join("\n").trim(), answer: null, at: null, latest: null, latest_at: null, end: "open" });
      continue;
    }
    const cur = turns.at(-1);
    if (m?.role !== "assistant" || !cur || !Array.isArray(m.content)) continue;
    const text = contentText(m.content).join("\n\n").trim();
    if (text) {
      cur.latest = text;
      cur.latest_at = e.timestamp ?? null;
    }
    if (m.stopReason === "stop" || m.stopReason === "length") {
      cur.end = "done";
      cur.answer = text || cur.latest;
      cur.at = e.timestamp ?? null;
    } else if (m.stopReason === "aborted") cur.end = "aborted";
    else if (m.stopReason === "error") {
      cur.end = "error";
      cur.error = typeof m.errorMessage === "string" ? m.errorMessage : undefined;
      cur.at = e.timestamp ?? null;
    }
  }
  return pickTurn(turns, maxChars);
}

// ---------- any agent ----------

type Sources = Pick<GatewayConfig, "transcriptRoots" | "cursorTranscriptRoots" | "codexSessionRoots" | "opencodeDb" | "piSessionRoots">;

// The agent's transcript read once: its turns and where they came from. Codex has no
// session to go by: with freshFor, the newest few rollouts for the cwd are checked for
// that prompt before falling back to the newest.
function readReply(cfg: Sources, agent: any, freshFor?: string): Reply | null {
  const claude = claudeSessionId(agent);
  const cursor = cursorSessionId(agent);
  const cwd: string | undefined = agent?.foreground_cwd ?? agent?.cwd;
  if (claude) {
    const file = findTranscript(cfg.transcriptRoots, claude, agent.cwd);
    const turn = file && lastReply(file, REPLY_CHARS);
    return turn ? { ...turn, ref: { kind: "claude_jsonl", path: file, session: claude } } : null;
  }
  if (cursor) {
    const file = findCursorTranscript(cfg.cursorTranscriptRoots, cursor, agent.cwd);
    const turn = file && lastCursorReply(file, REPLY_CHARS);
    return turn ? { ...turn, ref: { kind: "cursor_jsonl", path: file, session: cursor } } : null;
  }
  if (agent?.agent === "codex" && typeof cwd === "string") {
    const rollouts = codexRollouts(cfg.codexSessionRoots, cwd);
    let pick: { path: string; id: string | null; turn: Turn | null } | null = null;
    for (const r of freshFor ? rollouts.slice(0, 5) : rollouts.slice(0, 1)) {
      const turn = lastReply(r.path, REPLY_CHARS, findCodexReply);
      pick ??= { ...r, turn };
      if (freshFor && (samePrompt(freshFor, turn?.in_reply_to ?? null) || samePrompt(freshFor, turn?.in_progress?.prompt ?? null))) {
        pick = { ...r, turn };
        break;
      }
    }
    return pick?.turn ? { ...pick.turn, ref: { kind: "codex_rollout", path: pick.path, session: pick.id } } : null;
  }
  if (agent?.agent === "opencode" && cfg.opencodeDb) {
    const read = readOpencode(cfg.opencodeDb, agent);
    const turn = read && findOpencodeReply(read.messages, REPLY_CHARS);
    return turn ? { ...turn, ref: { kind: "opencode_sqlite", path: cfg.opencodeDb, session: read!.session } } : null;
  }
  if (agent?.agent === "pi") {
    const file = findPiSession(cfg.piSessionRoots, agent);
    const turn = file && lastReply(file, REPLY_CHARS, findPiReply);
    return turn ? { ...turn, ref: { kind: "pi_jsonl", path: file, session: piSessionId(file) } } : null;
  }
  return null;
}

// The agent's last complete answer, or null when it has no readable transcript.
// With freshFor, retries briefly until the answer is to that prompt: an agent can
// report idle a moment before the final entry reaches the file.
export async function agentReply(
  cfg: Sources,
  agent: any,
  opts: { freshFor?: string } = {},
): Promise<(Reply & { matches_prompt?: boolean }) | null> {
  for (let attempt = 0; ; attempt++) {
    const reply = readReply(cfg, agent, opts.freshFor);
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
