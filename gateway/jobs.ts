// Browser runs. browse starts `jev-browser run` detached, so it outlives the ssh call
// that asked for it, and returns at once. Each run gets a directory under
// <stateDir>/jobs holding job.json, the step log, the JSON summary, the trace and the
// exit code. watch_poll reports a run once when it ends, and the notifier sends that
// to the phone like a finished agent turn.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { GatewayError, expandHome, type GatewayConfig } from "./config.ts";
import { childEnv } from "./process.ts";
import { optInt, optStr, str, type Op } from "./params.ts";

export interface BrowserConfig {
  command: string[];
  cwd: string;
}

interface Job {
  id: string;
  label: string | null;
  url: string;
  goals: string[];
  started: string;
  pid: number;
}

// Runs kept on disk; traces hold page text, so old ones go.
const KEEP = 50;
const ID_RE = /^[0-9]{8}-[0-9]{6}-[a-z0-9]{4}$/;

export function parseBrowser(raw: unknown): BrowserConfig | null {
  if (raw == null) return null;
  const b = raw as Record<string, unknown>;
  if (!Array.isArray(b.command) || b.command.length === 0 || !b.command.every((a) => typeof a === "string" && a)) {
    throw new Error("browser.command must be a non-empty array of strings");
  }
  if (typeof b.cwd !== "string" || !(b.cwd.startsWith("/") || b.cwd.startsWith("~/"))) throw new Error("browser.cwd must be an absolute path");
  return { command: b.command.map((a) => expandHome(a as string)), cwd: expandHome(b.cwd) };
}

const jobsDir = (cfg: GatewayConfig) => resolve(cfg.stateDir, "jobs");

function readJson(path: string): any {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err?.code === "EPERM";
  }
}

function tail(path: string, lines: number): string {
  try {
    return readFileSync(path, "utf8").trimEnd().split("\n").slice(-lines).join("\n");
  } catch {
    return "";
  }
}

// running, done (every goal DONE), blocked (one BLOCKED or stopped), failed (setup
// error, exit 2), stopped (browse_stop) or lost (the process died without an exit code).
function stateOf(dir: string, job: Job): string {
  if (existsSync(resolve(dir, "stopped"))) return "stopped";
  const code = existsSync(resolve(dir, "exit")) ? Number(readFileSync(resolve(dir, "exit"), "utf8").trim()) : null;
  if (code === null) return alive(job.pid) ? "running" : "lost";
  return code === 0 ? "done" : code === 1 ? "blocked" : "failed";
}

function view(cfg: GatewayConfig, id: string, full: boolean, textChars = PAGE_TEXT_DEFAULT) {
  const dir = resolve(jobsDir(cfg), id);
  const job: Job | null = readJson(resolve(dir, "job.json"));
  if (!job) throw new GatewayError("job_not_found", `browser run ${id} not found`);
  const state = stateOf(dir, job);
  const summary = readJson(resolve(dir, "summary.json"));
  const out: Record<string, unknown> = { id, label: job.label, url: job.url, goals: job.goals, started: job.started, state };
  if (summary) out.summary = summary;
  if (full) {
    out.log_tail = tail(resolve(dir, "log.txt"), state === "running" ? 12 : 25);
    const pages = finalPages(readJson(resolve(dir, "trace.json")), textChars);
    if (pages.length) out.final_pages = pages;
  }
  return out;
}

// The page each goal ended on, with its visible text: what DONE should be checked
// against. The trace sits in the gateway's state, which the file tools do not serve.
// A short excerpt by default, enough to see the run landed where it should; up to
// PAGE_TEXT_MAX when checking a result needs the page's content.
const PAGE_TEXT_DEFAULT = 800;
const PAGE_TEXT_MAX = 6000;

function finalPages(trace: any, textChars: number): Array<{ goal: string; url: string; title: string; text: string; truncated: boolean }> {
  const runs: any[] = Array.isArray(trace?.runs) ? trace.runs : [];
  return runs.flatMap((r) => {
    const page = Array.isArray(r?.pages) ? r.pages.at(-1) : null;
    if (!page) return [];
    const text = typeof page.text === "string" ? page.text : "";
    return [{
      goal: String(r.goal ?? r.name ?? ""), url: String(page.url ?? r.url ?? ""), title: String(page.title ?? r.title ?? ""),
      text: text.slice(0, textChars), truncated: text.length > textChars,
    }];
  });
}

function jobIds(cfg: GatewayConfig): string[] {
  try {
    return readdirSync(jobsDir(cfg)).filter((d) => ID_RE.test(d)).sort();
  } catch {
    return [];
  }
}

function newId(): string {
  const t = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  return `${t.slice(0, 8)}-${t.slice(8)}-${Math.random().toString(36).slice(2, 6).padEnd(4, "0")}`;
}

// The phone message for a run that ended.
function message(v: Record<string, any>): string {
  const name = v.label ? `"${v.label}"` : v.id;
  const runs: any[] = v.summary?.runs ?? [];
  const last = runs.at(-1);
  const where = last?.url ? `: ${last.url}` : "";
  const steps = typeof v.summary?.steps === "number" ? ` in ${v.summary.steps} steps` : "";
  const head = {
    done: `browser run ${name} done${steps}${where}`,
    blocked: `browser run ${name} blocked at goal ${runs.findIndex((r) => String(r.status).toLowerCase() !== "done") + 1 || runs.length}${steps}${where}`,
    failed: `browser run ${name} failed to start`,
    stopped: `browser run ${name} stopped`,
    lost: `browser run ${name} ended without a result`,
  }[v.state as string] ?? `browser run ${name}: ${v.state}`;
  const why = v.state === "failed" || v.state === "lost" ? tail(resolve(v.dir, "log.txt"), 1) : "";
  return (why ? `${head}: ${why}` : head).replace(/\s+/g, " ").slice(0, 450);
}

// For watch_poll: messages for runs that ended since the last poll, and how many still run.
export function pollJobs(cfg: GatewayConfig): { messages: string[]; remaining: number } {
  const messages: string[] = [];
  let remaining = 0;
  for (const id of jobIds(cfg)) {
    const dir = resolve(jobsDir(cfg), id);
    if (existsSync(resolve(dir, "reported"))) continue;
    const v = view(cfg, id, false);
    if (v.state === "running") {
      remaining++;
      continue;
    }
    writeFileSync(resolve(dir, "reported"), new Date().toISOString());
    messages.push(message({ ...v, dir }));
  }
  return { messages, remaining };
}

export function jobOps(cfg: GatewayConfig): Record<string, Op> {
  const browser = () => {
    if (!cfg.browser) throw new GatewayError("capability_disabled", "no browser is configured on this machine");
    if (!cfg.allowExec) throw new GatewayError("capability_disabled", "browser runs need the exec capability");
    return cfg.browser;
  };
  return {
    async browse(params) {
      const b = browser();
      const url = str(params, "url");
      if (!/^https?:\/\//.test(url) || url.length > 2000) throw new GatewayError("invalid_params", "url must be an http(s) URL");
      const goals = params.goals;
      if (!Array.isArray(goals) || goals.length === 0 || goals.length > 10 || !goals.every((g) => typeof g === "string" && g.trim() && g.length <= 2000)) {
        throw new GatewayError("invalid_params", "goals must be 1-10 non-empty strings");
      }
      const label = optStr(params, "label") ?? null;
      if (label && label.length > 80) throw new GatewayError("invalid_params", "label must be at most 80 characters");

      const ids = jobIds(cfg);
      for (const old of ids.slice(0, Math.max(0, ids.length - KEEP + 1))) rmSync(resolve(jobsDir(cfg), old), { recursive: true, force: true });
      const id = newId();
      const dir = resolve(jobsDir(cfg), id);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      // argv only, no shell parsing of the goals: sh gets them as "$@".
      const script = 'dir=$1; shift; "$@" --json --trace "$dir/trace.json" >"$dir/summary.json" 2>"$dir/log.txt"; echo $? >"$dir/exit"';
      const child = spawn("/bin/sh", ["-c", script, "sh", dir, ...b.command, url, ...goals], {
        cwd: b.cwd, env: childEnv(cfg), detached: true, stdio: "ignore",
      });
      await new Promise<void>((ok, fail) => {
        child.once("spawn", ok);
        child.once("error", (e) => fail(new GatewayError("spawn_failed", e.message)));
      });
      child.unref();
      const job: Job = { id, label, url, goals: goals as string[], started: new Date().toISOString(), pid: child.pid! };
      writeFileSync(resolve(dir, "job.json"), JSON.stringify(job), { mode: 0o600 });
      return { id, state: "running", note: "the owner gets a phone notification when it ends; browse_status shows progress" };
    },

    async browse_status(params) {
      const id = optStr(params, "id", ID_RE);
      if (id) return view(cfg, id, true, optInt(params, "text_chars", 0, PAGE_TEXT_MAX) ?? PAGE_TEXT_DEFAULT);
      return { runs: jobIds(cfg).slice(-10).reverse().map((j) => view(cfg, j, false)) };
    },

    // Kills the run's process group: the shell, jev-browser and anything it started.
    async browse_stop(params) {
      browser();
      const id = str(params, "id", ID_RE);
      const dir = resolve(jobsDir(cfg), id);
      const v = view(cfg, id, false);
      if (v.state !== "running") return v;
      const job: Job = readJson(resolve(dir, "job.json"));
      writeFileSync(resolve(dir, "stopped"), new Date().toISOString());
      try {
        process.kill(-job.pid, "SIGTERM");
      } catch {
        // already gone
      }
      return view(cfg, id, false);
    },
  };
}
