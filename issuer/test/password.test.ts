import { describe, expect, test } from "bun:test";
import { checkPassword, hashPassword, Throttle } from "../src/password.ts";
import { publicJwks } from "../src/config.ts";

describe("password", () => {
  test("a hash verifies only its own password, and is salted", async () => {
    const a = await hashPassword("a long enough password");
    expect(await checkPassword("a long enough password", a)).toBe(true);
    expect(await checkPassword("another password here", a)).toBe(false);
    expect(await checkPassword("x", "not a hash")).toBe(false);
    expect(await hashPassword("a long enough password")).not.toBe(a);
  });

  test("the throttle blocks after five failures and forgets them after the window", () => {
    let now = 0;
    const t = new Throttle(5, 1000, () => now);
    for (let i = 0; i < 4; i++) t.fail("ip");
    expect(t.blocked("ip")).toBe(false);
    t.fail("ip");
    expect(t.blocked("ip")).toBe(true);
    expect(t.blocked("other")).toBe(false);
    now += 1001;
    expect(t.blocked("ip")).toBe(false);
    t.fail("ip"); t.ok("ip");
    expect(t.blocked("ip")).toBe(false);
  });

  test("the public JWKS never carries private members", () => {
    const pub = publicJwks({ kty: "RSA", n: "n", e: "e", d: "d", p: "p", q: "q", dp: "a", dq: "b", qi: "c", kid: "k" });
    expect(pub.keys[0]).toEqual({ kty: "RSA", n: "n", e: "e", kid: "k" });
  });
});
