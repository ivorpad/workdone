import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../gateway/config.ts";
import { hostOps } from "../gateway/host-ops.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "herdr-host-root-")));
const outside = realpathSync(mkdtempSync(join(tmpdir(), "herdr-host-out-")));
const state = mkdtempSync(join(tmpdir(), "herdr-host-state-"));
writeFileSync(join(outside, "secret.txt"), "nope");
symlinkSync(outside, join(root, "escape"));
writeFileSync(join(root, "hello.txt"), "hello\nworld\n");

const base = { allowedRoots: [root], stateDir: state, shell: "/bin/sh" };
const full = hostOps(loadConfig({ ...base, allowExec: true, allowFileRead: true, allowFileWrite: true }), () => root);
const locked = hostOps(loadConfig(base), () => root);

describe("paths", () => {
  test("a symlink out of the root is refused", async () => {
    await expect(full.read_file!({ path: join(root, "escape", "secret.txt") })).rejects.toMatchObject({ code: "path_not_allowed" });
    await expect(full.list_dir!({ path: join(root, "escape") })).rejects.toMatchObject({ code: "path_not_allowed" });
  });
  test("the gateway's state and alias map are refused even inside a root", async () => {
    const own = realpathSync(mkdtempSync(join(tmpdir(), "herdr-host-own-")));
    const inside = join(own, "gw-state");
    mkdirSync(inside);
    writeFileSync(join(inside, "watch.json"), "{}");
    writeFileSync(join(own, "aliases.json"), JSON.stringify({ otter: { kind: "claude", args: [] } }));
    writeFileSync(join(own, "notes.txt"), "fine");
    const ops = hostOps(loadConfig({ ...base, allowedRoots: [own], stateDir: inside, allowFileRead: true, agentAliases: join(own, "aliases.json") }), () => own);
    await expect(ops.read_file!({ path: join(inside, "watch.json") })).rejects.toMatchObject({ code: "path_not_allowed" });
    await expect(ops.read_file!({ path: join(own, "aliases.json") })).rejects.toMatchObject({ code: "path_not_allowed" });
    expect(await ops.read_file!({ path: join(own, "notes.txt") })).toBeDefined();
  });
  test("relative paths are refused", async () => {
    await expect(full.read_file!({ path: "hello.txt" })).rejects.toMatchObject({ code: "invalid_params" });
  });
  test("writing through a symlinked parent is refused", async () => {
    await expect(full.write_file!({ path: join(root, "escape", "new.txt"), content: "x" })).rejects.toMatchObject({ code: "path_not_allowed" });
    expect(existsSync(join(outside, "new.txt"))).toBe(false);
  });
});

describe("files", () => {
  test("list_dir shows entries with types, dirs first", async () => {
    mkdirSync(join(root, "sub"), { recursive: true });
    const res: any = await full.list_dir!({ path: root });
    expect(res.entries[0]).toMatchObject({ name: "sub", type: "dir" });
    expect(res.entries.find((e: any) => e.name === "escape")).toMatchObject({ type: "symlink", target: outside });
    expect(res.entries.find((e: any) => e.name === "hello.txt")).toMatchObject({ type: "file", size: 12 });
  });
  test("read_file pages text without splitting a character", async () => {
    writeFileSync(join(root, "utf8.txt"), "aé".repeat(10));
    const first: any = await full.read_file!({ path: join(root, "utf8.txt"), max_bytes: 4 });
    expect(first.text).toBe("aéa");
    expect(first.next_offset).toBe(4);
    const rest: any = await full.read_file!({ path: join(root, "utf8.txt"), offset: first.next_offset, max_bytes: 1000 });
    expect(first.text + rest.text).toBe("aé".repeat(10));
    expect(rest.next_offset).toBeNull();
  });
  test("binary files are described, not dumped", async () => {
    writeFileSync(join(root, "blob.bin"), Buffer.from([1, 0, 2, 3]));
    expect(await full.read_file!({ path: join(root, "blob.bin") })).toMatchObject({ kind: "binary" });
    expect(await full.read_file!({ path: join(root, "blob.bin"), as: "base64" })).toMatchObject({ kind: "base64", data: "AQACAw==" });
  });
  test("images come back as base64 with a mime type", async () => {
    writeFileSync(join(root, "dot.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const res: any = await full.read_file!({ path: join(root, "dot.png") });
    expect(res.image).toEqual({ mime: "image/png", data: "iVBORw==" });
  });
  test("documents go through the configured converter", async () => {
    const conv = join(state, "fake-anydoc");
    writeFileSync(conv, '#!/bin/sh\nprintf "# converted %s" "$(basename "$1")"\n');
    chmodSync(conv, 0o755);
    const ops = hostOps(loadConfig({ ...base, allowFileRead: true, documentConverter: conv }), () => root);
    writeFileSync(join(root, "report.pdf"), "%PDF-1.4");
    expect(await ops.read_file!({ path: join(root, "report.pdf") })).toMatchObject({ kind: "document", text: "# converted report.pdf" });
  });
  test("reads need the capability", async () => {
    await expect(locked.read_file!({ path: join(root, "hello.txt") })).rejects.toMatchObject({ code: "capability_disabled" });
    await expect(locked.list_dir!({ path: root })).rejects.toMatchObject({ code: "capability_disabled" });
    await expect(locked.search_files!({ path: root, pattern: "x" })).rejects.toMatchObject({ code: "capability_disabled" });
  });
  test("writes need the capability", async () => {
    await expect(locked.write_file!({ path: join(root, "a.txt"), content: "x" })).rejects.toMatchObject({ code: "capability_disabled" });
    await expect(locked.delete_path!({ path: join(root, "hello.txt") })).rejects.toMatchObject({ code: "capability_disabled" });
  });
  test("create refuses to overwrite; overwrite and append work", async () => {
    const p = join(root, "notes", "n.txt");
    await full.write_file!({ path: p, content: "one" });
    await expect(full.write_file!({ path: p, content: "two" })).rejects.toMatchObject({ code: "already_exists" });
    await full.write_file!({ path: p, content: "two", mode: "overwrite" });
    await full.write_file!({ path: p, content: "!", mode: "append" });
    expect(readFileSync(p, "utf8")).toBe("two!");
  });
  test("delete moves into the gateway trash, never the roots themselves", async () => {
    const p = join(root, "gone.txt");
    writeFileSync(p, "bye");
    const res: any = await full.delete_path!({ path: p });
    expect(existsSync(p)).toBe(false);
    expect(readFileSync(res.moved_to, "utf8")).toBe("bye");
    await expect(full.delete_path!({ path: root })).rejects.toMatchObject({ code: "invalid_params" });
  });
  test("deleting a symlink removes the link, not its target", async () => {
    await full.delete_path!({ path: join(root, "escape") });
    expect(existsSync(join(outside, "secret.txt"))).toBe(true);
    symlinkSync(outside, join(root, "escape"));
  });
  test("move stays inside the roots", async () => {
    writeFileSync(join(root, "m.txt"), "m");
    await full.move_path!({ from: join(root, "m.txt"), to: join(root, "sub", "m.txt") });
    expect(readFileSync(join(root, "sub", "m.txt"), "utf8")).toBe("m");
    await expect(full.move_path!({ from: join(root, "sub", "m.txt"), to: join(outside, "m.txt") })).rejects.toMatchObject({ code: "path_not_allowed" });
  });
  test("search_files finds lines", async () => {
    const res: any = await full.search_files!({ path: root, pattern: "wor.d" }).catch((e) => e);
    if (res?.code === "not_available") return; // no ripgrep on this machine
    expect(res.matches).toContainEqual({ path: join(root, "hello.txt"), line: 2, text: "world" });
  });
});

describe("exec", () => {
  test("disabled unless allowExec", async () => {
    await expect(locked.exec!({ command: "true" })).rejects.toMatchObject({ code: "capability_disabled" });
  });
  test("returns exit code, output and cwd", async () => {
    const res: any = await full.exec!({ command: "echo out; echo err >&2; exit 3" });
    expect(res).toMatchObject({ exit_code: 3, stdout: "out\n", stderr: "err\n", cwd: root, timed_out: false });
  });
  test("passes stdin", async () => {
    const res: any = await full.exec!({ command: "tr a-z A-Z", stdin: "shout" });
    expect(res.stdout).toBe("SHOUT");
  });
  test("refuses a cwd outside the roots", async () => {
    await expect(full.exec!({ command: "pwd", cwd: outside })).rejects.toMatchObject({ code: "path_not_allowed" });
  });
  test("a timeout kills the whole process group", async () => {
    const res: any = await full.exec!({ command: "sleep 30 & sleep 30", timeout_ms: 1000 });
    expect(res.timed_out).toBe(true);
    expect(res.duration_ms).toBeLessThan(5000);
  });
  test("a backgrounded child does not hold the call open", async () => {
    const res: any = await full.exec!({ command: "sleep 20 >/dev/null 2>&1 & echo started" });
    expect(res.stdout).toBe("started\n");
    expect(res.duration_ms).toBeLessThan(3000);
  });
  test("keeps the start and end of long output", async () => {
    const ops = hostOps(loadConfig({ ...base, allowExec: true, maxOutputBytes: 2000 }), () => root);
    const res: any = await ops.exec!({ command: "seq 1 5000" });
    expect(res.stdout_truncated).toBe(true);
    expect(res.stdout.startsWith("1\n2\n")).toBe(true);
    expect(res.stdout.trimEnd().endsWith("5000")).toBe(true);
  });
});
