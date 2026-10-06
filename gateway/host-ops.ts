// Ops that act on the machine itself rather than on Herdr: exec and the file tools.
// Every path is canonicalised (symlinks resolved) and must sit inside an allowed root.

import {
  appendFileSync, closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync,
  readSync, renameSync, statSync, writeFileSync,
} from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { GatewayError, canonical, expandHome, withinRoots, type GatewayConfig } from "./config.ts";
import { gatedBy } from "./gated.ts";
import { optBool, optEnum, optInt, optStr, str, type Op, type Params } from "./params.ts";
import { childEnv, findBinary, isDirectory, runProcess } from "./process.ts";

const DOCUMENT_EXT = new Set([".pdf", ".docx", ".pptx", ".xlsx", ".odt", ".ods", ".odp", ".rtf", ".epub"]);
const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
};
const MAX_IMAGE_BYTES = 3_000_000;
const PROTECTED_MAC_DIRS = ["Downloads", "Documents", "Desktop"];

function rawPath(params: Params, key: string): string {
  const p = str(params, key);
  if (!p.startsWith("/") && !p.startsWith("~/") && p !== "~") {
    throw new GatewayError("invalid_params", `${key} must be absolute or start with ~/`);
  }
  return p;
}

// The gateway's own files: its config and its state. Out of reach even when an allowed
// root contains them.
function privateDirs(cfg: GatewayConfig): string[] {
  const conf = process.env.HERDR_GATEWAY_CONFIG ?? join(process.env.HOME ?? "/", ".config/herdr-chatgpt/gateway.json");
  return [cfg.stateDir, dirname(conf)].map((p) => canonical(p));
}

function checkRoots(cfg: GatewayConfig, p: string): string {
  if (withinRoots(p, privateDirs(cfg))) throw new GatewayError("path_not_allowed", `${p} holds the gateway's own config or state`);
  if (!withinRoots(p, cfg.allowedRoots)) {
    throw new GatewayError("path_not_allowed", `${p} is outside the allowed roots (${cfg.allowedRoots.join(", ")})`);
  }
  return p;
}

// Follows symlinks all the way: for reading, listing and writing through a path.
function resolved(cfg: GatewayConfig, params: Params, key: string): string {
  return checkRoots(cfg, canonical(rawPath(params, key)));
}

// Resolves the parent but not the last component: for moving or deleting the entry itself.
function entry(cfg: GatewayConfig, params: Params, key: string): string {
  const abs = resolve(expandHome(rawPath(params, key)));
  return checkRoots(cfg, join(canonical(dirname(abs)), basename(abs)));
}

function fsError(err: unknown, path: string): GatewayError {
  const e = err as NodeJS.ErrnoException;
  switch (e.code) {
    case "ENOENT":
      return new GatewayError("not_found", `${path} does not exist`);
    case "EEXIST":
      return new GatewayError("already_exists", `${path} already exists`);
    case "EISDIR":
      return new GatewayError("is_directory", `${path} is a directory`);
    case "ENOTDIR":
      return new GatewayError("not_directory", `${path} is not a directory`);
    case "EACCES":
    case "EPERM": {
      const tcc = process.platform === "darwin" && PROTECTED_MAC_DIRS.some((d) => path.startsWith(`${process.env.HOME}/${d}`));
      const hint = tcc ? " (macOS privacy protection: turn on \"Allow full disk access for remote users\" in System Settings > General > Sharing > Remote Login)" : "";
      return new GatewayError("permission_denied", `${path}: ${e.message}${hint}`);
    }
    default:
      return new GatewayError("fs_error", `${path}: ${e.message ?? String(err)}`);
  }
}

function readWindow(path: string, offset: number, length: number): { buf: Buffer; size: number } {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const n = Math.max(0, Math.min(length, size - offset));
    const buf = Buffer.alloc(n);
    if (n > 0) readSync(fd, buf, 0, n, offset);
    return { buf, size };
  } finally {
    closeSync(fd);
  }
}

// Cut a trailing partial UTF-8 sequence so the next window starts on a character.
function wholeChars(buf: Buffer): Buffer {
  for (let i = buf.length - 1; i >= Math.max(0, buf.length - 4); i--) {
    const b = buf[i]!;
    if ((b & 0xc0) === 0x80) continue;
    const need = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 1;
    return i + need > buf.length ? buf.subarray(0, i) : buf;
  }
  return buf;
}

function statOrThrow(path: string) {
  try {
    return statSync(path);
  } catch (e) {
    throw fsError(e, path);
  }
}

function needRead(cfg: GatewayConfig) {
  if (!cfg.allowFileRead) throw new GatewayError("capability_disabled", "file reads are disabled in the gateway config");
}

function needWrite(cfg: GatewayConfig) {
  if (!cfg.allowFileWrite) throw new GatewayError("capability_disabled", "file writes are disabled in the gateway config");
}

// exec's parameters, shared with the pane-based exec (pane-exec.ts).
export function execParams(cfg: GatewayConfig, params: Params, repoPath: (key: string) => string) {
  if (!cfg.allowExec) throw new GatewayError("capability_disabled", "exec is disabled in the gateway config");
  const command = str(params, "command");
  if (command.length > 20_000) throw new GatewayError("invalid_params", "command exceeds 20000 characters");
  const stdin = params.stdin === undefined || params.stdin === null ? undefined : String(params.stdin);
  if (stdin !== undefined && stdin.length > cfg.maxFileBytes) throw new GatewayError("invalid_params", "stdin is too large");
  const gated = gatedBy(`${command}\n${stdin ?? ""}`);
  if (gated && params.confirm !== true) {
    throw new GatewayError("needs_confirmation", `this command runs a ${gated}, which is the owner's call: ask them, then call again with confirm: true`);
  }
  const repo = optStr(params, "repo");
  const cwd = params.cwd !== undefined && params.cwd !== null ? resolved(cfg, params, "cwd") : repo ? repoPath(repo) : cfg.allowedRoots[0]!;
  if (!isDirectory(cwd)) throw new GatewayError("not_directory", `${cwd} is not a directory`);
  const timeoutMs = optInt(params, "timeout_ms", 1000, cfg.maxWaitMs) ?? Math.min(60_000, cfg.maxWaitMs);
  return { command, stdin, cwd, timeoutMs };
}

export function hostOps(cfg: GatewayConfig, repoPath: (key: string) => string): Record<string, Op> {
  return {
    async exec(params) {
      const { command, stdin, cwd, timeoutMs } = execParams(cfg, params, repoPath);
      const res = await runProcess([cfg.shell, "-lc", command], { cwd, env: childEnv(cfg), timeoutMs, maxBytes: cfg.maxOutputBytes, stdin });
      return { cwd, ...res };
    },

    // Replaced by pane-exec.ts when execInPane is on: only a pane has the owner's screen.
    async screenshot() {
      throw new GatewayError("capability_disabled", "screenshots need execInPane in the gateway config, on macOS");
    },

    async list_dir(params) {
      needRead(cfg);
      const dir = resolved(cfg, params, "path");
      const hidden = optBool(params, "include_hidden", false);
      const limit = optInt(params, "limit", 1, 2000) ?? 500;
      let names: string[];
      try {
        names = readdirSync(dir);
      } catch (e) {
        throw fsError(e, dir);
      }
      names = names.filter((n) => hidden || !n.startsWith("."));
      const entries = names.map((name) => {
        const full = join(dir, name);
        try {
          const st = lstatSync(full);
          const type = st.isDirectory() ? "dir" : st.isFile() ? "file" : st.isSymbolicLink() ? "symlink" : "other";
          const e: Record<string, unknown> = { name, type, modified: st.mtime.toISOString() };
          if (type === "file") e.size = st.size;
          if (type === "symlink") e.target = readlinkSync(full);
          return e;
        } catch {
          return { name, type: "unknown" } as Record<string, unknown>;
        }
      });
      entries.sort((a, b) => Number(b.type === "dir") - Number(a.type === "dir") || String(a.name).localeCompare(String(b.name)));
      return { path: dir, total: entries.length, truncated: entries.length > limit, entries: entries.slice(0, limit) };
    },

    async read_file(params) {
      needRead(cfg);
      const path = resolved(cfg, params, "path");
      const as = optEnum(params, "as", ["auto", "text", "document", "image", "base64"] as const, "auto");
      const offset = optInt(params, "offset", 0, Number.MAX_SAFE_INTEGER) ?? 0;
      const maxBytes = optInt(params, "max_bytes", 1, cfg.maxFileBytes) ?? Math.min(200_000, cfg.maxFileBytes);
      const st = statOrThrow(path);
      if (st.isDirectory()) throw new GatewayError("is_directory", `${path} is a directory; use list_dir`);
      const ext = extname(path).toLowerCase();
      const kind = as !== "auto" ? as : DOCUMENT_EXT.has(ext) && cfg.documentConverter ? "document" : IMAGE_MIME[ext] ? "image" : "text";
      const base = { path, size: st.size, modified: st.mtime.toISOString() };

      if (kind === "document") {
        if (!cfg.documentConverter) throw new GatewayError("capability_disabled", "no documentConverter is configured");
        const res = await runProcess([cfg.documentConverter, path], {
          cwd: dirname(path), env: childEnv(cfg), timeoutMs: Math.min(90_000, cfg.maxWaitMs), maxBytes: 20_000_000,
        });
        if (res.exit_code !== 0) throw new GatewayError("convert_failed", res.stderr.trim().slice(-500) || `converter exited ${res.exit_code}`);
        const text = res.stdout.slice(offset, offset + maxBytes);
        const next = offset + text.length;
        return { ...base, kind, format: "markdown", offset, next_offset: next < res.stdout.length ? next : null, length: res.stdout.length, text };
      }

      if (kind === "image") {
        if (st.size > MAX_IMAGE_BYTES) {
          throw new GatewayError("too_large", `image is ${st.size} bytes; the limit is ${MAX_IMAGE_BYTES}. Shrink a copy first (macOS: sips -Z 1600 in.png --out /tmp/small.png)`);
        }
        let data: Buffer;
        try {
          data = readFileSync(path);
        } catch (e) {
          throw fsError(e, path);
        }
        return { ...base, kind, image: { mime: IMAGE_MIME[ext] ?? "application/octet-stream", data: data.toString("base64") } };
      }

      let win: { buf: Buffer; size: number };
      try {
        win = readWindow(path, offset, maxBytes);
      } catch (e) {
        throw fsError(e, path);
      }
      const eof = offset + win.buf.length >= win.size;
      if (kind === "base64") {
        return { ...base, kind, offset, bytes: win.buf.length, next_offset: eof ? null : offset + win.buf.length, data: win.buf.toString("base64") };
      }
      if (as === "auto" && win.buf.subarray(0, 8192).includes(0)) {
        return { ...base, kind: "binary", note: "binary file: pass as=base64 for raw bytes, or inspect it with exec (file, unzip -l, ...)" };
      }
      const buf = eof ? win.buf : wholeChars(win.buf);
      return { ...base, kind: "text", offset, bytes: buf.length, next_offset: eof ? null : offset + buf.length, text: buf.toString("utf8") };
    },

    async write_file(params) {
      needWrite(cfg);
      const path = resolved(cfg, params, "path");
      const hasText = typeof params.content === "string";
      const hasB64 = typeof params.content_base64 === "string";
      if (hasText === hasB64) throw new GatewayError("invalid_params", "pass exactly one of content or content_base64");
      const data = hasText ? Buffer.from(params.content as string, "utf8") : Buffer.from(params.content_base64 as string, "base64");
      if (data.length > cfg.maxFileBytes) throw new GatewayError("too_large", `content exceeds ${cfg.maxFileBytes} bytes`);
      const mode = optEnum(params, "mode", ["create", "overwrite", "append"] as const, "create");
      try {
        if (optBool(params, "make_parents", true)) mkdirSync(dirname(path), { recursive: true });
        if (mode === "append") appendFileSync(path, data);
        else if (mode === "create") writeFileSync(path, data, { flag: "wx" });
        else {
          // Write beside the target and rename over it, keeping the old file's mode.
          const old = existsSync(path) ? statSync(path).mode & 0o7777 : 0o644;
          const tmp = `${path}.workdone-${process.pid}.tmp`;
          writeFileSync(tmp, data, { mode: old });
          renameSync(tmp, path);
        }
      } catch (e) {
        throw fsError(e, path);
      }
      return { path, bytes: data.length, mode };
    },

    async move_path(params) {
      needWrite(cfg);
      const from = entry(cfg, params, "from");
      const to = entry(cfg, params, "to");
      if (cfg.allowedRoots.some((r) => withinRoots(r, [from]))) throw new GatewayError("invalid_params", "cannot move an allowed root or a folder that contains one");
      if (!optBool(params, "overwrite", false) && existsSync(to)) throw new GatewayError("already_exists", `${to} already exists`);
      try {
        if (optBool(params, "make_parents", true)) mkdirSync(dirname(to), { recursive: true });
        renameSync(from, to);
      } catch (e) {
        throw fsError(e, from);
      }
      return { from, to };
    },

    // Deleting moves the entry into the gateway's own trash folder, so a mistake can be undone.
    async delete_path(params) {
      needWrite(cfg);
      const path = entry(cfg, params, "path");
      if (cfg.allowedRoots.some((r) => withinRoots(r, [path]))) throw new GatewayError("invalid_params", "cannot delete an allowed root or a folder that contains one");
      try {
        lstatSync(path);
      } catch (e) {
        throw fsError(e, path);
      }
      const trash = join(cfg.stateDir, "trash");
      const dest = join(trash, `${new Date().toISOString().replace(/[:.]/g, "-")}-${basename(path)}`);
      try {
        mkdirSync(trash, { recursive: true, mode: 0o700 });
        renameSync(path, dest);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "EXDEV") {
          throw new GatewayError("fs_error", `${path} is on another volume than the trash folder; delete it with exec instead`);
        }
        throw fsError(e, path);
      }
      return { path, moved_to: dest };
    },

    async search_files(params) {
      needRead(cfg);
      const dir = resolved(cfg, params, "path");
      const pattern = str(params, "pattern");
      if (pattern.length > 500) throw new GatewayError("invalid_params", "pattern exceeds 500 characters");
      const glob = optStr(params, "glob");
      const max = optInt(params, "max_results", 1, 1000) ?? 200;
      const rg = findBinary("rg", cfg);
      if (!rg) throw new GatewayError("not_available", "ripgrep (rg) is not installed on this machine");
      const argv = [rg, "--line-number", "--with-filename", "--null", "--no-heading", "--color=never", "--max-columns=300", "--max-columns-preview", "--max-count=50", "--max-filesize=5M"];
      if (optBool(params, "fixed_strings", false)) argv.push("--fixed-strings");
      if (optBool(params, "case_insensitive", false)) argv.push("--ignore-case");
      if (optBool(params, "include_hidden", false)) argv.push("--hidden");
      if (glob) argv.push("--glob", glob);
      argv.push("--regexp", pattern, "--", dir);
      const res = await runProcess(argv, { cwd: isDirectory(dir) ? dir : dirname(dir), env: childEnv(cfg), timeoutMs: 30_000, maxBytes: 400_000 });
      if (res.exit_code === 2 && !res.stdout) throw new GatewayError("search_failed", res.stderr.trim().slice(0, 500));
      const matches: Array<{ path: string; line: number; text: string }> = [];
      let total = 0;
      for (const l of res.stdout.split("\n")) {
        const nul = l.indexOf("\0");
        if (nul < 0) continue;
        total++;
        if (matches.length >= max) continue;
        const rest = l.slice(nul + 1);
        const colon = rest.indexOf(":");
        matches.push({ path: l.slice(0, nul), line: Number(rest.slice(0, colon)), text: rest.slice(colon + 1) });
      }
      return { path: dir, matches, truncated: total > max || res.stdout_truncated, timed_out: res.timed_out };
    },
  };
}
