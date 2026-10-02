#!/usr/bin/env bun
// Writes the agentModels file from the models this machine's agent CLIs offer: per CLI,
// one entry per model family ("opus", "sol", "grok"), always the family's newest version.
// A family whose newest version is a generation behind its vendor's newest is left out
// (Codex's gpt-5.5 once gpt-6 is out). Rerun it when a CLI adds models.
//
// usage: bun scripts/agent-models.ts [FILE]     (default ~/.config/herdr-chatgpt/agent-models.json)
//   Claude Code: CLAUDE_CODE below, pinned by full ID, with --effort.
//   Codex: `codex debug models`, with -c model_reasoning_effort.
//   Cursor: `cursor-agent models`, where the effort is part of the model ID.
//   OpenCode: `opencode models openrouter`, OpenRouter's ~vendor/family-latest IDs.
//   pi: `pi --list-models openrouter`, the same IDs, with --thinking where a model thinks.
// Other CLIs Herdr can start run on their own default model and need no entry.
//
// A vendor's models go through its own CLI when that CLI is installed: Claude models
// only in Claude Code, GPT models only in Codex. Without it, the other CLIs offer them.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

interface Model {
  model: string;
  args: string[];
  efforts?: Record<string, string>;
  effort?: string;
  default?: boolean;
}
type ModelList = Record<string, Record<string, Model>>;

// Every agent starts with full access: no permission or approval prompts, no sandbox.
// What stays the owner's call is enforced where agents can't turn it off: GitHub branch
// protection, and the gateway's gated list for what ChatGPT runs itself.
const FULL_ACCESS: Record<string, string[]> = {
  claude: ["--dangerously-skip-permissions"],
  codex: ["--dangerously-bypass-approvals-and-sandbox"],
  cursor: ["--force", "--trust"],
  opencode: ["--auto"],
  pi: [],
};

// Claude Code has no model list to read. Pinned by full ID so an update to Claude Code's
// own "opus" alias never changes what a name means; update these when a version ships.
const CLAUDE_CODE: Array<[name: string, model: string]> = [
  ["opus", "claude-opus-5-5"],
  ["fable", "claude-fable-5-1"],
  ["sonnet", "claude-sonnet-5-5"],
];
const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const PI_EFFORTS = ["low", "medium", "high", "xhigh", "max"];

// The model a CLI starts when ChatGPT names only the CLI. Others start on their own default.
const DEFAULT_MODEL: Record<string, string> = { claude: "opus", codex: "sol", cursor: "auto" };

const has = (exe: string) => Bun.which(exe) !== null;

function run(cmd: string[]): string | null {
  try {
    const p = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "ignore", timeout: 60_000 });
    return p.exitCode === 0 ? p.stdout.toString() : null;
  } catch {
    return null;
  }
}

const VERSION_RE = /^[vk]?\d+(?:\.\d+)*$/;

// A model ID as its family and version: gpt-6.1-sol is gpt-sol 6.1, claude-opus-5-5 is
// claude-opus 5.5, kimi-k2.7-code is kimi-code 2.7, cursor-grok-4.6 is grok 4.6.
export function familyOf(id: string): { family: string; version: number[] } {
  let tokens = id.split("-");
  if (tokens[0] === "cursor" && tokens.length > 1) tokens = tokens.slice(1);
  const version: number[] = [];
  const rest: string[] = [];
  for (const t of tokens) {
    if (VERSION_RE.test(t)) version.push(...t.replace(/^[vk]/, "").split(".").map(Number));
    else rest.push(t);
  }
  return { family: rest.join("-"), version };
}

const newer = (a: number[], b: number[]) => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  return false;
};

// Of model IDs, the newest of each family, without families a generation behind their
// vendor (the family's first word). Families without a version number are kept.
export function newestPerFamily(ids: string[]): Map<string, string> {
  const best = new Map<string, { id: string; version: number[] }>();
  for (const id of ids) {
    const { family, version } = familyOf(id);
    const cur = best.get(family);
    if (!cur || newer(version, cur.version)) best.set(family, { id, version });
  }
  const top = new Map<string, number>();
  for (const [family, { version }] of best) {
    const vendor = family.split("-")[0]!;
    if (version.length) top.set(vendor, Math.max(top.get(vendor) ?? 0, version[0]!));
  }
  const out = new Map<string, string>();
  for (const [family, { id, version }] of best) {
    if (version.length && version[0]! < (top.get(family.split("-")[0]!) ?? 0)) continue;
    out.set(family, id);
  }
  return out;
}

// The name ChatGPT uses: the family, without the vendor word when the CLI is the vendor's
// own (opus in Claude Code, sol in Codex).
function shortName(family: string, vendor: string): string {
  return family.startsWith(`${vendor}-`) ? family.slice(vendor.length + 1) : family;
}

// Vendors whose models are skipped in other CLIs because their own CLI is installed.
function ownCliVendors(): Set<string> {
  const out = new Set<string>();
  if (has("claude")) out.add("claude").add("anthropic");
  if (has("codex")) out.add("gpt").add("openai");
  return out;
}

function claudeModels(): Record<string, Model> {
  if (!has("claude")) return {};
  return Object.fromEntries(CLAUDE_CODE.map(([name, model]) => [name, {
    model, args: ["--model", model, "--effort", "{effort}", ...FULL_ACCESS.claude!],
    efforts: Object.fromEntries(CLAUDE_EFFORTS.map((e) => [e, e])), effort: "high",
  }]));
}

function codexModels(): Record<string, Model> {
  const out = run(["codex", "debug", "models"]);
  if (!out) return {};
  // codex-auto-review reviews commands for Codex itself; it is not a model to work with.
  const models: any[] = (JSON.parse(out).models ?? []).filter((m: any) => typeof m.slug === "string" && m.slug !== "codex-auto-review");
  const bySlug = new Map(models.map((m) => [m.slug as string, m]));
  const result: Record<string, Model> = {};
  for (const [family, slug] of newestPerFamily([...bySlug.keys()])) {
    const m = bySlug.get(slug)!;
    const levels: string[] = (m.supported_reasoning_levels ?? []).map((l: any) => l.effort ?? l).filter((l: unknown) => typeof l === "string");
    const name = shortName(family, "gpt");
    result[name] = levels.length === 0
      ? { model: slug, args: ["-m", slug, ...FULL_ACCESS.codex!] }
      : {
        model: slug, args: ["-m", slug, "-c", "model_reasoning_effort={effort}", ...FULL_ACCESS.codex!],
        efforts: Object.fromEntries(levels.map((l) => [l, l])),
        effort: levels.includes(m.default_reasoning_level) ? m.default_reasoning_level : levels[0],
      };
  }
  return result;
}

const EFFORT_ORDER = ["none", "minimal", "low", "medium", "default", "high", "xhigh", "max"];
const EFFORT_SUFFIX = /-(none|minimal|low|medium|high|xhigh|extra-high|max)$/;
const EFFORT_THINKING = /-(none|minimal|low|medium|high|xhigh|extra-high|max)-thinking$/;

// A Cursor model ID as a model and an effort: claude-opus-5-5-high-fast is claude-opus-5-5
// at high-fast, claude-4.6-opus-max-thinking is claude-4.6-opus-thinking at max, and an ID
// with no effort in it is its model at "default".
export function cursorSplit(id: string): [string, string] {
  let rest = id;
  const fast = rest.endsWith("-fast");
  if (fast) rest = rest.slice(0, -5);
  let effort = "default";
  let m: RegExpMatchArray | null;
  if ((m = rest.match(EFFORT_THINKING))) {
    effort = m[1]!;
    rest = rest.slice(0, -m[0].length) + "-thinking";
  } else if ((m = rest.match(EFFORT_SUFFIX))) {
    effort = m[1]!;
    rest = rest.slice(0, -m[0].length);
  }
  if (effort === "extra-high") effort = "xhigh";
  if (fast) effort = effort === "default" ? "fast" : `${effort}-fast`;
  return [rest, effort];
}

function cursorModels(skip: Set<string>): Record<string, Model> {
  const out = run(["cursor-agent", "models"]);
  if (!out) return {};
  const byModel = new Map<string, Record<string, string>>();
  for (const line of out.split("\n")) {
    const id = line.match(/^([a-z0-9][a-z0-9.\-]*) - /)?.[1];
    if (!id) continue;
    const [model, effort] = cursorSplit(id);
    // Thinking variants are the same model with another switch; the plain one is enough.
    if (model.endsWith("-thinking")) continue;
    byModel.set(model, { ...byModel.get(model), [effort]: id });
  }
  for (const model of [...byModel.keys()]) if (skip.has(familyOf(model).family.split("-")[0]!)) byModel.delete(model);
  // Least to most effort, each followed by its fast variant.
  const rank = (e: string) => EFFORT_ORDER.indexOf(e.replace(/-?fast$/, "") || "default") * 2 + (e.endsWith("fast") ? 1 : 0);
  const result: Record<string, Model> = {};
  for (const [family, model] of newestPerFamily([...byModel.keys()])) {
    const all = byModel.get(model)!;
    const efforts = Object.fromEntries(Object.keys(all).sort((a, b) => rank(a) - rank(b)).map((e) => [e, all[e]!]));
    const effort = ["high", "medium", "default"].find((e) => e in efforts) ?? Object.keys(efforts).find((e) => !e.endsWith("fast"))!;
    result[family] = { model, args: ["--model", "{effort}", ...FULL_ACCESS.cursor!], efforts, effort };
  }
  return result;
}

// OpenRouter's ~vendor/family-latest IDs always point at the family's newest version.
// Versioned ones (~deepseek/deepseek-v4-flash-latest) duplicate a plain family.
function latestRoutes(ids: string[], skip: Set<string>): Array<[name: string, id: string]> {
  const out: Array<[string, string]> = [];
  for (const id of ids) {
    const m = id.match(/^~([a-z0-9-]+)\/([a-z0-9.-]+)-latest$/);
    if (!m || /\d/.test(m[2]!) || skip.has(m[1]!)) continue;
    out.push([m[2]!, id]);
  }
  return out;
}

function opencodeModels(skip: Set<string>): Record<string, Model> {
  const out = run(["opencode", "models", "openrouter"]);
  if (!out) return {};
  const ids = out.split("\n").map((l) => l.trim().replace(/^openrouter\//, ""));
  return Object.fromEntries(latestRoutes(ids, skip).map(([name, id]) => [name, { model: id, args: ["-m", `openrouter/${id}`, ...FULL_ACCESS.opencode!] }]));
}

function piModels(skip: Set<string>): Record<string, Model> {
  const out = run(["pi", "--list-models", "openrouter"]);
  if (!out) return {};
  const thinks = new Map<string, boolean>();
  for (const line of out.split("\n")) {
    const cols = line.trim().split(/\s+/);
    if (cols[0] === "openrouter" && cols[1]) thinks.set(cols[1], cols[4] === "yes");
  }
  return Object.fromEntries(latestRoutes([...thinks.keys()], skip).map(([name, id]): [string, Model] => [name, thinks.get(id)
    ? { model: id, args: ["--provider", "openrouter", "--model", id, "--thinking", "{effort}"], efforts: Object.fromEntries(PI_EFFORTS.map((e) => [e, e])), effort: "high" }
    : { model: id, args: ["--provider", "openrouter", "--model", id] }]));
}

function main() {
  const file = resolve((process.argv[2] ?? "~/.config/herdr-chatgpt/agent-models.json").replace(/^~(?=\/)/, process.env.HOME ?? "~"));
  const old: ModelList = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  const skip = ownCliVendors();
  const found: ModelList = {
    claude: claudeModels(), codex: codexModels(), cursor: cursorModels(skip), opencode: opencodeModels(skip), pi: piModels(skip),
  };
  const next: ModelList = {};
  for (const [kind, models] of Object.entries(found)) {
    if (Object.keys(models).length === 0) {
      // A CLI missing on this machine keeps what another machine wrote for it.
      if (old[kind] && !old[kind]!.kind) next[kind] = old[kind]!;
      continue;
    }
    const def = DEFAULT_MODEL[kind];
    if (def && models[def]) models[def]!.default = true;
    next[kind] = models;
  }
  if (Object.keys(next).length === 0) throw new Error("found no claude, codex, cursor-agent, opencode or pi to list models from");

  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
  for (const [kind, models] of Object.entries(next)) {
    for (const [name, m] of Object.entries(models)) {
      const efforts = m.efforts ? Object.keys(m.efforts).join(" ") : "-";
      console.log(`${kind.padEnd(9)} ${(name + (m.default ? "*" : "")).padEnd(16)} ${m.model.padEnd(34)} ${m.effort ?? "-"}\t${efforts}`);
    }
  }
  console.log(`\n${Object.values(next).reduce((n, m) => n + Object.keys(m).length, 0)} models in ${file} (* = the CLI's default)`);
}

if (import.meta.main) main();
