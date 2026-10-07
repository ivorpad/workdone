import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../gateway/config.ts";
import { chunkText, openclawOps, parseOpenclaw, parseReply } from "../gateway/openclaw.ts";
import { TOOLS } from "../mcp/src/tools.ts";

const dir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
const log = join(dir, "calls.log");
// A stand-in for the openclaw CLI: logs its argv, answers `agent` with JSON.
const bin = join(dir, "openclaw"); // env markers do not reach it (childEnv is filtered): files in dir do
writeFileSync(bin, `#!/bin/sh
echo "$@" >> ${log}
case "$1" in
  message) [ -e ${dir}/fail-post ] && { echo boom >&2; exit 1; }; echo '{"ok":true}';;
  agent) [ -e ${dir}/slow ] && sleep 2; echo 'log line'; echo '{"runId":"r1","status":"ok","result":{"payloads":[{"text":"Meeting at 10"}]}}';;
esac
`);
chmodSync(bin, 0o755);

const oc = { command: [bin], agent: "lead", channel: "discord", target: "channel:123", sessionKey: "agent:lead:discord:channel:123" };
const ops = (extra: Record<string, unknown> = {}, sub = "state") => openclawOps(loadConfig({ allowedRoots: [dir], stateDir: join(dir, sub), openclaw: oc, ...extra }));
const calls = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []);
afterAll(() => void 0);

describe("chunking", () => {
  test("short text is one message with no prefix", () => expect(chunkText("hi")).toEqual(["hi"]));
  test("long text is split on lines under 1900 with (i/n) prefixes", () => {
    const text = Array.from({ length: 400 }, (_, i) => `line ${i}`).join("\n");
    const parts = chunkText(text);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((p) => p.length <= 1900)).toBe(true);
    expect(parts[0]!.startsWith(`(1/${parts.length}) `)).toBe(true);
    expect(parts.map((p) => p.replace(/^\(\d+\/\d+\) /, "")).join("").replace(/\n/g, "")).toBe(text.replace(/\n/g, ""));
  });
  test("a single line longer than a message is cut", () => {
    const parts = chunkText("x".repeat(5000));
    expect(parts.every((p) => p.length <= 1900)).toBe(true);
    expect(parts.join("").replace(/\(\d+\/\d+\) /g, "").length).toBe(5000);
  });
});

describe("reply parsing", () => {
  test("payload text, after log lines", () => expect(parseReply('warn\n{"runId":"a","status":"ok","result":{"payloads":[{"text":"x"},{"text":"y"}]}}')).toEqual({ reply: "x\n\ny", run_id: "a", status: "ok" }));
  test("falls back to the final visible text", () => expect(parseReply('{"status":"ok","result":{"payloads":[],"meta":{"finalAssistantVisibleText":"z"}}}').reply).toBe("z"));
  test("garbage is no reply", () => expect(parseReply("nope").reply).toBeNull());
});

describe("config", () => {
  test("needs a target and a sane session key", () => {
    expect(() => parseOpenclaw({})).toThrow(/target/);
    expect(() => parseOpenclaw({ target: "channel:1", sessionKey: "x" })).toThrow(/sessionKey/);
    expect(parseOpenclaw(undefined)).toBeNull();
  });
});

describe("ask_openclaw", () => {
  test("posts the question visibly, runs the agent once with delivery, returns the reply", async () => {
    const res: any = await ops().ask_openclaw!({ text: "what is on my calendar today?" });
    expect(res).toMatchObject({ state: "done", reply: "Meeting at 10", posts: 1, run_id: "r1" });
    const [post, agent] = calls().slice(-2);
    expect(post).toContain("message send --channel discord --target channel:123 -m what is on my calendar today?");
    expect(agent).toContain("agent --agent lead --session-key agent:lead:discord:channel:123 --json");
    expect(agent).toContain("--channel discord --reply-to channel:123 --deliver");
  });
  test("a long question is posted in pieces and the agent gets it whole", async () => {
    const before = calls().length;
    const text = Array.from({ length: 300 }, (_, i) => `row ${i}`).join("\n");
    const res: any = await ops().ask_openclaw!({ text });
    expect(res.posts).toBeGreaterThan(1);
    const made = calls().slice(before);
    expect(made.filter((c) => c.startsWith("message send")).length).toBe(res.posts);
    expect(made.at(-1)).toContain(`row 299`);
    expect(made.at(-1)).not.toContain("(1/");
  });
  test("visible: false posts nothing and does not deliver", async () => {
    const before = calls().length;
    await ops().ask_openclaw!({ text: "quiet", visible: false });
    const made = calls().slice(before);
    expect(made).toHaveLength(1);
    expect(made[0]).not.toContain("--deliver");
  });
  test("a failed post stops before the agent runs", async () => {
    writeFileSync(join(dir, "fail-post"), "");
    const before = calls().length;
    const res: any = await ops().ask_openclaw!({ text: "x" });
    rmSync(join(dir, "fail-post"));
    expect(res.state).toBe("failed");
    expect(res.error).toContain("post_failed");
    expect(calls().slice(before).some((c) => c.startsWith("agent"))).toBe(false);
  });
  test("the same command_id is one run, other text under it is refused", async () => {
    const o = ops({}, "state-replay");
    const first: any = await o.ask_openclaw!({ text: "once", command_id: "c1" });
    const before = calls().length;
    const again: any = await o.ask_openclaw!({ text: "once", command_id: "c1" });
    expect(again).toMatchObject({ id: first.id, replayed: true });
    expect(calls().length).toBe(before);
    await expect(o.ask_openclaw!({ text: "other text", command_id: "c1" })).rejects.toMatchObject({ code: "command_conflict" });
  });
  test("a slow agent returns running, then openclaw_status has the reply; a third ask is refused while two run", async () => {
    writeFileSync(join(dir, "slow"), "");
    const o = ops({}, "state-slow");
    const a: any = await o.ask_openclaw!({ text: "a", wait_ms: 0 });
    const b: any = await o.ask_openclaw!({ text: "b", wait_ms: 0 });
    expect(a.state).toBe("running");
    await expect(o.ask_openclaw!({ text: "c", wait_ms: 0 })).rejects.toMatchObject({ code: "openclaw_busy" });
    await Bun.sleep(3500);
    rmSync(join(dir, "slow"), { force: true });
    expect(await o.openclaw_status!({ id: a.id })).toMatchObject({ state: "done", reply: "Meeting at 10" });
    expect(((await o.openclaw_status!({})) as any).asks.map((x: any) => x.id)).toContain(b.id);
  });
  test("the result outlives the process that asked: a fresh gateway reads it", async () => {
    writeFileSync(join(dir, "slow"), "");
    const a: any = await ops({}, "state-outlive").ask_openclaw!({ text: "a", wait_ms: 0 });
    expect(a.state).toBe("running");
    await Bun.sleep(3500);
    rmSync(join(dir, "slow"), { force: true });
    expect(await ops({}, "state-outlive").openclaw_status!({ id: a.id })).toMatchObject({ state: "done", reply: "Meeting at 10", posts: 1 });
  });
  test("a running record whose runner is gone reads as failed", async () => {
    const st = join(dir, "state-dead");
    mkdirSync(join(st, "openclaw"), { recursive: true });
    const id = "20261007-010101-abcd";
    writeFileSync(join(st, "openclaw", `${id}.json`), JSON.stringify({ id, command_id: null, started: "2026-10-07T01:01:01Z", text_chars: 1, visible: true, posts: 0, state: "running", reply: null, error: null, run_id: null, duration_ms: null, pid: 99999999 }));
    expect(await ops({}, "state-dead").openclaw_status!({ id })).toMatchObject({ state: "failed" });
  });
  test("without the config the capability is off", async () => {
    const off = openclawOps(loadConfig({ allowedRoots: [dir], stateDir: join(dir, "x") }));
    await expect(off.ask_openclaw!({ text: "hi" })).rejects.toMatchObject({ code: "capability_disabled" });
  });
  test("over maxPromptChars is refused", async () => {
    await expect(ops({ maxPromptChars: 10 }).ask_openclaw!({ text: "x".repeat(11) })).rejects.toMatchObject({ code: "invalid_params" });
  });
});

test("the MCP tools exist and ask_openclaw is not read-only", () => {
  expect(TOOLS.ask_openclaw!.annotations.readOnlyHint).toBe(false);
  expect(TOOLS.openclaw_status!.annotations.readOnlyHint).toBe(true);
});
