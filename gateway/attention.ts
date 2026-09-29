// What an agent needs from its owner, and the one-line excerpts that go into phone
// notifications. Herdr's status says when a dialog is up (blocked); whether an agent
// that stopped is asking something comes from the end of its last answer. A wrong
// guess only changes the wording of a notification, never whether one is sent.

import type { Dialog } from "./dialog.ts";

export type Attention = "dialog" | "question" | null;

const SETTLED = new Set(["idle", "done"]);

// Wording that hands a decision or a question to the owner.
const ASK_RE =
  /\b(?:should I|shall I|do you want|would you like|want me to|which (?:one|option|approach|do you|would you)|(?:can|could) you (?:confirm|approve|decide|clarify)|please (?:confirm|choose|decide|approve|advise|clarify|let me know)|let me know (?:if|whether|which|how|what)|(?:awaiting|waiting for|need|needs) (?:your|a) (?:decision|input|answer|approval|confirmation|go-ahead|call)|decision (?:needed|required)|(?:it'?s|that'?s) your call|before I (?:proceed|continue|go ahead))\b/i;

// Markdown emphasis, quotes or brackets that can follow a closing question mark.
const ENDS_WITH_QUESTION = /\?[\s"'`)\]*_]*$/;

// The last two paragraphs, where an answer that waits on the owner says so.
function tail(text: string): string[] {
  const paragraphs = text.trim().split(/\n\s*\n/);
  return paragraphs.slice(-2).join("\n").slice(-800).split("\n").map((l) => l.trim()).filter(Boolean);
}

export function asksOwner(text: string): boolean {
  return tail(text).some((l) => ENDS_WITH_QUESTION.test(l) || ASK_RE.test(l));
}

export function attentionOf(status: unknown, text: string | null | undefined): Attention {
  if (status === "blocked") return "dialog";
  return SETTLED.has(status as string) && text && asksOwner(text) ? "question" : null;
}

// ---------- excerpts ----------

// Values that look like credentials. Notifications leave the machine through Pushover.
const SECRETS: Array<[RegExp, string]> = [
  [/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g, "[redacted]"],
  [/\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{10,}/g, "[redacted]"],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, "[redacted]"],
  [/\bglpat-[A-Za-z0-9_-]{20,}/g, "[redacted]"],
  [/\bnpm_[A-Za-z0-9]{30,}/g, "[redacted]"],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, "[redacted]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[redacted]"],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, "[redacted]"],
  [/\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/g, "[redacted]"],
  // user:password@ in a URL.
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+@/gi, "$1[redacted]@"],
  [/\b(bearer)\s+[A-Za-z0-9._~+/-]{8,}=*/gi, "$1 [redacted]"],
  // NAME=value where the name says what it is: DB_PASSWORD=, GITHUB_TOKEN=, X-Api-Key:.
  [/((?<![A-Za-z0-9])[A-Za-z0-9_-]*(?:token|password|passwd|secret|api[_-]?key|access[_-]?key|[_-]key)[A-Za-z0-9_]*)(["']?\s*[:=]\s*)["']?[^\s"',]{6,}/gi, "$1$2[redacted]"],
  // Long unbroken runs of letters and digits: hex digests, most API keys.
  [/\b[A-Za-z0-9]{32,}\b/g, "[redacted]"],
];

export function redact(text: string): string {
  return SECRETS.reduce((t, [re, to]) => t.replace(re, to), text);
}

// Box drawing, block elements and table pipes: terminal UI, not content.
const BOX = /[│┃║|┌┐└┘├┤┬┴┼─━═╭╮╯╰▄▀▔▁]+/g;

function plain(text: string): string {
  return text
    .replace(/^\s*```.*$/gm, "")
    .replace(/^\s*#{1,6}\s+/gm, "")
    .replace(/^\s*[-*•]\s+/gm, "")
    .replace(/\*\*|__/g, "")
    .replace(/`([^`\n]*)`/g, "$1")
    .replace(/\[([^\]\n]+)\]\([^)\n]+\)/g, "$1")
    .replace(BOX, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function clip(text: string, max: number, keep: "start" | "end"): string {
  if (text.length <= max) return text;
  return keep === "start" ? text.slice(0, max - 1).trimEnd() + "…" : "…" + text.slice(text.length - max + 1).trimStart();
}

const EXCERPT_CHARS = 200;

// A question is quoted from where it is asked; a finished answer from its start, which is usually the summary.
export function replyExcerpt(text: string, asks: boolean): string {
  if (asks) {
    const lines = tail(text);
    let at = -1;
    for (let i = lines.length - 1; i >= 0 && at < 0; i--) if (ENDS_WITH_QUESTION.test(lines[i]!) || ASK_RE.test(lines[i]!)) at = i;
    return clip(redact(plain(lines.slice(Math.max(0, at - 1), at + 1).join("\n"))), EXCERPT_CHARS, "end");
  }
  return clip(redact(plain(text)), EXCERPT_CHARS, "start");
}

const RULE_RE = /^\s*[╭┌╰└]?[─━═▀▄▔▁]{20,}[╮┐╯┘]?\s*$/;
// Footer hints that many agent UIs print under their input box.
const HINT_RE = /\? for shortcuts|esc to (?:interrupt|cancel)|ctrl\+c to|⏎ send|context left|shift\+tab to/i;

// The agent's own output at the bottom of a screen, without the input box and footer
// under it: the lines above the topmost horizontal rule among the last 15 lines.
export function screenReply(screen: string): string {
  const lines = screen.replace(/\s+$/, "").split("\n");
  let cut = lines.length;
  for (let i = Math.max(0, lines.length - 15); i < lines.length; i++) {
    if (RULE_RE.test(lines[i]!)) {
      cut = i;
      break;
    }
  }
  return lines
    .slice(0, cut)
    .filter((l) => l.trim() && !HINT_RE.test(l))
    .slice(-8)
    .join("\n");
}

// Lines of a menu that are not what it is about: key hints, and the agent's own
// output above it ("• Running touch …"), and the dashed box around a diff.
const MENU_NOISE_RE = /^[•⏺✻⎿]|^[╌─━]+$|esc to |enter to |enter continue|enter\/esc|press enter|tab to amend|arrow keys|↑\/↓|ctrl\+|shift\+tab|esc (?:back|quit|skip)/i;

// What a menu asks about, for the record of what WorkDone answered: its header, the
// command or file, and the question, without the options.
export function menuExcerpt(d: Dialog): string {
  const labels = new Set(d.options.map((o) => o.label.replace(/\s+/g, " ")));
  const option = (line: string) => {
    const bare = line.replace(/^[❯›>▶→]\s*/, "").replace(/^\d{1,2}\.\s+(?:\[[ ✔✓xX]\]\s+)?|^\[[a-z]\]\s+/, "");
    return labels.has(bare) || labels.has(bare.replace(/\s+\([a-z+ ]+\)$/, ""));
  };
  const lines = d.text.split("\n").map((l) => l.replace(/\s+/g, " ").trim()).filter((l) => l && !MENU_NOISE_RE.test(l) && !option(l));
  return clip(lines.map((l) => clip(redact(l), 120, "start")).join(" / "), EXCERPT_CHARS + 40, "start");
}

// A dialog's question with two lines either side: the command or file, the first options.
export function dialogExcerpt(screen: string): string {
  const lines = screen.split("\n").map((l) => l.replace(BOX, " ").replace(/\s+/g, " ").trim()).filter(Boolean).slice(-12);
  let q = -1;
  for (let i = lines.length - 1; i >= 0 && q < 0; i--) if (lines[i]!.includes("?")) q = i;
  const picked = q >= 0 ? lines.slice(Math.max(0, q - 2), q + 3) : lines.slice(-5);
  // Redact whole lines: clipping first could cut a key below the length the patterns need.
  return clip(picked.map((l) => clip(redact(l), 100, "start")).join(" / "), EXCERPT_CHARS + 40, "start");
}

// Startup dialogs a Herdr manifest can miss, so the agent reads as idle: Cursor's
// workspace trust prompt is one. Text typed into one answers it. The dialog sits at
// the bottom of the screen and is still open while no input box has been drawn under
// it. Callers check Cursor agents only: other agents draw other input boxes.
const DIALOG_RE = /Workspace Trust Required|Do you trust the (?:contents|files) (?:of|in) this (?:directory|folder)\?|\[a\] Trust this workspace/i;
const INPUT_RULE_RE = /^\s*(?:[▄▀]{20,}|[─━]{20,})\s*$/;

export function openDialog(screen: string): string | null {
  const lines = screen.replace(/\s+$/, "").split("\n");
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 20); i--) {
    if (INPUT_RULE_RE.test(lines[i]!)) return null;
    if (DIALOG_RE.test(lines[i]!)) return dialogExcerpt(lines.slice(Math.max(0, i - 12)).join("\n"));
  }
  return null;
}
