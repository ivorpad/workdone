// Small JSON files in the gateway's state directory: which panes, tabs and workspaces
// the bridge created, and which agents to report on when they finish or need the owner.
// Also the audit log, and the lock that keeps two processes from answering one menu.

import { appendFileSync, mkdirSync, readFileSync, renameSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export type CreatedKind = "panes" | "tabs" | "workspaces";

// A watched agent, keyed by pane ID. prompt_agent watches one turn: the entry goes
// once that turn is reported. A managed entry (watch_agent, or an agent started
// through the bridge) reports every turn and stays until the agent exits.
export interface Watched {
  name: string | null;
  cwd: string | null;
  since: string;
  last_status?: string;
  kind?: string | null;
  managed?: boolean;
  // Managed only: a turn is running that has not been reported yet, and when
  // prompt_agent started it without waiting for the answer.
  busy?: boolean;
  prompted_at?: string;
  // Herdr's state_change_seq when last seen: it moves on every status change, so a
  // turn shorter than the poll interval still shows. session is its session ID.
  seq?: number;
  session?: string | null;
  // New on every write outside the poller, so a poll that read the entry earlier can
  // tell that its decision about it is out of date.
  rev?: string;
  last_event?: { type: string; at: string; excerpt: string | null };
}

export type WatchInfo = Pick<Watched, "name" | "cwd" | "kind">;

// What a Herdr agent object says about the fields the watcher compares.
export function seenState(a: any): Pick<Watched, "last_status" | "seq" | "session"> {
  const out: Pick<Watched, "last_status" | "seq" | "session"> = { last_status: a?.agent_status ?? "unknown" };
  if (typeof a?.state_change_seq === "number") out.seq = a.state_change_seq;
  if (typeof a?.agent_session?.value === "string") out.session = a.agent_session.value;
  return out;
}

const newRev = () => Math.random().toString(36).slice(2, 10);

export class StateStore {
  constructor(private dir: string) {}

  private read(file: string): unknown {
    try {
      return JSON.parse(readFileSync(resolve(this.dir, file), "utf8"));
    } catch {
      return undefined;
    }
  }

  private write(file: string, value: unknown) {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const path = resolve(this.dir, file);
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
    renameSync(tmp, path);
  }

  created(kind: CreatedKind): string[] {
    const v = this.read(`created-${kind}.json`);
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  }

  remember(kind: CreatedKind, id: string) {
    this.write(`created-${kind}.json`, [...this.created(kind).filter((x) => x !== id), id].slice(-200));
  }

  forget(kind: CreatedKind, id: string) {
    this.write(`created-${kind}.json`, this.created(kind).filter((x) => x !== id));
  }

  // The alias each agent started through the bridge was started as, by pane ID and by name.
  alias(target: string): string | null {
    const v = this.read("aliases.json") as Record<string, unknown> | undefined;
    const a = v && Object.hasOwn(v, target) ? v[target] : null;
    return typeof a === "string" ? a : null;
  }

  setAlias(paneId: string, name: string, alias: string) {
    const v = this.read("aliases.json");
    const cur = v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, string>) : {};
    delete cur[paneId];
    delete cur[name];
    this.write("aliases.json", Object.fromEntries([...Object.entries(cur), [paneId, alias], [name, alias]].slice(-400)));
  }

  // The workspace pane exec opens its tabs in.
  execWorkspace(): string | null {
    const v = this.read("exec-workspace.json") as { id?: unknown } | undefined;
    return typeof v?.id === "string" ? v.id : null;
  }

  setExecWorkspace(id: string) {
    this.write("exec-workspace.json", { id });
  }

  watched(): Record<string, Watched> {
    const v = this.read("watch.json");
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, Watched>) : {};
  }

  // Read, change and write watch.json while holding its lock. Every op runs in its own
  // process, so two watch_agent calls, or a prompt and a poll, can overlap. Writes
  // only when fn changed something.
  updateWatched<T>(fn: (w: Record<string, Watched>) => T): T {
    return this.locked(() => {
      const w = this.watched();
      const before = JSON.stringify(w);
      const out = fn(w);
      if (JSON.stringify(w) !== before) this.write("watch.json", w);
      return out;
    });
  }

  // A directory as the lock: mkdir either creates it or fails. The lock is held for a
  // read and a write. One older than 10 s was left by a process that died holding it;
  // after 3 s of waiting the caller goes ahead without it rather than fail the op.
  private locked<T>(fn: () => T): T {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const lock = resolve(this.dir, "watch.lock");
    let held = false;
    for (const deadline = Date.now() + 3000; !held && Date.now() < deadline; ) {
      try {
        mkdirSync(lock);
        held = true;
      } catch (err: any) {
        if (err?.code !== "EEXIST") break;
        try {
          if (Date.now() - statSync(lock).mtimeMs > 10_000) rmdirSync(lock);
        } catch {
          // gone already
        }
        Bun.sleepSync(10);
      }
    }
    try {
      return fn();
    } finally {
      if (held) rmdirSync(lock);
    }
  }

  // After prompt_agent. settled is the agent it returned when it waited for the answer,
  // else null; agent is what Herdr reported right after the prompt went in. The caller
  // already has a settled answer, so it is not reported again; a managed agent stays
  // watched either way.
  prompted(paneId: string, info: WatchInfo, agent: any, settled: boolean) {
    const now = new Date().toISOString();
    const seq = seenState(agent).seq;
    this.updateWatched((w) => {
      const cur = w[paneId];
      if (cur?.managed) {
        const status = agent?.agent_status;
        w[paneId] = settled
          ? { ...cur, last_status: status, seq, busy: status === "blocked", prompted_at: undefined, rev: newRev() }
          : { ...cur, seq, busy: true, prompted_at: now, rev: newRev() };
      } else if (settled) {
        delete w[paneId];
      } else {
        w[paneId] = { ...info, since: now, seq, rev: newRev() };
      }
    });
  }

  // Report every turn of this agent from now on. A turn already running counts, and
  // so does one prompt_agent is watching that has not been reported yet. A dialog
  // already up is not reported: the caller sees the status. fresh replaces whatever
  // the pane had, for an agent that was just started there.
  manage(paneId: string, info: WatchInfo, agent: any, fresh = false): Watched {
    return this.updateWatched((w) => {
      const cur = fresh ? undefined : w[paneId];
      const seen = seenState(agent);
      const pending = cur ? (cur.managed ? cur.busy === true : true) : false;
      const entry: Watched = {
        ...info,
        since: cur?.managed ? cur.since : new Date().toISOString(),
        ...seen,
        managed: true,
        busy: seen.last_status === "working" || pending,
        prompted_at: cur ? (cur.managed ? cur.prompted_at : cur.since) : undefined,
        rev: newRev(),
        last_event: cur?.last_event,
      };
      w[paneId] = entry;
      return entry;
    });
  }

  unwatch(paneId: string) {
    this.updateWatched((w) => {
      delete w[paneId];
    });
  }

  // One process at a time answers a pane's menu: the notifier's poll and a tool call
  // can find the same menu, and keys pressed twice land in whatever the agent shows
  // next. null when another process still holds the pane after waitMs. A lock older
  // than 60 s was left by a process that died holding it.
  async withPane<T>(paneId: string, waitMs: number, fn: () => Promise<T>): Promise<T | null> {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const lock = resolve(this.dir, `answer-${paneId.replace(/[^A-Za-z0-9_.-]/g, "_")}.lock`);
    let held = false;
    for (const deadline = Date.now() + waitMs; !held; ) {
      try {
        mkdirSync(lock);
        held = true;
      } catch (err: any) {
        if (err?.code !== "EEXIST") break;
        let gone = false;
        try {
          if (Date.now() - statSync(lock).mtimeMs > 60_000) {
            rmdirSync(lock);
            gone = true;
          }
        } catch {
          gone = true;
        }
        if (gone) continue;
        if (Date.now() >= deadline) return null;
        await Bun.sleep(100);
      }
    }
    try {
      return await fn();
    } finally {
      if (held) rmdirSync(lock);
    }
  }

  audit(entry: Record<string, unknown>) {
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      const line = { ts: new Date().toISOString(), client: process.env.SSH_CLIENT?.split(" ")[0] ?? "local", ...entry };
      appendFileSync(resolve(this.dir, "audit.jsonl"), JSON.stringify(line) + "\n", { mode: 0o600 });
    } catch {
      // Auditing must never break a request.
    }
  }
}
