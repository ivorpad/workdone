// Menus that agent CLIs draw at the bottom of their screen: approvals, questions,
// folder trust, update prompts. parseDialog reads one into numbered options, and
// selectKeys says what to press for each, because the CLIs differ:
//
//   Claude Code  ❯ 1. Yes            digit picks it, and submits a single question
//                ❯ No, exit          no numbers (folder trust): arrows, then enter
//                ❯ 1. [ ] Cheese     a multi-select: digits toggle, tab moves on
//   Codex        › 1. Trust ...      digit picks it
//   Cursor       → Run (once) (y)    the key in parentheses
//                ▶ [a] Trust ...     the letter in brackets
//
// Herdr flags most of these as blocked, but not all: Codex's folder trust, update and
// model notices, and Cursor's folder trust, read as idle. goAhead says which menus
// only ask for a go-ahead, and which option gives it.

import { gatedBy } from "./gated.ts";

export interface Choice {
  n: number;
  label: string;
  // The cursor is on it.
  current?: boolean;
  // Multi-select only.
  checked?: boolean;
  // Choosing it opens a text field: "Type something", "tell the agent what to do instead".
  free_text?: boolean;
}

export interface Dialog {
  // The dialog as drawn, from its first line to its hints.
  text: string;
  options: Choice[];
  multi: boolean;
  free_text: boolean;
  style: "numbered" | "lettered" | "hinted" | "plain";
  // Per option: letters go in as typed text, anything else as a Herdr key.
  keys: string[][];
}

// Characters a CLI draws in front of the option the cursor is on.
const MARK = "[❯›>▶→]";
const NUM_RE = new RegExp(`^(${MARK}\\s*)?(\\d{1,2})\\.\\s+(?:\\[([ ✔✓xX])\\]\\s+)?(\\S.*)$`);
const LET_RE = new RegExp(`^(${MARK}\\s*)?\\[([a-z])\\]\\s+(\\S.*)$`);
const HINT_RE = new RegExp(`^(${MARK}\\s*)?(\\S.*?)\\s+\\(([a-z+ ]+)\\)$`);
const MARKED_RE = new RegExp(`^${MARK}\\s+(\\S.*)$`);
// Hint lines under a menu. Idle input boxes and status lines never say these.
const FOOTER_RE = /enter to (?:select|confirm)|press enter to confirm|enter continue|enter\/esc confirm|arrow keys to navigate|↑\/↓ to navigate|esc to cancel/i;
const RULE_RE = /^[─━═▄▀]{10,}$/;
const FREE_TEXT_RE = /^type something\.?$|tell (?:the agent|codex|claude)? ?what to (?:do|change)|what to do (?:instead|differently)/i;

// A screen line without the box it may be drawn in.
function unbox(line: string): string {
  return line.replace(/^\s*[│┃║]\s?/, "").replace(/\s*[│┃║]\s*$/, "").trim();
}

function region(lines: string[], first: number, last: number): string {
  let start = first;
  for (let i = first - 1; i >= Math.max(0, first - 12); i--) {
    if (RULE_RE.test(lines[i]!) || /^[╭┌]/.test(lines[i]!)) break;
    start = i;
  }
  let end = last;
  for (let i = last + 1; i < Math.min(lines.length, last + 6); i++) if (lines[i] && !RULE_RE.test(lines[i]!)) end = i;
  return lines.slice(start, end + 1).filter((l) => l && !RULE_RE.test(l) && !/^[╭╮╰╯└┘┌┐─]+$/.test(l)).join("\n");
}

type Found = { d: Dialog; last: number } | null;

function numbered(lines: string[]): Found {
  // The last "1." with a cursor on one of its options, then 2, 3, ... below it.
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i]!.match(NUM_RE);
    if (!m || m[2] !== "1") continue;
    const found: Array<{ at: number; m: RegExpMatchArray }> = [{ at: i, m }];
    for (let j = i + 1; j < lines.length; j++) {
      const k = lines[j]!.match(NUM_RE);
      if (k && Number(k[2]) === found.length + 1) found.push({ at: j, m: k });
    }
    if (found.length < 2 || !found.some((f) => f.m[1])) return null;
    const multi = found.some((f) => f.m[3] !== undefined);
    const options = found.map(({ m }, idx) => {
      const c: Choice = { n: idx + 1, label: m[4]!.trim() };
      if (m[1]) c.current = true;
      if (multi && m[3] !== undefined) c.checked = m[3] !== " ";
      if (FREE_TEXT_RE.test(c.label.replace(/\s*\((?:esc|[a-z])\)$/, ""))) c.free_text = true;
      return c;
    });
    const last = found.at(-1)!.at;
    return {
      last,
      d: {
        text: region(lines, i, last), options, multi, free_text: options.some((o) => o.free_text),
        style: "numbered", keys: options.map((o) => [String(o.n)]),
      },
    };
  }
  return null;
}

function lettered(lines: string[]): Found {
  let last = -1;
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 20); i--) if (LET_RE.test(lines[i]!)) { last = i; break; }
  if (last < 0) return null;
  let first = last;
  while (first > 0 && LET_RE.test(lines[first - 1]!)) first--;
  const block = lines.slice(first, last + 1).map((l) => l.match(LET_RE)!);
  if (block.length < 2) return null;
  const options = block.map((m, idx) => ({ n: idx + 1, label: m[3]!.trim(), ...(m[1] ? { current: true } : {}) }));
  return {
    last,
    d: { text: region(lines, first, last), options, multi: false, free_text: false, style: "lettered", keys: block.map((m) => [m[2]!]) },
  };
}

// Cursor's approval: "→ Run (once) (y)", one option per line, the key at the end.
function hinted(lines: string[]): Found {
  let last = -1;
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 8); i--) if (HINT_RE.test(lines[i]!)) { last = i; break; }
  if (last < 0) return null;
  let first = last;
  while (first > 0 && HINT_RE.test(lines[first - 1]!)) first--;
  const block = lines.slice(first, last + 1).map((l) => l.match(HINT_RE)!);
  if (block.length < 2 || !block.some((m) => m[1])) return null;
  const options = block.map((m, idx) => {
    const c: Choice = { n: idx + 1, label: m[2]!.trim() };
    if (m[1]) c.current = true;
    if (FREE_TEXT_RE.test(c.label)) c.free_text = true;
    return c;
  });
  // "esc or n": prefer the letter, which cannot also cancel something else.
  const keyOf = (hint: string) => {
    const alts = hint.split(/\s+or\s+/).map((s) => s.trim());
    return alts.find((a) => /^[a-z]$/.test(a)) ?? alts[0]!;
  };
  return {
    last,
    d: {
      text: region(lines, first, last), options, multi: false, free_text: options.some((o) => o.free_text),
      style: "hinted", keys: block.map((m) => [keyOf(m[3]!)]),
    },
  };
}

// Claude Code's folder trust: "❯ No, exit" over "  Yes, I trust this folder", no numbers.
function plain(lines: string[]): Found {
  const footer = lines.findLastIndex((l) => FOOTER_RE.test(l));
  if (footer < 0) return null;
  const cur = lines.slice(0, footer).findLastIndex((l) => MARKED_RE.test(l));
  if (cur < 0 || footer - cur > 8) return null;
  let first = cur;
  while (first > 0 && lines[first - 1] && !/[?:]$/.test(lines[first - 1]!)) first--;
  let last = cur;
  while (last + 1 < footer && lines[last + 1]) last++;
  const block = lines.slice(first, last + 1);
  if (block.length < 2) return null;
  const now = cur - first;
  const options = block.map((l, idx) => ({ n: idx + 1, label: l.replace(new RegExp(`^${MARK}\\s+`), ""), ...(idx === now ? { current: true } : {}) }));
  const keys = options.map((_, idx) => [...Array(Math.abs(idx - now)).fill(idx > now ? "down" : "up"), "enter"]);
  return { last, d: { text: region(lines, first, footer), options, multi: false, free_text: false, style: "plain", keys } };
}

// An empty input box, or one with a CLI's placeholder in it.
const INPUT_RE = /^[❯›→]\s*$|^[❯›→] (?:Try "|Ask Codex|Add a follow-up|Plan, search)/;

// The menu at the bottom of the screen, or null. An input box below the last option
// means the menu was answered and is only scrollback.
export function parseDialog(screen: string): Dialog | null {
  const lines = screen.replace(/\s+$/, "").split("\n").slice(-45).map(unbox);
  const found = numbered(lines) ?? hinted(lines) ?? lettered(lines) ?? plain(lines);
  if (!found) return null;
  if (lines.slice(found.last + 1).some((l) => INPUT_RE.test(l))) return null;
  return found.d;
}

// Keys for one answer: the option's own keys, or for a multi-select the digits that
// flip each option whose box is not already as wanted, then tab to the next step.
export function answerKeys(d: Dialog, pick: number[]): string[] {
  if (!d.multi) return d.keys[pick[0]! - 1]!;
  const want = new Set(pick);
  const flips = d.options.filter((o) => o.checked !== undefined && o.checked !== want.has(o.n)).map((o) => String(o.n));
  return [...flips, "tab"];
}

// ---------- go-ahead menus ----------

// Most menus only ask for a go-ahead: run this command, make this edit, trust this
// folder, update now. WorkDone gives it so an agent never waits on one, and leaves
// questions (the owner's decisions) alone. The option taken is the one that lets the
// agent carry on and changes nothing else: allow once, not "don't ask again" or an
// allowlist; skip an update rather than install it; keep the model an alias pins.
export type GoAheadKind = "permission" | "trust" | "notice";

export interface GoAhead {
  kind: GoAheadKind;
  option: number;
}

// Claude's questions offer "Type something" and "Chat about this" and end in a review
// step; Codex's say "submit answer".
const QUESTION_OPTION_RE = /^(?:type something|chat about this|submit answers?)\b/i;
const QUESTION_TEXT_RE = /submit (?:answer|all)|review your answers/i;
const TRUST_TEXT_RE = /\btrust this (?:folder|workspace)\b|do you trust the (?:contents|files)|one you trust\?/i;
const TRUST_OPTION_RE = /^(?:yes, i trust|(?:\[[a-z]\] )?trust)\b/i;
const PERMISSION_TEXT_RE =
  /\b(?:do you want|would you like) to (?:proceed|make|create|allow|run|write|delete|overwrite|apply|edit)\b|\b(?:run this command|write to this file|allow command|run a dynamic workflow)\?/i;
export const APPROVE_RE = /^(?:yes\b|proceed\b|run \(once\)|allow\b|approve\b)/i;
const DECLINE_RE = /^(?:no\b|skip\b|reject\b|deny\b|decline\b|cancel\b)/i;
// Answers that outlast this one request.
const PERSIST_RE = /don['’]t ask again|allowlist|always allow|run everything/i;

export function goAhead(d: Dialog): GoAhead | null {
  const text = d.text.replace(/\s+/g, " ");
  const labels = d.options.map((o) => o.label);
  const find = (re: RegExp) => d.options.find((o) => re.test(o.label))?.n ?? null;
  if (d.multi || labels.some((l) => QUESTION_OPTION_RE.test(l)) || QUESTION_TEXT_RE.test(text)) return null;
  if (TRUST_TEXT_RE.test(text)) {
    const n = find(TRUST_OPTION_RE);
    return n ? { kind: "trust", option: n } : null;
  }
  // Codex at startup: an update, or a model about to retire.
  if (labels.some((l) => /^update now\b/i.test(l))) {
    const n = find(/^skip\b/i);
    return n ? { kind: "notice", option: n } : null;
  }
  if (labels.some((l) => /^try new model\b/i.test(l))) {
    const n = find(/^use existing model\b/i);
    return n ? { kind: "notice", option: n } : null;
  }
  if (!PERMISSION_TEXT_RE.test(text) || !d.options.some((o) => DECLINE_RE.test(o.label) || o.free_text)) return null;
  // A push, merge, deletion or deploy is the owner's call, whatever the menu looks like.
  if (gatedBy(d.text)) return null;
  const n = d.options.find((o) => APPROVE_RE.test(o.label) && !PERSIST_RE.test(o.label))?.n;
  return n ? { kind: "permission", option: n } : null;
}
