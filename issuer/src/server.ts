#!/usr/bin/env bun
// The issuer process: oidc-provider's routes plus the login and consent pages, on one
// loopback port. Put Caddy (or another TLS proxy) in front of it on the public hostname.

import { createServer } from "node:http";
import { join } from "node:path";
import type { Configuration } from "oidc-provider";
import { loadConfig } from "./config.ts";
import { interactionHandler } from "./interactions.ts";
import { createProvider } from "./provider.ts";
import { openDb, sqliteAdapter, sweep } from "./storage.ts";

export function buildServer(cfg = loadConfig(), extra: Configuration = {}) {
  const db = openDb(join(cfg.dir, "oidc.sqlite"));
  const provider = createProvider(cfg, sqliteAdapter(db), extra);
  // oidc-provider reports OAuth failures as events, not log lines. One JSON line each, no
  // tokens or codes: the error, its description and the client.
  for (const name of ["authorization.error", "grant.error", "server_error", "jwks.error", "backchannel.error"] as const) {
    (provider as any).on(name, (ctx: any, err: any) => {
      console.error(JSON.stringify({ event: name, error: err?.error ?? err?.name, description: err?.error_description ?? err?.message, detail: err?.error_detail ?? null, client: ctx?.oidc?.client?.clientId ?? ctx?.oidc?.params?.client_id ?? null }));
    });
  }
  const interactions = interactionHandler(provider, cfg);
  const callback = provider.callback();
  const server = createServer(async (req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    // The MCP's 401 points ChatGPT at resource_metadata on the resource's origin, which is
    // this host. Publish the same public document here so that link resolves.
    if (req.method === "GET" && (path === "/.well-known/oauth-protected-resource" || path === `/.well-known/oauth-protected-resource${new URL(cfg.resource).pathname}`)) {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ resource: cfg.resource, authorization_servers: [cfg.issuer], scopes_supported: [cfg.scope] }));
      return;
    }
    if (path === "/healthz") { res.writeHead(200, { "content-type": "text/plain" }); res.end("ok"); return; }
    try {
      if (await interactions(req, res)) return;
      callback(req, res);
    } catch (e) {
      console.error(JSON.stringify({ event: "error", message: (e as Error).message }));
      if (!res.headersSent) { res.writeHead(500); res.end("error"); }
    }
  });
  const timer = setInterval(() => sweep(db), 10 * 60_000);
  timer.unref();
  return { server, provider, db, cfg };
}

if (import.meta.main) {
  const { server, cfg } = buildServer();
  server.listen(cfg.port, cfg.host, () => console.log(JSON.stringify({ event: "listening", host: cfg.host, port: cfg.port, issuer: cfg.issuer, resource: cfg.resource })));
}
