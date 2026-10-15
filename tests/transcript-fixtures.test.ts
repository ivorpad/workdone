// The recorded shapes of each agent's transcript store, end to end through agentReply.
// tests/fixtures/transcripts holds one file per store with the fields the 2026-10-15
// lab saw (herdr-tui-control.md sections 2 and 4), with invented content: a Codex
// rollout with its injected context, a question and an interrupted turn, plus a
// `codex exec` thread for the same cwd; opencode's tables as `.schema` prints them,
// with a question part and a rejected permission; a pi session with a prose question.
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentReply, codexRollouts, piSlug } from "../gateway/transcript.ts";

const fixtures = join(import.meta.dir, "fixtures/transcripts");
const none = { transcriptRoots: [], cursorTranscriptRoots: [], codexSessionRoots: [], opencodeDb: null, piSessionRoots: [] };
const CWD = "/srv/allowed/app";

describe("Codex rollouts on disk", () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-fx-codex-"));
  const place = (day: string, name: string, fixture: string, mtime: number) => {
    mkdirSync(join(root, day), { recursive: true });
    const path = join(root, day, name);
    copyFileSync(join(fixtures, fixture), path);
    utimesSync(path, mtime, mtime);
    return path;
  };
  const current = place("2026/10/15", "rollout-2026-10-15T17-08-03-01a14100-0000-7000-8000-000000000001.jsonl", "codex-rollout.jsonl", 3000);
  const old = place("2026/10/14", "rollout-2026-10-14T11-00-00-01a14000-0000-7000-8000-000000000000.jsonl", "codex-rollout-old.jsonl", 1000);
  place("2026/10/15", "rollout-2026-10-15T18-00-00-01a14200-0000-7000-8000-000000000002.jsonl", "codex-exec.jsonl", 4000);

  test("the pane's rollouts are the TUI threads for its cwd, newest first; codex exec is not one", () => {
    expect(codexRollouts([root], CWD)).toEqual([
      { path: current, id: "01a14100-0000-7000-8000-000000000001" },
      { path: old, id: "01a14000-0000-7000-8000-000000000000" },
    ]);
  });
  test("the answered question turn, the turn in progress, and what Codex injected left out", async () => {
    const reply = await agentReply({ ...none, codexSessionRoots: [root] }, { agent: "codex", cwd: CWD, foreground_cwd: CWD });
    expect(reply).toMatchObject({
      text: "ANIMAL=dog",
      at: "2026-10-15T15:10:27.500Z",
      in_reply_to: "Use request_user_input to ask which animal I prefer, cat, dog or bird. Then reply ANIMAL=<answer>.",
      in_progress: { prompt: "Run the tests and tell me how many pass.", latest_text: "I'll run bun test now.", interrupted: false },
      ref: { kind: "codex_rollout", path: current, session: "01a14100-0000-7000-8000-000000000001" },
    });
    // Neither the AGENTS.md block nor the answer Codex echoes as a user item is a prompt.
    expect(reply!.in_reply_to).not.toContain("AGENTS.md");
    expect(reply!.text).not.toContain("question_reply");
  });
  test("the prompt just sent picks the older thread it belongs to", async () => {
    const reply = await agentReply({ ...none, codexSessionRoots: [root] }, { agent: "codex", cwd: CWD }, { freshFor: "Say OLD." });
    expect(reply).toMatchObject({ text: "OLD", matches_prompt: true, ref: { path: old } });
  });
});

describe("opencode database on disk", () => {
  const dir = mkdtempSync(join(tmpdir(), "herdr-fx-oc-"));
  const path = join(dir, "opencode.db");
  const db = new Database(path);
  db.run("PRAGMA journal_mode = WAL");
  db.run(readFileSync(join(fixtures, "opencode.sql"), "utf8"));
  db.close();
  const cfg = { ...none, opencodeDb: path };

  test("the pane's session is the newest top-level one for its cwd, not its subagent's", async () => {
    const reply = await agentReply(cfg, { agent: "opencode", cwd: CWD, foreground_cwd: CWD });
    expect(reply!.ref).toEqual({ kind: "opencode_sqlite", path, session: "ses_pane" });
    expect(reply!.text).not.toBe("SUBAGENT ANSWER");
  });
  test("a bash call the owner rejected on the permission prompt ends that turn", async () => {
    const reply = await agentReply(cfg, { agent: "opencode", cwd: CWD });
    expect(reply).toMatchObject({ in_reply_to: "Run exactly this shell command: ls -la | head -3", in_progress: null, ended: expect.stringContaining("rejected permission") });
  });
  test("a session Herdr names by id wins over the cwd", async () => {
    const reply = await agentReply(cfg, { agent: "opencode", cwd: CWD, agent_session: { kind: "id", value: "ses_old" } });
    expect(reply).toMatchObject({ text: "OLD", in_reply_to: "Say OLD.", at: "2026-10-14T17:46:41.000Z", ref: { session: "ses_old" } });
  });
  test("the question tool's turn: the answer that followed the owner's pick", async () => {
    // Up to the end of turn 1: drop the rejected turn's rows.
    const trimmed = join(dir, "turn1.db");
    const t = new Database(trimmed);
    t.run(readFileSync(join(fixtures, "opencode.sql"), "utf8"));
    t.run("DELETE FROM part WHERE message_id IN ('msg_u2', 'msg_a3'); DELETE FROM message WHERE id IN ('msg_u2', 'msg_a3')");
    t.close();
    const reply = await agentReply({ ...none, opencodeDb: trimmed }, { agent: "opencode", cwd: CWD });
    expect(reply).toMatchObject({ text: "FRUIT=Pear", in_reply_to: expect.stringContaining("which fruit"), at: "2026-10-15T15:41:10.000Z", in_progress: null });
  });
});

describe("pi sessions on disk", () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-fx-pi-"));
  const dir = join(root, piSlug(CWD));
  mkdirSync(dir, { recursive: true });
  const entries = readFileSync(join(fixtures, "pi-session.jsonl"), "utf8").split("\n").filter(Boolean);
  const file = join(dir, "2026-10-15T15-11-21-741Z_01a14300-0000-7000-8000-000000000003.jsonl");
  writeFileSync(file, entries.join("\n") + "\n");
  const cfg = { ...none, piSessionRoots: [root] };

  test("the slug is the cwd with its separators turned into dashes, wrapped in --", () => {
    expect(dir).toBe(join(root, "--srv-allowed-app--"));
  });
  test("the last answer, to the owner's reply to a question asked in prose", async () => {
    expect(await agentReply(cfg, { agent: "pi", cwd: CWD, foreground_cwd: CWD })).toMatchObject({
      text: "DRINK=coffee", in_reply_to: "2", at: "2026-10-15T15:14:47.261Z", in_progress: null,
      ref: { kind: "pi_jsonl", path: file, session: "01a14300-0000-7000-8000-000000000003" },
    });
  });
  test("while the question stands, it is the answer: pi has no question tool, so status stays done", async () => {
    // The file as it was before the owner replied "2".
    writeFileSync(file, entries.slice(0, 7).join("\n") + "\n");
    const reply = await agentReply(cfg, { agent: "pi", cwd: CWD });
    expect(reply).toMatchObject({ in_reply_to: expect.stringContaining("which drink"), in_progress: null });
    expect(reply!.text).toEndWith("Reply with your choice.");
    expect(reply!.text).not.toContain("No question tool here");
  });
});
