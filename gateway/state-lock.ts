import { mkdirSync, readFileSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

// A timestamp alone cannot establish that an owner died. PID reuse is fenced by
// the process start identity; a nonce fences release by this particular holder.
function startIdentity(pid: number): string | null {
  const result = spawnSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } });
  return result.status === 0 && result.stdout.trim() ? result.stdout.trim() : null;
}
interface Owner { pid: number; start: string; nonce: string }
function owner(path: string): Owner | null {
  try {
    const o = JSON.parse(readFileSync(join(path, "owner.json"), "utf8"));
    return Number.isSafeInteger(o.pid) && o.pid > 0 && typeof o.start === "string" && typeof o.nonce === "string" ? o : null;
  } catch { return null; }
}
function dead(o: Owner): boolean {
  try { process.kill(o.pid, 0); }
  catch (err: any) { return err.code === "ESRCH"; }
  const current = startIdentity(o.pid);
  return current !== null && current !== o.start;
}
function reap(path: string) {
  const o = owner(path);
  if (!o || !dead(o)) return; // Unknown/legacy owners require operator recovery.
  // Only one contender may reap. Nonrecursive removal cannot delete a replacement
  // lock populated by another owner, even if this process is delayed.
  const reaper = join(path, "reaping");
  try { mkdirSync(reaper); } catch { return; }
  try {
    const cur = owner(path);
    if (cur?.nonce !== o.nonce || !dead(cur)) return;
    unlinkSync(join(path, "owner.json"));
    rmdirSync(reaper);
    rmdirSync(path);
    return true;
  } finally {
    try { rmdirSync(reaper); } catch { /* already removed */ }
  }
}
export function tryLock(path: string): (() => void) | null {
  try { mkdirSync(path, { mode: 0o700 }); }
  catch (err: any) {
    if (err.code !== "EEXIST") throw err;
    return reap(path) ? tryLock(path) : null;
  }
  const start = startIdentity(process.pid);
  if (!start) { rmdirSync(path); throw new Error("Cannot establish lock owner identity"); }
  const o: Owner = { pid: process.pid, start, nonce: randomUUID() };
  try { writeFileSync(join(path, "owner.json"), JSON.stringify(o), { mode: 0o600, flag: "wx" }); }
  catch (err) { rmdirSync(path); throw err; }
  const inode = statSync(path).ino;
  return () => {
    if (statSync(path).ino !== inode || owner(path)?.nonce !== o.nonce) throw new Error("State lock ownership changed");
    unlinkSync(join(path, "owner.json"));
    rmdirSync(path);
  };
}
