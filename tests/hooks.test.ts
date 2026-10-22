import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { hookOutput, hookRequest } from "../gateway/hook-cli.ts";
import { HOOK_TIMING, INHERIT_MAX, normalizePrompt } from "../gateway/hooks.ts";
import { SESSION, gitAgent } from "./git-agent.ts";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const setup = () => {
  const t = gitAgent();
  dirs.push(t.root);
  const typed = () => t.sent.filter(([m]) => m === "agent.prompt" || m === "pane.send_input").map(([, p]) => String(p.text));
  const claim = async (label: string, take_over = false) => ((await t.gw.request("claim_agents", { label, targets: ["fixer"], ...(take_over ? { take_over } : {}) })) as any).lease as string;
  const hello = () => t.gw.handle("hook_hello", { pane_id: "w1:p1", session_id: SESSION, kind: "cursor" });
  const prompt = async (prompt_id: string, prompt: string) => ((await t.gw.handle("hook_prompt", { pane_id: "w1:p1", session_id: SESSION, prompt_id, prompt, kind: "cursor" })) as any).context as string | null;
  const stop = (prompt_id: string, text: string) => t.gw.handle("hook_stop", { pane_id: "w1:p1", session_id: SESSION, prompt_id, text });
  // The agent's UserPromptSubmit hook firing as the prompt is submitted, as Claude Code does.
  const contexts: Array<string | null> = [];
  const autoHook = (prompt_id: string, wrap = (x: string) => x) => { t.agent.onPrompt = async (text: string) => { contexts.push(await prompt(prompt_id, wrap(text))); }; };
  return { ...t, typed, claim, hello, prompt, stop, contexts, autoHook };
};
// How Claude Code 2.1.308 handed the probe's prompts to UserPromptSubmit (2026-10-22).
const pasted = (text: string) => `\n\n<pasted_content id="f63c">\n${text}\n</pasted_content id="f63c">\n`;

describe("Claude Code hooks", () => {
  test("without a hook's hello the footer stays, so agents without hooks still learn the sender", async () => {
    const t = setup();
    const lease = await t.claim("relay review");
    await t.gw.request("prompt_agent", { target: "w1:p1", text: "do it", lease });
    expect(t.typed()[0]).toContain("[Sent by the owner from their ChatGPT chat (lease …");
  });

  test("with one, the text goes in bare, the hook tells the agent who sent it, and the owner's own prompts get nothing", async () => {
    const t = setup();
    const lease = await t.claim("relay review");
    await t.hello();
    expect(await t.prompt("own-1", "what's the time?")).toBeNull();
    t.autoHook("p-1", pasted);
    const res: any = await t.gw.request("prompt_agent", { target: "w1:p1", text: "Line one of the probe.\n\nRun the checks", lease });
    expect(t.typed()).toEqual(["Line one of the probe.\n\nRun the checks"]);
    expect(res.sender_note).toBeUndefined();
    expect(existsSync(join(t.state, "hook-panes", "w1:p1"))).toBe(true);
    const context = t.contexts[0]!;
    expect(context).toContain(`"relay review" (lease …${lease.slice(-4)})`);
    expect(context).toContain("Your final answer goes back to that chat by itself");
    expect(context).not.toContain(lease);
    // Matched once: the same text typed again by the owner is not WorkDone's.
    expect(await t.prompt("own-2", pasted("Line one of the probe.\n\nRun the checks"))).toBeNull();
  });

  test("a hello from another kind of agent than the pane's leaves the footer on", async () => {
    const t = setup();
    const lease = await t.claim("relay review");
    await t.gw.handle("hook_hello", { pane_id: "w1:p1", session_id: SESSION, kind: "codex" });
    await t.gw.request("prompt_agent", { target: "w1:p1", text: "do it", lease });
    expect(t.typed()[0]).toContain("[Sent by the owner from their ChatGPT chat");
  });

  test("a hook that doesn't match brings the footer back: as a follow-up now, on the text from then on", async () => {
    const t = setup();
    HOOK_TIMING.confirmMs = 50;
    try {
      const lease = await t.claim("relay review");
      await t.hello();
      const res: any = await t.gw.request("prompt_agent", { target: "w1:p1", text: "count the files", lease });
      expect(res.sender_note).toBe("footer_followup");
      expect(t.typed()[0]).toBe("count the files");
      expect(t.typed()[1]).toContain("[Sent by the owner from their ChatGPT chat (lease …");
      t.agent.agent_status = "idle";
      await t.gw.request("prompt_agent", { target: "w1:p1", text: "and again", lease });
      expect(t.typed().at(-1)).toContain("and again\n\n[Sent by the owner");
      // A hello means the hook works again.
      await t.hello();
      t.autoHook("p-9");
      t.agent.agent_status = "idle";
      await t.gw.request("prompt_agent", { target: "w1:p1", text: "third", lease });
      expect(t.typed().at(-1)).toBe("third");
    } finally {
      HOOK_TIMING.confirmMs = 3000;
    }
  });

  test("a marker left unmatched past the stale limit brings the footer back for the next message", async () => {
    const t = setup();
    HOOK_TIMING.staleMs = 0;
    try {
      const lease = await t.claim("relay review");
      await t.hello();
      t.agent.agent_status = "working";
      await t.gw.request("steer_agent", { target: "w1:p1", text: "queued steer", lease });
      expect(t.typed()).toEqual(["queued steer"]);
      await Bun.sleep(5);
      await t.gw.request("steer_agent", { target: "w1:p1", text: "second steer", lease });
      expect(t.typed().at(-1)).toContain("second steer [Sent by the owner");
    } finally {
      HOOK_TIMING.staleMs = 15_000;
    }
  });

  test("a steer mid-turn, collapsed to one line, still matches", async () => {
    const t = setup();
    const lease = await t.claim("relay review");
    await t.hello();
    t.agent.agent_status = "working";
    await t.gw.request("steer_agent", { target: "w1:p1", text: "Steer:\nend with STEERED.", lease });
    expect(t.typed()).toEqual(["Steer: end with STEERED."]);
    expect(await t.prompt("p-2", "Steer: end with STEERED.")).toContain("relay review");
  });

  test("the Stop hook's exact answer is what the owed chat gets, not the transcript", async () => {
    const t = setup();
    const lease = await t.claim("relay review");
    await t.hello();
    t.autoHook("p-1");
    await t.gw.request("prompt_agent", { target: "w1:p1", text: "count the files", lease });
    await t.stop("p-1", "There are 12 files.");
    t.finish("stale transcript text");
    const [r] = await t.poll();
    expect(r).toMatchObject({ type: "finished", reply_to: lease, reply_leases: [lease] });
    expect(((await t.gw.handle("read_message", { id: r.text_id })) as any).text).toBe("There are 12 files.");
  });

  test("an answer kept before a prompt the owner typed is not used for the owner's turn", async () => {
    const t = setup();
    const lease = await t.claim("relay review");
    await t.hello();
    t.autoHook("p-1");
    await t.gw.request("prompt_agent", { target: "w1:p1", text: "count the files", lease });
    await t.stop("p-1", "There are 12 files.");
    await Bun.sleep(5);
    expect(await t.prompt("own-1", "now something of mine")).toBeNull();
    t.finish("my own answer");
    const [r] = await t.poll();
    expect(((await t.gw.handle("read_message", { id: r.text_id })) as any).text).toBe("my own answer");
  });

  test("a background task's turn continues the last WorkDone prompt a bounded number of times", async () => {
    const t = setup();
    const lease = await t.claim("relay review");
    await t.hello();
    t.autoHook("p-1");
    await t.gw.request("prompt_agent", { target: "w1:p1", text: "run the long job", lease });
    t.agent.onPrompt = undefined;
    t.finish("Started it in the background.");
    await t.poll();
    expect(t.watched()["w1:p1"]?.reply_to).toBeUndefined();
    const note = "<task-notification>\n<task-id>blut110wm</task-id>\n</task-notification>";
    for (let i = 1; i <= INHERIT_MAX; i++) {
      expect(await t.prompt(`n-${i}`, note)).toContain("a background task finished");
      expect(t.watched()["w1:p1"].reply_to).toBe(lease);
    }
    expect(await t.prompt("n-x", note)).toBeNull();
  });

  test("two chats prompting into one turn are both owed its answer, the first after a take-over too", async () => {
    const t = setup();
    const a = await t.claim("first chat");
    await t.gw.request("prompt_agent", { target: "w1:p1", text: "start", lease: a });
    const b = await t.claim("second chat", true);
    t.agent.agent_status = "working";
    await t.gw.request("steer_agent", { target: "w1:p1", text: "also this", lease: b });
    t.finish("Done with both.");
    const [r] = await t.poll();
    expect(r).toMatchObject({ reply_to: b, reply_leases: [a, b], lease: b });
  });
});

describe("hook script plumbing", () => {
  test("hook input becomes the gateway op, and only a prompt's context is printed", () => {
    expect(hookRequest("UserPromptSubmit", { session_id: "s", prompt_id: "p", prompt: "hi" }, "w1:p1")).toEqual({ op: "hook_prompt", params: { pane_id: "w1:p1", session_id: "s", kind: "claude", prompt_id: "p", prompt: "hi" } });
    expect(hookRequest("Stop", { session_id: "s", prompt_id: "p", last_assistant_message: "ok", stop_hook_active: true }, "w1:p1")?.params.text).toBe("ok");
    expect(hookRequest("Stop", { session_id: "s" }, "w1:p1")).toBeNull();
    expect(hookRequest("Notification", { session_id: "s" }, "w1:p1")).toBeNull();
    expect(JSON.parse(hookOutput("UserPromptSubmit", '{"id":"hook","ok":true,"result":{"context":"from chat"}}\n'))).toEqual({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "from chat" } });
    expect(hookOutput("UserPromptSubmit", '{"id":"hook","ok":true,"result":{"context":null}}')).toBe("");
    expect(hookOutput("UserPromptSubmit", "not json")).toBe("");
    expect(hookOutput("Stop", '{"result":{"context":"x"}}')).toBe("");
  });

  test("Codex input: turn_id stands in for prompt_id, and only known agent kinds pass", () => {
    // As Codex 0.163 sent it to Stop in the probe (2026-10-22).
    const stop = { session_id: "01a1630b-d987-76d2-a36a-ff54ce3080e8", turn_id: "01a1630c-1131-7540-bc9a-582cfff7a59f", last_assistant_message: "PROBE ONE STEERED", stop_hook_active: false };
    expect(hookRequest("Stop", stop, "w1:p1", "codex")).toEqual({ op: "hook_stop", params: { pane_id: "w1:p1", session_id: stop.session_id, kind: "codex", prompt_id: stop.turn_id, text: "PROBE ONE STEERED" } });
    expect(hookRequest("SessionStart", { session_id: "s", source: "startup" }, "w1:p1", "codex")?.params.kind).toBe("codex");
    expect(hookRequest("SessionStart", { session_id: "s" }, "w1:p1", "cursor")).toBeNull();
  });

  test("normalizing strips the pasted wrapper and whitespace", () => {
    expect(normalizePrompt(pasted("a\n\nb"))).toBe("a b");
    expect(normalizePrompt("a b")).toBe("a b");
  });
});
