// Codex, opencode and pi transcripts. Fixtures are synthesized in the shape each CLI writes.
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  agentReply, codexRollouts, findCodexReply, findOpencodeReply, findPiReply, findPiSession, piSlug, readOpencode, type OpencodeMessage,
} from "../gateway/transcript.ts";

const none = { transcriptRoots: [], cursorTranscriptRoots: [], codexSessionRoots: [], opencodeDb: null, piSessionRoots: [] };
const lines = (entries: any[]) => entries.map((e) => JSON.stringify(e)).join("\n") + "\n";

// ---------- Codex ----------

const meta = (cwd: string, extra: Record<string, unknown> = {}) => ({
  type: "session_meta", payload: { id: "thread-1", cwd, source: "cli", thread_source: "user", originator: "codex-tui", base_instructions: { text: "x".repeat(40_000) }, ...extra },
});
const started = () => ({ type: "event_msg", payload: { type: "task_started", turn_id: "t" } });
const complete = (last: string | null, ts = "2026-10-15T10:01:00Z") => ({ type: "event_msg", timestamp: ts, payload: { type: "task_complete", last_agent_message: last } });
const aborted = () => ({ type: "event_msg", payload: { type: "turn_aborted", reason: "interrupted" } });
const user = (...texts: string[]) => ({ type: "response_item", payload: { type: "message", role: "user", content: texts.map((text) => ({ type: "input_text", text })) } });
const answer = (text: string, phase = "final_answer", ts = "2026-10-15T10:00:30Z") => ({
  type: "response_item", timestamp: ts, payload: { type: "message", role: "assistant", phase, content: [{ type: "output_text", text }] },
});

describe("findCodexReply", () => {
  test("the final answer of the last finished turn, without the context Codex injects", () => {
    const entries = [
      meta("/app"), started(), user("# AGENTS.md instructions for /app\n\n<INSTRUCTIONS>…"), user("<environment_context>\n  <cwd>/app</cwd>"),
      user("list the files"), answer("Looking.", "commentary"), answer("Two files."), complete("Two files."),
    ];
    expect(findCodexReply(entries, 1000)).toEqual({
      text: "Two files.", at: "2026-10-15T10:01:00Z", in_reply_to: "list the files", truncated: false, in_progress: null,
    });
  });
  test("an answer to Codex's own question and a prompt sent mid-turn stay in that turn", () => {
    const entries = [
      started(), user("ask me which animal"), user("<send_user_message_question_reply>\n[{\"answer\":\"dog\"}]"),
      user("also say OK"), answer("ANIMAL=dog\nOK"), complete("ANIMAL=dog\nOK"),
    ];
    expect(findCodexReply(entries, 1000)).toMatchObject({ text: "ANIMAL=dog\nOK", in_reply_to: "ask me which animal", in_progress: null });
  });
  test("a running turn and an interrupted one", () => {
    const done = [started(), user("first"), answer("one"), complete("one")];
    const running = [...done, started(), user("second"), answer("Starting.", "commentary", "2026-10-15T11:00:00Z")];
    expect(findCodexReply(running, 1000)).toMatchObject({
      text: "one", in_reply_to: "first", in_progress: { prompt: "second", latest_text: "Starting.", at: "2026-10-15T11:00:00Z", interrupted: false },
    });
    expect(findCodexReply([...running, aborted(), user("<turn_aborted>\nThe user interrupted.</turn_aborted>")], 1000)!.in_progress)
      .toMatchObject({ prompt: "second", interrupted: true });
  });
  test("task_complete's last message stands in when no message is marked final", () => {
    expect(findCodexReply([started(), user("go"), answer("Done.", "commentary"), complete("Done.")], 1000)!.text).toBe("Done.");
    expect(findCodexReply([started(), user("go"), complete(null)], 1000)!.text).toBe("");
  });
  test("null before any prompt", () => {
    expect(findCodexReply([meta("/app")], 1000)).toBeNull();
  });
});

describe("Codex rollouts", () => {
  const write = (root: string, day: string, name: string, entries: any[], mtime: number) => {
    const dir = join(root, ...day.split("/"));
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `rollout-${name}.jsonl`);
    writeFileSync(path, lines(entries));
    utimesSync(path, mtime, mtime);
    return path;
  };
  test("the newest TUI rollout for the cwd; Desktop, exec and subagent threads are skipped", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-codex-"));
    const mine = write(root, "2026/10/14", "a", [meta("/app"), started(), user("hi"), answer("hello"), complete("hello")], 1000);
    write(root, "2026/10/15", "b", [meta("/app", { source: { subagent: { other: "guardian" } }, thread_source: "guardian_review" })], 2000);
    write(root, "2026/10/15", "c", [meta("/app", { originator: "Codex Desktop", source: "vscode" })], 3000);
    write(root, "2026/10/15", "d", [meta("/app", { source: "exec" })], 4000);
    write(root, "2026/10/15", "e", [meta("/elsewhere")], 5000);
    expect(codexRollouts([root], "/app").map((r) => r.path)).toEqual([mine]);
  });
  test("agentReply joins by cwd, and by the prompt just sent when two sessions share it", async () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-codex-"));
    const older = write(root, "2026/10/14", "a", [meta("/app", { id: "thread-a" }), started(), user("Reply with OK"), answer("OK"), complete("OK")], 1000);
    write(root, "2026/10/15", "b", [meta("/app", { id: "thread-b" }), started(), user("other work"), answer("done"), complete("done")], 2000);
    const cfg = { ...none, codexSessionRoots: [root] };
    expect(await agentReply(cfg, { agent: "codex", cwd: "/app" })).toMatchObject({ text: "done", ref: { kind: "codex_rollout", session: "thread-b" } });
    expect(await agentReply(cfg, { agent: "codex", cwd: "/app" }, { freshFor: "Reply with OK" })).toMatchObject({
      text: "OK", matches_prompt: true, ref: { kind: "codex_rollout", path: older, session: "thread-a" },
    });
    expect(await agentReply(cfg, { agent: "codex", cwd: "/nowhere" })).toBeNull();
  });
});

// ---------- opencode ----------

function opencodeDb(dir: string) {
  const path = join(dir, "opencode.db");
  const db = new Database(path);
  db.run("PRAGMA journal_mode = WAL");
  db.run(`CREATE TABLE session (id text PRIMARY KEY, parent_id text, directory text NOT NULL, time_updated integer NOT NULL, time_archived integer);
    CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL, time_created integer NOT NULL, data text NOT NULL);
    CREATE TABLE part (id text PRIMARY KEY, message_id text NOT NULL, session_id text NOT NULL, data text NOT NULL);`);
  let n = 0;
  const id = (p: string) => `${p}_${String(++n).padStart(4, "0")}`;
  return {
    path, db,
    session(directory: string, updated: number, parent: string | null = null) {
      const s = id("ses");
      db.query("INSERT INTO session VALUES (?, ?, ?, ?, NULL)").run(s, parent, directory, updated);
      return s;
    },
    message(session: string, at: number, data: Record<string, unknown>, parts: any[] = []) {
      const m = id("msg");
      db.query("INSERT INTO message VALUES (?, ?, ?, ?)").run(m, session, at, JSON.stringify(data));
      for (const p of parts) db.query("INSERT INTO part VALUES (?, ?, ?, ?)").run(id("prt"), m, session, JSON.stringify(p));
      return m;
    },
  };
}
const said = (text: string) => ({ type: "text", text });
const msg = (role: string, text: string, extra: Partial<OpencodeMessage> = {}): OpencodeMessage => ({
  id: "m", role, created: 1_792_000_000_000, completed: role === "assistant" ? 1_792_000_001_000 : null, finish: role === "assistant" ? "stop" : null, error: null, text, ...extra,
});

describe("findOpencodeReply", () => {
  test("the text that closes the turn, the prompt, and the completion time", () => {
    const r = findOpencodeReply([msg("user", "fix it"), msg("assistant", "Looking.", { finish: "tool-calls" }), msg("assistant", "Fixed.")], 1000);
    expect(r).toEqual({ text: "Fixed.", at: new Date(1_792_000_001_000).toISOString(), in_reply_to: "fix it", truncated: false, in_progress: null });
  });
  test("a step that called tools leaves the turn running; Esc marks it interrupted", () => {
    const base = [msg("user", "first"), msg("assistant", "one"), msg("user", "second")];
    expect(findOpencodeReply([...base, msg("assistant", "Working.", { finish: "tool-calls", completed: null })], 1000)).toMatchObject({
      text: "one", in_progress: { prompt: "second", latest_text: "Working.", interrupted: false },
    });
    expect(findOpencodeReply([...base, msg("assistant", "", { finish: null, error: { name: "MessageAbortedError", message: "Aborted" } })], 1000)!.in_progress)
      .toMatchObject({ prompt: "second", interrupted: true });
  });
  test("a refused permission or a failed model call ends the turn", () => {
    expect(findOpencodeReply([msg("user", "run ls"), msg("assistant", "", { finish: "tool-calls", rejected: "The user rejected permission to use this specific tool call." })], 1000))
      .toMatchObject({ text: "", in_reply_to: "run ls", in_progress: null, ended: "error: The user rejected permission to use this specific tool call." });
    expect(findOpencodeReply([msg("user", "go"), msg("assistant", "", { finish: null, error: { name: "APIError", message: "needs more credits" } })], 1000))
      .toMatchObject({ ended: "error: needs more credits", in_progress: null });
  });
});

describe("opencode database", () => {
  test("the newest top-level session for the cwd, read from a WAL database without writing to it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "herdr-oc-"));
    const f = opencodeDb(dir);
    const old = f.session("/app", 1000);
    f.message(old, 1, { role: "user" }, [said("old prompt")]);
    const s = f.session("/app", 2000);
    f.session("/app", 3000, s); // a subagent's session: newer, but not the pane's
    f.session("/elsewhere", 4000);
    const u = f.message(s, 10, { role: "user" }, [said("Reply with OK"), { ...said("file contents"), synthetic: true }]);
    f.message(s, 11, { role: "assistant", parentID: u, finish: "tool-calls", time: { created: 11, completed: 12 } }, [
      { type: "tool", tool: "bash", state: { status: "error", error: "exit 1" } },
    ]);
    f.message(s, 13, { role: "assistant", parentID: u, finish: "stop", time: { created: 13, completed: 14 } }, [{ type: "reasoning", text: "think" }, said("OK")]);
    const read = readOpencode(f.path, { agent: "opencode", cwd: "/app" })!;
    expect(read.session).toBe(s);
    expect(read.messages.map((m) => m.text)).toEqual(["Reply with OK", "", "OK"]);
    const cfg = { ...none, opencodeDb: f.path };
    expect(await agentReply(cfg, { agent: "opencode", cwd: "/app" }, { freshFor: "Reply with OK" })).toMatchObject({
      text: "OK", in_reply_to: "Reply with OK", matches_prompt: true, ref: { kind: "opencode_sqlite", path: f.path, session: s },
    });
    // A refused permission is found among the tool parts.
    const r = f.message(s, 20, { role: "user" }, [said("run ls")]);
    f.message(s, 21, { role: "assistant", parentID: r, finish: "tool-calls", time: { created: 21, completed: 22 } }, [
      { type: "tool", tool: "bash", state: { status: "error", error: "The user rejected permission to use this specific tool call." } },
    ]);
    expect(await agentReply(cfg, { agent: "opencode", cwd: "/app" })).toMatchObject({ in_reply_to: "run ls", ended: expect.stringContaining("rejected permission") });
    expect(await agentReply(cfg, { agent: "opencode", cwd: "/nowhere" })).toBeNull();
    f.db.close();
  });
});

// ---------- pi ----------

const piUser = (text: string) => ({ type: "message", timestamp: "2026-10-15T10:00:00Z", message: { role: "user", content: [{ type: "text", text }] } });
const piSay = (stopReason: string, blocks: any[], ts = "2026-10-15T10:00:05Z", extra = {}) => ({
  type: "message", timestamp: ts, message: { role: "assistant", stopReason, content: blocks, ...extra },
});
const piText = (text: string) => ({ type: "text", text });

describe("findPiReply", () => {
  test("the stop message answers the turn; tool steps and tool results do not", () => {
    const entries = [
      { type: "session", cwd: "/app" }, { type: "model_change" }, piUser("which drink?"),
      piSay("toolUse", [{ type: "thinking", thinking: "…" }, { type: "toolCall", name: "bash" }]),
      { type: "message", message: { role: "toolResult", content: [piText("ok")] } },
      { type: "custom_message", content: "extension note" },
      piSay("stop", [{ type: "thinking", thinking: "…" }, piText("DRINK=coffee")], "2026-10-15T10:00:09Z"),
    ];
    expect(findPiReply(entries, 1000)).toEqual({ text: "DRINK=coffee", at: "2026-10-15T10:00:09Z", in_reply_to: "which drink?", truncated: false, in_progress: null });
  });
  test("a running turn, an aborted one and a failed one", () => {
    const done = [piUser("first"), piSay("stop", [piText("one")])];
    expect(findPiReply([...done, piUser("second"), piSay("toolUse", [piText("Checking.")], "2026-10-15T11:00:00Z")], 1000)).toMatchObject({
      text: "one", in_progress: { prompt: "second", latest_text: "Checking.", at: "2026-10-15T11:00:00Z", interrupted: false },
    });
    expect(findPiReply([...done, piUser("second"), piSay("aborted", [], undefined, { errorMessage: "Operation aborted" })], 1000)!.in_progress)
      .toMatchObject({ prompt: "second", interrupted: true });
    expect(findPiReply([...done, piUser("second"), piSay("error", [], undefined, { errorMessage: "404 not found" })], 1000))
      .toMatchObject({ text: "", in_reply_to: "second", in_progress: null, ended: "error: 404 not found" });
  });
});

describe("pi sessions", () => {
  test("the slug pi derives from a cwd", () => {
    expect(piSlug("/Users/me/src/relay/.worktrees/x")).toBe("--Users-me-src-relay-.worktrees-x--");
    expect(piSlug("/private/tmp/claude-501/-Users-me/lab")).toBe("--private-tmp-claude-501--Users-me-lab--");
  });
  test("Herdr's session path when it lies under a pi root, else the newest file in the cwd's folder", async () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-pi-"));
    const dir = join(root, piSlug("/app"));
    mkdirSync(join(dir, "subagents"), { recursive: true });
    const first = join(dir, "2026-10-15T10-00-00-000Z_aaa111.jsonl");
    const second = join(dir, "2026-10-15T11-00-00-000Z_bbb222.jsonl");
    writeFileSync(first, lines([{ type: "session", cwd: "/app" }, piUser("hi"), piSay("stop", [piText("hello")])]));
    writeFileSync(second, lines([{ type: "session", cwd: "/app" }, piUser("again"), piSay("stop", [piText("hello again")])]));
    utimesSync(first, 1000, 1000);
    utimesSync(second, 2000, 2000);
    expect(findPiSession([root], { agent: "pi", cwd: "/app" })).toBe(second);
    expect(findPiSession([root], { agent: "pi", cwd: "/app", agent_session: { kind: "path", value: first } })).toBe(first);
    // A path outside the roots is not followed.
    const outside = join(mkdtempSync(join(tmpdir(), "herdr-pi-out-")), "x.jsonl");
    writeFileSync(outside, lines([piUser("secret"), piSay("stop", [piText("nope")])]));
    expect(findPiSession([root], { agent: "pi", cwd: "/app", agent_session: { kind: "path", value: outside } })).toBe(second);
    expect(findPiSession([root], { agent: "pi", cwd: "/app", agent_session: { kind: "path", value: join(root, "..", "x.jsonl") } })).toBe(second);
    const cfg = { ...none, piSessionRoots: [root] };
    expect(await agentReply(cfg, { agent: "pi", cwd: "/app", agent_session: { kind: "path", value: first } })).toMatchObject({
      text: "hello", in_reply_to: "hi", ref: { kind: "pi_jsonl", path: first, session: "aaa111" },
    });
    expect(await agentReply(cfg, { agent: "pi", cwd: "/nowhere" })).toBeNull();
  });
});

describe("ref for Claude and Cursor", () => {
  test("names the transcript file and the session", async () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-ref-"));
    const id = "15c598c3-7545-4add-a8cc-4fd01efe6590";
    mkdirSync(join(root, "-app"), { recursive: true });
    const file = join(root, "-app", `${id}.jsonl`);
    writeFileSync(file, lines([
      { type: "user", message: { role: "user", content: "hi" } },
      { type: "assistant", message: { id: "m", role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "hello" }] } },
    ]));
    const agent = { agent: "claude", cwd: "/app", agent_session: { kind: "id", value: id } };
    expect((await agentReply({ ...none, transcriptRoots: [root] }, agent))!.ref).toEqual({ kind: "claude_jsonl", path: file, session: id });
  });
});
