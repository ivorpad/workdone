import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { approveMenus, timing } from "../gateway/answer-ops.ts";
import { menuExcerpt } from "../gateway/attention.ts";
import { loadConfig, type HerdrCall } from "../gateway/config.ts";
import { answerKeys, goAhead, isPermissionDialog, parseDialog } from "../gateway/dialog.ts";
import { Gateway } from "../gateway/gateway.ts";

// Screens captured from Claude Code, Codex and cursor-agent on 28-09 (tests/fixtures/screens).
const screen = (name: string) => readFileSync(join(import.meta.dir, "fixtures/screens", `${name}.txt`), "utf8");
const labels = (name: string) => parseDialog(screen(name))?.options.map((o) => o.label);

// Source-derived renderings, not terminal captures. Pi's official permission-gate
// example calls ui.select with this title and Yes/No. ExtensionSelectorComponent
// renders its arrow and footer; default bindings navigate vertically and confirm.
// https://github.com/badlogic/pi-mono/blob/8ce69e9d2b171d173fe4b6b2b6256f1f4411e69d/packages/coding-agent/examples/extensions/permission-gate.ts
const piPermission = (command = "sudo echo inspect", current = 0) => [
  "────────────────────────────────────────", "", "⚠️ Dangerous command:", "", `  ${command}`, "", "Allow?", "",
  `${current === 0 ? "→ " : "  "}Yes`, `${current === 1 ? "→ " : "  "}No`, "", "↑↓ navigate  enter select  esc cancel", "", "────────────────────────────────────────",
].join("\n");

// OpenCode Prompt's button backgrounds encode selection. Left/right wrap, Enter
// submits the selected choice, and Escape directly rejects. Test each selection
// and missing/ambiguous colors without assuming Enter always means Allow once.
// https://github.com/anomalyco/opencode/blob/0112a92c416f5ad833d96e7a8308441f0a875d94/packages/tui/src/routes/session/permission.tsx
const openCodePermission = (current: number | null = 0, command = "bun test", colors = ["48;2;220;180;50", "48;2;30;30;30"]) => [
  "│ △ Permission required", "│ # Shell command", `│ $ ${command}`, "│",
  `│ ${["Allow once", "Allow always", "Reject"].map((label, idx) => current === null ? label : `\x1b[${colors[idx === current ? 0 : 1]}m ${label} \x1b[0m`).join("  ")}`,
  "│ ctrl+f fullscreen  ⇆ select  enter confirm",
].join("\n");

describe("Pi and OpenCode source-derived dialogs", () => {
  test("Pi extension permissions use arrows from the actual selection, never digits", () => {
    for (const current of [0, 1]) {
      const d = parseDialog(piPermission("sudo echo inspect", current))!;
      expect(d.options.map((o) => o.label)).toEqual(["Yes", "No"]);
      expect(d.options[current]!.current).toBe(true);
      expect(d.style).toBe("plain");
      expect(answerKeys(d, [1])).toEqual(current === 0 ? ["enter"] : ["up", "enter"]);
      expect(answerKeys(d, [2])).toEqual(current === 1 ? ["enter"] : ["down", "enter"]);
      expect(goAhead(d)).toEqual({ kind: "permission", option: 1 });
    }
  });

  test("Pi session decisions and arbitrary Yes/No selectors remain questions", () => {
    for (const title of ["Clear session?\nThis will delete all messages in the current session.", "Switch session?\nYou have messages in the current session. Switch anyway?", "Which result should we keep?"]) {
      const d = parseDialog(`────────────────────────────────────────\n${title}\n\n→ Yes\n  No\n\n↑↓ navigate  enter select  esc cancel\n────────────────────────────────────────`)!;
      expect(d.options.map((o) => o.label)).toEqual(["Yes", "No"]);
      expect(goAhead(d, { includeGated: true })).toBeNull();
    }
  });

  test("Pi dangerous commands need the separately chosen gated policy", () => {
    const d = parseDialog(piPermission("rm -rf /tmp/obsolete"))!;
    expect(goAhead(d)).toBeNull();
    expect(goAhead(d, { includeGated: true })).toEqual({ kind: "permission", option: 1 });
  });

  test("OpenCode's selected background determines safe arrows for Allow once", () => {
    for (const current of [0, 1, 2]) {
      const d = parseDialog(openCodePermission(current))!;
      expect(d.style).toBe("horizontal");
      expect(d.options.map((o) => o.label)).toEqual(["Allow once", "Allow always", "Reject"]);
      expect(d.options[current]!.current).toBe(true);
      expect(answerKeys(d, [1])).toEqual([...Array(current).fill("left"), "enter"]);
      expect(answerKeys(d, [3])).toEqual(["esc"]);
      expect(goAhead(d)).toEqual({ kind: "permission", option: 1 });
      expect(d.text).toContain("$ bun test");
      expect(d.text).not.toContain("\x1b");
    }
  });

  test("OpenCode always-allow is never the automatic approval option", () => {
    const d = parseDialog(openCodePermission(1, "git push origin main"))!;
    expect(goAhead(d)).toBeNull();
    expect(goAhead(d, { includeGated: true })).toEqual({ kind: "permission", option: 1 });
    expect(answerKeys(d, [1])).toEqual(["left", "enter"]);
  });

  test("OpenCode colorless or ambiguous menus fail closed for approval but can reject", () => {
    for (const text of [openCodePermission(null), openCodePermission(1, "bun test", ["48;2;30;30;30", "48;2;30;30;30"])]) {
      const d = parseDialog(text)!;
      expect(d.options.some((o) => o.current)).toBe(false);
      expect(isPermissionDialog(d)).toBe(true);
      expect(d.keys).toEqual([[], [], ["esc"]]);
      expect(goAhead(d, { includeGated: true })).toBeNull();
      expect(() => answerKeys(d, [1])).toThrow("no safe approval keys");
      expect(answerKeys(d, [3])).toEqual(["esc"]);
    }
  });

  test("a permission with only a persistent grant is recognized but never auto-approved", () => {
    const d = parseDialog("Bash command\n\necho inspect\n\nDo you want to proceed?\n❯ 1. Yes, always allow\n  2. No\nEsc to cancel · Tab to amend")!;
    expect(isPermissionDialog(d)).toBe(true);
    expect(goAhead(d, { includeGated: true })).toBeNull();
  });

  test("OpenCode supports indexed and colon-separated RGB ANSI without confusing foreground colors", () => {
    for (const colors of [["48;5;11", "48;5;0"], ["48:2::220:180:50", "48:2::30:30:30"], ["43;38;2;30;48;20", "40;38;2;30;48;20"]]) {
      const d = parseDialog(openCodePermission(2, "bun test", colors))!;
      expect(d.options[2]!.current).toBe(true);
      expect(answerKeys(d, [1])).toEqual(["left", "left", "enter"]);
    }
  });

  test("OpenCode button labels in normal output and answered scrollback are not live menus", () => {
    expect(parseDialog("Permission required\nAllow once  Allow always  Reject\nA description of these choices.")).toBeNull();
    expect(parseDialog("Allow once  Allow always  Reject\n⇆ select  enter confirm")).toBeNull();
    expect(parseDialog(`${openCodePermission(0)}\n❯ `)).toBeNull();
  });

  test("raw ANSI is stripped for existing Codex and Claude menus too", () => {
    for (const name of ["codex-perm", "claude-perm", "claude-ask"]) {
      const original = parseDialog(screen(name))!;
      const colored = parseDialog(screen(name).split("\n").map((line) => `\x1b[32m${line}\x1b[0m`).join("\n"))!;
      expect(colored).toEqual(original);
    }
  });

  test("permission-like ordinary questions stay questions under every automatic policy", () => {
    for (const question of ["Do you want to create another example for this documentation?", "Would you like to delete the alternative design from the plan?", "Do you want to proceed with another approach?"]) {
      const d = parseDialog(`${question}\n❯ 1. Yes\n  2. No\nEnter to select · Esc to cancel`)!;
      expect(isPermissionDialog(d)).toBe(false);
      expect(goAhead(d)).toBeNull();
      expect(goAhead(d, { includeGated: true })).toBeNull();
    }
    for (const name of ["claude-ask", "claude-multi-1", "claude-multi-2", "claude-multi-3"]) {
      const d = parseDialog(screen(name))!;
      expect(isPermissionDialog(d)).toBe(false);
      expect(goAhead(d, { includeGated: true })).toBeNull();
    }
  });
});

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

describe("goAhead", () => {
  const go = (name: string) => goAhead(parseDialog(screen(name))!);

  test("permissions: allow once, never an allowlist or don't-ask-again", () => {
    // Claude in auto mode under an ask rule (Bash, Write, Edit), and in default mode.
    for (const name of ["claude-ask-rule", "claude-write", "claude-edit", "claude-write-config", "claude-perm"]) {
      expect([name, go(name)]).toEqual([name, { kind: "permission", option: 1 }]);
    }
    // A plan may proceed while WorkDone keeps control of later permission menus.
    expect(go("claude-plan")).toEqual({ kind: "permission", option: 2 });
    expect(parseDialog(screen("claude-plan"))!.options[2]).toMatchObject({ label: "Tell Claude what to change", free_text: true });
    for (const name of ["codex-perm", "codex-edit", "cursor-perm", "cursor-write"]) expect([name, go(name)]).toEqual([name, { kind: "permission", option: 1 }]);
  });

  test("automatic permission approval never changes the agent's permission mode", () => {
    for (const mode of ["Yes, and use auto mode", "Yes, and switch to auto mode", "Yes, bypass permissions", "Yes, auto-accept edits", "Yes, accept all edits"]) {
      const d = parseDialog(`Bash command\n\necho inspect\n\nDo you want to proceed?\n❯ 1. ${mode}\n  2. Yes, allow once\n  3. No\nEsc to cancel · Tab to amend`)!;
      expect(goAhead(d)).toEqual({ kind: "permission", option: 2 });
      expect(goAhead(d, { includeGated: true })).toEqual({ kind: "permission", option: 2 });
    }
    const command = parseDialog("Bash command\n\nexample --auto-mode\n\nDo you want to proceed?\n❯ 1. Yes, proceed\n  2. No\nEsc to cancel · Tab to amend")!;
    expect(goAhead(command)).toEqual({ kind: "permission", option: 1 });
  });

  test("folder trust, and the update and model notices Codex opens on", () => {
    expect(go("claude-trust")).toEqual({ kind: "trust", option: 2 });
    for (const name of ["codex-trust", "codex-trust-2", "cursor-start", "cursor-trust-narrow"]) expect([name, go(name)]).toEqual([name, { kind: "trust", option: 1 }]);
    // Skip the update rather than install it mid-task; keep the model the alias pins.
    expect(go("codex-update")).toEqual({ kind: "notice", option: 2 });
    expect(go("codex-migrate")).toEqual({ kind: "notice", option: 2 });
  });

  test("questions are the owner's", () => {
    for (const name of ["claude-ask", "claude-ask-typing", "claude-multi-1", "claude-multi-2", "claude-multi-3", "claude-multiselect"]) {
      expect([name, go(name)]).toEqual([name, null]);
    }
    // A yes/no that is not a request to run, edit or allow something.
    expect(goAhead(parseDialog("Ship it now?\n❯ 1. Yes\n  2. No\nEnter to select · Esc to cancel")!)).toBeNull();
  });

  test("the record of an approval names the command or file, not the options", () => {
    expect(menuExcerpt(parseDialog(screen("claude-ask-rule"))!)).toBe(
      "Bash command / echo approve-capture / Print approve-capture / Ask rule Bash(echo:*) overrides auto mode for this command. / /permissions to let auto mode decide / Do you want to proceed?",
    );
    expect(menuExcerpt(parseDialog(screen("codex-edit"))!)).toBe(
      "Would you like to make the following edits? / Description: Apply proposed file edits / Destination: /Users/me/codex-approve-capture.txt",
    );
    expect(menuExcerpt(parseDialog(screen("cursor-perm"))!)).toBe("$ kill 83616 2>/dev/null || true in . / Run this command? / Not in allowlist: kill, true");
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
    expect(c.pressed).toEqual(["n", "text:Do not kill anything", "enter"]);
    // Declining without text: Cursor's field still wants enter; Codex's option is enough.
    const skip = setup("cursor", "blocked", screen("cursor-perm"));
    await skip.gw.handle("answer_agent", { target: "w1:p1", option: 4 });
    expect(skip.pressed).toEqual(["n", "enter"]);
    const no = setup("codex", "blocked", screen("codex-perm"));
    await no.gw.handle("answer_agent", { target: "w1:p1", option: 3 });
    expect(no.pressed).toEqual(["3"]);
  });

  test("letters are keys, arrows count from the cursor, multi-select tabs on", async () => {
    // Cursor's approval menus ignore a letter typed as text (28-09, Write to this file?).
    const t = setup("cursor", "idle", screen("cursor-start"));
    await t.gw.handle("answer_agent", { target: "w1:p1", option: 1 });
    expect(t.pressed).toEqual(["a"]);
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
    // The menu is gone (answered already): nothing pressed, and not an error.
    expect(await idle.gw.handle("answer_agent", { target: "w1:p1", option: 1 })).toMatchObject({ answered: null, status: "idle" });
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
    expect(res).toMatchObject({ attention: "dialog", choices: { multi: false, free_text: false, kind: "permission", go_ahead: 1 } });
    expect(res.choices.options).toHaveLength(4);
    const idle = setup("codex", "idle", screen("codex-trust"));
    expect(await idle.gw.handle("get_agent", { target: "w1:p1" })).toMatchObject({
      attention: "dialog", choices: { kind: "trust", go_ahead: 1, options: [{ label: "Trust and continue" }, { label: "Back to Agent Command Center" }] },
    });
    const ask = setup("claude", "blocked", screen("claude-ask"));
    expect(await ask.gw.handle("get_agent", { target: "w1:p1" })).toMatchObject({ choices: { kind: "question", go_ahead: null } });
  });
});

describe("approveMenus", () => {
  timing.key = timing.text = timing.settle = 0;

  // Each key press shows the next screen.
  function setup(screens: string[], extra: Record<string, unknown> = {}) {
    let at = 0;
    const pressed: string[] = [];
    const herdr: HerdrCall = async (method, params: any) => {
      if (method === "agent.get") return { agent: { pane_id: "w1:p1", agent: "codex", agent_status: at < screens.length - 1 ? "blocked" : "idle", cwd: "/srv/allowed/app" } };
      if (method === "agent.read") return { text: screens[at] };
      if (method === "agent.send_keys") {
        pressed.push(...params.keys);
        at = Math.min(at + 1, screens.length - 1);
      }
      return {};
    };
    const state = mkdtempSync(join(tmpdir(), "herdr-go-"));
    const cfg = loadConfig({ allowedRoots: ["/srv/allowed"], stateDir: state, ...extra });
    return { cfg, herdr, pressed, state };
  }

  test("one menu after another until the agent is ready, each in the audit log", async () => {
    const t = setup([screen("codex-update"), screen("codex-trust"), screen("codex-after-migrate")]);
    const res = await approveMenus(t.cfg, t.herdr, "w1:p1", "spawn_agent", { waitMs: 0 });
    expect(t.pressed).toEqual(["2", "1"]);
    expect(res.approved.map((a) => [a.kind, a.option])).toEqual([["notice", "Skip"], ["trust", "Trust and continue"]]);
    expect(res.status).toBe("idle");
    const audit = readFileSync(join(t.state, "audit.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(audit.map((e) => [e.op, e.via, e.args.option])).toEqual([["auto_approve", "spawn_agent", "Skip"], ["auto_approve", "spawn_agent", "Trust and continue"]]);
  });

  test("stops at a question, at a menu that stays up, and when kinds leaves it out", async () => {
    const ask = setup([screen("claude-ask"), screen("claude-ask-after")]);
    expect((await approveMenus(ask.cfg, ask.herdr, "w1:p1", "watch_poll", { waitMs: 0 })).approved).toEqual([]);
    expect(ask.pressed).toEqual([]);
    // Keys that did not take: pressed once, not counted, and the audit log says so.
    const stuck = setup([screen("cursor-write"), screen("cursor-write")]);
    expect((await approveMenus(stuck.cfg, stuck.herdr, "w1:p1", "watch_poll", { waitMs: 0 })).approved).toEqual([]);
    expect(stuck.pressed).toEqual(["y"]);
    expect(JSON.parse(readFileSync(join(stuck.state, "audit.jsonl"), "utf8"))).toMatchObject({ op: "auto_approve", ok: false, args: { option: "Proceed" } });
    const perm = setup([screen("claude-edit"), screen("claude-ask-after")]);
    expect((await approveMenus(perm.cfg, perm.herdr, "w1:p1", "prompt_agent", { waitMs: 0, kinds: ["trust", "notice"] })).approved).toEqual([]);
    expect(perm.pressed).toEqual([]);
  });

  test("autoApprove false turns it off", async () => {
    const t = setup([screen("claude-ask-rule"), screen("claude-ask-after")], { autoApprove: false });
    expect(await approveMenus(t.cfg, t.herdr, "w1:p1", "watch_poll", { waitMs: 0 })).toEqual({ approved: [], status: null });
    expect(t.pressed).toEqual([]);
  });

  test("a pane another process is answering is left alone; a lock a dead process left is not", async () => {
    const t = setup([screen("claude-ask-rule"), screen("claude-ask-after")]);
    const lock = join(t.state, "answer-w1_p1.lock");
    mkdirSync(lock);
    expect(await approveMenus(t.cfg, t.herdr, "w1:p1", "watch_poll", { waitMs: 0 })).toEqual({ approved: [], status: null, busy: true });
    expect(t.pressed).toEqual([]);
    utimesSync(lock, new Date(Date.now() - 120_000), new Date(Date.now() - 120_000));
    expect((await approveMenus(t.cfg, t.herdr, "w1:p1", "watch_poll", { waitMs: 0 })).approved).toHaveLength(1);
    expect(t.pressed).toEqual(["1"]);
    expect(existsSync(lock)).toBe(false);
  });
});
