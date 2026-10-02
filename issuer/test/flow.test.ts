import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalJWKSet, exportJWK, generateKeyPair, jwtVerify } from "jose";
import { publicJwks, type IssuerConfig } from "../src/config.ts";
import { hashPassword } from "../src/password.ts";
import { buildServer } from "../src/server.ts";

const RESOURCE = "https://mcp.example.com/mcp";
const REDIRECT = "https://chatgpt.com/connector_platform_oauth_redirect";
const PASSWORD = "correct horse battery staple";

let dir: string;
let cfg: IssuerConfig;
let base: string;
let stop: () => void;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "issuer-"));
  const { privateKey } = await generateKeyPair("RS256", { extractable: true });
  const privateJwk = { ...(await exportJWK(privateKey)), alg: "RS256", use: "sig", kid: "k1" } as Record<string, unknown>;
  cfg = {
    issuer: "http://127.0.0.1:0", resource: RESOURCE, scope: "workdone", subject: "owner", dir, host: "127.0.0.1", port: 0,
    clientHosts: ["chatgpt.com"], accessTokenTtl: 3600, refreshTokenTtl: 86400,
    passwordHash: await hashPassword(PASSWORD), privateJwk, cookieKeys: [randomBytes(32).toString("base64url")], clients: [],
  };
  // The issuer URL has to be known before the provider is built, so take a free port first.
  const probe = Bun.serve({ port: 0, fetch: () => new Response("") });
  const port = probe.port!;
  probe.stop(true);
  cfg.port = port;
  cfg.issuer = `http://127.0.0.1:${port}`;
  const built = buildServer(cfg, { clients: [{ client_id: "chatgpt-test", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }] });
  await new Promise<void>((res) => built.server.listen(port, "127.0.0.1", res));
  base = cfg.issuer;
  stop = () => { built.server.close(); built.db.close(); };
  writeFileSync(join(dir, "jwks.json"), JSON.stringify(publicJwks(privateJwk)));
});
afterAll(() => { stop(); rmSync(dir, { recursive: true, force: true }); });

class Jar {
  private c = new Map<string, string>();
  take(res: Response) { for (const line of res.headers.getSetCookie()) { const [kv] = line.split(";"); const i = kv!.indexOf("="); this.c.set(kv!.slice(0, i), kv!.slice(i + 1)); } }
  header() { return [...this.c].map(([k, v]) => `${k}=${v}`).join("; "); }
}

async function hop(jar: Jar, url: string, init: RequestInit = {}) {
  const res = await fetch(url, { ...init, redirect: "manual", headers: { ...(init.headers as Record<string, string>), cookie: jar.header() } });
  jar.take(res);
  return res;
}

const pkce = () => { const verifier = randomBytes(32).toString("base64url"); return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") }; };

async function signIn(password = PASSWORD, extra: Record<string, string> = {}) {
  const jar = new Jar();
  const { verifier, challenge } = pkce();
  const q = new URLSearchParams({ client_id: "chatgpt-test", response_type: "code", redirect_uri: REDIRECT, scope: "workdone offline_access", code_challenge: challenge, code_challenge_method: "S256", resource: RESOURCE, state: "s1", ...extra });
  let res = await hop(jar, `${base}/auth?${q}`);
  if (res.status !== 303) return { res, jar, verifier, code: null as string | null };
  const interaction = new URL(res.headers.get("location")!, base).pathname;
  await hop(jar, base + interaction);
  res = await hop(jar, `${base}${interaction}/login`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ password }) });
  if (res.status !== 303) return { res, jar, verifier, code: null };
  res = await hop(jar, new URL(res.headers.get("location")!, base).toString());
  const consent = new URL(res.headers.get("location")!, base).pathname;
  const page = await (await hop(jar, base + consent)).text();
  expect(page).toContain("Approve access");
  res = await hop(jar, `${base}${consent}/confirm`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "" });
  res = await hop(jar, new URL(res.headers.get("location")!, base).toString());
  const back = new URL(res.headers.get("location")!);
  expect(back.origin + back.pathname).toBe(REDIRECT);
  return { res, jar, verifier, code: back.searchParams.get("code"), iss: back.searchParams.get("iss"), state: back.searchParams.get("state") };
}

const token = (body: Record<string, string>) => fetch(`${base}/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body) });

// Checks the way mcp/src/auth.ts does: issuer, audience, RS256, sub, exp, scope, public JWKS only.
async function verify(jwt: string) {
  const jwks = JSON.parse(await Bun.file(join(dir, "jwks.json")).text());
  expect(jwks.keys.every((k: any) => !("d" in k) && !("p" in k))).toBe(true);
  const { payload } = await jwtVerify(jwt, createLocalJWKSet(jwks), { issuer: cfg.issuer, audience: RESOURCE, algorithms: ["RS256"], requiredClaims: ["iss", "aud", "sub", "exp"], clockTolerance: 0 });
  return payload;
}

describe("issuer", () => {
  test("discovery advertises S256, client metadata documents and no registration", async () => {
    const meta = await (await fetch(`${base}/.well-known/openid-configuration`)).json() as any;
    expect(meta.code_challenge_methods_supported).toEqual(["S256"]);
    expect(meta.client_id_metadata_document_supported).toBe(true);
    expect(meta.registration_endpoint).toBeUndefined();
    expect(meta.token_endpoint_auth_methods_supported).toContain("none");
    expect((await fetch(`${base}/reg`, { method: "POST", body: "{}" })).status).toBeGreaterThanOrEqual(400);
  });

  test("sign-in, consent and code exchange give a JWT the resource server accepts, and a refresh works", async () => {
    const r = await signIn();
    expect(r.code).toBeTruthy();
    const res = await token({ grant_type: "authorization_code", client_id: "chatgpt-test", code: r.code!, redirect_uri: REDIRECT, code_verifier: r.verifier, resource: RESOURCE });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    const payload = await verify(body.access_token);
    expect(payload.sub).toBe("owner");
    expect(payload.aud).toBe(RESOURCE);
    expect(String(payload.scope).split(" ")).toContain("workdone");
    expect(payload.exp! - payload.iat!).toBe(3600);
    expect(body.refresh_token).toBeTruthy();
    const again = await token({ grant_type: "refresh_token", client_id: "chatgpt-test", refresh_token: body.refresh_token, resource: RESOURCE });
    expect(again.status).toBe(200);
    expect((await verify(((await again.json()) as any).access_token)).sub).toBe("owner");
    // Refresh tokens rotate: the old one is dead.
    expect((await token({ grant_type: "refresh_token", client_id: "chatgpt-test", refresh_token: body.refresh_token })).status).toBe(400);
  });

  test("the code is bound to the PKCE verifier and is single use", async () => {
    const r = await signIn();
    const bad = await token({ grant_type: "authorization_code", client_id: "chatgpt-test", code: r.code!, redirect_uri: REDIRECT, code_verifier: randomBytes(32).toString("base64url") });
    expect(bad.status).toBe(400);
    const r2 = await signIn();
    const ok = await token({ grant_type: "authorization_code", client_id: "chatgpt-test", code: r2.code!, redirect_uri: REDIRECT, code_verifier: r2.verifier });
    expect(ok.status).toBe(200);
    expect((await token({ grant_type: "authorization_code", client_id: "chatgpt-test", code: r2.code!, redirect_uri: REDIRECT, code_verifier: r2.verifier })).status).toBe(400);
  });

  test("a wrong password gets no code", async () => {
    const r = await signIn("not the password");
    expect(r.code).toBeNull();
    expect(r.res.status).toBe(401);
  });

  test("a resource other than the MCP one is refused, and PKCE is mandatory", async () => {
    const jar = new Jar();
    const q = (extra: Record<string, string>) => new URLSearchParams({ client_id: "chatgpt-test", response_type: "code", redirect_uri: REDIRECT, scope: "workdone", state: "s", ...extra });
    const other = await hop(jar, `${base}/auth?${q({ resource: "https://evil.example/mcp", code_challenge: "x".repeat(43), code_challenge_method: "S256" })}`);
    expect(other.headers.get("location") ?? "").toContain("error=invalid_target");
    const noPkce = await hop(jar, `${base}/auth?${q({ resource: RESOURCE })}`);
    expect(noPkce.headers.get("location") ?? "").toContain("error=invalid_request");
  });

  test("a redirect URI that is not the client's is not honoured", async () => {
    const jar = new Jar();
    const { challenge } = pkce();
    const res = await hop(jar, `${base}/auth?${new URLSearchParams({ client_id: "chatgpt-test", response_type: "code", redirect_uri: "https://evil.example/cb", scope: "workdone", code_challenge: challenge, code_challenge_method: "S256", resource: RESOURCE })}`);
    expect(res.status).toBe(400);
  });
});

describe("protected resource metadata on the issuer's origin", () => {
  test("both the bare and the path-suffixed document name the resource and this issuer", async () => {
    for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
      const res = await fetch(base + path);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ resource: RESOURCE, authorization_servers: [cfg.issuer], scopes_supported: ["workdone"] });
    }
    expect((await fetch(base + "/.well-known/oauth-protected-resource/other")).status).toBe(404);
  });
});
