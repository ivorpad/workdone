// Answering an agent's menu and steering a busy agent, for callers that know only what
// the owner decided, not which keys a CLI wants. answer_agent reads the menu with
// parseDialog and presses that CLI's keys for the chosen option, types any text the
// option asks for, and reads the screen again. steer_agent types a message into a
// working agent the way its CLI takes one mid-turn. approveMenus answers the menus
// that only ask for a go-ahead (goAhead), so an agent never waits on one.
//
// Keys go one at a time with a pause, and text and enter separately: a TUI that gets
// them in one burst drops some, or takes enter before it has drawn the text.

import { menuExcerpt } from "./attention.ts";
import { GatewayError, TARGET_RE, type GatewayConfig, type HerdrCall } from "./config.ts";
import { parseDialog, answerKeys, goAhead, type Dialog, type GoAheadKind } from "./dialog.ts";
import { showApproved } from "./sidebar.ts";
import type { Gateway } from "./gateway.ts";
import { str, type Op } from "./params.ts";
import { StateStore } from "./state.ts";
import { lastLines, textOf } from "./views.ts";

// Pauses between keys, around typed text, and before reading the result. Tests set them to 0.
export const timing = { key: 250, text: 450, settle: 1500 };

// How each CLI takes a message while it works, from its own screens:
//   claude  enter queues it; it goes in after the current tool call
//   codex   enter queues it; it goes in after the current tool call
//   cursor  enter queues it, a second enter ("enter steer") sends it now
const STEER_ENTERS: Record<string, number> = { cursor: 2 };

// A menu that was answered and is still being acted on. Only the menu's own lines
// count: an old trust box in the scrollback above says nothing about a new menu.
const BUSY_RE = /⏳|Trusting workspace\.\.\./;
const busy = (d: Dialog | null) => d !== null && BUSY_RE.test(d.text);

// kind and go_ahead: what WorkDone would answer, or "question" and null for a decision.
export function dialogView(d: Dialog) {
  const go = goAhead(d);
  return { text: d.text, options: d.options, multi: d.multi, free_text: d.free_text, kind: go?.kind ?? "question", go_ahead: go?.option ?? null };
}

// One line: a newline would submit whatever came before it.
const oneLine = (s: string) => s.replace(/\s*\n\s*/g, " ").trim();

export async function menuScreen(herdr: HerdrCall, paneId: string): Promise<string> {
  return textOf(await herdr("agent.read", { target: paneId, source: "visible", lines: 60, format: "text", strip_ansi: true }));
}

// Letters go as Herdr keys too: Cursor's approval menus ignore a letter typed as text.
async function press(herdr: HerdrCall, paneId: string, keys: string[]) {
  for (const k of keys) {
    await herdr("agent.send_keys", { target: paneId, keys: [k] });
    await Bun.sleep(timing.key);
  }
}

async function type(herdr: HerdrCall, paneId: string, text: string) {
  await Bun.sleep(timing.text);
  if (text) {
    await herdr("pane.send_input", { pane_id: paneId, text });
    await Bun.sleep(timing.text);
  }
  await press(herdr, paneId, ["enter"]);
}

async function after(herdr: HerdrCall, paneId: string) {
  await Bun.sleep(timing.settle);
  let now = await menuScreen(herdr, paneId);
  // Cursor draws "⏳ Trusting workspace..." under the menu it just answered and keeps
  // the menu up for several seconds on a slow machine. Wait that out, up to 15 s.
  for (let i = 0; i < 15 && busy(parseDialog(now)); i++) {
    await Bun.sleep(timing.settle ? 1000 : 0);
    now = await menuScreen(herdr, paneId);
  }
  // An answer can end the agent (Quit, No, exit).
  const agent = (await herdr("agent.get", { target: paneId }).catch(() => null))?.agent;
  const next = parseDialog(now);
  return { status: agent?.agent_status ?? null, dialog: next ? dialogView(next) : null, ...(next ? {} : { screen_tail: lastLines(now, 12) }) };
}

// Presses the keys for options chosen in d, types text for an option that opens a
// field, and reads the result. The caller checked the choice against d.
async function answerMenu(herdr: HerdrCall, paneId: string, d: Dialog, chosen: number[], text?: string) {
  const first = d.options[chosen[0]! - 1]!;
  await press(herdr, paneId, answerKeys(d, chosen));
  // A digit picks the option in most menus, but only moves the cursor in some (Codex's
  // folder trust). Still the same menu, with the cursor on the choice: confirm it.
  // Another menu, like Claude's next question, never gets this enter.
  if (d.style === "numbered" && !d.multi && !first.free_text) {
    await Bun.sleep(timing.text);
    const still = parseDialog(await menuScreen(herdr, paneId));
    const same = still && still.options.map((o) => o.label).join("\n") === d.options.map((o) => o.label).join("\n");
    if (same && still.options[first.n - 1]!.current) await press(herdr, paneId, ["enter"]);
  }
  if (text) await type(herdr, paneId, text);
  // Cursor's "tell the agent what to do instead" field waits for enter; empty skips.
  else if (first.free_text && d.style === "hinted") await type(herdr, paneId, "");
  return await after(herdr, paneId);
}

export interface Approval {
  kind: GoAheadKind;
  option: string;
  menu: string;
}

// Answers the go-ahead menus on an agent's screen, one after another (Codex can open
// on an update notice and then folder trust), and stops at a question, at a menu that
// did not go away, or after five. A menu still up after its keys is not approved, so
// the owner hears of it. waitMs is how long to wait for another process that is
// answering the same pane; busy when it still is. kinds limits which go-aheads to give.
// Each one goes into the audit log, and the last one into Herdr's sidebar for a minute.
export async function approveMenus(
  cfg: GatewayConfig, herdr: HerdrCall, paneId: string, via: string, opts: { waitMs: number; kinds?: GoAheadKind[] },
): Promise<{ approved: Approval[]; status: string | null; busy?: boolean }> {
  const none = { approved: [], status: null };
  if (!cfg.autoApprove) return none;
  const store = new StateStore(cfg.stateDir);
  const res = await store.withPane(paneId, opts.waitMs, async () => {
    const approved: Approval[] = [];
    let status: string | null = null;
    let screen = await menuScreen(herdr, paneId);
    for (let i = 0; i < 5; i++) {
      const d = parseDialog(screen);
      const go = d && !busy(d) ? goAhead(d) : null;
      if (!d || !go || (opts.kinds && !opts.kinds.includes(go.kind))) break;
      const a: Approval = { kind: go.kind, option: d.options[go.option - 1]!.label, menu: menuExcerpt(d) };
      const res = await answerMenu(herdr, paneId, d, [go.option]);
      const took = !res.dialog || res.dialog.text !== d.text;
      store.audit({ op: "auto_approve", ok: took, via, args: { target: paneId, kind: a.kind, option: a.option, menu: d.text.slice(0, 1000) } });
      if (!took) break;
      approved.push(a);
      status = res.status;
      if (!res.dialog) break;
      screen = await menuScreen(herdr, paneId);
    }
    return { approved, status };
  });
  if (res) showApproved(herdr, paneId, res.approved);
  return res ?? { ...none, busy: true };
}

export function answerOps(g: Gateway): Record<string, Op> {
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
      const text = typeof params.text === "string" && params.text.trim() ? oneLine(params.text) : undefined;
      if (text && text.length > g.cfg.maxPromptChars) throw new GatewayError("invalid_params", `text exceeds ${g.cfg.maxPromptChars} characters`);
      // Reads the menu only once no one else is answering it: it may be gone by then.
      const res = await g.state.withPane(agent.pane_id, 20_000, async () => {
        const d = parseDialog(await menuScreen(g.herdr, agent.pane_id));
        if (!d) throw new GatewayError("no_dialog", "the agent is not showing a menu; read_agent to see its screen, or prompt_agent to send it a message");
        const chosen = picks(params, d, text);
        const first = d.options[chosen[0]! - 1]!;
        if (!d.multi) {
          // "No, and tell Codex what to do differently" and "Skip & tell the agent what to do
          // instead" work without text too; Claude's "Type something" does not.
          const declines = /^(?:no\b|skip\b)/i.test(first.label);
          if (first.free_text && !text && !declines) throw new GatewayError("invalid_params", `option ${first.n} ("${first.label}") opens a text field: pass text`);
          if (text && !first.free_text) throw new GatewayError("invalid_params", `option ${first.n} ("${first.label}") takes no text; the options that do are marked free_text`);
        }
        const labels = chosen.map((n) => d.options[n - 1]!.label);
        return { answered: { options: chosen, labels, ...(text ? { text } : {}) }, ...(await answerMenu(g.herdr, agent.pane_id, d, chosen, text)) };
      });
      if (!res) throw new GatewayError("agent_busy", "WorkDone is answering this agent's menu already; read_agent again in a few seconds");
      return res;
    },

    // A message for an agent that is working. An idle agent just gets it as a prompt.
    async steer_agent(params) {
      const agent = await g.scopedAgent(str(params, "target", TARGET_RE));
      const text = oneLine(str(params, "text"));
      if (text.length > g.cfg.maxPromptChars) throw new GatewayError("invalid_params", `text exceeds ${g.cfg.maxPromptChars} characters`);
      if (agent.agent_status !== "working") {
        if (agent.agent_status === "blocked") throw new GatewayError("agent_blocked", "the agent is showing a menu: answer it with answer_agent first (choices.go_ahead is the option that lets it carry on)");
        return { steered: false, prompted: true, result: await g.handle("prompt_agent", { target: agent.pane_id, text }) };
      }
      // A menu can come up between Herdr's status and the keys: enter would answer it.
      const d = parseDialog(await menuScreen(g.herdr, agent.pane_id));
      if (d) throw new GatewayError("agent_blocked", `the agent is showing a menu: ${lastLines(d.text, 6)}. Answer it with answer_agent first`);
      await g.herdr("pane.send_input", { pane_id: agent.pane_id, text });
      await Bun.sleep(timing.text);
      const enters = STEER_ENTERS[agent.agent] ?? 1;
      for (let i = 0; i < enters; i++) {
        await press(g.herdr, agent.pane_id, ["enter"]);
        if (i + 1 < enters) await Bun.sleep(timing.text);
      }
      const res = await after(g.herdr, agent.pane_id);
      return {
        steered: true,
        delivery: enters > 1 ? "sent now" : "queued: it reaches the agent after its current tool call",
        ...res,
      };
    },
  };
}
