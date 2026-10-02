#!/usr/bin/env bun
// One-time setup: makes the signing key, cookie keys and password hash in a directory.
//   bun src/setup.ts DIR            reads the password from stdin (one line)
// Writes DIR/signing-key.json (private, 0600), DIR/cookie-keys.json (0600), DIR/password-hash (0600)
// and DIR/jwks.json (public): copy that one to the MCP server's auth.jwksPath.
// Nothing secret is printed. Rerun with --rotate-password to change only the password.

import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { exportJWK, generateKeyPair } from "jose";
import { publicJwks } from "./config.ts";
import { hashPassword } from "./password.ts";

const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith("--"));
if (!dir) { console.error("usage: bun src/setup.ts DIR [--rotate-password]"); process.exit(2); }
const rotateOnly = args.includes("--rotate-password");

mkdirSync(dir, { recursive: true, mode: 0o700 });
const put = (name: string, text: string, mode: number) => { const p = join(dir, name); writeFileSync(p, text, { mode }); chmodSync(p, mode); };

const line = (await Bun.stdin.text()).split("\n")[0]!.replace(/\r$/, "");
if (line.length < 12) { console.error("password must be at least 12 characters (read one line from stdin)"); process.exit(2); }
put("password-hash", (await hashPassword(line)) + "\n", 0o600);

if (!rotateOnly) {
  if (existsSync(join(dir, "signing-key.json"))) { console.error(`${dir}/signing-key.json exists; refusing to replace the signing key (delete it first to rotate)`); process.exit(2); }
  const { privateKey } = await generateKeyPair("RS256", { modulusLength: 3072, extractable: true });
  const jwk = { ...(await exportJWK(privateKey)), alg: "RS256", use: "sig" } as Record<string, unknown>;
  jwk.kid = randomBytes(8).toString("hex");
  put("signing-key.json", JSON.stringify(jwk) + "\n", 0o600);
  put("jwks.json", JSON.stringify(publicJwks(jwk), null, 2) + "\n", 0o644);
  put("cookie-keys.json", JSON.stringify([randomBytes(32).toString("base64url")]) + "\n", 0o600);
}
console.log(rotateOnly ? "password changed" : `wrote ${dir}: signing-key.json, cookie-keys.json, password-hash, jwks.json (public)`);
