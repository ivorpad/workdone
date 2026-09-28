import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  agentReply, claudeSessionId, cursorSessionId, findCursorReply, findCursorTranscript, findReply, findTranscript, lastCursorReply, lastReply, samePrompt,
} from "../gateway/transcript.ts";

const prompt = (text: string) => ({ type: "user", message: { role: "user", content: text } });
const toolResult = () => ({ type: "user", message: { role: "user", content: [{ type: "tool_result", content: "ok" }] } });
const say = (id: string, stop: string, blocks: any[], ts = "2026-09-25T10:00:00Z") => ({
  type: "assistant", timestamp: ts, message: { id, role: "assistant", stop_reason: stop, content: blocks },
});
const text = (t: string) => ({ type: "text", text: t });

describe("findReply", () => {
  test("returns the final message of the last complete turn", () => {
    const entries = [
      prompt("fix the build"),
      say("m1", "tool_use", [text("Looking.")]),
      say("m1", "tool_use", [{ type: "tool_use", name: "Bash" }]),
      toolResult(),
      say("m2", "end_turn", [{ type: "thinking", thinking: "..." }]),
      say("m2", "end_turn", [text("Fixed: the import was wrong.")], "2026-09-25T10:05:00Z"),
      { type: "ai-title" },
    ];
    expect(findReply(entries, 1000)).toEqual({
      text: "Fixed: the import was wrong.",
      at: "2026-09-25T10:05:00Z",
      in_reply_to: "fix the build",
      truncated: false,
      in_progress: null,
    });
  });
  test("reports a newer prompt that is still running", () => {
    const entries = [
      prompt("first"),
      say("m1", "end_turn", [text("done one")]),
      prompt("second task"),
      say("m2", "tool_use", [text("Starting on it.")], "2026-09-25T11:00:00Z"),
      toolResult(),
    ];
    const r = findReply(entries, 1000)!;
    expect(r.text).toBe("done one");
    expect(r.in_progress).toEqual({ prompt: "second task", latest_text: "Starting on it.", at: "2026-09-25T11:00:00Z", interrupted: false });
  });
  test("an Esc marks the running prompt as interrupted instead of replacing it", () => {
    const entries = [
      prompt("first"),
      say("m1", "end_turn", [text("done one")]),
      prompt("\n\n<pasted_content>big paste</pasted_content>"),
      prompt("[Request interrupted by user]"),
      prompt("<local-command-stdout>ok</local-command-stdout>"),
    ];
    expect(findReply(entries, 1000)!.in_progress).toMatchObject({ prompt: "<pasted_content>big paste</pasted_content>", interrupted: true });
  });
  test("ignores sidechain entries and keeps the tail of a long answer", () => {
    const entries = [prompt("go"), say("m1", "end_turn", [text("x".repeat(50) + "END")]), { ...say("s", "end_turn", [text("sub")]), isSidechain: true }];
    const r = findReply(entries, 10)!;
    expect(r.text).toBe("…xxxxxxxEND");
    expect(r.truncated).toBe(true);
  });
  test("null when there is nothing yet", () => {
    expect(findReply([{ type: "summary" }], 100)).toBeNull();
  });
});

describe("files", () => {
  test("finds a transcript by session id and reads the last reply", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-tr-"));
    const id = "15c598c3-7545-4add-a8cc-4fd01efe6590";
    mkdirSync(join(root, "-Users-me-src-app"), { recursive: true });
    const file = join(root, "-Users-me-src-app", `${id}.jsonl`);
    writeFileSync(file, [prompt("hi"), say("m", "end_turn", [text("hello")])].map((e) => JSON.stringify(e)).join("\n") + "\n");
    expect(findTranscript([root], id, "/Users/me/src/app")).toBe(file);
    expect(findTranscript([root], id)).toBe(file);
    expect(lastReply(file, 100)?.text).toBe("hello");
  });
  test("session id comes only from a claude agent with a UUID", () => {
    const s = { kind: "id", value: "15c598c3-7545-4add-a8cc-4fd01efe6590" };
    expect(claudeSessionId({ agent: "claude", agent_session: s })).toBe(s.value);
    expect(claudeSessionId({ agent: "codex", agent_session: s })).toBeNull();
    expect(claudeSessionId({ agent: "claude", agent_session: { kind: "id", value: "../../etc/passwd" } })).toBeNull();
  });
  test("samePrompt compares a normalised prefix", () => {
    expect(samePrompt("Reply with  exactly:\nOK", "Reply with exactly: OK")).toBe(true);
    expect(samePrompt("something else", "Reply with exactly: OK")).toBe(false);
    expect(samePrompt("x", null)).toBe(false);
  });
});

// Cursor CLI transcript entries.
const ask = (q: string) => ({ role: "user", message: { content: [{ type: "text", text: `<timestamp>Monday, Sep 28, 2026, 6:05 AM (UTC+2)</timestamp>\n<user_query>\n${q}\n</user_query>` }] } });
const act = (t: string | null, tools = 0) => ({
  role: "assistant",
  message: { content: [...(t ? [text(t)] : []), ...Array.from({ length: tools }, () => ({ type: "tool_use", name: "Shell", input: {} }))] },
});
const ended = (status = "success", error?: string) => ({ type: "turn_ended", status, ...(error ? { error } : {}) });

describe("findCursorReply", () => {
  test("the text that closes the last turn, and the prompt it answers", () => {
    const entries = [ask("audit the repo"), act("I'll audit it.", 3), act(null, 2), act("The shortest path is the workflow."), ended()];
    expect(findCursorReply(entries, 1000)).toEqual({
      text: "The shortest path is the workflow.", at: null, in_reply_to: "audit the repo", truncated: false, in_progress: null,
    });
  });
  test("a newer prompt is the turn in progress", () => {
    const entries = [ask("first"), act("done one"), ended(), ask("second task"), act("Starting on it.", 1)];
    const r = findCursorReply(entries, 1000)!;
    expect(r.text).toBe("done one");
    expect(r.in_progress).toEqual({ prompt: "second task", latest_text: "Starting on it.", at: null, interrupted: false });
  });
  test("Cursor drops the last turn_ended when the next prompt arrives", () => {
    // What the file holds during a second turn, and once it ends.
    const running = [ask("first"), act("done one"), ask("second task"), act("Working.", 1)];
    expect(findCursorReply(running, 1000)).toMatchObject({ text: "done one", in_reply_to: "first", in_progress: { prompt: "second task", latest_text: "Working." } });
    const finished = [...running, act("done two"), ended()];
    expect(findCursorReply(finished, 1000)).toMatchObject({ text: "done two", in_reply_to: "second task", in_progress: null });
    expect(findCursorReply([ask("only")], 1000)).toMatchObject({ text: "", in_reply_to: null, in_progress: { prompt: "only", latest_text: null } });
  });
  test("a turn that ended badly says how", () => {
    expect(findCursorReply([ask("go"), act("Running the tests.", 1), ended("aborted")], 1000)).toMatchObject({ text: "Running the tests.", ended: "aborted" });
    expect(findCursorReply([ask("go"), ended("error", "User aborted request")], 1000)).toMatchObject({ text: "", ended: "error: User aborted request" });
  });
  test("user entries that are only a timestamp or a tool catalog are not prompts", () => {
    const stamp = { role: "user", message: { content: [text("<timestamp>Monday, Sep 28, 2026, 6:05 AM (UTC+2)</timestamp>")] } };
    const catalog = { role: "user", message: { content: [text("<available_subagent_types>…</available_subagent_types>")] } };
    const entries = [ask("first"), act("done one"), ended(), stamp, catalog, ask("second task"), act("Working.", 1)];
    expect(findCursorReply(entries, 1000)).toMatchObject({ text: "done one", in_reply_to: "first", in_progress: { prompt: "second task" } });
    const after = [ask("go"), catalog, act("Done."), ended()];
    expect(findCursorReply(after, 1000)).toMatchObject({ text: "Done.", in_reply_to: "go" });
  });
  test("an abort logged after a successful end does not make the turn an error", () => {
    const r = findCursorReply([ask("go"), act("Done."), ended(), ended("error", "User aborted request")], 1000)!;
    expect(r.text).toBe("Done.");
    expect(r.ended).toBeUndefined();
  });
  test("null before the first prompt", () => {
    expect(findCursorReply([], 100)).toBeNull();
    expect(findCursorReply([act("banner")], 100)).toBeNull();
  });
});

describe("cursor files", () => {
  const id = "e43d3c8e-3c1f-4eb9-a7fe-777ee1ea7902";
  const write = (root: string, slug: string, entries: any[]) => {
    const dir = join(root, slug, "agent-transcripts", id);
    mkdirSync(join(dir, "subagents"), { recursive: true });
    writeFileSync(join(dir, `${id}.jsonl`), entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
    return join(dir, `${id}.jsonl`);
  };
  test("finds the transcript by the folder slug, else by scanning", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-cur-"));
    const file = write(root, "Users-me-src-tries-2026-08-26-relay", [ask("hi"), act("hello"), ended()]);
    expect(findCursorTranscript([root], id, "/Users/me/src/tries/2026-08-26-relay")).toBe(file);
    expect(findCursorTranscript([root], id, "/elsewhere")).toBe(file);
    expect(findCursorTranscript([root], "00000000-0000-4000-8000-000000000000")).toBeNull();
  });
  test("a settled answer is dated by the file's last write", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-cur-"));
    const file = write(root, "Users-me-app", [ask("hi"), act("hello"), ended()]);
    expect(lastCursorReply(file, 100)).toMatchObject({ text: "hello", at: statSync(file).mtime.toISOString() });
  });
  test("agentReply reads a Cursor agent's transcript", async () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-cur-"));
    write(root, "Users-me-app", [ask("Reply with OK"), act("OK"), ended()]);
    const agent = { agent: "cursor", cwd: "/Users/me/app", agent_session: { kind: "id", value: id } };
    const reply = await agentReply({ transcriptRoots: [], cursorTranscriptRoots: [root] }, agent, { freshFor: "Reply with OK" });
    expect(reply).toMatchObject({ text: "OK", in_reply_to: "Reply with OK", matches_prompt: true });
  });
  test("session id comes only from a cursor agent with a UUID", () => {
    expect(cursorSessionId({ agent: "cursor", agent_session: { kind: "id", value: id } })).toBe(id);
    expect(cursorSessionId({ agent: "claude", agent_session: { kind: "id", value: id } })).toBeNull();
    expect(cursorSessionId({ agent: "cursor", agent_session: { kind: "id", value: "../x" } })).toBeNull();
  });
});
