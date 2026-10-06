import { closeSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { Binding, CommandReceipt, Dispatch, Receipt } from "./coord.ts";

export const STATE_FILES = ["created-panes.json", "created-tabs.json", "created-workspaces.json", "exec-workspace.json", "told.json", "leases.json", "watch.json", "supervisor.json", "coord.json", "outbox.json", "inbox.json"] as const;
const files = new Set<string>(STATE_FILES);
const object = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every(s => typeof s === "string");
const integer = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0;
const nullableString = (v: unknown) => v === null || typeof v === "string";
const optional = (v: Record<string, any>, key: string, check: (value: unknown) => boolean) => !Object.hasOwn(v, key) || check(v[key]);
const nonempty = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
const hash = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const timestamp = (v: unknown): v is string => typeof v === "string" && Number.isFinite(Date.parse(v));
const commandId = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_.:-]{1,80}$/.test(v);
function watched(v: unknown) {
  if (!object(v)) return false;
  return ["name", "cwd", "kind", "session"].every(k => optional(v, k, nullableString))
    && ["since", "last_status", "prompted_at", "rev", "dialog_id", "reply_to"].every(k => optional(v, k, x => typeof x === "string"))
    && ["managed", "busy"].every(k => optional(v, k, x => typeof x === "boolean"))
    && optional(v, "seq", integer)
    && optional(v, "result_request", r => object(r) && typeof r.id === "string" && typeof r.at === "string" && nullableString(r.lease));
}
const taskStatus = (v: unknown) => ["queued", "executing", "waiting_dependency", "verifying", "blocked", "complete"].includes(v as string);
const record = (v: unknown, check: (v: unknown) => boolean) => object(v) && Object.values(v).every(check);
function receipt(v: unknown): v is Receipt {
  // Null hashes are the supported migration of old report_ids, not absent receipts.
  return object(v) && (v.hash === null || hash(v.hash)) && timestamp(v.at) && integer(v.version) && taskStatus(v.status);
}
function receipts(v: unknown) {
  return object(v) && Object.entries(v).every(([id, r]) => commandId(id) && receipt(r));
}
function dispatch(v: unknown): v is Dispatch {
  // prev is a saved dispatch restored on a definitive refusal. Walk it without
  // recursion so malformed nesting cannot overflow before we refuse the store.
  const seen = new Set<unknown>();
  while (v !== null) {
    if (!object(v) || seen.has(v) || !commandId(v.command_id) || !["sending", "delivered", "unknown", "lost"].includes(v.state) || !timestamp(v.at)) return false;
    seen.add(v);
    if (!Object.hasOwn(v, "prev")) return true;
    v = v.prev;
  }
  return seen.size > 0;
}
function commandReceipt(v: unknown): v is CommandReceipt {
  return object(v) && ["pane_id", "objective", "task", "binding_id"].every(k => nonempty(v[k])) && hash(v.hash) && timestamp(v.at)
    && ["sending", "delivered", "refused", "unknown", "lost", "superseded"].includes(v.state);
}
function binding(v: unknown): v is Binding {
  return object(v) && nonempty(v.id) && typeof v.token === "string" && /^wdt_[A-Za-z0-9_-]{20,80}$/.test(v.token)
    && hash(v.token_hash) && v.token_hash === createHash("sha256").update(v.token).digest("hex") && nonempty(v.pane_id)
    && (v.session === null || nonempty(v.session)) && integer(v.generation) && v.generation > 0 && timestamp(v.issued_at)
    && (v.prompted_at === null || timestamp(v.prompted_at)) && (v.last_report_at === null || timestamp(v.last_report_at))
    && optional(v, "dispatch", d => d === null || dispatch(d)) && optional(v, "receipts", receipts);
}
function task(v: unknown, id: string) {
  if (!object(v)) return false;
  return v.id === id && taskStatus(v.status) && integer(v.version) && integer(v.generation) && optional(v, "progress", integer)
    && ["deps", "acceptance", "evidence", "artifacts", "waiting_for"].every(k => strings(v[k]))
    && ["title", "created_at", "updated_at"].every(k => typeof v[k] === "string")
    && nullableString(v.blocker) && nullableString(v.blocker_kind) && nullableString(v.next_action) && nullableString(v.protocol)
    && (v.owner === null || (object(v.owner) && typeof v.owner.name === "string" && nullableString(v.owner.pane_id)))
    && (v.binding === null || (binding(v.binding) && v.binding.generation === v.generation))
    && (v.result === null || (object(v.result) && typeof v.result.summary === "string" && nullableString(v.result.commit) && typeof v.result.at === "string"))
    && optional(v, "pending", p => p === null || (object(p) && commandId(p.command_id) && timestamp(p.at) && binding(p.binding)
      && p.binding.generation === v.generation + 1 && optional(p, "name", nullableString)))
    && optional(v, "receipts", receipts) && optional(v, "report_ids", r => strings(r) && r.every(commandId));
}
function attempts(v: Record<string, any>) {
  const bindings = new Map<string, { objective: string; task: string; binding: Binding }>();
  for (const o of Object.values<any>(v.objectives)) for (const t of Object.values<any>(o.tasks)) {
    // Baseline v2 had neither field. New attempt markers require their registry;
    // deleting it must not turn a modern store into a receipt-free legacy import.
    if ((Object.hasOwn(t, "pending") || (t.binding && Object.hasOwn(t.binding, "dispatch"))) && !Object.hasOwn(v, "commands")) return false;
    for (const b of [t.binding, t.pending?.binding]) if (b) {
      if (bindings.has(b.id)) return false;
      bindings.set(b.id, { objective: o.id, task: t.id, binding: b });
    }
    if (Object.hasOwn(v, "commands")) {
      const matches = (id: string, b: Binding, state: string) => {
        const r = Object.hasOwn(v.commands, id) ? v.commands[id] : null;
        return r && r.objective === o.id && r.task === t.id && r.binding_id === b.id && r.pane_id === b.pane_id && r.state === state;
      };
      if (t.pending && !matches(t.pending.command_id, t.pending.binding, "sending")) return false;
      if (t.binding?.dispatch && !matches(t.binding.dispatch.command_id, t.binding, t.binding.dispatch.state)) return false;
    }
  }
  for (const [pane, id] of Object.entries(v.current ?? {})) {
    const b = bindings.get(id as string);
    // Removed/reassigned bindings leave historical map entries. If the binding
    // still exists, its pane must agree; never attribute another pane's task.
    if (!nonempty(pane) || (b && b.binding.pane_id !== pane)) return false;
  }
  for (const r of Object.values<any>(v.commands ?? {})) {
    const b = bindings.get(r.binding_id);
    // Expired-attempt receipts may remain until the next command compacts them.
    if (b && (b.objective !== r.objective || b.task !== r.task || b.binding.pane_id !== r.pane_id)) return false;
  }
  return true;
}
function coordination(v: unknown) {
  if (!object(v) || v.version !== 2 || !object(v.objectives) || !optional(v, "resources", object) || !optional(v, "resource_generations", object)
    || !optional(v, "current", c => record(c, nonempty)) || !optional(v, "commands", c => object(c) && Object.entries(c).every(([id, r]) => commandId(id) && commandReceipt(r)))) return false;
  return Object.entries(v.objectives).every(([id, o]) => object(o) && o.id === id && object(o.tasks) && Array.isArray(o.transitions) && integer(o.version) && integer(o.next_seq) && integer(o.acked_seq)
    && typeof o.title === "string" && nullableString(o.repo) && nullableString(o.supervisor) && typeof o.created_at === "string" && typeof o.updated_at === "string"
    && o.transitions.every((tr: unknown) => object(tr) && integer(tr.seq) && typeof tr.at === "string" && typeof tr.task === "string" && typeof tr.kind === "string" && nullableString(tr.detail) && optional(tr, "objective", x => typeof x === "string"))
    && Object.entries(o.tasks).every(([id, t]) => task(t, id)))
    && Object.values(v.resources ?? {}).every(r => object(r) && typeof r.objective === "string" && typeof r.task === "string" && integer(r.generation) && nullableString(r.pane_id) && nullableString(r.session) && nullableString(r.stale_since) && typeof r.acquired_at === "string" && typeof r.renewed_at === "string" && optional(r, "binding", b => b === null || nonempty(b)))
    && Object.values(v.resource_generations ?? {}).every(integer) && attempts(v);
}
export function validateState(file: string, value: unknown) {
  let valid = false;
  if (file.startsWith("created-")) valid = strings(value);
  else if (file === "told.json") valid = Array.isArray(value) && value.every(v => object(v) && nullableString(v.pane_id) && typeof v.text === "string" && typeof v.at === "string" && optional(v, "event_id", x => typeof x === "string") && optional(v, "objective", x => typeof x === "string") && optional(v, "recipient_lease", x => typeof x === "string") && optional(v, "transition", t => object(t) && typeof t.task === "string" && integer(t.seq) && typeof t.kind === "string"));
  else if (file === "outbox.json") valid = Array.isArray(value) && value.every(v => object(v) && typeof v.event_id === "string" && nullableString(v.pane_id) && typeof v.type === "string" && typeof v.message === "string" && nullableString(v.agent) && nullableString(v.kind) && nullableString(v.cwd) && nullableString(v.excerpt) && nullableString(v.lease) && nullableString(v.reply_to));
  else if (file === "inbox.json") valid = Array.isArray(value) && value.every(v => object(v) && nonempty(v.id) && ["tell", "result", "finished", "gone", "question"].includes(v.kind) && timestamp(v.at) && nullableString(v.pane_id) && nullableString(v.agent) && typeof v.text === "string" && (v.status === "unanswered" || v.status === "answered" || v.status === "dismissed") && optional(v, "resolved_at", timestamp) && optional(v, "resolved_by", x => typeof x === "string"));
  else if (file === "exec-workspace.json") valid = object(value) && typeof value.id === "string";
  else if (file === "coord.json") valid = coordination(value);
  else if (file === "leases.json") valid = object(value) && Object.values(value).every(v => object(v) && Array.isArray(v.panes) && v.panes.every((p: unknown) => typeof p === "string") && typeof v.used === "string");
  else if (file === "supervisor.json") valid = object(value) && Object.values(value).every(v => object(v) && Array.isArray(v.turns) && Array.isArray(v.nudges));
  else if (file === "watch.json") valid = object(value) && Object.values(value).every(watched);
  if (!files.has(file) || !valid) throw new Error(`Invalid gateway state: ${file}`);
}
export function readState(dir: string, file: string): unknown {
  let text: string;
  try { text = readFileSync(resolve(dir, file), "utf8"); }
  catch (err: any) { if (err.code === "ENOENT") return undefined; throw err; }
  const value = JSON.parse(text);
  validateState(file, value);
  return value;
}
function syncDir(dir: string) {
  const fd = openSync(dir, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function replace(dir: string, file: string, value: unknown) {
  const path = resolve(dir, file);
  const tmp = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(tmp, "wx", 0o600);
  try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd); }
  finally { closeSync(fd); }
  renameSync(tmp, path);
}
// A committed redo record is the authority until every file has been installed.
// Readers hold the same lock and recover first, so no reader sees half a commit.
export function recoverState(dir: string) {
  let raw: string;
  try { raw = readFileSync(resolve(dir, "transaction.json"), "utf8"); }
  catch (err: any) { if (err.code === "ENOENT") return; throw err; }
  const journal = JSON.parse(raw);
  if (!object(journal) || journal.version !== 1 || !object(journal.writes) || !Object.keys(journal.writes).length) throw new Error("Invalid gateway transaction journal");
  for (const [file, value] of Object.entries(journal.writes)) validateState(file, value);
  for (const [file, value] of Object.entries(journal.writes)) replace(dir, file, value);
  syncDir(dir);
  unlinkSync(resolve(dir, "transaction.json"));
  syncDir(dir);
}
export function commitState(dir: string, writes: Map<string, unknown>) {
  if (!writes.size) return;
  for (const [file, value] of writes) validateState(file, value);
  replace(dir, "transaction.json", { version: 1, writes: Object.fromEntries(writes) });
  syncDir(dir);
  recoverState(dir);
}
