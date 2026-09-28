// Answering an agent's menu and steering a busy agent, for callers that know only what
// the owner decided, not which keys a CLI wants. answer_agent reads the menu with
// parseDialog and presses that CLI's keys for the chosen option, types any text the
// option asks for, and reads the screen again. steer_agent types a message into a
// working agent the way its CLI takes one mid-turn.
//
// Keys go one at a time with a pause, and text and enter separately: a TUI that gets
// them in one burst drops some, or takes enter before it has drawn the text.

import { GatewayError, TARGET_RE } from "./config.ts";
import { parseDialog, answerKeys, type Dialog } from "./dialog.ts";
import type { Gateway } from "./gateway.ts";
import { str, type Op } from "./params.ts";
import { lastLines, textOf } from "./views.ts";

// Pauses between keys, around typed text, and before reading the result. Tests set them to 0.
export const timing = { key: 250, text: 450, settle: 1500 };

// How each CLI takes a message while it works, from its own screens:
//   claude  enter queues it; it goes in after the current tool call
//   codex   enter queues it; it goes in after the current tool call
//   cursor  enter queues it, a second enter ("enter steer") sends it now
const STEER_ENTERS: Record<string, number> = { cursor: 2 };

// A menu that was answered and is still being acted on.
const BUSY_RE = /⏳|Trusting workspace\.\.\./;

export function dialogView(d: Dialog) {
  return { text: d.text, options: d.options, multi: d.multi, free_text: d.free_text };
}

// One line: a newline would submit whatever came before it.
const oneLine = (s: string) => s.replace(/\s*\n\s*/g, " ").trim();

export function answerOps(g: Gateway): Record<string, Op> {
  const screen = async (paneId: string) =>
    textOf(await g.herdr("agent.read", { target: paneId, source: "visible", lines: 60, format: "text", strip_ansi: true }));

  async function press(paneId: string, keys: string[]) {
    for (const k of keys) {
      // Herdr key names cover control keys; a menu letter goes in as typed text.
      if (/^[a-z]$/.test(k)) await g.herdr("pane.send_input", { pane_id: paneId, text: k });
      else await g.herdr("agent.send_keys", { target: paneId, keys: [k] });
      await Bun.sleep(timing.key);
    }
  }

  async function type(paneId: string, text: string) {
    await Bun.sleep(timing.text);
    if (text) {
      await g.herdr("pane.send_input", { pane_id: paneId, text });
      await Bun.sleep(timing.text);
    }
    await press(paneId, ["enter"]);
  }

  async function after(paneId: string) {
    await Bun.sleep(timing.settle);
    let now = await screen(paneId);
    // Cursor draws "⏳ Trusting workspace..." under the menu it just answered and keeps
    // the menu up for several seconds on a slow machine. Wait that out, up to 15 s.
    for (let i = 0; i < 15 && BUSY_RE.test(now) && parseDialog(now); i++) {
      await Bun.sleep(timing.settle ? 1000 : 0);
      now = await screen(paneId);
    }
    const agent = await g.scopedAgent(paneId);
    const next = parseDialog(now);
    return { status: agent.agent_status, dialog: next ? dialogView(next) : null, ...(next ? {} : { screen_tail: lastLines(now, 12) }) };
  }

  function picks(params: Record<string, unknown>, d: Dialog, text: string | undefined): number[] {
    const n = d.options.length;
    const valid = (x: unknown): x is number => typeof x === "number" && Number.isInteger(x) && x >= 1 && x <= n;
    if (d.multi) {
      const list = Array.isArray(params.options) ? params.options : params.option !== undefined ? [params.option] : null;
      if (!list || !list.every(valid)) throw new GatewayError("invalid_params", `this menu takes several answers: pass options, a list of numbers from 1 to ${n}`);
      if (text) throw new GatewayError("invalid_params", "text cannot go with a multiple-choice menu: pick the options, then answer the next step");
      return list;
    }
    if (params.option === undefined && text && d.free_text) return [d.options.find((o) => o.free_text)!.n];
    if (!valid(params.option)) throw new GatewayError("invalid_params", `option must be a number from 1 to ${n}`);
    return [params.option];
  }

  return {
    // params: target, option (1-based, from the menu's options) or options (multi-select), text.
    async answer_agent(params) {
      const agent = await g.scopedAgent(str(params, "target", TARGET_RE));
      const d = parseDialog(await screen(agent.pane_id));
      if (!d) throw new GatewayError("no_dialog", "the agent is not showing a menu; read_agent to see its screen, or prompt_agent to send it a message");
      const text = typeof params.text === "string" && params.text.trim() ? oneLine(params.text) : undefined;
      if (text && text.length > g.cfg.maxPromptChars) throw new GatewayError("invalid_params", `text exceeds ${g.cfg.maxPromptChars} characters`);
      const chosen = picks(params, d, text);
      const first = d.options[chosen[0]! - 1]!;
      if (!d.multi) {
        // "No, and tell Codex what to do differently" and "Skip & tell the agent what to do
        // instead" work without text too; Claude's "Type something" does not.
        const declines = /^(?:no\b|skip\b)/i.test(first.label);
        if (first.free_text && !text && !declines) throw new GatewayError("invalid_params", `option ${first.n} ("${first.label}") opens a text field: pass text`);
        if (text && !first.free_text) throw new GatewayError("invalid_params", `option ${first.n} ("${first.label}") takes no text; the options that do are marked free_text`);
      }
      await press(agent.pane_id, answerKeys(d, chosen));
      // A digit picks the option in most menus, but only moves the cursor in some (Codex's
      // folder trust). Still the same menu, with the cursor on the choice: confirm it.
      // Another menu, like Claude's next question, never gets this enter.
      if (d.style === "numbered" && !d.multi && !first.free_text) {
        await Bun.sleep(timing.text);
        const still = parseDialog(await screen(agent.pane_id));
        const same = still && still.options.map((o) => o.label).join("\n") === d.options.map((o) => o.label).join("\n");
        if (same && still.options[first.n - 1]!.current) await press(agent.pane_id, ["enter"]);
      }
      if (text) await type(agent.pane_id, text);
      // Cursor's "tell the agent what to do instead" field waits for enter; empty skips.
      else if (first.free_text && d.style === "hinted") await type(agent.pane_id, "");
      const labels = chosen.map((n) => d.options[n - 1]!.label);
      return { answered: { options: chosen, labels, ...(text ? { text } : {}) }, ...(await after(agent.pane_id)) };
    },

    // A message for an agent that is working. An idle agent just gets it as a prompt.
    async steer_agent(params) {
      const agent = await g.scopedAgent(str(params, "target", TARGET_RE));
      const text = oneLine(str(params, "text"));
      if (text.length > g.cfg.maxPromptChars) throw new GatewayError("invalid_params", `text exceeds ${g.cfg.maxPromptChars} characters`);
      if (agent.agent_status !== "working") {
        if (agent.agent_status === "blocked") throw new GatewayError("agent_blocked", "the agent is showing a menu: show it to the user and answer_agent with their choice first");
        return { steered: false, prompted: true, result: await g.handle("prompt_agent", { target: agent.pane_id, text }) };
      }
      // A menu can come up between Herdr's status and the keys: enter would answer it.
      const d = parseDialog(await screen(agent.pane_id));
      if (d) throw new GatewayError("agent_blocked", `the agent is showing a menu: ${lastLines(d.text, 6)}. Show the user and answer_agent with their choice first`);
      await g.herdr("pane.send_input", { pane_id: agent.pane_id, text });
      await Bun.sleep(timing.text);
      const enters = STEER_ENTERS[agent.agent] ?? 1;
      for (let i = 0; i < enters; i++) {
        await press(agent.pane_id, ["enter"]);
        if (i + 1 < enters) await Bun.sleep(timing.text);
      }
      const res = await after(agent.pane_id);
      return {
        steered: true,
        delivery: enters > 1 ? "sent now" : "queued: it reaches the agent after its current tool call",
        ...res,
      };
    },
  };
}
