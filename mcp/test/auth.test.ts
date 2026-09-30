import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { AuthenticationError, AuthService, principalId } from "../src/auth.ts";
import { parseConfig, type AuthConfig } from "../src/config.ts";

const NOW = Date.parse("2026-09-30T12:00:00Z");
const ISSUER = "https://issuer.example";
const RESOURCE = "https://workdone.example/mcp";
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let publicKey: Awaited<ReturnType<typeof exportJWK>>;
let directory: string;
let config: AuthConfig;
let auth: AuthService;

beforeAll(async () => {
  keys = await generateKeyPair("RS256", { extractable: true });
  publicKey = { ...await exportJWK(keys.publicKey), kid: "test", use: "sig", alg: "RS256" };
});

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "workdone-auth-"));
  config = { issuer: ISSUER, resource: RESOURCE, jwksPath: join(directory, "jwks.json"), grantsPath: join(directory, "grants.json"), requiredScopes: ["workdone"], algorithms: ["RS256"] };
  await Bun.write(config.jwksPath, JSON.stringify({ keys: [publicKey] }));
  await grants({ owner: { scopes: ["workdone"], machines: ["mac"] } });
  auth = new AuthService(config, ["mac", "ovh"], () => NOW);
});
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

async function grants(subjects: Record<string, unknown>) {
  await Bun.write(config.grantsPath, JSON.stringify({ subjects }));
}

async function token(overrides: Record<string, unknown> = {}, key = keys.privateKey, kid = "test") {
  return new SignJWT({ iss: ISSUER, aud: RESOURCE, sub: "owner", exp: NOW / 1000 + 3600, scope: "workdone other", ...overrides }).setProtectedHeader({ alg: "RS256", kid }).sign(key);
}

function request(bearer?: string) {
  return new Request("http://127.0.0.1:8787/mcp", { headers: bearer === undefined ? {} : { authorization: `Bearer ${bearer}` } });
}

describe("OAuth resource authentication", () => {
  test("verified issuer and subject bind a stable profile, independent of token and scope order", async () => {
    const first = await auth.authenticate(request(await token()));
    const refreshed = await auth.authenticate(request(await token({ scope: "other workdone", exp: NOW / 1000 + 7200 })));
    expect(first.id).toBe(principalId(ISSUER, "owner"));
    expect(refreshed.id).toBe(first.id);
    expect(first.scopes).toEqual(["other", "workdone"]);
    expect(await auth.allowedMachines(first)).toEqual(["mac"]);
    expect(await auth.isAuthorized(first, "ovh")).toBe(false);
  });

  test("rejects absent bearer and malformed JWT without returning credential text", async () => {
    for (const bearer of [undefined, "secret.invalid.jwt", ""]) {
      try { await auth.authenticate(request(bearer)); throw new Error("accepted"); }
      catch (error) {
        expect(error).toBeInstanceOf(AuthenticationError);
        expect(String(error)).not.toContain("secret.invalid.jwt");
      }
    }
  });

  test("enforces issuer, resource audience, signature, expiry, nbf and required identity claims", async () => {
    const wrongKeys = await generateKeyPair("RS256");
    const invalid = [
      await token({ iss: "https://other.example" }),
      await token({ aud: "https://other.example/mcp" }),
      await token({ exp: NOW / 1000 }),
      await token({ nbf: NOW / 1000 + 1 }),
      await token({ sub: " " }),
      await token({ exp: undefined }),
      await token({}, wrongKeys.privateKey),
    ];
    for (const value of invalid) await expect(auth.authenticate(request(value))).rejects.toBeInstanceOf(AuthenticationError);
  });

  test("both token scopes and current resource grant scopes are required", async () => {
    await expect(auth.authenticate(request(await token({ scope: "other" })))).rejects.toMatchObject({ code: "insufficient_scope" });
    await grants({ owner: { scopes: ["other"], machines: ["mac"] } });
    await expect(auth.authenticate(request(await token()))).rejects.toMatchObject({ code: "insufficient_scope" });
  });

  test("resource policy revocation is reloaded for existing principals and fresh requests", async () => {
    const value = await token();
    const principal = await auth.authenticate(request(value));
    await grants({});
    expect(await auth.isAuthorized(principal)).toBe(false);
    await expect(auth.authenticate(request(value))).rejects.toMatchObject({ code: "insufficient_scope" });
    await grants({ owner: { scopes: ["workdone"], machines: ["ovh"] } });
    expect(await auth.allowedMachines(principal)).toEqual(["ovh"]);
    await Bun.write(config.grantsPath, "invalid-json");
    expect(await auth.isAuthorized(principal)).toBe(false);
  });

  test("persisted authorization bindings fail closed on expiry or identity tampering", async () => {
    const principal = await auth.authenticate(request(await token()));
    for (const changed of [
      { ...principal, tokenExpiresAt: NOW },
      { ...principal, id: "someone-else" },
      { ...principal, issuer: "https://other.example" },
      { ...principal, subject: "another" },
    ]) expect(await auth.isAuthorized(changed)).toBe(false);
  });

  test("reloaded public JWKS rotates issuer keys without a restart", async () => {
    const previous = await token();
    await auth.authenticate(request(previous));
    const next = await generateKeyPair("RS256", { extractable: true });
    await Bun.write(config.jwksPath, JSON.stringify({ keys: [{ ...await exportJWK(next.publicKey), kid: "rotated", alg: "RS256" }] }));
    await auth.authenticate(request(await token({}, next.privateKey, "rotated")));
    await expect(auth.authenticate(request(previous))).rejects.toBeInstanceOf(AuthenticationError);
  });

  test("rejects symmetric and private signing material in issuer JWKS", async () => {
    for (const key of [{ kty: "oct", k: "Zm9v" }, await exportJWK(keys.privateKey)]) {
      await Bun.write(config.jwksPath, JSON.stringify({ keys: [key] }));
      await expect(auth.authenticate(request(await token()))).rejects.toBeInstanceOf(AuthenticationError);
    }
  });

  test("resource metadata and challenge publish OAuth identity and required scopes", () => {
    expect(auth.metadata()).toEqual({ resource: RESOURCE, authorization_servers: [ISSUER], scopes_supported: ["workdone"] });
    expect(auth.challenge("invalid_token")).toContain('resource_metadata="https://workdone.example/.well-known/oauth-protected-resource"');
    expect(auth.challenge("invalid_token")).toContain('error="invalid_token"');
  });
});

describe("OAuth and Events configuration", () => {
  const ssh = { user: "u", host: "host.example", identityFile: "/k", knownHostsFile: "/kh" };
  test("no-auth tools fallback stays the default", () => {
    const fallback = parseConfig({ ssh });
    expect(fallback.auth).toBeNull();
    expect(fallback.events).toBeNull();
  });
  test("native Events requires OAuth and exact callback hosts, independently of phone notifications", () => {
    const events = { statePath: "/var/lib/herdr-mcp/events.sqlite", callbackHosts: ["callbacks.openai.com"] };
    expect(() => parseConfig({ ssh, events })).toThrow(/OAuth/);
    const enabled = parseConfig({ ssh, auth: config, events });
    expect(enabled.events).toEqual(events);
    expect(enabled.notify).toBeNull();
    expect(() => parseConfig({ ssh, auth: config, events: { ...events, callbackHosts: ["*.example"] } })).toThrow(/callbackHosts/);
    expect(() => parseConfig({ ssh, auth: config, events: { ...events, callbackHosts: ["callback.internal"] } })).toThrow(/callbackHosts/);
  });
  test("rejects unsafe discovery identifiers, ambiguous scopes and signing algorithms", () => {
    for (const changed of [{ resource: "http://workdone.example/mcp" }, { issuer: 'https://issuer.example/#"' }, { requiredScopes: ["read write"] }, { algorithms: ["HS256"] }, { grantsPath: "relative.json" }]) {
      expect(() => parseConfig({ ssh, auth: { ...config, ...changed } })).toThrow();
    }
  });
  test("an optional authenticated staging port must be valid and separate from the fallback port", () => {
    expect(parseConfig({ ssh, auth: { ...config, listenPort: 8788 } }).auth?.listenPort).toBe(8788);
    for (const listenPort of [0, 65536, 8787, 8788.5, "8788"]) expect(() => parseConfig({ ssh, auth: { ...config, listenPort } })).toThrow(/listenPort/);
  });
});
