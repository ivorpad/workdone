#!/usr/bin/env bun
// Writes the agentAliases file from the models this machine's agent CLIs offer: one
// alias per model, with its reasoning efforts. Names already in the file are kept, so
// rerunning after a CLI adds models only names the new ones. Point the gateway config
// at the file with "agentAliases": "~/.config/herdr-chatgpt/agent-aliases.json".
//
// usage: bun scripts/agent-aliases.ts [FILE]     (default ~/.config/herdr-chatgpt/agent-aliases.json)
//   Claude Code: its model aliases, with --effort.
//   Codex: `codex debug models`, with -c model_reasoning_effort.
//   Cursor: `cursor-agent models`, where the effort is part of the model ID.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

interface Alias {
  kind: string;
  model: string;
  args: string[];
  efforts?: Record<string, string>;
  effort?: string;
}

// Names are themed by CLI so the owner can tell them apart; ChatGPT only sees the names.
// The owner mostly speaks them, so they are everyday words that dictation spells right
// and that don't sound like each other or like ordinary instructions.
const POOLS: Record<string, string[]> = {
  claude: ["eagle", "robin", "falcon", "parrot", "pigeon", "penguin", "raven", "flamingo"],
  codex: ["maple", "willow", "cedar", "cherry", "olive", "apple", "lemon", "mango", "walnut", "bamboo", "cactus", "coconut"],
  cursor: [
    "tiger", "lion", "zebra", "panda", "koala", "rabbit", "monkey", "camel", "dolphin", "turtle", "giraffe", "kangaroo",
    "gorilla", "hippo", "rhino", "cheetah", "leopard", "jaguar", "llama", "donkey", "pony", "buffalo", "squirrel", "hamster",
    "lobster", "octopus", "spider", "beaver", "otter", "bison", "walrus", "badger", "raccoon", "hedgehog", "chicken", "rooster",
    "lizard", "gecko", "salmon", "shark", "horse", "mouse", "frog", "wolf", "goat", "sheep", "puppy", "kitten", "moose",
    "crocodile", "unicorn", "dragon", "dinosaur", "bunny", "piglet", "reindeer",
  ],
};

// Cursor models that get the first names in the pool, the ones said most often. The rest
// follow in the order Cursor lists them.
const CURSOR_FIRST = [
  "claude-opus-5-5", "claude-fable-5-1", "gpt-5.6-sol", "grok-4.7", "claude-sonnet-5", "gemini-3.8-flash",
  "composer-2.5", "kimi-k3", "glm-5.2", "gpt-5.6-terra", "gpt-5.6-luna", "muse-spark-1.3",
];

const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"];

function run(cmd: string[]): string | null {
  try {
    const p = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "ignore" });
    return p.exitCode === 0 ? p.stdout.toString() : null;
  } catch {
    return null;
  }
}

function claudeModels(): Alias[] {
  if (!Bun.which("claude")) return [];
  const withEffort = (model: string): Alias => ({
    kind: "claude", model, args: ["--model", model, "--effort", "{effort}"],
    efforts: Object.fromEntries(CLAUDE_EFFORTS.map((e) => [e, e])), effort: "high",
  });
  return [withEffort("fable"), withEffort("opus"), withEffort("sonnet"), { kind: "claude", model: "haiku", args: ["--model", "haiku"] }];
}

function codexModels(): Alias[] {
  const out = run(["codex", "debug", "models"]);
  if (!out) return [];
  const models: any[] = JSON.parse(out).models ?? [];
  // codex-auto-review reviews commands for Codex itself; it is not a model to work with.
  return models
    .filter((m) => typeof m.slug === "string" && m.slug !== "codex-auto-review")
    .map((m) => {
      const levels: string[] = (m.supported_reasoning_levels ?? []).map((l: any) => l.effort ?? l).filter((l: unknown) => typeof l === "string");
      if (levels.length === 0) return { kind: "codex", model: m.slug, args: ["-m", m.slug] };
      return {
        kind: "codex", model: m.slug, args: ["-m", m.slug, "-c", "model_reasoning_effort={effort}"],
        efforts: Object.fromEntries(levels.map((l) => [l, l])),
        effort: levels.includes(m.default_reasoning_level) ? m.default_reasoning_level : levels[0],
      };
    });
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

function cursorModels(): Alias[] {
  const out = run(["cursor-agent", "models"]);
  if (!out) return [];
  const byModel = new Map<string, Record<string, string>>();
  for (const line of out.split("\n")) {
    const id = line.match(/^([a-z0-9][a-z0-9.\-]*) - /)?.[1];
    if (!id) continue;
    const [model, effort] = cursorSplit(id);
    byModel.set(model, { ...byModel.get(model), [effort]: id });
  }
  // Least to most effort, each followed by its fast variant.
  const rank = (e: string) => EFFORT_ORDER.indexOf(e.replace(/-?fast$/, "") || "default") * 2 + (e.endsWith("fast") ? 1 : 0);
  const first = (m: string) => (CURSOR_FIRST.includes(m) ? CURSOR_FIRST.indexOf(m) : CURSOR_FIRST.length);
  return [...byModel].sort(([a], [b]) => first(a) - first(b)).map(([model, all]) => {
    const efforts = Object.fromEntries(Object.keys(all).sort((a, b) => rank(a) - rank(b)).map((e) => [e, all[e]!]));
    const effort = ["high", "medium", "default"].find((e) => e in efforts) ?? Object.keys(efforts).find((e) => !e.endsWith("fast"))!;
    return { kind: "cursor", model, args: ["--model", "{effort}"], efforts, effort };
  });
}

function main() {
  const file = resolve((process.argv[2] ?? "~/.config/herdr-chatgpt/agent-aliases.json").replace(/^~(?=\/)/, process.env.HOME ?? "~"));
  const old: Record<string, Alias> = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  const nameOf = new Map(Object.entries(old).map(([name, a]) => [`${a.kind}/${a.model}`, name]));
  const models = [...claudeModels(), ...codexModels(), ...cursorModels()];
  if (models.length === 0) throw new Error("found no claude, codex or cursor-agent to list models from");

  const taken = new Set(Object.keys(old));
  const next: Record<string, Alias> = {};
  for (const m of models) {
    let name = nameOf.get(`${m.kind}/${m.model}`);
    if (!name) {
      name = POOLS[m.kind]!.find((n) => !taken.has(n)) ?? `${m.kind === "cursor" ? "beast" : m.kind === "codex" ? "tree" : "bird"}${taken.size + 1}`;
      taken.add(name);
    }
    next[name] = m;
  }
  // Models a CLI no longer lists keep their alias, so an agent started with one still reads right.
  for (const [name, a] of Object.entries(old)) if (!(name in next)) next[name] = a;

  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
  for (const [name, a] of Object.entries(next)) {
    const efforts = a.efforts ? Object.keys(a.efforts).join(" ") : "-";
    console.log(`${name.padEnd(12)} ${a.kind.padEnd(7)} ${a.model.padEnd(30)} ${a.effort ?? "-"}\t${efforts}`);
  }
  console.log(`\n${Object.keys(next).length} aliases in ${file}`);
}

if (import.meta.main) main();
