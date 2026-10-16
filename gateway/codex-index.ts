// Codex's own index of its threads: <codex home>/state_<N>.sqlite, table threads with
// the rollout path, cwd, source, originator and last update of every thread the
// app-server daemon has written. One query by cwd names the pane's rollout, so the
// sessions root (hundreds of files, gigabytes) is never listed. The daemon keeps the
// index current per turn (updated_at_ms), and it holds no rollout open, so this is the
// only link from a pane to its thread that does not depend on the agent's start time.
//
// Codex Desktop, `codex exec` and subagent threads (guardian reviews) are indexed too,
// often for the same cwd: the filter mirrors rolloutMeta's TUI rule in transcript.ts,
// and a row Codex 0.160+ labelled originator "codex-tui" comes before the rest. The
// lab's TUI thread (2026-10-15) carries source "vscode" and originator "codex-tui": the
// shared daemon reports vscode for TUI panes, so source alone says nothing. Rows from
// before 2026-09-16 on this Mac have no originator at all.

import { Database } from "bun:sqlite";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

export interface IndexedThread {
  id: string;
  path: string;
  cwd: string;
  updated_at: string | null;
}

const STATE_DB_RE = /^state_(\d+)\.sqlite$/;

// The newest schema version of the index under a Codex home, from one directory read.
export function findCodexStateDb(codexHome: string): string | null {
  let names: string[];
  try {
    names = readdirSync(codexHome);
  } catch {
    return null;
  }
  const versions = names.map((n) => n.match(STATE_DB_RE)).filter((m): m is RegExpMatchArray => m !== null).map((m) => Number(m[1]));
  return versions.length ? join(codexHome, `state_${Math.max(...versions)}.sqlite`) : null;
}

const THREAD_SQL = `
  SELECT id, rollout_path, cwd, updated_at_ms, updated_at FROM threads
  WHERE cwd = ? AND archived = 0
    AND source != 'exec' AND source NOT LIKE '{%'
    AND (thread_source IS NULL OR thread_source = 'user')
    AND (originator IS NULL OR originator != 'Codex Desktop')
  ORDER BY (originator = 'codex-tui') DESC, COALESCE(updated_at_ms, updated_at * 1000) DESC, id DESC LIMIT ?`;

// The index is in WAL mode. Once the daemon checkpoints and closes, its -wal and -shm
// files are gone, and a read-only connection cannot create the -shm it needs: the first
// statement fails with SQLITE_CANTOPEN (seen on 2026-10-15 with Codex 0.162.1). Then
// read it as immutable, which takes no locks, writes nothing beside the file, and
// ignores any -wal that appears meanwhile. So if the daemon reopens and writes between
// the failed read-only attempt and this one, the result is stale (the main file without
// those writes), or in a checkpoint's own window a torn page. A gateway process reads
// once and exits, and this path only runs after the writer checkpointed and closed.
function queryIndex<T>(dbPath: string, run: (db: Database) => T): T | null {
  for (const open of [() => new Database(dbPath, { readonly: true }), () => new Database(`file:${dbPath}?immutable=1`, { readonly: true })]) {
    let db: Database;
    try {
      db = open();
    } catch {
      return null;
    }
    try {
      return run(db);
    } catch (err: any) {
      if (err?.code !== "SQLITE_CANTOPEN") return null;
    } finally {
      db.close();
    }
  }
  return null;
}

// The live TUI threads for cwd, newest first (a codex-tui row before an unlabelled one),
// at most limit. Null when the index is missing or does not have the threads table (an
// older Codex, or another schema); never a throw.
export function indexedCodexThreads(dbPath: string | null, cwd: string, limit = 1): IndexedThread[] | null {
  if (!dbPath || !existsSync(dbPath)) return null;
  return queryIndex(dbPath, (db) => {
    const rows = db.query(THREAD_SQL).all(cwd, limit) as Array<{ id: string; rollout_path: string; cwd: string; updated_at_ms: number | null; updated_at: number | null }>;
    return rows
      .filter((r) => typeof r.id === "string" && typeof r.rollout_path === "string")
      .map((r) => {
        const ms = typeof r.updated_at_ms === "number" ? r.updated_at_ms : typeof r.updated_at === "number" ? r.updated_at * 1000 : null;
        return { id: r.id, path: r.rollout_path, cwd: r.cwd, updated_at: ms === null ? null : new Date(ms).toISOString() };
      });
  });
}
