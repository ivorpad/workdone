// Issuer settings come from the environment so the same code runs in tests and under
// systemd. Secrets live in files under ISSUER_DIR (see setup.ts), never in the env.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface IssuerConfig {
  /** Public HTTPS origin of this issuer, e.g. https://auth.example.com. Must equal `auth.issuer` in the MCP config. */
  issuer: string;
  /** Canonical MCP resource URL. Must equal `auth.resource` in the MCP config: it becomes the token audience. */
  resource: string;
  /** The one scope the MCP resource server requires. */
  scope: string;
  /** Stable `sub` of the owner. Must be a key of `subjects` in principal-grants.json. */
  subject: string;
  dir: string;
  host: string;
  port: number;
  /** Hostnames a client_id URL or a redirect URI may use. ChatGPT's own, by default. */
  clientHosts: string[];
  accessTokenTtl: number;
  refreshTokenTtl: number;
  /** scrypt hash of the owner's password, from setup.ts. */
  passwordHash: string;
  privateJwk: Record<string, unknown>;
  cookieKeys: string[];
  /** Fixed clients from ISSUER_DIR/clients.json: public clients (no secret) with exact redirect URIs. */
  clients: StaticClient[];
}

export interface StaticClient {
  client_id: string;
  redirect_uris: string[];
}

function need(env: Record<string, string | undefined>, name: string): string {
  const v = env[name]?.trim();
  if (!v) throw new Error(`${name} is required`);
  return v;
}

function httpsUrl(name: string, v: string, pathOk: boolean): string {
  let u: URL;
  try { u = new URL(v); } catch { throw new Error(`${name} must be an absolute URL`); }
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
  if (u.protocol !== "https:" && !(local && u.protocol === "http:")) throw new Error(`${name} must be https`);
  if (u.search || u.hash) throw new Error(`${name} must not have a query or fragment`);
  if (!pathOk && u.pathname !== "/") throw new Error(`${name} must be an origin with no path`);
  return pathOk ? v : u.origin;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): IssuerConfig {
  const dir = need(env, "ISSUER_DIR");
  const num = (name: string, dflt: number, min: number, max: number) => {
    const v = env[name] === undefined ? dflt : Number(env[name]);
    if (!Number.isInteger(v) || v < min || v > max) throw new Error(`${name} must be an integer from ${min} to ${max}`);
    return v;
  };
  const read = (f: string) => readFileSync(join(dir, f), "utf8");
  const cookieKeys = JSON.parse(read("cookie-keys.json"));
  if (!Array.isArray(cookieKeys) || !cookieKeys.length || cookieKeys.some((k) => typeof k !== "string" || k.length < 32)) throw new Error("cookie-keys.json must hold strings of 32 or more characters");
  const privateJwk = JSON.parse(read("signing-key.json"));
  if (privateJwk.kty !== "RSA" || !privateJwk.d) throw new Error("signing-key.json must be a private RSA JWK");
  const clients: StaticClient[] = existsSync(join(dir, "clients.json")) ? JSON.parse(read("clients.json")) : [];
  if (!Array.isArray(clients)) throw new Error("clients.json must be a list");
  for (const c of clients) {
    if (typeof c?.client_id !== "string" || !(/^[\w.-]{3,64}$/.test(c.client_id) || /^https:\/\/[\w.-]+\/[\w./-]{1,150}$/.test(c.client_id))) throw new Error("clients.json: client_id must be 3 to 64 letters, digits, dot, dash or underscore, or an https URL");
    if (!Array.isArray(c.redirect_uris) || !c.redirect_uris.length || c.redirect_uris.some((u: unknown) => typeof u !== "string" || !u.startsWith("https://"))) throw new Error(`clients.json: ${c.client_id} needs https redirect_uris`);
  }
  return {
    issuer: httpsUrl("ISSUER_URL", need(env, "ISSUER_URL"), false),
    resource: httpsUrl("MCP_RESOURCE", need(env, "MCP_RESOURCE"), true),
    scope: env.ISSUER_SCOPE?.trim() || "workdone",
    subject: env.OWNER_SUBJECT?.trim() || "owner",
    dir,
    host: env.ISSUER_HOST?.trim() || "127.0.0.1",
    port: num("ISSUER_PORT", 8790, 1, 65535),
    clientHosts: (env.ISSUER_CLIENT_HOSTS ?? "chatgpt.com,openai.com").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean),
    accessTokenTtl: num("ACCESS_TOKEN_TTL_SECONDS", 3600, 60, 86400),
    refreshTokenTtl: num("REFRESH_TOKEN_TTL_SECONDS", 30 * 86400, 3600, 365 * 86400),
    passwordHash: read("password-hash").trim(),
    privateJwk,
    cookieKeys,
    clients,
  };
}

export function publicJwks(privateJwk: Record<string, unknown>) {
  const { d, p, q, dp, dq, qi, oth, k, ...pub } = privateJwk as Record<string, unknown>;
  return { keys: [pub] };
}
