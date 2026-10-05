// A Cursor agent in a real git repo under the allowed root, with a transcript the
// watcher reads its final answer from. Shared by the result and supervisor tests.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { timing } from "../gateway/answer-ops.ts";
import { GatewayError, loadConfig } from "../gateway/config.ts";
import { Gateway } from "../gateway/gateway.ts";

export const SESSION = "5bada10f-7201-4b25-8616-ec95d6a71501";

export function gitAgent(extra: Record<string, unknown> = {}) {
  timing.key = timing.text = timing.settle = 0;
  const root = realpathSync(mkdtempSync(join(tmpdir(), "workdone-result-")));
  const repo = join(root, "repo");
  const state = join(root, "state");
  mkdirSync(repo, { recursive: true });
  // Without GIT_DIR and friends from a calling hook, so git -C really means this repo.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", env }).trim();
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
      if (agent.failPrompt) throw new GatewayError("herdr_error", "prompt refused");
      agent.agent_status = params.wait ? "idle" : "working";
      agent.state_change_seq++;
      return { agent: { ...agent } };
    }
    return {};
  };
  const gw = new Gateway(loadConfig({ allowedRoots: [root], stateDir: state, cursorTranscriptRoots: [state], agentKinds: ["cursor"], ...extra }), herdr);
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
  return { gw, root, agent, repo, git, state, sent, finish, watched, poll };
}

