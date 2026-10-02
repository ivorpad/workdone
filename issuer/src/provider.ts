// The authorization server: oidc-provider configured for one owner and one resource.
// ChatGPT registers through a client ID metadata document (its client_id is an HTTPS URL),
// so there is no open registration endpoint. Only ChatGPT's hosts may be fetched or
// redirected to.

import Provider, { errors, type Configuration } from "oidc-provider";
import type { IssuerConfig } from "./config.ts";
import { publicJwks } from "./config.ts";

export const hostAllowed = (hosts: string[], url: string) => {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && hosts.some((h) => u.hostname === h || u.hostname.endsWith(`.${h}`));
  } catch {
    return false;
  }
};

export function createProvider(cfg: IssuerConfig, adapter: Configuration["adapter"], extra: Configuration = {}): Provider {
  const scopes = [cfg.scope, "offline_access", "openid"];
  const configuration: Configuration = {
    adapter,
    jwks: { keys: [cfg.privateJwk as any] },
    cookies: { keys: cfg.cookieKeys },
    scopes,
    claims: { openid: ["sub"] },
    // Public clients only: no secret, PKCE required, the redirect URIs exactly as listed.
    clients: cfg.clients.map((c) => ({
      client_id: c.client_id,
      redirect_uris: c.redirect_uris,
      token_endpoint_auth_method: "none" as const,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    })),
    pkce: { required: () => true },
    // ChatGPT's client metadata document says private_key_jwt (its key at chatgpt.com/oauth/jwks.json);
    // static clients and anything else use none. Shared-secret methods stay off.
    clientAuthMethods: ["none", "private_key_jwt"],
    // One fixed account: the owner. Login proves the password, not which user.
    findAccount: async (_ctx, id) => ({ accountId: id, claims: async () => ({ sub: id }) }),
    interactions: { url: (_ctx, interaction) => `/interaction/${interaction.uid}` },
    ttl: {
      AccessToken: cfg.accessTokenTtl,
      AuthorizationCode: 60,
      RefreshToken: cfg.refreshTokenTtl,
      Interaction: 600,
      Session: 14 * 86400,
      Grant: cfg.refreshTokenTtl,
    },
    features: {
      devInteractions: { enabled: false },
      registration: { enabled: false },
      revocation: { enabled: true },
      introspection: { enabled: false },
      clientIdMetadataDocument: {
        enabled: true,
        ack: "draft-02",
        allowFetch: async (_ctx, clientId) => hostAllowed(cfg.clientHosts, clientId),
        allowClient: async (_ctx, client) => {
          const uris = client.redirectUris ?? [];
          return uris.length > 0 && uris.every((u) => hostAllowed(cfg.clientHosts, u));
        },
      },
      resourceIndicators: {
        enabled: true,
        defaultResource: async () => cfg.resource,
        useGrantedResource: async () => true,
        getResourceServerInfo: async (_ctx, resource) => {
          if (resource !== cfg.resource) throw new errors.InvalidTarget();
          return {
            scope: cfg.scope,
            audience: cfg.resource,
            accessTokenTTL: cfg.accessTokenTtl,
            accessTokenFormat: "jwt",
            jwt: { sign: { alg: "RS256" } },
          };
        },
      },
    },
    // A refresh token for any client allowed the grant, without the offline_access prompt dance.
    issueRefreshToken: async (_ctx, client) => client.grantTypeAllowed("refresh_token"),
    expiresWithSession: async () => false,
    ...extra,
  };
  const provider = new Provider(cfg.issuer, configuration);
  // Behind Caddy on loopback: trust X-Forwarded-* for the public origin and client address.
  provider.proxy = true;
  return provider;
}

export { publicJwks };
