// The models each agent CLI can start. ChatGPT names three things: the CLI (kind), the
// model family ("opus", "sol", "grok") and the effort. The gateway turns them into the
// Herdr kind and the CLI's model and effort args. scripts/agent-models.ts writes the list,
// one family per model line and only its newest version, nested by CLI:
//   {"claude": {"opus": {"model": "claude-opus-5-5", "args": [...], "efforts": [...], "effort": "high", "default": true}}}

// args may hold {effort}, replaced by efforts[effort] for the effort ChatGPT picked
// (or the default).
export interface AgentModel {
  model: string;
  args: string[];
  efforts: Record<string, string>;
  effort: string | null;
  default?: boolean;
}

export type ModelList = Record<string, Record<string, AgentModel>>;

const EFFORT_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const NAME_RE = /^[a-z][a-z0-9-]{0,31}$/;

export function parseModels(raw: unknown): ModelList {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) throw new Error("agentModels must be an object");
  const out: ModelList = {};
  for (const [kind, families] of Object.entries<any>(raw)) {
    if (!NAME_RE.test(kind)) throw new Error(`invalid agent kind: ${kind}`);
    // The old alias file had one flat entry per name, each with its kind.
    if (typeof families?.kind === "string") throw new Error(`agentModels: ${kind} looks like an old alias entry; rerun scripts/agent-models.ts`);
    if (!families || typeof families !== "object" || Array.isArray(families)) throw new Error(`agentModels.${kind} must map model names to models`);
    out[kind] = {};
    for (const [name, a] of Object.entries<any>(families)) {
      const bad = (why: string) => new Error(`agent model ${kind} ${name}: ${why}`);
      if (!NAME_RE.test(name)) throw bad("invalid name");
      if (typeof a?.model !== "string" || !a.model) throw bad("needs a model");
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
      out[kind][name] = { model: a.model, args, efforts, effort, ...(a.default === true && { default: true }) };
    }
  }
  return out;
}

// The args for one start of a model.
export function modelArgs(m: AgentModel, effort: string | undefined): string[] {
  const pick = effort ?? m.effort;
  if (pick === null) return m.args;
  if (!Object.hasOwn(m.efforts, pick)) throw new RangeError(`effort must be one of ${Object.keys(m.efforts).join(", ")}`);
  return m.args.map((x) => x.replaceAll("{effort}", m.efforts[pick]!));
}

// The family ChatGPT asked for, matched loosely because it is usually dictated: "Gemini
// Flash" is gemini-flash, and the full model ID ("claude-opus-5-5") works too.
export function findModel(families: Record<string, AgentModel>, asked: string): string | null {
  const flat = (s: string) => s.replace(/[^a-z0-9]/g, "");
  const want = flat(asked);
  if (!want) return null;
  const names = Object.keys(families);
  return names.find((n) => flat(n) === want)
    ?? names.find((n) => flat(families[n]!.model) === want)
    ?? names.find((n) => flat(n).startsWith(want) || want.startsWith(flat(n)))
    ?? null;
}
