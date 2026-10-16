// Codex's thread index, in the shape ~/.codex/state_5.sqlite had on 2026-10-15 (Codex 0.162.1).
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { findCodexStateDb, indexedCodexThreads } from "../gateway/codex-index.ts";

// The columns the query touches, as `.schema threads` prints them (the rest left out).
const SCHEMA = `CREATE TABLE threads (
  id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  source TEXT NOT NULL, model_provider TEXT NOT NULL, cwd TEXT NOT NULL, title TEXT NOT NULL,
  sandbox_policy TEXT NOT NULL, approval_mode TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0,
  thread_source TEXT, updated_at_ms INTEGER, originator TEXT);
CREATE INDEX idx_threads_updated_at ON threads(updated_at DESC, id DESC);`;

type Row = { id: string; cwd: string; at: number; source?: string; thread_source?: string | null; originator?: string | null; archived?: number; ms?: boolean };

function index(rows: Row[]): string {
  const dir = mkdtempSync(join(tmpdir(), "herdr-codex-index-"));
  const path = join(dir, "state_5.sqlite");
  const db = new Database(path);
  db.run("PRAGMA journal_mode = WAL");
  db.run(SCHEMA);
  const ins = db.query("INSERT INTO threads (id, rollout_path, created_at, updated_at, source, model_provider, cwd, title, sandbox_policy, approval_mode, archived, thread_source, updated_at_ms, originator) VALUES (?, ?, ?, ?, ?, 'openai', ?, '', '', '', ?, ?, ?, ?)");
  for (const r of rows) {
    ins.run(r.id, `/home/u/.codex/sessions/2026/10/15/rollout-2026-10-15T10-00-00-${r.id}.jsonl`, Math.floor(r.at / 1000), Math.floor(r.at / 1000), r.source ?? "cli", r.cwd, r.archived ?? 0, r.thread_source === undefined ? "user" : r.thread_source, r.ms === false ? null : r.at, r.originator === undefined ? "codex-tui" : r.originator);
  }
  db.close();
  return path;
}

const CWD = "/srv/allowed/app";
const T = Date.UTC(2026, 9, 15, 15, 0, 0);

describe("Codex thread index", () => {
  test("the newest live TUI thread for the cwd, whatever source the daemon recorded", () => {
    const db = index([
      { id: "older", cwd: CWD, at: T - 3_600_000 },
      // The lab's own row: a TUI pane that the shared daemon files as vscode.
      { id: "pane", cwd: CWD, at: T, source: "vscode" },
      { id: "elsewhere", cwd: "/srv/allowed/other", at: T + 60_000 },
    ]);
    expect(indexedCodexThreads(db, CWD)).toEqual([{ id: "pane", path: "/home/u/.codex/sessions/2026/10/15/rollout-2026-10-15T10-00-00-pane.jsonl", cwd: CWD, updated_at: "2026-10-15T15:00:00.000Z" }]);
    expect(indexedCodexThreads(db, CWD, 5)!.map((t) => t.id)).toEqual(["pane", "older"]);
    expect(indexedCodexThreads(db, "/nowhere")).toEqual([]);
  });

  test("exec, Codex Desktop, subagent and archived threads for the cwd are not the pane's", () => {
    const db = index([
      { id: "mine", cwd: CWD, at: T - 10_000 },
      { id: "exec", cwd: CWD, at: T, source: "exec", originator: "codex_exec" },
      { id: "desktop", cwd: CWD, at: T + 1, source: "vscode", originator: "Codex Desktop" },
      { id: "guardian", cwd: CWD, at: T + 2, source: '{"subagent":{"other":"guardian"}}', thread_source: "guardian_review" },
      { id: "sub", cwd: CWD, at: T + 3, source: "vscode", thread_source: "subagent" },
      { id: "gone", cwd: CWD, at: T + 4, archived: 1 },
    ]);
    expect(indexedCodexThreads(db, CWD, 10)!.map((t) => t.id)).toEqual(["mine"]);
  });

  test("a thread labelled codex-tui comes before a newer one with no label; unlabelled rows order by their second timestamps", () => {
    const db = index([
      { id: "old-newer", cwd: CWD, at: T, ms: false, originator: null, thread_source: null },
      { id: "old-older", cwd: CWD, at: T - 5_000, ms: false, originator: null, thread_source: null },
      { id: "tui", cwd: CWD, at: T - 60_000 },
    ]);
    expect(indexedCodexThreads(db, CWD, 3)!.map((t) => [t.id, t.updated_at])).toEqual([
      ["tui", "2026-10-15T14:59:00.000Z"], ["old-newer", "2026-10-15T15:00:00.000Z"], ["old-older", "2026-10-15T14:59:55.000Z"],
    ]);
  });

  test("after the daemon checkpointed (no -wal, no -shm), the index still reads, and nothing is written beside it", () => {
    const db = index([{ id: "pane", cwd: CWD, at: T }]);
    for (const side of ["-wal", "-shm"]) rmSync(db + side, { force: true });
    expect(indexedCodexThreads(db, CWD)!.map((t) => t.id)).toEqual(["pane"]);
    expect(readdirSync(dirname(db))).toEqual(["state_5.sqlite"]);
  });

  test("no index, a file that is not sqlite, or a schema without threads: null, not a throw", () => {
    expect(indexedCodexThreads(null, CWD)).toBeNull();
    expect(indexedCodexThreads("/nonexistent/state_5.sqlite", CWD)).toBeNull();
    const dir = mkdtempSync(join(tmpdir(), "herdr-codex-index-"));
    writeFileSync(join(dir, "state_5.sqlite"), "not a database");
    expect(indexedCodexThreads(join(dir, "state_5.sqlite"), CWD)).toBeNull();
    const other = new Database(join(dir, "state_6.sqlite"));
    other.run("CREATE TABLE unrelated (id TEXT)");
    other.close();
    expect(indexedCodexThreads(join(dir, "state_6.sqlite"), CWD)).toBeNull();
  });

  test("the newest schema version under the Codex home, from one directory read", () => {
    const home = mkdtempSync(join(tmpdir(), "herdr-codex-home-"));
    expect(findCodexStateDb(home)).toBeNull();
    for (const n of ["state_5.sqlite", "state_5.before-retag-20260723.sqlite", "state_12.sqlite", "state_5.sqlite-wal", "logs_2.sqlite"]) writeFileSync(join(home, n), "");
    expect(findCodexStateDb(home)).toBe(join(home, "state_12.sqlite"));
    expect(findCodexStateDb(join(home, "missing"))).toBeNull();
  });
});
