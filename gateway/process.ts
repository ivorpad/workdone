// Child processes: the exec op, plus the fixed-argv helpers (git, rg, the document
// converter) that other ops run. Nothing here goes through a shell except exec.

import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { GatewayError, findExecutable, searchPath, type GatewayConfig } from "./config.ts";

export interface RunResult {
  exit_code: number | null;
  signal: string | null;
  timed_out: boolean;
  duration_ms: number;
  stdout: string;
  stderr: string;
  stdout_truncated: boolean;
  stderr_truncated: boolean;
}

export interface RunOptions {
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  maxBytes: number;
  stdin?: string;
}

// Keeps the start and the end of a stream, where the useful lines usually are.
class Capture {
  private head = Buffer.alloc(0);
  private tail: Buffer[] = [];
  private tailLen = 0;
  private total = 0;
  private headMax: number;
  private tailMax: number;

  constructor(maxBytes: number) {
    this.headMax = Math.floor(maxBytes / 4);
    this.tailMax = maxBytes - this.headMax;
  }

  push(chunk: Buffer) {
    this.total += chunk.length;
    if (this.head.length < this.headMax) {
      const take = Math.min(this.headMax - this.head.length, chunk.length);
      this.head = Buffer.concat([this.head, chunk.subarray(0, take)]);
      chunk = chunk.subarray(take);
    }
    if (chunk.length === 0) return;
    this.tail.push(chunk);
    this.tailLen += chunk.length;
    while (this.tail.length > 1 && this.tailLen - this.tail[0]!.length >= this.tailMax) {
      this.tailLen -= this.tail.shift()!.length;
    }
  }

  result(): { text: string; truncated: boolean } {
    let tail = Buffer.concat(this.tail);
    if (tail.length > this.tailMax) tail = tail.subarray(tail.length - this.tailMax);
    const dropped = this.total - this.head.length - tail.length;
    if (dropped <= 0) return { text: this.head.toString("utf8") + tail.toString("utf8"), truncated: false };
    return { text: `${this.head.toString("utf8")}\n[... ${dropped} bytes omitted ...]\n${tail.toString("utf8")}`, truncated: true };
  }
}

export function runProcess(argv: string[], opts: RunOptions): Promise<RunResult> {
  return new Promise((resolvePromise, reject) => {
    const started = Date.now();
    // detached: the child leads its own process group, so a timeout can kill
    // everything it started, and it survives the ssh session ending.
    const child = spawn(argv[0]!, argv.slice(1), {
      cwd: opts.cwd,
      env: opts.env,
      stdio: [opts.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      detached: true,
    });
    const out = new Capture(opts.maxBytes);
    const err = new Capture(opts.maxBytes);
    child.stdout!.on("data", (c: Buffer) => out.push(c));
    child.stderr!.on("data", (c: Buffer) => err.push(c));
    let timedOut = false;
    let settled = false;
    let exit: { code: number | null; signal: string | null } | undefined;
    const killGroup = (sig: NodeJS.Signals) => {
      try {
        if (child.pid) process.kill(-child.pid, sig);
      } catch {
        // already gone
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup("SIGTERM");
      setTimeout(() => killGroup("SIGKILL"), 2000).unref();
    }, opts.timeoutMs);
    const finish = () => {
      if (settled || !exit) return;
      settled = true;
      clearTimeout(timer);
      child.stdout!.destroy();
      child.stderr!.destroy();
      const o = out.result();
      const e = err.result();
      resolvePromise({
        exit_code: exit.code,
        signal: exit.signal,
        timed_out: timedOut,
        duration_ms: Date.now() - started,
        stdout: o.text,
        stderr: e.text,
        stdout_truncated: o.truncated,
        stderr_truncated: e.truncated,
      });
    };
    child.on("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new GatewayError("spawn_failed", `${argv[0]}: ${e.message}`));
    });
    child.on("exit", (code, signal) => {
      exit = { code, signal };
      // A backgrounded grandchild can hold the pipes open forever; stop waiting for them.
      setTimeout(finish, 300);
    });
    child.on("close", finish);
    if (opts.stdin !== undefined) child.stdin!.end(opts.stdin);
  });
}

// Environment for child processes: the user's identity and a PATH that includes
// the configured tool directories. Nothing from the ssh session leaks through.
export function childEnv(cfg: GatewayConfig): Record<string, string> {
  const home = process.env.HOME ?? "/";
  const user = process.env.USER ?? process.env.LOGNAME ?? "";
  return {
    HOME: home,
    USER: user,
    LOGNAME: user,
    SHELL: cfg.shell,
    PATH: [...searchPath(cfg.extraPath), "/usr/sbin", "/sbin"].join(":"),
    LANG: process.env.LANG ?? "en_US.UTF-8",
    TMPDIR: process.env.TMPDIR ?? "/tmp",
    TERM: "dumb",
    NO_COLOR: "1",
    PAGER: "cat",
    GIT_PAGER: "cat",
    GIT_TERMINAL_PROMPT: "0",
  };
}

export function findBinary(name: string, cfg: GatewayConfig): string | null {
  return findExecutable(name, cfg.extraPath);
}

export function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// Branch and changed-file count for a directory, or null when it is not a git work tree.
// --no-optional-locks keeps this from taking index.lock while an agent is committing,
// and core.fsmonitor=false stops a repo's config from making git run a program.
export async function gitSummary(cfg: GatewayConfig, cwd: string): Promise<{ branch: string | null; changed: number } | null> {
  const git = findBinary("git", cfg);
  if (!git) return null;
  const res = await runProcess(
    [git, "--no-optional-locks", "-c", "core.fsmonitor=false", "-C", cwd, "status", "--porcelain=v1", "--branch"],
    { cwd, env: childEnv(cfg), timeoutMs: 5000, maxBytes: 200_000 },
  ).catch(() => null);
  if (!res || res.exit_code !== 0) return null;
  const lines = res.stdout.split("\n").filter(Boolean);
  const head = lines[0]?.startsWith("## ") ? lines.shift()!.slice(3) : null;
  const branch = head ? head.replace(/^No commits yet on /, "").split("...")[0]!.split(" ")[0]! : null;
  return { branch, changed: lines.length };
}
