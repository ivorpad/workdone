// Herdr remote MCP server. Listens on loopback only; the OpenAI tunnel client is
// the only intended caller. Each tool call becomes one ssh round trip to a machine's gateway.

import { createMcpHandler, hostHeaderValidationResponse, isLegacyRequest, WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import { parseConfig, type OvhConfig } from "./config.ts";
import { sshGateway, type CallGateway } from "./gateway-client.ts";
import { inbox } from "./inbox.ts";
import { startNotifier, WAIT_MS } from "./notifier.ts";
import { buildServer } from "./tools.ts";

// Records what the client says about itself on initialize or server/discover: its protocol
// version and capabilities show which extensions (e.g. openai/elicitation) ChatGPT offers.
// Other methods are logged by name only, never their arguments.
export function logRpc(msgs: unknown, protocolHeader: string | null, log: (line: string) => void = console.log) {
  for (const m of Array.isArray(msgs) ? msgs : [msgs]) {
    const method = (m as any)?.method;
    if (typeof method !== "string") continue;
    if (method === "initialize" || method === "server/discover") {
      // 2025 puts these in initialize's params; 2026-07-28 in each request's _meta envelope.
      const { protocolVersion, capabilities, clientInfo, _meta } = (m as any).params ?? {};
      log(JSON.stringify({ event: "client_hello", method, protocolHeader, protocolVersion, clientInfo, capabilities, meta: _meta }));
    } else {
      // The tool or resource named, never its arguments.
      const p = (m as any).params ?? {};
      const name = method === "tools/call" ? p.name : method === "resources/read" ? p.uri : undefined;
      log(JSON.stringify({ event: "rpc", method, name, protocolHeader }));
    }
  }
}

export function createHandler(cfg: OvhConfig, call: CallGateway, onWatch?: (machine: string) => void) {
  const allowedHosts = ["127.0.0.1", "localhost", "[::1]"];
  const build = () => buildServer(call, Object.keys(cfg.machines), cfg.defaultMachine, onWatch);
  // 2026-07-28 traffic (server/discover, a per-request _meta envelope). Stateless by
  // design: each request gets a fresh server. 2025 traffic is routed below instead.
  const modern = createMcpHandler(build, { legacy: "reject" });

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    if (url.pathname === "/healthz" && req.method === "GET") {
      return Response.json({ ok: true, service: "herdr-mcp" });
    }
    if (url.pathname !== "/mcp") {
      // Includes /.well-known/oauth-protected-resource: this server has no OAuth,
      // and the tunnel client treats a 404 there as "no auth metadata". The body
      // stays empty: the client tries to parse any body as JSON.
      return new Response(null, { status: 404 });
    }
    // createMcpHandler checks no Host header: DNS rebinding protection is ours.
    const badHost = hostHeaderValidationResponse(req, allowedHosts);
    if (badHost) return badHost;
    let parsedBody: unknown;
    if (req.method === "POST") {
      try {
        parsedBody = JSON.parse(await req.clone().text());
      } catch {
        // Not JSON: the legacy transport answers it with a parse error.
      }
      logRpc(parsedBody, req.headers.get("mcp-protocol-version"));
    }
    const legacy = req.method === "POST" && parsedBody === undefined ? true : await isLegacyRequest(req, parsedBody);
    if (!legacy) return modern.fetch(req, { parsedBody });
    // 2025 initialize clients. Stateless: a fresh server and transport per request, no session to hijack.
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    const server = build();
    await server.connect(transport);
    try {
      return await transport.handleRequest(req);
    } finally {
      // JSON response mode has fully produced the body by now.
      void server.close();
    }
  };
}

if (import.meta.main) {
  const path = process.env.HERDR_MCP_CONFIG ?? "/etc/herdr-mcp/ovh.json";
  const cfg = parseConfig(await Bun.file(path).json());
  const call = sshGateway(cfg);
  const notifier = cfg.notify ? startNotifier(call, Object.keys(cfg.machines), cfg.notify.machine, cfg.notify.intervalMs, WAIT_MS, (m, r) => inbox.add(m, r)) : null;
  const handler = createHandler(cfg, call, notifier?.markPending);
  const srv = Bun.serve({ hostname: cfg.listen.host, port: cfg.listen.port, fetch: handler, idleTimeout: 255 });
  const machines = Object.fromEntries(Object.entries(cfg.machines).map(([name, t]) => [name, `${t.user}@${t.host}`]));
  console.log(JSON.stringify({ event: "listening", url: `http://${srv.hostname}:${srv.port}/mcp`, machines, notify: cfg.notify }));
}
