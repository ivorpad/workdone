// What an agent said, kept whole. A wake, an event or an inbox entry carries a preview
// sized for where it lands (a chat message, a webhook, the console), and the full text
// stays here under the report's event_id, so whoever was woken can read all of it with
// read_message, even after the agent has moved on to another turn. read_agent only
// has the agent's latest turn; a take-over or the owner typing at the terminal replaces it.
//
// One file per message in <stateDir>/messages, written once and never changed. Kept 14
// days (as long as the inbox ages entries out) and at most MAX_KEPT of the newest.

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { GatewayError } from "./config.ts";
import type { Gateway } from "./gateway.ts";
import { optInt, str, type Params } from "./params.ts";

// The most read from a transcript for one answer. An answer longer than this keeps its
// end, and says so (cut_at_source).
export const MESSAGE_CHARS = 1_000_000;
const PAGE_CHARS = 20_000;
const MAX_PAGE_CHARS = 100_000;
const KEEP_MS = 14 * 24 * 3600_000;
const MAX_KEPT = 2000;
export const MESSAGE_ID_RE = /^[\w.:-]{1,100}$/;

export interface StoredMessage {
  id: string;
  at: string;
  // reply: a turn's final answer (finished or question); tell: an agent wrote on purpose;
  // note: the owner typed it in the console; openclaw: an ask_openclaw answer.
  kind: "reply" | "tell" | "note" | "openclaw";
  pane_id: string | null;
  agent: string | null;
  text: string;
  // The source was already cut before it got here: a transcript answer over MESSAGE_CHARS.
  cut_at_source: boolean;
}

// What a report says about the text it previews.
export interface TextRef { text_id: string; text_chars: number }

const dirOf = (stateDir: string) => resolve(stateDir, "messages");
const fileOf = (stateDir: string, id: string) => resolve(dirOf(stateDir), `${encodeURIComponent(id)}.json`);

// Writes the message unless one with this id is already kept, and returns how to point at it.
export function keepMessage(stateDir: string, m: Omit<StoredMessage, "cut_at_source"> & { cut_at_source?: boolean }): TextRef {
  if (!MESSAGE_ID_RE.test(m.id)) throw new Error(`message id ${m.id} is not storable`);
  const dir = dirOf(stateDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = fileOf(stateDir, m.id);
  const ref = { text_id: m.id, text_chars: m.text.length };
  try {
    statSync(file);
    return ref;
  } catch { /* not kept yet */ }
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ ...m, cut_at_source: m.cut_at_source ?? false }), { mode: 0o600 });
  renameSync(tmp, file);
  prune(dir);
  return ref;
}

// Never fails the caller: a preview without a full copy is what there was before.
export function tryKeep(stateDir: string, m: Parameters<typeof keepMessage>[1]): TextRef | null {
  try {
    return keepMessage(stateDir, m);
  } catch {
    return null;
  }
}

function prune(dir: string, now = Date.now()) {
  let files: Array<{ path: string; at: number }>;
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => {
      const path = resolve(dir, f);
      return { path, at: statSync(path).mtimeMs };
    });
  } catch {
    return;
  }
  if (files.length <= MAX_KEPT && files.every((f) => now - f.at < KEEP_MS)) return;
  files.sort((a, b) => b.at - a.at);
  files.forEach((f, i) => {
    if (i >= MAX_KEPT || now - f.at >= KEEP_MS) rmSync(f.path, { force: true });
  });
}

export function hasMessage(stateDir: string, id: string): boolean {
  return MESSAGE_ID_RE.test(id) && existsSync(fileOf(stateDir, id));
}

export function readMessage(stateDir: string, id: string): StoredMessage | null {
  if (!MESSAGE_ID_RE.test(id)) return null;
  try {
    return JSON.parse(readFileSync(fileOf(stateDir, id), "utf8")) as StoredMessage;
  } catch {
    return null;
  }
}

export function messageOps(g: Gateway) {
  return {
    // Read-only, like read_agent: no lease, since anything an agent says can already be read from its pane.
    async read_message(params: Params) {
      const id = str(params, "id", MESSAGE_ID_RE);
      const m = readMessage(g.cfg.stateDir, id);
      if (!m) throw new GatewayError("not_found", `no message ${id} on this machine: it is older than 14 days, or the id is from another machine`);
      const offset = optInt(params, "offset", 0, Number.MAX_SAFE_INTEGER) ?? 0;
      const max = optInt(params, "max_chars", 1, MAX_PAGE_CHARS) ?? PAGE_CHARS;
      const text = m.text.slice(offset, offset + max);
      const next = offset + text.length < m.text.length ? offset + text.length : null;
      return {
        id: m.id, at: m.at, kind: m.kind, pane_id: m.pane_id, agent: m.agent,
        chars: m.text.length, offset, text, next_offset: next,
        ...(m.cut_at_source ? { cut_at_source: true, note: `the answer was longer than ${MESSAGE_CHARS} characters; this is its end` } : {}),
      };
    },
  };
}
