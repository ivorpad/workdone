// Git evidence for the supervisor and for final results: the commit, its tree, and a
// digest of the uncommitted changes, so two turns can be compared without keeping or
// sending the diff itself. Read-only git, fixed argv, no optional locks.

import { createHash } from "node:crypto";
import type { GatewayConfig } from "./config.ts";
import { childEnv, findBinary, runProcess } from "./process.ts";

export interface Checkpoint {
  commit?: string;
  tree?: string;
  // Digest of `git status --porcelain` and the full `git diff HEAD`: changes when the
  // working state does, including an edit that keeps line counts. Untracked files
  // count by name only.
  diff: string;
  clean: boolean;
  changed: number;
  branch: string | null;
  upstream: string | null;
  ahead: number | null;
}

const short = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);

// What an agent said, reduced to compare one turn's answer with the next.
export function activityDigest(text: string | null | undefined): string | undefined {
  const t = text?.toLowerCase().replace(/\d+/g, "#").replace(/\s+/g, " ").trim();
  return t ? short(t.slice(0, 2000)) : undefined;
}

export async function checkpoint(cfg: GatewayConfig, cwd: string | null | undefined): Promise<Checkpoint | null> {
  const git = findBinary("git", cfg);
  if (!git || !cwd) return null;
  const base = [git, "--no-optional-locks", "-c", "core.fsmonitor=false", "-C", cwd];
  const run = (args: string[]) =>
    runProcess([...base, ...args], { cwd, env: childEnv(cfg), timeoutMs: 5000, maxBytes: 400_000 }).catch(() => null);
  const status = await run(["status", "--porcelain=v1", "--branch"]);
  if (!status || status.exit_code !== 0) return null;
  const lines = status.stdout.split("\n").filter(Boolean);
  const head = lines[0]?.startsWith("## ") ? lines.shift()!.slice(3) : "";
  const [local, rest = ""] = head.replace(/^No commits yet on /, "").split("...");
  const upstream = rest ? rest.split(" ")[0]! : null;
  const ahead = upstream ? Number(/\[ahead (\d+)/.exec(rest)?.[1] ?? 0) : null;
  const ids = await run(["rev-parse", "HEAD", "HEAD^{tree}"]);
  const [commit, tree] = ids?.exit_code === 0 ? ids.stdout.trim().split("\n") : [];
  // The diff goes through git hash-object in a pipe, so its size never matters here.
  const diff = commit
    ? await runProcess(["/bin/sh", "-c", '"$@" diff HEAD --binary | "$1" hash-object --stdin', "sh", ...base],
      { cwd, env: childEnv(cfg), timeoutMs: 10_000, maxBytes: 200 }).catch(() => null)
    : null;
  const diffId = diff?.exit_code === 0 ? diff.stdout.trim() : "";
  return {
    ...(commit ? { commit } : {}),
    ...(tree ? { tree } : {}),
    diff: short(`${lines.join("\n")}\n--\n${diffId}`),
    clean: lines.length === 0,
    changed: lines.length,
    branch: local ? local.split(" ")[0]! : null,
    upstream,
    ahead,
  };
}
