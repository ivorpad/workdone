import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { timing } from "../gateway/answer-ops.ts";
import { loadConfig } from "../gateway/config.ts";
import { Gateway } from "../gateway/gateway.ts";
import { resultLine } from "../gateway/watcher.ts";

const SESSION = "5bada10f-7201-4b25-8616-ec95d6a71501";
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

// A Cursor agent in a real git repo under the allowed root, with a transcript the
// watcher reads its final answer from.
function setup() {
  timing.key = timing.text = timing.settle = 0;
  const root = realpathSync(mkdtempSync(join(tmpdir(), "workdone-result-")));
  dirs.push(root);
  const repo = join(root, "repo");
  const state = join(root, "state");
  mkdirSync(repo, { recursive: true });
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  writeFileSync(join(repo, "a.txt"), "one\n");
  git("add", "a.txt");
  git("commit", "-q", "-m", "first");
  const agent: any = { pane_id: "w1:p1", name: "fixer", agent: "cursor", agent_status: "idle", cwd: repo, agent_session: { kind: "id", value: SESSION }, state_change_seq: 1 };
  const sent: Array<[string, any]> = [];
  const herdr = async (method: string, params: any) => {
    sent.push([method, params]);
    if (method === "agent.list") return { agents: agent.gone ? [] : [agent] };
    if (method === "agent.get") return { agent };
    if (method === "agent.read" || method === "pane.read") return { read: { text: "" } };
    if (method === "agent.prompt") {
      agent.agent_status = params.wait ? "idle" : "working";
      agent.state_change_seq++;
      return { agent: { ...agent } };
    }
    return {};
  };
  const gw = new Gateway(loadConfig({ allowedRoots: [root], stateDir: state, cursorTranscriptRoots: [state], agentKinds: ["cursor"] }), herdr);
  const transcript = (answer: string) => {
    const dir = join(state, repo.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, ""), "agent-transcripts", SESSION);
    mkdirSync(dir, { recursive: true });
    const lines = [
      { role: "user", message: { content: [{ type: "text", text: "<user_query>\nfix it\n</user_query>" }] } },
      { role: "assistant", message: { content: [{ type: "text", text: answer }] } },
      { type: "turn_ended", status: "success" },
    ];
    writeFileSync(join(dir, `${SESSION}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n"));
  };
  // The agent's turn ends: a new answer and a settled status the watcher hasn't seen.
  const finish = (answer: string) => {
    transcript(answer);
    agent.agent_status = "done";
    agent.state_change_seq++;
  };
  const watched = () => JSON.parse(readFileSync(join(state, "watch.json"), "utf8"));
  const poll = async () => ((await gw.handle("watch_poll", {})) as any).reports ?? [];
  return { gw, agent, repo, git, state, sent, finish, watched, poll };
}

describe("reply: true", () => {
  test("is opt-in: without it nothing is owed and reports carry no result", async () => {
    const t = setup();
    await t.gw.handle("watch_agent", { target: "w1:p1" });
    const res: any = await t.gw.handle("prompt_agent", { target: "w1:p1", text: "fix it" });
    expect(res.result_request).toBeUndefined();
    expect(t.watched()["w1:p1"].result_request).toBeUndefined();
    t.finish("Fixed.\nRESULT: fixed");
    const reports = await t.poll();
    expect(reports.map((r: any) => r.type)).toEqual(["finished"]);
    expect(reports[0].result).toBeUndefined();
  });

  test("the next finished turn carries a structured result once, with git evidence and the RESULT: line", async () => {
    const t = setup();
    await t.gw.handle("watch_agent", { target: "w1:p1" });
    const res: any = await t.gw.handle("prompt_agent", { target: "w1:p1", text: "fix it", reply: true, lease: "L-abc123" });
    expect(res.result_request.result_id).toMatch(/^res_[a-f0-9]{16}$/);
    expect(t.watched()["w1:p1"]).toMatchObject({ result_request: { id: res.result_request.result_id, lease: "L-abc123" }, reply_to: "L-abc123" });
    writeFileSync(join(t.repo, "a.txt"), "two\n");
    t.git("commit", "-qam", "second");
    t.finish("Changed a.txt and committed.\n\n**RESULT:** retry fix landed in a.txt");
    const [r] = await t.poll();
    expect(r.type).toBe("finished");
    expect(r.result).toMatchObject({
      result_id: res.result_request.result_id, status: "finished", summary: "retry fix landed in a.txt",
      commit: t.git("rev-parse", "HEAD"), tree: t.git("rev-parse", "HEAD^{tree}"), clean: true, changed: 0, branch: "main", kind: "cursor",
    });
    expect(t.watched()["w1:p1"].result_request).toBeUndefined();
    // The next turn is nobody's result.
    t.finish("Another answer.\nRESULT: again");
    const next = await t.poll();
    expect(next.map((x: any) => x.type)).toEqual(["finished"]);
    expect(next[0].result).toBeUndefined();
  });

  test("a question leaves the result owed; the finish after it resolves it", async () => {
    const t = setup();
    await t.gw.handle("watch_agent", { target: "w1:p1" });
    const { result_request } = (await t.gw.handle("prompt_agent", { target: "w1:p1", text: "fix it", reply: true })) as any;
    t.finish("Which branch should I use?");
    const asked = await t.poll();
    expect(asked.map((x: any) => [x.type, x.result])).toEqual([["question", undefined]]);
    expect(t.watched()["w1:p1"].result_request.id).toBe(result_request.result_id);
    t.finish("Used main.\nRESULT: done on main");
    const [r] = await t.poll();
    expect(r.result).toMatchObject({ result_id: result_request.result_id, summary: "done on main" });
  });

  test("an agent that exits with a result owed reports it as gone", async () => {
    const t = setup();
    await t.gw.handle("watch_agent", { target: "w1:p1" });
    const { result_request } = (await t.gw.handle("prompt_agent", { target: "w1:p1", text: "fix it", reply: true })) as any;
    t.agent.gone = true;
    const [r] = await t.poll();
    expect(r.type).toBe("gone");
    expect(r.result).toMatchObject({ result_id: result_request.result_id, status: "gone", summary: null });
  });

  test("asking again while one is pending returns the same request, so one wake", async () => {
    const t = setup();
    await t.gw.handle("watch_agent", { target: "w1:p1" });
    const first: any = await t.gw.handle("prompt_agent", { target: "w1:p1", text: "fix it", reply: true });
    t.agent.agent_status = "idle";
    const second: any = await t.gw.handle("prompt_agent", { target: "w1:p1", text: "and this", reply: true });
    expect(second.result_request).toMatchObject({ result_id: first.result_request.result_id, already_pending: true });
    t.finish("Both done.\nRESULT: both");
    expect((await t.poll()).filter((x: any) => x.result)).toHaveLength(1);
  });

  test("an answer returned inside the call is the result: nothing stays owed", async () => {
    const t = setup();
    await t.gw.handle("watch_agent", { target: "w1:p1" });
    const res: any = await t.gw.handle("prompt_agent", { target: "w1:p1", text: "fix it", reply: true, wait: true });
    expect(res.result_request).toEqual({ result_id: expect.stringMatching(/^res_/), delivered: "inline" });
    expect(t.watched()["w1:p1"].result_request).toBeUndefined();
  });

  test("reply must be a boolean", async () => {
    const t = setup();
    await expect(t.gw.handle("prompt_agent", { target: "w1:p1", text: "x", reply: "yes" })).rejects.toThrow("reply must be true or false");
  });

  test("finished turns of a managed agent become supervisor turn records with checkpoint evidence", async () => {
    const t = setup();
    await t.gw.handle("watch_agent", { target: "w1:p1" });
    const sup = () => JSON.parse(readFileSync(join(t.state, "supervisor.json"), "utf8"))["w1:p1"];
    expect(sup().baseline.commit).toBe(t.git("rev-parse", "HEAD"));
    t.finish("Looked around.");
    await t.poll();
    writeFileSync(join(t.repo, "a.txt"), "edited\n");
    t.finish("Edited a.txt.");
    await t.poll();
    const turns = sup().turns;
    expect(turns).toHaveLength(2);
    expect(turns[0]).toMatchObject({ session: SESSION, status: "finished", commit: t.git("rev-parse", "HEAD"), clean: true });
    expect(turns[1]).toMatchObject({ clean: false, changed: 1 });
    expect(turns[1].diff).not.toBe(turns[0].diff);
    expect(turns[1].activity).not.toBe(turns[0].activity);
  });
});

test("resultLine takes the last RESULT: line, plain or bold, and nothing else", () => {
  expect(resultLine("a\nRESULT: first\nb\n- **RESULT:** second **")).toBe("second");
  expect(resultLine("no result here")).toBeNull();
  expect(resultLine("the RESULT: is inline, not a line")).toBeNull();
  expect(resultLine(null)).toBeNull();
});
