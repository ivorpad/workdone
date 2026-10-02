// oidc-provider's storage on SQLite, so authorizations and refresh tokens survive a
// restart (the default adapter is in memory, and ChatGPT would have to sign in again).
// node:sqlite, because oidc-provider supports Node and the issuer runs there; Bun has it too.

import { DatabaseSync } from "node:sqlite";
import type { Adapter, AdapterPayload } from "oidc-provider";

export function openDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`CREATE TABLE IF NOT EXISTS oidc (
    model TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL,
    grant_id TEXT, user_code TEXT, uid TEXT, expires_at INTEGER,
    PRIMARY KEY (model, id))`);
  db.exec("CREATE INDEX IF NOT EXISTS oidc_grant ON oidc (grant_id)");
  db.exec("CREATE INDEX IF NOT EXISTS oidc_uid ON oidc (uid)");
  db.exec("CREATE INDEX IF NOT EXISTS oidc_user_code ON oidc (user_code)");
  return db;
}

export function sqliteAdapter(db: DatabaseSync, now: () => number = Date.now) {
  return class SqliteAdapter implements Adapter {
    private model: string;
    constructor(model: string) {
      this.model = model;
    }

    private row(where: string, ...args: (string | number)[]): AdapterPayload | undefined {
      const r = db.prepare(`SELECT payload, expires_at FROM oidc WHERE model = ? AND ${where}`).get(this.model, ...args) as { payload: string; expires_at: number | null } | undefined;
      if (!r || (r.expires_at !== null && r.expires_at <= now())) return undefined;
      return JSON.parse(r.payload);
    }

    async upsert(id: string, payload: AdapterPayload, expiresIn: number) {
      db.prepare(`INSERT OR REPLACE INTO oidc (model, id, payload, grant_id, user_code, uid, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(this.model, id, JSON.stringify(payload), payload.grantId ?? null, payload.userCode ?? null, payload.uid ?? null, expiresIn ? now() + expiresIn * 1000 : null);
    }
    async find(id: string) { return this.row("id = ?", id); }
    async findByUid(uid: string) { return this.row("uid = ?", uid); }
    async findByUserCode(code: string) { return this.row("user_code = ?", code); }
    async consume(id: string) {
      const p = this.row("id = ?", id);
      if (!p) return;
      p.consumed = Math.floor(now() / 1000);
      db.prepare("UPDATE oidc SET payload = ? WHERE model = ? AND id = ?").run(JSON.stringify(p), this.model, id);
    }
    async destroy(id: string) { db.prepare("DELETE FROM oidc WHERE model = ? AND id = ?").run(this.model, id); }
    async revokeByGrantId(grantId: string) { db.prepare("DELETE FROM oidc WHERE grant_id = ?").run(grantId); }
  };
}

export function sweep(db: DatabaseSync, now: () => number = Date.now) {
  db.prepare("DELETE FROM oidc WHERE expires_at IS NOT NULL AND expires_at <= ?").run(now());
}
