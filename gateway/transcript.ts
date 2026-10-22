// An agent's last answer as clean text, read from its transcript instead of scraped
// from the terminal. Herdr reports the session ID of each Claude and Cursor agent.
// Claude Code writes <root>/<project-slug>/<session-id>.jsonl under a transcript root;
// the Cursor CLI writes <root>/<project-slug>/agent-transcripts/<id>/<id>.jsonl under
// ~/.cursor/projects. Codex, opencode and pi are found from the pane (pi also by the
// session path Herdr reports): Codex rollouts under ~/.codex/sessions, opencode's
// sqlite database, pi's session files under ~/.pi/agent/sessions. None of these stores
// is scanned whole: they are history, and a gateway process lives for one call.

import { Database } from "bun:sqlite";
import { closeSync, existsSync, fstatSync, openSync, readdirSync, readFileSync, readlinkSync, readSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { indexedCodexThreads } from "./codex-index.ts";
import type { GatewayConfig, HerdrCall } from "./config.ts";

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
  // Codex and opencode: the questions their question tool asked in this turn (the running
  // one, else the answered one), with the owner's answers once given.
  questions?: Question[];
}

export interface Question {
  title: string;
  options: string[];
  answers?: string[];
  // opencode's short label for the question.
  header?: string;
}

// Where a reply was read: the transcript file (opencode: its database) and the session in it.
export interface ReplyRef {
  kind: "claude_jsonl" | "cursor_jsonl" | "codex_rollout" | "opencode_sqlite" | "pi_jsonl";
  path: string | null;
  session: string | null;
  // Codex only: how the rollout was tied to the pane. "pid" is certain; "index" is Codex's
  // own newest live thread for the directory and "cwd" the newest rollout file for it,
  // both of which two Codex panes in one cwd share.
  match?: "index" | "pid" | "cwd";
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
  questions?: Question[];
}

// The newest answered turn, and the turn after it when that one is running or was stopped.
export function pickTurn(turns: TurnRecord[], maxChars: number): Turn | null {
  const last = turns.at(-1);
  if (!last) return null;
  const inProgress: Turn["in_progress"] = last.end === "open" || last.end === "aborted"
    ? { prompt: clip(last.prompt, 300), latest_text: last.latest && clip(last.latest, 1500), at: last.latest_at, interrupted: last.end === "aborted" }
    : null;
  const answered = turns.findLast((t) => t.end === "done" || t.end === "error");
  const questions = (inProgress && last.questions?.length ? last.questions : answered?.questions) ?? [];
  if (!answered) return inProgress ? { text: "", at: null, in_reply_to: null, truncated: false, in_progress: inProgress, ...(questions.length ? { questions } : {}) } : null;
  const { text, truncated } = clipStart((answered.answer ?? "").trim(), maxChars);
  const turn: Turn = { text, at: answered.at, in_reply_to: clip(answered.prompt, 300), truncated, in_progress: inProgress };
  if (answered.end === "error") turn.ended = answered.error ? `error: ${clip(answered.error, 200)}` : "error";
  if (questions.length) turn.questions = questions;
  return turn;
}

// ---------- Codex ----------

// Herdr reports no session for Codex (its hook is not wired, and Codex's shared app-server
// daemon hides it anyway), and ~/.codex/sessions is history that is never scanned: it
// holds hundreds of rollouts. The pane's rollout comes from the pane itself, by the
// first rule that answers:
//   index  Codex's own thread index (codex-index.ts): the newest live TUI thread for the
//          pane's cwd, one query, kept current by the daemon per turn.
//   pid    the rollout the pane's codex process holds open (pane.process_info, then lsof
//          on macOS or /proc/<pid>/fd on Linux). Codex 0.159 and later write through a
//          shared app-server daemon that holds no rollout open, so there this finds
//          nothing; it serves older Codex and a pane running codex exec.
//   cwd    the newest rollout named with a timestamp at or after the agent started (its
//          day's folder and the next, plus today's), among at most CODEX_OPEN_MAX files
//          opened to check session_meta's cwd.
// index and cwd give two Codex panes in one directory the same answer. The result is
// cached per pane in <stateDir>/codex-rollouts.json: later polls do one stat. Codex
// Desktop, `codex exec` and subagent threads (guardian reviews) write rollouts under
// the same root, often for the same cwd: they are skipped.
export interface CodexRollout { path: string; id: string | null; match: "index" | "pid" | "cwd" }
interface RolloutMeta { id: string | null; cwd: string | null; tui: boolean }
const rolloutMetas = new Map<string, RolloutMeta>();
export const CODEX_OPEN_MAX = 3;
// How many rollouts this process opened to look at session_meta: tests hold it to the cap.
export const codexStats = { opened: 0 };
const ROLLOUT_RE = /^rollout-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-.*\.jsonl$/;
const DAY_MS = 86_400_000;

function rolloutMeta(path: string): RolloutMeta | null {
  const known = rolloutMetas.get(path);
  if (known) return known;
  let first: any;
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return null;
  }
  codexStats.opened++;
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

const real = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};

// Is path inside one of roots (not a root itself)? Symlinks resolved: lsof prints
// /private/var/… for a /var/… root on macOS.
function under(roots: string[], path: string): boolean {
  const p = real(path);
  return roots.some((r) => {
    const rel = relative(real(r), p);
    return rel !== "" && !rel.startsWith("..") && !rel.startsWith("/");
  });
}

// Codex names the file and its day folder in local time.
function rolloutStamp(name: string): number | null {
  const m = name.match(ROLLOUT_RE);
  return m ? new Date(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!).getTime() : null;
}

const dayDir = (root: string, t: number) => {
  const d = new Date(t);
  return join(root, String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0"));
};

// Rollouts named at or after since (a minute's slack), from that day's folder, the next
// and today's, newest first. Without since: yesterday's and today's folders, whole.
// Nothing is opened.
export function codexCandidates(roots: string[], since: number | null, now = Date.now()): string[] {
  const from = since ?? now - DAY_MS;
  const floor = since === null ? -Infinity : since - 60_000;
  const found: { path: string; stamp: number }[] = [];
  for (const root of roots) {
    const dirs = new Set([dayDir(root, from), dayDir(root, from + DAY_MS), dayDir(root, now)]);
    for (const dir of dirs) {
      let names: string[];
      try {
        names = readdirSync(dir);
      } catch {
        continue;
      }
      for (const name of names) {
        const stamp = rolloutStamp(name);
        if (stamp !== null && stamp >= floor) found.push({ path: join(dir, name), stamp });
      }
    }
  }
  return found.sort((a, b) => b.stamp - a.stamp).map((f) => f.path);
}

// The TUI rollouts for cwd among the newest candidates, opening at most max of them.
export function codexRollouts(roots: string[], cwd: string, opts: { since?: number | null; max?: number; now?: number } = {}): { path: string; id: string | null }[] {
  const out: { path: string; id: string | null }[] = [];
  for (const path of codexCandidates(roots, opts.since ?? null, opts.now).slice(0, opts.max ?? CODEX_OPEN_MAX)) {
    const meta = rolloutMeta(path);
    if (meta?.tui && meta.cwd === cwd) out.push({ path, id: meta.id });
  }
  return out;
}

const CODEX_PROC_RE = /(^|\/)codex(-[a-z0-9_.-]+)?$/i;

// The pids of the pane's foreground processes that are Codex.
async function codexPids(herdr: HerdrCall, paneId: string): Promise<number[]> {
  const info = (await herdr("pane.process_info", { pane_id: paneId }).catch(() => null))?.process_info;
  const procs: any[] = Array.isArray(info?.foreground_processes) ? info.foreground_processes : [];
  return procs
    .filter((p) => typeof p?.pid === "number" && [p.name, p.argv0, p.argv?.[0]].some((v) => typeof v === "string" && CODEX_PROC_RE.test(v)))
    .map((p) => p.pid as number);
}

// The rollout files a process holds open, under roots: /proc on Linux, lsof elsewhere.
export function openRollouts(pid: number, roots: string[], platform = process.platform): string[] {
  let paths: string[] = [];
  if (platform === "linux") {
    try {
      for (const fd of readdirSync(`/proc/${pid}/fd`)) {
        try {
          paths.push(readlinkSync(`/proc/${pid}/fd/${fd}`));
        } catch {}
      }
    } catch {
      return [];
    }
  } else {
    try {
      const r = Bun.spawnSync(["lsof", "-p", String(pid), "-Fn"], { stdout: "pipe", stderr: "ignore", timeout: 5000 });
      paths = r.stdout.toString().split("\n").filter((l) => l.startsWith("n")).map((l) => l.slice(1));
    } catch {
      return [];
    }
  }
  return paths.filter((p) => ROLLOUT_RE.test(basename(p)) && under(roots, p));
}

type RolloutCache = Record<string, CodexRollout & { cwd: string }>;
const cacheFile = (stateDir: string) => join(stateDir, "codex-rollouts.json");

function readRolloutCache(stateDir: string | undefined): RolloutCache {
  if (!stateDir) return {};
  try {
    const v = JSON.parse(readFileSync(cacheFile(stateDir), "utf8"));
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

function rememberRollout(stateDir: string | undefined, paneId: string | undefined, entry: CodexRollout & { cwd: string }) {
  if (!stateDir || !paneId) return;
  try {
    writeFileSync(cacheFile(stateDir), JSON.stringify({ ...readRolloutCache(stateDir), [paneId]: entry }));
  } catch {}
}

export interface CodexLookup {
  herdr?: HerdrCall;
  // When the agent started (ISO), from the gateway's watch record: bounds the cwd rule.
  since?: string | null;
  // Skip the cached answer: the caller found it was not this pane's thread.
  fresh?: boolean;
}

// The pane's rollout: cached, else by pid, else the newest for the cwd.
export async function resolveCodexRollout(cfg: Sources, agent: any, opts: CodexLookup = {}): Promise<CodexRollout | null> {
  const cwd: string | undefined = agent?.foreground_cwd ?? agent?.cwd;
  const paneId: string | undefined = agent?.pane_id;
  if (typeof cwd !== "string") return null;
  const hit = paneId ? readRolloutCache(cfg.stateDir)[paneId] : undefined;
  if (hit && !opts.fresh && hit.cwd === cwd && existsSync(hit.path)) return { path: hit.path, id: hit.id, match: hit.match };
  let found: CodexRollout | null = null;
  // The newest few: a row whose file was deleted, or lies outside the roots, is passed over.
  for (const t of indexedCodexThreads(cfg.codexStateDb ?? null, cwd, CODEX_OPEN_MAX) ?? []) {
    if (!under(cfg.codexSessionRoots, t.path) || !existsSync(t.path)) continue;
    found = { path: t.path, id: t.id, match: "index" };
    break;
  }
  if (!found && opts.herdr && paneId) {
    for (const pid of await codexPids(opts.herdr, paneId)) {
      const path = openRollouts(pid, cfg.codexSessionRoots)[0];
      if (path) {
        found = { path, id: rolloutMeta(path)?.id ?? null, match: "pid" };
        break;
      }
    }
  }
  if (!found) {
    const since = opts.since ? Date.parse(opts.since) : NaN;
    const r = codexRollouts(cfg.codexSessionRoots, cwd, { since: Number.isNaN(since) ? null : since })[0];
    if (r) found = { ...r, match: "cwd" };
  }
  if (found) rememberRollout(cfg.stateDir, paneId, { ...found, cwd });
  return found;
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

// request_user_input_async's arguments: {"questions":[{"title","options":[…]}]}.
function codexQuestions(p: any): Question[] {
  if (p?.type !== "function_call" || p.name !== "request_user_input_async" || typeof p.arguments !== "string") return [];
  try {
    const qs = JSON.parse(p.arguments)?.questions;
    return Array.isArray(qs)
      ? qs.filter((q: any) => typeof q?.title === "string").map((q: any) => ({ title: q.title, options: Array.isArray(q.options) ? q.options.filter((o: any) => typeof o === "string") : [] }))
      : [];
  } catch {
    return [];
  }
}

// The owner's answers come back as a user item: <send_user_message_question_reply>[{"answer","question"}]</…>.
function codexAnswers(p: any): Array<{ question: string; answer: string }> {
  if (p?.type !== "message" || p.role !== "user" || !Array.isArray(p.content)) return [];
  const out: Array<{ question: string; answer: string }> = [];
  for (const b of p.content) {
    const m = typeof b?.text === "string" ? b.text.match(/^<send_user_message_question_reply>\s*([\s\S]*?)\s*<\/send_user_message_question_reply>/) : null;
    if (!m) continue;
    try {
      for (const a of JSON.parse(m[1]!)) if (typeof a?.question === "string" && typeof a.answer === "string") out.push({ question: a.question, answer: a.answer });
    } catch {}
  }
  return out;
}

// A turn runs from task_started to task_complete or turn_aborted; its answer is the
// final_answer message, else task_complete's last_agent_message. A prompt sent while a
// turn runs joins that turn, as do the questions it asks and their answers.
export function findCodexReply(entries: any[], maxChars: number): Turn | null {
  const turns: TurnRecord[] = [];
  let cur: TurnRecord | null = null;
  const open = (prompt: string): TurnRecord => ({ prompt, answer: null, at: null, latest: null, latest_at: null, end: "open" });
  for (const e of entries) {
    const p = e?.payload;
    if (e?.type === "event_msg" && p?.type === "task_started") turns.push(cur = open(""));
    else if (e?.type === "response_item") {
      const asked = codexQuestions(p);
      if (asked.length && cur) (cur.questions ??= []).push(...asked);
      for (const a of codexAnswers(p)) {
        const q = cur?.questions?.find((q) => q.title === a.question && !q.answers);
        if (q) q.answers = [a.answer];
      }
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

// rejected: the error of a tool call the user refused, which ends the turn. questions:
// what the question tool asked in this message, with the answers once given.
export interface OpencodeMessage {
  id: string; role: string; created: number; completed: number | null; finish: string | null;
  error: { name?: string; message?: string } | null; text: string; rejected?: string; questions?: Question[];
}

// The question tool's part: state.input.questions[{header, question, options[{label}]}] and
// state.metadata.answers[i] once the owner answered.
function opencodeQuestions(d: any): Question[] {
  const qs = d?.state?.input?.questions;
  if (d?.type !== "tool" || d.tool !== "question" || !Array.isArray(qs)) return [];
  const answers = d.state?.metadata?.answers;
  return qs.filter((q: any) => typeof q?.question === "string").map((q: any, i: number) => ({
    title: q.question,
    options: Array.isArray(q.options) ? q.options.map((o: any) => (typeof o === "string" ? o : o?.label)).filter((o: any) => typeof o === "string") : [],
    ...(typeof q.header === "string" ? { header: q.header } : {}),
    ...(Array.isArray(answers?.[i]) ? { answers: answers[i].filter((a: any) => typeof a === "string") } : {}),
  }));
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
    const asked = new Map<string, Question[]>();
    const rejected = new Map<string, string>();
    if (rows.length) {
      const ids = rows.map(() => "?").join(",");
      const parts = db.query(
        `SELECT message_id, data FROM part WHERE session_id = ? AND message_id IN (${ids})
         AND (json_extract(data, '$.type') = 'text' OR (json_extract(data, '$.type') = 'tool' AND json_extract(data, '$.tool') = 'question')) ORDER BY id`,
      ).all(row.id, ...rows.map((r) => r.id)) as { message_id: string; data: string }[];
      for (const part of parts) {
        let d: any;
        try {
          d = JSON.parse(part.data);
        } catch {
          continue;
        }
        const qs = opencodeQuestions(d);
        if (qs.length) asked.set(part.message_id, [...(asked.get(part.message_id) ?? []), ...qs]);
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
        ...(asked.has(r.id) ? { questions: asked.get(r.id) } : {}),
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
    if (m.questions?.length) (cur.questions ??= []).push(...m.questions);
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
    if (under(roots, p) && existsSync(p)) return p;
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

export type Sources = Pick<GatewayConfig, "transcriptRoots" | "cursorTranscriptRoots" | "codexSessionRoots" | "opencodeDb" | "piSessionRoots"> & { stateDir?: string; codexStateDb?: string | null };

export interface ReplyOptions extends CodexLookup {
  freshFor?: string;
  // How much of the answer to keep (its end). Default REPLY_CHARS; the watcher keeps more for read_message.
  maxChars?: number;
}

// The agent's transcript read once: its turns and where they came from. Codex has no
// session to go by: the pane's rollout is resolved (resolveCodexRollout), and with
// freshFor, when that one does not hold the prompt just sent, the other recent rollouts
// for the cwd are checked for it.
async function readReply(cfg: Sources, agent: any, opts: ReplyOptions): Promise<Reply | null> {
  const { freshFor } = opts;
  const max = opts.maxChars ?? REPLY_CHARS;
  const claude = claudeSessionId(agent);
  const cursor = cursorSessionId(agent);
  const cwd: string | undefined = agent?.foreground_cwd ?? agent?.cwd;
  if (claude) {
    const file = findTranscript(cfg.transcriptRoots, claude, agent.cwd);
    const turn = file && lastReply(file, max);
    return turn ? { ...turn, ref: { kind: "claude_jsonl", path: file, session: claude } } : null;
  }
  if (cursor) {
    const file = findCursorTranscript(cfg.cursorTranscriptRoots, cursor, agent.cwd);
    const turn = file && lastCursorReply(file, max);
    return turn ? { ...turn, ref: { kind: "cursor_jsonl", path: file, session: cursor } } : null;
  }
  if (agent?.agent === "codex" && typeof cwd === "string") {
    const holds = (turn: Turn | null) => !!freshFor && (samePrompt(freshFor, turn?.in_reply_to ?? null) || samePrompt(freshFor, turn?.in_progress?.prompt ?? null));
    let pick = await resolveCodexRollout(cfg, agent, opts);
    let turn = pick ? lastReply(pick.path, max, findCodexReply) : null;
    if (freshFor && !holds(turn)) {
      const since = opts.since ? Date.parse(opts.since) : NaN;
      for (const r of codexRollouts(cfg.codexSessionRoots, cwd, { since: Number.isNaN(since) ? null : since })) {
        if (r.path === pick?.path) continue;
        const t = lastReply(r.path, max, findCodexReply);
        if (!holds(t)) continue;
        pick = { ...r, match: "cwd" };
        turn = t;
        rememberRollout(cfg.stateDir, agent?.pane_id, { ...pick, cwd });
        break;
      }
    }
    return pick && turn ? { ...turn, ref: { kind: "codex_rollout", path: pick.path, session: pick.id, match: pick.match } } : null;
  }
  if (agent?.agent === "opencode" && cfg.opencodeDb) {
    const read = readOpencode(cfg.opencodeDb, agent);
    const turn = read && findOpencodeReply(read.messages, max);
    return turn ? { ...turn, ref: { kind: "opencode_sqlite", path: cfg.opencodeDb, session: read!.session } } : null;
  }
  if (agent?.agent === "pi") {
    const file = findPiSession(cfg.piSessionRoots, agent);
    const turn = file && lastReply(file, max, findPiReply);
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
  opts: ReplyOptions = {},
): Promise<(Reply & { matches_prompt?: boolean }) | null> {
  for (let attempt = 0; ; attempt++) {
    const reply = await readReply(cfg, agent, opts);
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
