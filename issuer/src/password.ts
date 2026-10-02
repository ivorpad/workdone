// scrypt password hashing and a small login throttle. One owner, so no user table.

import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

const N = 2 ** 15;
const scryptAsync = (pw: string, salt: Buffer, n: number) =>
  new Promise<Buffer>((res, rej) => scrypt(pw, salt, 32, { N: n, r: 8, p: 1, maxmem: 128 * n * 8 * 2 }, (e, k) => (e ? rej(e) : res(k))));

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  return `scrypt$${N}$${salt.toString("base64url")}$${(await scryptAsync(password, salt, N)).toString("base64url")}`;
}

export async function checkPassword(password: string, stored: string): Promise<boolean> {
  const [alg, n, salt, hash] = stored.split("$");
  if (alg !== "scrypt" || !n || !salt || !hash) return false;
  const want = Buffer.from(hash, "base64url");
  const got = await scryptAsync(password, Buffer.from(salt, "base64url"), Number(n));
  return got.length === want.length && timingSafeEqual(got, want);
}

// After `max` failures from one address inside `windowMs`, that address is refused until
// the window passes. In memory: a restart clears it, which is acceptable for one owner.
export class Throttle {
  private fails = new Map<string, number[]>();
  private max: number;
  private windowMs: number;
  private now: () => number;
  constructor(max = 5, windowMs = 15 * 60_000, now: () => number = Date.now) {
    this.max = max;
    this.windowMs = windowMs;
    this.now = now;
  }
  private recent(key: string) {
    const t = this.now();
    const list = (this.fails.get(key) ?? []).filter((at) => at + this.windowMs > t);
    if (list.length) this.fails.set(key, list); else this.fails.delete(key);
    return list;
  }
  blocked(key: string): boolean { return this.recent(key).length >= this.max; }
  fail(key: string) { this.fails.set(key, [...this.recent(key), this.now()]); }
  ok(key: string) { this.fails.delete(key); }
}
