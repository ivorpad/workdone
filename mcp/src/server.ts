// Herdr remote MCP server. Listens on loopback only; the OpenAI tunnel client is
// the only intended caller. Each tool call becomes one ssh round trip to a machine's gateway.

import { createMcpHandler, hostHeaderValidationResponse, isLegacyRequest, WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import { parseConfig, type OvhConfig } from "./config.ts";
import { AuthenticationError, AuthService } from "./auth.ts";
import { leaseActivity } from "./activity.ts";
import { EventsService, type EventPrincipal, type EventsOptions } from "./events.ts";
import { sshGateway, type CallGateway } from "./gateway-client.ts";
import { inbox } from "./inbox.ts";
import { startNotifier, WAIT_MS } from "./notifier.ts";
import { buildServer } from "./tools.ts";
import type { Report } from "../../gateway/watcher.ts";

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
      // The tool or resource named, never its arguments. For a tool call, the _meta keys
      // ChatGPT sent, and the values of ones that look like a chat or session ID, to
      // find what can name the chat a message to an agent came from.
      const p = (m as any).params ?? {};
      const name = method === "tools/call" ? p.name : method === "resources/read" ? p.uri : undefined;
      const meta = method === "tools/call" && p._meta && typeof p._meta === "object" ? p._meta : null;
      const ids = meta ? Object.fromEntries(Object.entries(meta).filter(([k, v]) => /session|conversation|thread|chat/i.test(k) && typeof v === "string").map(([k, v]) => [k, (v as string).slice(0, 120)])) : undefined;
      log(JSON.stringify({ event: "rpc", method, name, protocolHeader, ...(meta ? { meta_keys: Object.keys(meta).slice(0, 40), meta_ids: ids } : {}) }));
    }
  }
}

export interface HandlerServices { auth?: AuthService; events?: EventsService }

export function createReportSink(events?: Pick<EventsService, "addReports">, fallback: (machine: string, reports: Report[]) => void = (m, r) => { inbox.add(m, r); }) {
  const handled = new WeakSet<object>();
  return async (machine: string, reports: Report[]) => {
    try { if (events) await events.addReports(machine, reports); }
    finally {
      // Intake retries reuse this batch. Give cards their events once even when
      // native persistence fails, while leaving phone delivery independent.
      if (!handled.has(reports)) { handled.add(reports); fallback(machine, reports); }
    }
  };
}

export function createEventService(cfg: OvhConfig, call: CallGateway, auth: AuthService, options: Pick<EventsOptions, "sender" | "now" | "random" | "log" | "onSubscribed"> = {}): EventsService | undefined {
  if (!cfg.events) return undefined;
  const unavailable = new Set(["machine_offline", "gateway_unreachable", "herdr_unavailable", "herdr_timeout", "herdr_closed"]);
  return new EventsService({
    ...cfg.events,
    lastActive: (machine, lease) => leaseActivity.lastActive(machine, lease),
    ...options,
    authorize: async (principal, args, report) => {
      const machines = await auth.allowedMachines(principal);
      if (!machines.length || (args.machine !== undefined && !machines.includes(args.machine))) return false;
      // The gateway is the authority for current allowed roots. Recheck even for
      // unfiltered subscriptions before exposing an agent's report.
      if (report) {
        if (!machines.includes(report.machine)) return false;
        const checked = await call(report.machine, "get_agent", { target: report.pane_id });
        if (!checked.ok && unavailable.has(checked.error.code)) throw new Error("Agent authorization is temporarily unavailable.");
        return checked.ok && (checked.result as any)?.pane_id === report.pane_id && await auth.isAuthorized(principal, report.machine);
      }
      if (args.target) {
        let transient = false;
        for (const machine of args.machine ? [args.machine] : machines) {
          const checked = await call(machine, "get_agent", { target: args.target });
          if (checked.ok && await auth.isAuthorized(principal, machine)) return true;
          if (!checked.ok && unavailable.has(checked.error.code)) transient = true;
        }
        if (transient) throw new Error("Agent authorization is temporarily unavailable.");
        return false;
      }
      return true;
    },
  });
}

// The SDK currently omits the OpenAI securitySchemes extension when listing
// registered tools. Add it on the JSON transport response, including card tools.
async function declareToolAuth(response: Response, scopes: string[]): Promise<Response> {
  if (!response.headers.get("content-type")?.includes("application/json")) return response;
  const body = await response.json() as any;
  for (const message of Array.isArray(body) ? body : [body]) {
    for (const tool of message?.result?.tools ?? []) {
      tool.securitySchemes = [{ type: "oauth2", scopes }];
      tool._meta = { ...tool._meta, securitySchemes: tool.securitySchemes };
    }
  }
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  return new Response(JSON.stringify(body), { status: response.status, statusText: response.statusText, headers });
}

export function createHandler(cfg: OvhConfig, call: CallGateway, onWatch?: (machine: string) => void, services: HandlerServices = {}) {
  const allowedHosts = ["127.0.0.1", "localhost", "[::1]"];
  const auth = services.auth ?? (cfg.auth ? new AuthService(cfg.auth, Object.keys(cfg.machines)) : undefined);
  if (services.events && !auth) throw new Error("native Events requires an authenticated endpoint");
  const contexts = new WeakMap<Request, () => ReturnType<typeof buildServer>>();
  const modern = createMcpHandler(({ requestInfo }) => {
    const build = requestInfo && contexts.get(requestInfo);
    if (!build) throw new Error("Missing validated request identity");
    return build();
  }, { legacy: "reject", ...(auth ? { responseMode: "json" as const } : {}) });

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    if (url.pathname === "/healthz" && req.method === "GET") {
      return Response.json({ ok: true, service: "herdr-mcp" });
    }
    const metadataPath = cfg.auth ? new URL(cfg.auth.resource).pathname.replace(/\/$/, "") : "/mcp";
    if (auth && req.method === "GET" && ["/.well-known/oauth-protected-resource", `/.well-known/oauth-protected-resource${metadataPath}`].includes(url.pathname)) {
      const badHost = hostHeaderValidationResponse(req, allowedHosts);
      return badHost ?? Response.json(auth.metadata());
    }
    if (url.pathname !== "/mcp") {
      // No-auth fallback has no resource metadata. Keep unknown-route 404s empty
      // because tunnel-client attempts JSON parsing on OAuth discovery responses.
      return new Response(null, { status: 404 });
    }
    // createMcpHandler checks no Host header: DNS rebinding protection is ours.
    const badHost = hostHeaderValidationResponse(req, allowedHosts);
    if (badHost) return badHost;
    let principal: EventPrincipal | undefined;
    let machines = Object.keys(cfg.machines);
    if (auth) {
      try {
        principal = await auth.authenticate(req);
        machines = await auth.allowedMachines(principal);
        if (!machines.length) throw new AuthenticationError("insufficient_scope");
      } catch (error) {
        const code = error instanceof AuthenticationError ? error.code : "invalid_token";
        return Response.json({ error: code }, { status: 401, headers: { "WWW-Authenticate": auth.challenge(code) } });
      }
    }
    const scopedCall: CallGateway = principal && auth ? async (machine, op, params) => {
      if (!await auth.isAuthorized(principal!, machine)) return { ok: false, error: { code: "access_denied", message: "This account no longer has access to this machine." } };
      return call(machine, op, params);
    } : call;
    const defaultMachine = machines.includes(cfg.defaultMachine) ? cfg.defaultMachine : machines[0]!;
    const build = (modern = true) => buildServer(scopedCall, machines, defaultMachine, onWatch, modern && services.events && principal ? { service: services.events, principal } : undefined, principal);
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
    if (!legacy) {
      // Each factory resolves the identity bound to this exact request. Concurrent
      // users never share a bearer context, including under the shared HTTP handler.
      contexts.set(req, () => build());
      let response: Response;
      try { response = await modern.fetch(req, { parsedBody }); }
      finally { contexts.delete(req); }
      if (principal && services.events && (parsedBody as any)?.method === "events/subscribe" && response.ok) {
        const result = await response.clone().json() as any;
        if (result.result?.id) {
          const chosen = (parsedBody as any).params?.arguments?.machine;
          for (const machine of chosen ? [chosen] : machines) onWatch?.(machine);
        }
      }
      return auth ? declareToolAuth(response, auth.config.requiredScopes) : response;
    }
    // 2025 initialize clients. Stateless: a fresh server and transport per request, no session to hijack.
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    const server = build(false);
    await server.connect(transport);
    try {
      const response = await transport.handleRequest(req);
      return auth ? declareToolAuth(response, auth.config.requiredScopes) : response;
    } finally {
      // JSON response mode has fully produced the body by now.
      void server.close();
    }
  };
}

export function createEndpoints(cfg: OvhConfig, call: CallGateway, onWatch?: (machine: string) => void, services: HandlerServices = {}) {
  if (cfg.auth?.listenPort !== undefined) {
    return [
      { host: cfg.listen.host, port: cfg.listen.port, authenticated: false, handler: createHandler({ ...cfg, auth: null, events: null }, call, onWatch) },
      { host: cfg.listen.host, port: cfg.auth.listenPort, authenticated: true, handler: createHandler(cfg, call, onWatch, services) },
    ];
  }
  return [{ host: cfg.listen.host, port: cfg.listen.port, authenticated: !!cfg.auth, handler: createHandler(cfg, call, onWatch, services) }];
}

if (import.meta.main) {
  const path = process.env.HERDR_MCP_CONFIG ?? "/etc/herdr-mcp/ovh.json";
  const cfg = parseConfig(await Bun.file(path).json());
  const call = sshGateway(cfg);
  const auth = cfg.auth ? new AuthService(cfg.auth, Object.keys(cfg.machines)) : undefined;
  // A new agent.message subscription starts polling its machines, which may have nothing watched.
  const onSubscribed = (name: string, args: { machine?: string }) => {
    if (name === "agent.message") for (const m of args.machine ? [args.machine] : Object.keys(cfg.machines)) notifier?.markPending(m);
  };
  const events = auth ? createEventService(cfg, call, auth, { onSubscribed }) : undefined;
  const notifier = cfg.notify || events ? startNotifier(call, Object.keys(cfg.machines), cfg.notify?.machine ?? null, cfg.notify?.intervalMs ?? 15_000, WAIT_MS, createReportSink(events), (m) => events?.wantsMessages(m) ?? false) : null;
  events?.start();
  const endpoints = createEndpoints(cfg, call, notifier?.markPending, { auth, events });
  const servers = endpoints.map(({ host, port, handler }) => Bun.serve({ hostname: host, port, fetch: handler, idleTimeout: 255 }));
  const machines = Object.fromEntries(Object.entries(cfg.machines).map(([name, t]) => [name, `${t.user}@${t.host}`]));
  console.log(JSON.stringify({ event: "listening", endpoints: endpoints.map(({ host, port, authenticated }) => ({ url: `http://${host}:${port}/mcp`, authenticated })), machines, notify: cfg.notify, events: !!events }));
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    for (const server of servers) server.stop();
    notifier?.stop();
    await notifier?.idle();
    await events?.close();
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
