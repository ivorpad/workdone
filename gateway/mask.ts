// Agent aliases. With agentAliases in the config, ChatGPT starts agents by a name the
// owner picked ("otter"), and the gateway expands it to a Herdr kind plus the model and
// effort args. What goes back names the alias, never the CLI or model behind it: kind
// fields become the pane's alias, and vendor and model names in agent text are replaced.

import type { StateStore } from "./state.ts";

// args may hold {effort}, replaced by efforts[effort] for the effort ChatGPT picked
// (or the default). model is for the owner reading the config and never leaves the
// machine; note is shown to ChatGPT, so keep it free of vendor and model names.
export interface AgentAlias {
  kind: string;
  args: string[];
  efforts: Record<string, string>;
  effort: string | null;
  model?: string;
  note?: string;
}

const EFFORT_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

export function parseAliases(raw: unknown, nameRe: RegExp): Record<string, AgentAlias> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) throw new Error("agentAliases must be an object");
  const out: Record<string, AgentAlias> = {};
  for (const [name, a] of Object.entries<any>(raw)) {
    const bad = (why: string) => new Error(`agent alias ${name}: ${why}`);
    if (!nameRe.test(name)) throw new Error(`invalid agent alias: ${name}`);
    if (typeof a?.kind !== "string" || !a.kind) throw bad("needs a kind");
    const args = a.args ?? [];
    if (!Array.isArray(args) || !args.every((x: unknown) => typeof x === "string")) throw bad("args must be strings");
    // A list of efforts passes each name through as is.
    const e = Array.isArray(a.efforts) ? Object.fromEntries(a.efforts.map((x: unknown) => [x, x])) : a.efforts ?? {};
    if (typeof e !== "object" || !Object.entries(e).every(([k, v]) => EFFORT_RE.test(k) && typeof v === "string" && v)) {
      throw bad("efforts must map short lowercase names to strings");
    }
    const efforts = e as Record<string, string>;
    const templated = args.some((x: string) => x.includes("{effort}"));
    if (templated !== Object.keys(efforts).length > 0) throw bad("args use {effort} exactly when efforts are given");
    const effort = a.effort ?? Object.keys(efforts)[0] ?? null;
    if (effort !== null && !Object.hasOwn(efforts, effort)) throw bad(`default effort ${effort} is not in efforts`);
    out[name] = { kind: a.kind, args, efforts, effort };
    if (typeof a.model === "string") out[name].model = a.model;
    if (typeof a.note === "string") out[name].note = a.note;
  }
  return out;
}

// The args for one start of an alias.
export function aliasArgs(a: AgentAlias, effort: string | undefined): string[] {
  const pick = effort ?? a.effort;
  if (pick === null) return a.args;
  if (!Object.hasOwn(a.efforts, pick)) throw new RangeError(`effort must be one of ${Object.keys(a.efforts).join(", ")}`);
  return a.args.map((x) => x.replaceAll("{effort}", a.efforts[pick]!));
}

// Matched case-sensitively at the start of a word, taking the rest of the token and a
// version after a space: "claude-opus-5-thinking-high", "Opus 5.5", "Grok 4.7".
// Plain "cursor" is left out: it is an ordinary word in code and prose.
export const DEFAULT_REDACT = [
  "Claude Code", "Claude", "claude", "CLAUDE", "Anthropic", "anthropic",
  "Opus", "opus", "Sonnet", "sonnet", "Haiku", "Fable",
  "Cursor", "cursor-agent", "Composer", "composer-",
  "Codex", "codex", "OpenAI", "openai", "ChatGPT", "GPT", "gpt-",
  "Grok", "grok", "xAI", "DeepSeek", "deepseek", "Gemini", "gemini",
  "Kimi", "kimi", "Qwen", "qwen", "GLM", "glm-", "Muse Spark", "muse-spark",
  "OpenCode", "opencode",
];

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function redactPattern(words: string[]): RegExp | null {
  if (words.length === 0) return null;
  const alt = [...words].sort((a, b) => b.length - a.length).map(escape).join("|");
  return new RegExp(`(?<![A-Za-z0-9_])(?:${alt})[\\w.-]*(?: \\d[\\d.]*)?`, "g");
}

// File and shell ops return file contents and paths that must round-trip unchanged, and
// browser runs report URLs and page titles that say nothing about the agents.
const UNMASKED_OPS = new Set([
  "exec", "list_dir", "read_file", "write_file", "move_path", "delete_path", "search_files", "browse", "browse_status", "browse_stop",
]);
// Strings under these keys are IDs or paths ChatGPT passes back.
const KEEP_KEYS = /(^|_)(id|ids|path|cwd|root|roots|branch|name)$/;
const GENERIC = "agent";

export class Mask {
  private pattern: RegExp | null;
  private kinds: Set<string>;

  constructor(private aliases: Record<string, AgentAlias>, redact: string[], agentKinds: string[], private state: StateStore) {
    this.pattern = redactPattern(redact);
    this.kinds = new Set([...agentKinds, ...Object.values(aliases).map((a) => a.kind)]);
  }

  get on() {
    return Object.keys(this.aliases).length > 0;
  }

  // Remember which alias started the agent in this pane, and under which name.
  started(paneId: string, name: string, alias: string) {
    if (this.on) this.state.setAlias(paneId, name, alias);
  }

  // The alias to show for a pane or agent name: the one that started it, else the first
  // alias of its kind, else a generic word.
  aliasOf(target: unknown, kind?: unknown): string {
    const known = typeof target === "string" ? this.state.alias(target) : null;
    if (known && this.aliases[known]) return known;
    return Object.entries(this.aliases).find(([, a]) => a.kind === kind)?.[0] ?? GENERIC;
  }

  text(s: string, alias = GENERIC): string {
    return this.on && this.pattern ? s.replace(this.pattern, alias) : s;
  }

  // fallback: the pane or agent name the request targeted, for text outside any pane object.
  result(op: string, value: unknown, fallback?: unknown): unknown {
    if (!this.on || UNMASKED_OPS.has(op)) return value;
    const top = typeof fallback === "string" ? this.aliasOf(fallback) : GENERIC;
    return this.walk(value, top, undefined);
  }

  private walk(v: unknown, alias: string, key: string | undefined): unknown {
    if (typeof v === "string") return key && KEEP_KEYS.test(key) ? v : this.text(v, alias);
    if (Array.isArray(v)) return v.map((x) => this.walk(x, alias, key));
    if (!v || typeof v !== "object") return v;
    const o = v as Record<string, any>;
    // An object about one pane speaks for it, and so does one holding a single agent or pane.
    const pane = o.pane_id ?? o.agent?.pane_id ?? o.pane?.pane_id;
    const kind = typeof o.agent === "string" ? o.agent : o.agent?.agent;
    const here = typeof pane === "string" ? this.aliasOf(pane, kind) : alias;
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(o)) {
      out[k] = (k === "agent" || k === "kind") && this.kinds.has(x) ? here : this.walk(x, here, k);
    }
    return out;
  }
}
