// OAuth resource server only. The configured external issuer owns login, consent,
// PKCE, client registration and refresh tokens. Public signing keys and WorkDone
// resource grants are local files, reloaded so revocation and key rotation need no restart.

import { createHash } from "node:crypto";
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from "jose";
import type { AuthConfig } from "./config.ts";
import type { EventPrincipal } from "./events.ts";

export class AuthenticationError extends Error {
  constructor(public readonly code: "invalid_token" | "insufficient_scope" = "invalid_token") {
    super(code === "insufficient_scope" ? "This account lacks WorkDone access." : "A valid OAuth access token is required.");
  }
}

export function principalId(issuer: string, subject: string): string {
  return `prf_${createHash("sha256").update(JSON.stringify([issuer, subject])).digest("hex")}`;
}

interface Grant { scopes: string[]; machines: string[] }

export class AuthService {
  private keyText?: string;
  private keys?: ReturnType<typeof createLocalJWKSet>;

  constructor(readonly config: AuthConfig, private machines: string[], private now: () => number = Date.now) {}

  metadata() {
    return { resource: this.config.resource, authorization_servers: [this.config.issuer], scopes_supported: this.config.requiredScopes };
  }

  metadataUrl(): string {
    const url = new URL(this.config.resource);
    url.pathname = "/.well-known/oauth-protected-resource";
    return url.href;
  }

  challenge(code?: "invalid_token" | "insufficient_scope"): string {
    const error = code ? `, error="${code}", error_description="${code === "insufficient_scope" ? "This account lacks WorkDone access" : "A valid OAuth access token is required"}"` : "";
    return `Bearer resource_metadata="${this.metadataUrl()}", scope="${this.config.requiredScopes.join(" ")}"${error}`;
  }

  async authenticate(request: Request): Promise<EventPrincipal> {
    const header = request.headers.get("authorization");
    const token = header?.match(/^Bearer ([A-Za-z0-9._~-]+)$/i)?.[1];
    if (!token || token.length > 32_768) throw new AuthenticationError();
    let principal: EventPrincipal;
    try {
      const text = await Bun.file(this.config.jwksPath).text();
      if (text !== this.keyText) {
        const jwks = JSON.parse(text) as JSONWebKeySet;
        // Never accept shared secrets or private signing keys as a resource server.
        if (!Array.isArray(jwks.keys) || !jwks.keys.length || jwks.keys.some((key) => key.kty === "oct" || "d" in key || "k" in key)) throw new Error("public JWKS required");
        this.keys = createLocalJWKSet(jwks);
        this.keyText = text;
      }
      const { payload } = await jwtVerify(token, this.keys!, {
        issuer: this.config.issuer,
        audience: this.config.resource,
        algorithms: this.config.algorithms,
        requiredClaims: ["iss", "aud", "sub", "exp"],
        currentDate: new Date(this.now()),
        clockTolerance: 0,
      });
      if (typeof payload.sub !== "string" || !payload.sub.trim() || typeof payload.exp !== "number") throw new Error("invalid identity");
      const scopes = typeof payload.scope === "string" ? payload.scope.split(/\s+/).filter(Boolean) : Array.isArray(payload.scp) && payload.scp.every((s) => typeof s === "string") ? payload.scp as string[] : [];
      principal = { id: principalId(this.config.issuer, payload.sub), issuer: this.config.issuer, subject: payload.sub, scopes: [...new Set(scopes)].sort(), tokenExpiresAt: payload.exp * 1000 };
    } catch {
      throw new AuthenticationError();
    }
    if (!await this.isAuthorized(principal)) throw new AuthenticationError("insufficient_scope");
    return principal;
  }

  private async grant(subject: string): Promise<Grant | null> {
    try {
      const raw = await Bun.file(this.config.grantsPath).json();
      if (!raw || typeof raw.subjects !== "object" || raw.subjects === null || !Object.hasOwn(raw.subjects, subject)) return null;
      const grant = raw.subjects[subject];
      if (!grant || !Array.isArray(grant.scopes) || !grant.scopes.every((scope: unknown) => typeof scope === "string") || !Array.isArray(grant.machines) || !grant.machines.length || !grant.machines.every((machine: unknown) => typeof machine === "string" && this.machines.includes(machine))) return null;
      return grant;
    } catch {
      // A removed or unreadable policy file revokes access, including queued delivery.
      return null;
    }
  }

  async allowedMachines(principal: EventPrincipal): Promise<string[]> {
    if (principal.issuer !== this.config.issuer || typeof principal.subject !== "string" || !principal.subject.trim() || !Array.isArray(principal.scopes) || principal.id !== principalId(principal.issuer, principal.subject) || !Number.isFinite(principal.tokenExpiresAt) || principal.tokenExpiresAt <= this.now()) return [];
    const grant = await this.grant(principal.subject);
    if (!grant || !this.config.requiredScopes.every((scope) => principal.scopes.includes(scope) && grant.scopes.includes(scope))) return [];
    return this.machines.filter((machine) => grant.machines.includes(machine));
  }

  async isAuthorized(principal: EventPrincipal, machine?: string): Promise<boolean> {
    const allowed = await this.allowedMachines(principal);
    return machine === undefined ? allowed.length > 0 : allowed.includes(machine);
  }
}
