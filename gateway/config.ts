// Gateway config loading and the allowed-root scope check.

import { accessSync, constants, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { DEFAULT_REDACT, parseAliases, type AgentAlias } from "./mask.ts";

export const GATEWAY_VERSION = "0.3.0";

export const TARGET_RE = /^[A-Za-z0-9][A-Za-z0-9_:.-]{0,63}$/;
export const AGENT_NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;
export const BRANCH_RE = /^(?!-)(?!.*\.\.)[A-Za-z0-9._\/-]{1,100}$/;
export const READ_SOURCES = ["visible", "recent", "recent_unwrapped", "detection"] as const;
export const AGENT_STATUSES = ["idle", "working", "blocked", "done", "unknown"] as const;
// Keys needed to steer an agent UI (dismiss, interrupt, pick a menu option).
export const ALLOWED_KEYS = new Set([
  "enter", "esc", "tab", "shift+tab", "up", "down", "left", "right", "space", "backspace",
  "ctrl+c", "y", "n", "1", "2", "3", "4", "5", "6", "7", "8", "9",
]);
// Any Herdr key name for raw pane input, e.g. ctrl+d, f5, pageup, alt+shift+left.
export const KEY_RE = /^[a-z0-9]+(\+[a-z0-9]+){0,3}$/;

export interface RepoConfig {
  path: string;
  tasks?: Record<string, string>;
}

export interface GatewayConfig {
  herdrSocketPath: string;
  allowedRoots: string[];
  repos: Record<string, RepoConfig>;
  agentKinds: string[];
  agentAliases: Record<string, AgentAlias>;
  redact: string[];
  allowRawPaneRun: boolean;
  allowWorktreeRemove: boolean;
  allowExec: boolean;
  allowFileRead: boolean;
  allowFileWrite: boolean;
  allowCloseAny: boolean;
  shell: string;
  extraPath: string[];
  transcriptRoots: string[];
  cursorTranscriptRoots: string[];
  documentConverter: string | null;
  notifyCommand: string[] | null;
  maxReadLines: number;
  maxPromptChars: number;
  maxWaitMs: number;
  maxFileBytes: number;
  maxOutputBytes: number;
  stateDir: string;
}

export class GatewayError extends Error {
  constructor(public code: string, message: string, public details?: unknown) {
    super(message);
  }
}

export type HerdrCall = (method: string, params: Record<string, unknown>, timeoutMs?: number) => Promise<any>;


export function expandHome(p: string): string {
  return p === "~" || p.startsWith("~/") ? resolve(process.env.HOME ?? "/", p.slice(2)) : p;
}

// Absolute path with every symlink in its existing part resolved. A path that does
// not exist yet keeps its missing tail, joined to the real path of the deepest
// ancestor that does, so a symlinked parent cannot smuggle it out of a root.
export function canonical(p: string): string {
  const abs = resolve(expandHome(p));
  const rest: string[] = [];
  let head = abs;
  for (;;) {
    try {
      return join(realpathSync(head), ...rest.reverse());
    } catch {
      const parent = dirname(head);
      if (parent === head) return abs;
      rest.push(basename(head));
      head = parent;
    }
  }
}

function absPath(v: unknown, what: string): string {
  if (typeof v !== "string" || !(v.startsWith("/") || v.startsWith("~/"))) throw new Error(`${what} must be an absolute path: ${v}`);
  return expandHome(v);
}

// The directories the gateway looks in for tools like git and rg, and for agent CLIs.
export function searchPath(extraPath: string[]): string[] {
  return [...extraPath, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"];
}

export function findExecutable(name: string, extraPath: string[]): string | null {
  for (const dir of searchPath(extraPath)) {
    const p = join(dir, name);
    try {
      accessSync(p, constants.X_OK);
      return p;
    } catch {
      // not here
    }
  }
  return null;
}

function pathList(v: unknown, what: string): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) throw new Error(`${what} must be an array`);
  return v.map((p) => absPath(p, `${what} entry`));
}

export function loadConfig(raw: unknown): GatewayConfig {
  if (!raw || typeof raw !== "object") throw new Error("config must be an object");
  const c = raw as Record<string, any>;
  if (!Array.isArray(c.allowedRoots) || c.allowedRoots.length === 0) throw new Error("allowedRoots must be a non-empty array");
  const allowedRoots = c.allowedRoots.map((r: unknown) => {
    if (typeof r !== "string" || !r.startsWith("/") && !r.startsWith("~")) throw new Error(`allowed root must be absolute: ${r}`);
    const p = canonical(r);
    if (p === "/" || p === canonical("~")) throw new Error(`allowed root is too broad: ${r}`);
    return p;
  });
  const repos: Record<string, RepoConfig> = {};
  for (const [key, repo] of Object.entries<any>(c.repos ?? {})) {
    if (!AGENT_NAME_RE.test(key)) throw new Error(`invalid repo key: ${key}`);
    if (typeof repo?.path !== "string") throw new Error(`repo ${key} needs a path`);
    const path = canonical(repo.path);
    if (!withinRoots(path, allowedRoots)) throw new Error(`repo ${key} is outside allowedRoots: ${path}`);
    const tasks: Record<string, string> = {};
    for (const [name, cmd] of Object.entries<any>(repo.tasks ?? {})) {
      if (!AGENT_NAME_RE.test(name) || typeof cmd !== "string" || !cmd.trim() || cmd.includes("\n")) {
        throw new Error(`invalid task ${key}.${name}`);
      }
      tasks[name] = cmd;
    }
    repos[key] = { path, tasks };
  }
  let notifyCommand: string[] | null = null;
  if (c.notifyCommand != null) {
    if (!Array.isArray(c.notifyCommand) || c.notifyCommand.length === 0 || !c.notifyCommand.every((a: unknown) => typeof a === "string")) {
      throw new Error("notifyCommand must be a non-empty array of strings");
    }
    notifyCommand = c.notifyCommand.map((a: string) => expandHome(a));
  }
  // Inline, or the path of a JSON file such as the one scripts/agent-aliases.ts writes.
  const aliasSource = typeof c.agentAliases === "string" ? JSON.parse(readFileSync(absPath(c.agentAliases, "agentAliases"), "utf8")) : c.agentAliases;
  const allAliases: Record<string, AgentAlias> = parseAliases(aliasSource, AGENT_NAME_RE);
  if (c.redact !== undefined && (!Array.isArray(c.redact) || !c.redact.every((w: unknown) => typeof w === "string" && w))) {
    throw new Error("redact must be an array of non-empty strings");
  }
  const extraPath = pathList(c.extraPath, "extraPath");
  // Herdr starts kind "cursor" as cursor-agent. Without a list in the config, offer it where it is installed.
  const agentKinds: string[] = Array.isArray(c.agentKinds)
    ? c.agentKinds.filter((k: unknown) => typeof k === "string")
    : ["claude", "codex", ...(findExecutable("cursor-agent", extraPath) ? ["cursor"] : [])];
  // One alias file serves every machine; each offers only the aliases of kinds it has.
  const agentAliases = Object.fromEntries(Object.entries(allAliases).filter(([, a]) => agentKinds.includes(a.kind)));
  const envShell = process.env.SHELL?.startsWith("/") ? process.env.SHELL : "/bin/sh";
  return {
    herdrSocketPath: expandHome(c.herdrSocketPath ?? "~/.config/herdr/herdr.sock"),
    allowedRoots,
    repos,
    agentKinds,
    agentAliases,
    redact: c.redact ?? DEFAULT_REDACT,
    allowRawPaneRun: c.allowRawPaneRun === true,
    allowWorktreeRemove: c.allowWorktreeRemove === true,
    allowExec: c.allowExec === true,
    allowFileRead: c.allowFileRead === true,
    allowFileWrite: c.allowFileWrite === true,
    allowCloseAny: c.allowCloseAny === true,
    shell: c.shell === undefined ? envShell : absPath(c.shell, "shell"),
    extraPath,
    transcriptRoots: c.transcriptRoots === undefined ? [expandHome("~/.claude/projects")] : pathList(c.transcriptRoots, "transcriptRoots"),
    cursorTranscriptRoots:
      c.cursorTranscriptRoots === undefined ? [expandHome("~/.cursor/projects")] : pathList(c.cursorTranscriptRoots, "cursorTranscriptRoots"),
    documentConverter: c.documentConverter == null ? null : absPath(c.documentConverter, "documentConverter"),
    notifyCommand,
    maxReadLines: clampInt(c.maxReadLines, 1, 2000, 400),
    maxPromptChars: clampInt(c.maxPromptChars, 1, 200_000, 20_000),
    maxWaitMs: clampInt(c.maxWaitMs, 1000, 600_000, 110_000),
    maxFileBytes: clampInt(c.maxFileBytes, 1024, 50_000_000, 2_000_000),
    maxOutputBytes: clampInt(c.maxOutputBytes, 1024, 1_000_000, 60_000),
    stateDir: expandHome(c.stateDir ?? "~/.local/state/herdr-chatgpt"),
  };
}

function clampInt(v: unknown, min: number, max: number, dflt: number): number {
  return typeof v === "number" && Number.isInteger(v) ? Math.min(max, Math.max(min, v)) : dflt;
}

// ---------- scope ----------

export function withinRoots(path: string, roots: string[]): boolean {
  return roots.some((r) => path === r || path.startsWith(r.endsWith("/") ? r : r + "/"));
}

function pathInScope(p: unknown, roots: string[]): boolean {
  return typeof p === "string" && p.startsWith("/") && withinRoots(canonical(p), roots);
}

// A pane is in scope only when every directory Herdr reports for it is inside an allowed root.
export function paneInScope(pane: { cwd?: unknown; foreground_cwd?: unknown }, roots: string[]): boolean {
  const dirs = [pane.cwd, pane.foreground_cwd].filter((d) => d !== undefined && d !== null);
  return dirs.length > 0 && dirs.every((d) => pathInScope(d, roots));
}
