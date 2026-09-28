import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { timing } from "../gateway/answer-ops.ts";
import { loadConfig, type HerdrCall } from "../gateway/config.ts";
import { answerKeys, parseDialog } from "../gateway/dialog.ts";
import { Gateway } from "../gateway/gateway.ts";

// Screens captured from Claude Code, Codex and cursor-agent on 28-09 (tests/fixtures/screens).
const screen = (name: string) => readFileSync(join(import.meta.dir, "fixtures/screens", `${name}.txt`), "utf8");
const labels = (name: string) => parseDialog(screen(name))?.options.map((o) => o.label);

describe("parseDialog", () => {
  test("numbered menus: digits", () => {
    const perm = parseDialog(screen("claude-perm"))!;
    expect(perm.options.map((o) => o.label)).toEqual([
      "Yes", "Yes, and don’t ask again for: curl -sI https://example.com", "Yes, and switch to auto mode · auto mode handles these prompts for you", "No",
    ]);
    expect(perm.keys).toEqual([["1"], ["2"], ["3"], ["4"]]);
    expect(perm.text).toContain("curl -sI https://example.com | head -1");
    expect(perm.options[0]!.current).toBe(true);
    expect(labels("codex-update")).toEqual(["Update now (runs `npm install -g @openai/codex`)", "Skip", "Skip until next version"]);
    expect(labels("codex-trust")).toEqual(["Trust and continue", "Back to Agent Command Center"]);
    expect(labels("codex-migrate")).toEqual(["Try new model", "Use existing model"]);
    expect(labels("claude-multi-3")).toEqual(["Submit answers", "Cancel"]);
  });

  test("options that open a text field", () => {
    const ask = parseDialog(screen("claude-ask"))!;
    expect(ask.options.map((o) => o.label)).toEqual(["Red", "Green", "Blue", "Type something.", "Chat about this"]);
    expect(ask.options.filter((o) => o.free_text).map((o) => o.n)).toEqual([4]);
    expect(parseDialog(screen("codex-perm"))!.options[2]).toMatchObject({ n: 3, free_text: true });
    expect(parseDialog(screen("cursor-perm"))!.options[3]).toMatchObject({ n: 4, label: "Skip & tell the agent what to do instead", free_text: true });
  });

  test("multi-select: boxes, and the digits that flip them", () => {
    const d = parseDialog(screen("claude-multi-2"))!;
    expect(d.multi).toBe(true);
    expect(d.options.slice(0, 3).map((o) => o.checked)).toEqual([true, false, false]);
    // Want Ham and Olives: Cheese is on, so flip 1, 2 and 3, then tab to the review step.
    expect(answerKeys(d, [2, 3])).toEqual(["1", "2", "3", "tab"]);
    expect(answerKeys(parseDialog(screen("claude-multiselect"))!, [2])).toEqual(["2", "tab"]);
  });

  test("Cursor: the key in parentheses, the letter in brackets", () => {
    const perm = parseDialog(screen("cursor-perm"))!;
    expect(perm.options.map((o) => o.label)).toEqual(["Run (once)", "Add Shell(kill), Shell(true) to allowlist?", "Run Everything", "Skip & tell the agent what to do instead"]);
    expect(perm.keys).toEqual([["y"], ["tab"], ["shift+tab"], ["n"]]);
    const trust = parseDialog(screen("cursor-start"))!;
    expect(trust.keys).toEqual([["a"], ["q"]]);
    expect(trust.text).toContain("Do you trust the contents of this directory?");
  });

  test("Claude's folder trust has no numbers: arrows from the cursor, then enter", () => {
    const d = parseDialog(screen("claude-trust"))!;
    expect(d.options.map((o) => o.label)).toEqual(["No, exit", "Yes, I trust this folder"]);
    expect(d.keys).toEqual([["enter"], ["down", "enter"]]);
  });

  test("no menu: idle and working screens, answered menus, text fields", () => {
    // cursor-trusted-narrow: the trust box stays in scrollback above the input line, with no rules around it.
    for (const name of ["cursor-trusted-narrow", "claude-ask-after", "claude-steer", "codex-after-migrate", "codex-steer", "cursor-idle", "cursor-skip", "cursor-steer-2"]) {
      expect([name, parseDialog(screen(name))]).toEqual([name, null]);
    }
    // A numbered list in an agent's answer is not a menu: nothing points at it.
    expect(parseDialog("Steps:\n1. Build\n2. Test\n3. Ship\n\n❯ ")).toBeNull();
  });
});

describe("answer_agent and steer_agent", () => {
  timing.key = timing.text = timing.settle = 0;

  // A fake Herdr with one agent whose screen the test sets, recording what was pressed.
  function setup(kind: string, status: string, first: string, then = "") {
    let shown = first;
    const pressed: string[] = [];
    const agent = { pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1", agent: kind, agent_status: status, cwd: "/srv/allowed/app" };
    const herdr: HerdrCall = async (method, params: any) => {
      if (method === "agent.get") return { agent };
      if (method === "agent.read") return { text: shown };
      if (method === "agent.send_keys") pressed.push(...params.keys);
      if (method === "pane.send_input") pressed.push(`text:${params.text}`);
      if (method === "agent.send_keys" || method === "pane.send_input") shown = then;
      return {};
    };
    const cfg = loadConfig({ allowedRoots: ["/srv/allowed"], stateDir: mkdtempSync(join(tmpdir(), "herdr-ans-")) });
    return { gw: new Gateway(cfg, herdr), pressed, agent };
  }

  test("a numbered option is its digit; the result says the menu is gone", async () => {
    const { gw, pressed } = setup("claude", "blocked", screen("claude-perm"), screen("claude-steer"));
    const res: any = await gw.handle("answer_agent", { target: "w1:p1", option: 1 });
    expect(pressed).toEqual(["1"]);
    expect(res).toMatchObject({ answered: { options: [1], labels: ["Yes"] }, dialog: null });
  });

  test("a digit that only moves the cursor gets an enter; one that answered does not", async () => {
    // Codex's folder trust: "1" leaves the same menu up with the cursor on option 1.
    const codex = setup("codex", "idle", screen("codex-trust"), screen("codex-trust"));
    await codex.gw.handle("answer_agent", { target: "w1:p1", option: 1 });
    expect(codex.pressed).toEqual(["1", "enter"]);
    // Claude's first question answered, the second one up: its cursor is on 1 too, but it is another menu.
    const claude = setup("claude", "blocked", screen("claude-multi-1"), screen("claude-multi-2"));
    await claude.gw.handle("answer_agent", { target: "w1:p1", option: 1 });
    expect(claude.pressed).toEqual(["1"]);
  });

  test("an answered menu that is still being acted on is waited out", async () => {
    const trusting = screen("cursor-start").replace("[q] Quit", "[q] Quit\n  ⏳ Trusting workspace...");
    let reads = 0;
    const t = setup("cursor", "idle", screen("cursor-start"));
    const herdr = (t.gw as any).herdr;
    (t.gw as any).herdr = async (method: string, params: any) => {
      if (method === "agent.read" && t.pressed.length) return { text: ++reads < 3 ? trusting : screen("cursor-idle") };
      return herdr(method, params);
    };
    const res: any = await t.gw.handle("answer_agent", { target: "w1:p1", option: 1 });
    expect(res.dialog).toBeNull();
    expect(reads).toBe(3);
  });

  test("text goes to the option that opens a field, typed apart from its enter", async () => {
    const { gw, pressed } = setup("claude", "blocked", screen("claude-ask"));
    await gw.handle("answer_agent", { target: "w1:p1", text: "Teal\nplease" });
    expect(pressed).toEqual(["4", "text:Teal please", "enter"]);
    const c = setup("cursor", "blocked", screen("cursor-perm"));
    await c.gw.handle("answer_agent", { target: "w1:p1", option: 4, text: "Do not kill anything" });
    expect(c.pressed).toEqual(["text:n", "text:Do not kill anything", "enter"]);
    // Declining without text: Cursor's field still wants enter; Codex's option is enough.
    const skip = setup("cursor", "blocked", screen("cursor-perm"));
    await skip.gw.handle("answer_agent", { target: "w1:p1", option: 4 });
    expect(skip.pressed).toEqual(["text:n", "enter"]);
    const no = setup("codex", "blocked", screen("codex-perm"));
    await no.gw.handle("answer_agent", { target: "w1:p1", option: 3 });
    expect(no.pressed).toEqual(["3"]);
  });

  test("letters are typed, arrows count from the cursor, multi-select tabs on", async () => {
    const t = setup("cursor", "idle", screen("cursor-start"));
    await t.gw.handle("answer_agent", { target: "w1:p1", option: 1 });
    expect(t.pressed).toEqual(["text:a"]);
    const c = setup("claude", "blocked", screen("claude-trust"));
    await c.gw.handle("answer_agent", { target: "w1:p1", option: 2 });
    expect(c.pressed).toEqual(["down", "enter"]);
    const m = setup("claude", "blocked", screen("claude-multi-2"), screen("claude-multi-3"));
    const res: any = await m.gw.handle("answer_agent", { target: "w1:p1", options: [2, 3] });
    expect(m.pressed).toEqual(["1", "2", "3", "tab"]);
    expect(res.dialog.options.map((o: any) => o.label)).toEqual(["Submit answers", "Cancel"]);
  });

  test("answers that cannot be right are refused before any key is pressed", async () => {
    const { gw, pressed } = setup("claude", "blocked", screen("claude-ask"));
    await expect(gw.handle("answer_agent", { target: "w1:p1", option: 9 })).rejects.toThrow("option must be a number from 1 to 5");
    await expect(gw.handle("answer_agent", { target: "w1:p1", option: 4 })).rejects.toThrow("opens a text field");
    await expect(gw.handle("answer_agent", { target: "w1:p1", option: 1, text: "x" })).rejects.toThrow("takes no text");
    const m = setup("claude", "blocked", screen("claude-multi-2"));
    await expect(m.gw.handle("answer_agent", { target: "w1:p1", option: 2, text: "x" })).rejects.toThrow("multiple-choice");
    const idle = setup("claude", "idle", screen("claude-steer"));
    await expect(idle.gw.handle("answer_agent", { target: "w1:p1", option: 1 })).rejects.toMatchObject({ code: "no_dialog" });
    expect([...pressed, ...m.pressed, ...idle.pressed]).toEqual([]);
  });

  test("steering: one enter queues it, Cursor takes a second to send it now", async () => {
    const claude = setup("claude", "working", screen("claude-steer"));
    const res: any = await claude.gw.handle("steer_agent", { target: "w1:p1", text: "skip the rest" });
    expect(claude.pressed).toEqual(["text:skip the rest", "enter"]);
    expect(res.delivery).toContain("queued");
    const cursor = setup("cursor", "working", screen("cursor-steer-2"));
    await cursor.gw.handle("steer_agent", { target: "w1:p1", text: "stop" });
    expect(cursor.pressed).toEqual(["text:stop", "enter", "enter"]);
  });

  test("steering never types into a menu, and an idle agent gets a prompt", async () => {
    // Cursor's approval came up while Herdr still said working: enter would have run the command.
    const menu = setup("cursor", "working", screen("cursor-perm"));
    await expect(menu.gw.handle("steer_agent", { target: "w1:p1", text: "stop" })).rejects.toMatchObject({ code: "agent_blocked" });
    expect(menu.pressed).toEqual([]);
    const blocked = setup("claude", "blocked", screen("claude-perm"));
    await expect(blocked.gw.handle("steer_agent", { target: "w1:p1", text: "stop" })).rejects.toMatchObject({ code: "agent_blocked" });
    const idle = setup("codex", "idle", screen("codex-steer"));
    const res: any = await idle.gw.handle("steer_agent", { target: "w1:p1", text: "next" });
    expect(res).toMatchObject({ steered: false, prompted: true });
  });

  test("get_agent shows a blocked agent's menu as choices, and a Codex menu Herdr calls idle", async () => {
    const b = setup("claude", "blocked", screen("claude-perm"));
    const res: any = await b.gw.handle("get_agent", { target: "w1:p1" });
    expect(res).toMatchObject({ attention: "dialog", choices: { multi: false, free_text: false } });
    expect(res.choices.options).toHaveLength(4);
    const idle = setup("codex", "idle", screen("codex-trust"));
    expect(await idle.gw.handle("get_agent", { target: "w1:p1" })).toMatchObject({ attention: "dialog", choices: { options: [{ label: "Trust and continue" }, { label: "Back to Agent Command Center" }] } });
  });
});
