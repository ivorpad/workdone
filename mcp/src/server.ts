// Herdr remote MCP server. Listens on loopback only; the OpenAI tunnel client is
// the only intended caller. Each tool call becomes one ssh round trip to a machine's gateway.

import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { parseConfig, type OvhConfig } from "./config.ts";
import { sshGateway, type CallGateway } from "./gateway-client.ts";
import { startNotifier } from "./notifier.ts";
import { buildServer } from "./tools.ts";

export function createHandler(cfg: OvhConfig, call: CallGateway, onWatch?: (machine: string) => void) {
  const port = cfg.listen.port;
  const allowedHosts = ["127.0.0.1", "localhost", "[::1]"].flatMap((h) => [h, `${h}:${port}`]);

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
    // Stateless: a fresh server and transport per request, no session to hijack.
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      enableDnsRebindingProtection: true,
      allowedHosts,
    });
    const server = buildServer(call, Object.keys(cfg.machines), cfg.defaultMachine, onWatch);
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
  const notifier = cfg.notify ? startNotifier(call, Object.keys(cfg.machines), cfg.notify.machine, cfg.notify.intervalMs) : null;
  const handler = createHandler(cfg, call, notifier?.markPending);
  const srv = Bun.serve({ hostname: cfg.listen.host, port: cfg.listen.port, fetch: handler, idleTimeout: 255 });
  const machines = Object.fromEntries(Object.entries(cfg.machines).map(([name, t]) => [name, `${t.user}@${t.host}`]));
  console.log(JSON.stringify({ event: "listening", url: `http://${srv.hostname}:${srv.port}/mcp`, machines, notify: cfg.notify }));
}
