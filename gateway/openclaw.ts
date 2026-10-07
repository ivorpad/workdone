// Asking the owner's OpenClaw something (calendar, reminders, anything its agent has tools
// for). ask_openclaw posts the question in the configured Discord channel, in pieces when it
// is longer than a message, then runs the agent once on the whole text in that channel's
// session with delivery on, so the answer appears there too. The agent's reply comes back in
// the tool result when it finishes within the wait; otherwise openclaw_status has it later.
// The gateway is one process per ssh call and exits when the call ends, so the run is a
// detached child (openclaw-run.ts) that writes its progress and reply to <stateDir>/openclaw.
//
// One ask is one agent run: no retry, no second run for the same command_id, at most two
// running at once. The Discord posts come from OpenClaw's bot account, not from the owner.

import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { GatewayError, expandHome, type GatewayConfig } from "./config.ts";
import { optBool, optInt, optStr, str, type Op, type Params } from "./params.ts";
import { childEnv, findBinary, runProcess } from "./process.ts";

export interface OpenclawConfig {
  command: string[];
  agent: string;
  channel: string;
  // Where the visible prompt and the reply go, e.g. channel:<id> for Discord.
  target: string;
  // The session that holds the conversation, e.g. agent:lead:discord:channel:<id>. Unset: OpenClaw's own routing.
  sessionKey: string | null;
  timeoutSec: number;
}

const WORD = /^[A-Za-z0-9][\w.-]{0,40}$/;
const TARGET = /^[\w:.-]{1,100}$/;
const SESSION = /^agent:[\w-]{1,40}:[\w:.-]{1,150}$/;

export function parseOpenclaw(raw: unknown): OpenclawConfig | null {
  if (raw == null) return null;
  const o = raw as Record<string, unknown>;
  const command = o.command ?? ["openclaw"];
  if (!Array.isArray(command) || command.length === 0 || !command.every((a) => typeof a === "string" && a)) {
    throw new Error("openclaw.command must be a non-empty array of strings");
  }
  const word = (v: unknown, what: string, dflt?: string) => {
    const s = v ?? dflt;
    if (typeof s !== "string" || !WORD.test(s)) throw new Error(`openclaw.${what} must be a short name`);
    return s;
  };
  if (typeof o.target !== "string" || !TARGET.test(o.target)) throw new Error("openclaw.target is required, e.g. channel:<discord channel id>");
  if (o.sessionKey != null && (typeof o.sessionKey !== "string" || !SESSION.test(o.sessionKey))) throw new Error("openclaw.sessionKey must look like agent:<id>:<key>");
  const timeoutSec = o.timeoutSec ?? 600;
  if (typeof timeoutSec !== "number" || !Number.isInteger(timeoutSec) || timeoutSec < 10 || timeoutSec > 3600) throw new Error("openclaw.timeoutSec must be 10-3600");
  return {
    command: command.map((a, i) => (i === 0 ? expandHome(a as string) : (a as string))),
    agent: word(o.agent, "agent"),
    channel: word(o.channel, "channel", "discord"),
    target: o.target,
    sessionKey: (o.sessionKey as string | null | undefined) ?? null,
    timeoutSec,
  };
}

// Discord caps a message at 2000 characters. Pieces stay under 1900 and split on line
// boundaries, with room for the "(i/n) " prefix.
export const CHUNK = 1900;

export function chunkText(text: string, limit = CHUNK): string[] {
  const room = limit - 12;
  const out: string[] = [];
  let cur = "";
  for (let line of text.trim().split(/(?<=\n)/)) {
    while (line.length > room) {
      if (cur) out.push(cur), (cur = "");
      out.push(line.slice(0, room));
      line = line.slice(room);
    }
    if (cur.length + line.length > room) out.push(cur), (cur = "");
    cur += line;
  }
  if (cur) out.push(cur);
  const n = out.length;
  return n <= 1 ? out : out.map((c, i) => `(${i + 1}/${n}) ${c}`);
}

// The agent's reply out of `openclaw agent --json`. Log lines can come first on stdout.
export function parseReply(stdout: string): { reply: string | null; run_id: string | null; status: string | null } {
  let json: any = null;
  for (const candidate of [stdout, stdout.slice(Math.max(0, stdout.search(/^\{/m)))]) {
    try {
      json = JSON.parse(candidate);
      break;
    } catch { /* log lines before the JSON: try from the first line that starts it */ }
  }
  if (!json) return { reply: null, run_id: null, status: null };
  const payloads: string[] = (json.result?.payloads ?? []).map((p: any) => p?.text).filter((t: unknown) => typeof t === "string" && t);
  const reply = payloads.length ? payloads.join("\n\n") : json.result?.meta?.finalAssistantVisibleText ?? null;
  return { reply: typeof reply === "string" && reply ? reply : null, run_id: typeof json.runId === "string" ? json.runId : null, status: typeof json.status === "string" ? json.status : null };
}

export interface Ask {
  id: string;
  command_id: string | null;
  started: string;
  text_chars: number;
  visible: boolean;
  posts: number;
  state: "running" | "done" | "failed";
  reply: string | null;
  error: string | null;
  run_id: string | null;
  duration_ms: number | null;
  pid: number | null;
}

// What the detached runner needs from the gateway's config.
export interface RunSpec {
  oc: OpenclawConfig;
  text: string;
  env: Pick<GatewayConfig, "shell" | "extraPath">;
  stateDir: string;
}

const ID_RE = /^[0-9]{8}-[0-9]{6}-[a-z0-9]{4}$/;
const KEEP = 30;
const MAX_RUNNING = 2;
const dir = (stateDir: string) => resolve(stateDir, "openclaw");
const file = (stateDir: string, id: string) => resolve(dir(stateDir), `${id}.json`);
const specFile = (stateDir: string, id: string) => resolve(dir(stateDir), `${id}.spec.json`);

function newId(): string {
  const d = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  return `${d}-${Math.random().toString(36).slice(2, 6).padEnd(4, "0")}`;
}

function alive(pid: number | null): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err?.code === "EPERM";
  }
}

// Written whole and renamed in, so a reader never sees half a record.
function save(stateDir: string, ask: Ask) {
  mkdirSync(dir(stateDir), { recursive: true, mode: 0o700 });
  const tmp = `${file(stateDir, ask.id)}.tmp`;
  writeFileSync(tmp, JSON.stringify(ask), { mode: 0o600 });
  renameSync(tmp, file(stateDir, ask.id));
}

function load(stateDir: string, id: string): Ask | null {
  try {
    const ask = JSON.parse(readFileSync(file(stateDir, id), "utf8")) as Ask;
    // Recorded as running by a process that is gone: nothing will finish it. A runner that has not
    // written its pid yet is given a few seconds.
    const starting = ask.pid === null && Date.now() - Date.parse(ask.started) < 10_000;
    return ask.state === "running" && !starting && !alive(ask.pid) ? { ...ask, state: "failed", error: ask.error ?? "the runner ended without a result; the reply may still have reached Discord" } : ask;
  } catch {
    return null;
  }
}

function ids(stateDir: string): string[] {
  try {
    return readdirSync(dir(stateDir)).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).filter((i) => ID_RE.test(i)).sort();
  } catch {
    return [];
  }
}

// The detached runner: posts the question, runs the agent once, records the outcome.
export async function runAsk(specPath: string, id: string) {
  const spec = JSON.parse(readFileSync(specPath, "utf8")) as RunSpec;
  rmSync(specPath, { force: true });
  const { oc, text } = spec;
  const cfg = { ...spec.env, stateDir: spec.stateDir, maxOutputBytes: 60_000 } as GatewayConfig;
  const ask = load(spec.stateDir, id)!;
  ask.pid = process.pid;
  save(spec.stateDir, ask);
  const started = Date.now();
  try {
    const bin = oc.command[0]!.includes("/") ? oc.command[0]! : findBinary(oc.command[0]!, cfg);
    if (!bin) throw new GatewayError("spawn_failed", `${oc.command[0]} was not found on this machine's PATH`);
    const base = [bin, ...oc.command.slice(1)];
    const env = childEnv(cfg);
    const cwd = process.env.HOME ?? "/";
    if (ask.visible) {
      for (const piece of chunkText(text)) {
        const res = await runProcess([...base, "message", "send", "--channel", oc.channel, "--target", oc.target, "-m", piece, "--json"], { cwd, env, timeoutMs: 60_000, maxBytes: 20_000 });
        if (res.exit_code !== 0) throw new GatewayError("post_failed", `posting to ${oc.channel} failed after ${ask.posts} message(s): ${res.stderr.trim().slice(-300) || `exit ${res.exit_code}`}`);
        ask.posts++;
        save(spec.stateDir, ask);
      }
    }
    const argv = [...base, "agent", "--agent", oc.agent, ...(oc.sessionKey ? ["--session-key", oc.sessionKey] : []), "--json", "--timeout", String(oc.timeoutSec)];
    if (ask.visible) argv.push("--channel", oc.channel, "--reply-to", oc.target, "--deliver");
    argv.push("-m", text);
    const res = await runProcess(argv, { cwd, env, timeoutMs: (oc.timeoutSec + 30) * 1000, maxBytes: 400_000 });
    const parsed = parseReply(res.stdout);
    ask.run_id = parsed.run_id;
    if (res.timed_out) throw new GatewayError("timeout", `OpenClaw did not finish in ${oc.timeoutSec} s`);
    if (res.exit_code !== 0 || (parsed.status && parsed.status !== "ok")) {
      throw new GatewayError("agent_failed", res.stderr.trim().slice(-300) || `exit ${res.exit_code}, status ${parsed.status ?? "unknown"}`);
    }
    ask.reply = parsed.reply;
    ask.state = "done";
  } catch (err) {
    ask.state = "failed";
    ask.error = err instanceof GatewayError ? `${err.code}: ${err.message}` : String((err as Error)?.message ?? err);
  }
  ask.duration_ms = Date.now() - started;
  save(spec.stateDir, ask);
}

export function openclawOps(cfg: GatewayConfig): Record<string, Op> {
  const config = (): OpenclawConfig => {
    if (!cfg.openclaw) throw new GatewayError("capability_disabled", "no OpenClaw is configured on this machine");
    return cfg.openclaw;
  };
  const view = (ask: Ask, full = true) => {
    const { reply, pid: _pid, ...rest } = ask;
    const clipped = reply !== null && reply.length > cfg.maxOutputBytes ? reply.slice(0, cfg.maxOutputBytes) : reply;
    return full ? { ...rest, reply: clipped, ...(clipped !== reply ? { reply_truncated: true } : {}) } : { ...rest, reply_chars: reply?.length ?? 0 };
  };

  return {
    async ask_openclaw(params: Params) {
      const oc = config();
      const text = str(params, "text").trim();
      if (!text) throw new GatewayError("invalid_params", "text is empty");
      if (text.length > cfg.maxPromptChars) throw new GatewayError("invalid_params", `text is ${text.length} characters, over the ${cfg.maxPromptChars} limit`);
      const commandId = optStr(params, "command_id", /^[\w.:-]{1,80}$/) ?? null;
      const visible = optBool(params, "visible", true);
      const wait = optInt(params, "wait_ms", 0, cfg.maxWaitMs) ?? Math.min(90_000, cfg.maxWaitMs);
      const all = ids(cfg.stateDir);

      // The same command_id again is the same ask, never a second run.
      if (commandId) {
        for (const id of all.slice(-KEEP).reverse()) {
          const old = load(cfg.stateDir, id);
          if (old?.command_id === commandId) {
            if (old.text_chars !== text.length) throw new GatewayError("command_conflict", `command_id ${commandId} was used for other text`);
            return { ...view(old), replayed: true };
          }
        }
      }
      const busy = all.map((id) => load(cfg.stateDir, id)).filter((a) => a?.state === "running").length;
      if (busy >= MAX_RUNNING) throw new GatewayError("openclaw_busy", `${busy} asks are still running; wait for one to finish (openclaw_status)`);

      for (const old of all.slice(0, Math.max(0, all.length - KEEP + 1))) rmSync(file(cfg.stateDir, old), { force: true });
      const ask: Ask = { id: newId(), command_id: commandId, started: new Date().toISOString(), text_chars: text.length, visible, posts: 0, state: "running", reply: null, error: null, run_id: null, duration_ms: null, pid: null };
      save(cfg.stateDir, ask);
      const spec: RunSpec = { oc, text, env: { shell: cfg.shell, extraPath: cfg.extraPath }, stateDir: cfg.stateDir };
      writeFileSync(specFile(cfg.stateDir, ask.id), JSON.stringify(spec), { mode: 0o600 });
      const runner = fileURLToPath(new URL("./openclaw-run.ts", import.meta.url));
      const child = spawn(process.execPath, ["--no-env-file", "--no-install", runner, specFile(cfg.stateDir, ask.id), ask.id], {
        cwd: dir(cfg.stateDir), env: childEnv(cfg), detached: true, stdio: "ignore",
      });
      await new Promise<void>((ok, fail) => {
        child.once("spawn", ok);
        child.once("error", (e) => fail(new GatewayError("spawn_failed", e.message)));
      });
      child.unref();

      const deadline = Date.now() + wait;
      for (;;) {
        const now = load(cfg.stateDir, ask.id) ?? ask;
        if (now.state !== "running" || Date.now() >= deadline) return view(now);
        await new Promise((ok) => setTimeout(ok, 200));
      }
    },

    async openclaw_status(params: Params) {
      config();
      const id = optStr(params, "id", ID_RE);
      if (id) {
        const ask = load(cfg.stateDir, id);
        if (!ask) throw new GatewayError("not_found", `no OpenClaw ask ${id}`);
        return view(ask);
      }
      return { asks: ids(cfg.stateDir).slice(-10).reverse().map((i) => load(cfg.stateDir, i)).filter((a): a is Ask => a !== null).map((a) => view(a, false)) };
    },
  };
}
