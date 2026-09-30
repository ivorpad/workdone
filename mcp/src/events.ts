// MCP Events (2026-07-28), probe stage. The server declares the events capability and
// lists what it could deliver, so ChatGPT can show them and try to subscribe. Delivery
// is not built yet: it needs outbound HTTPS to ChatGPT's callback, which this unit's
// IPAddressAllow blocks, and durable subscriptions. events/subscribe logs what ChatGPT
// asked for (the callback host, never its secret) and says it is not available.

import { ProtocolError, type McpServer, type ServerCapabilities } from "@modelcontextprotocol/server";
import { z } from "zod";

const agentArgs = {
  type: "object",
  properties: {
    machine: { type: "string", description: "Machine the agent runs on (mac, ovh, syno...). Omit for every machine." },
    target: { type: "string", description: "Agent name or pane ID. Omit for every watched agent." },
  },
  additionalProperties: false,
};

const agentPayload = {
  type: "object",
  properties: {
    machine: { type: "string" },
    pane_id: { type: "string" },
    agent: { type: "string", description: "The name the agent was started as." },
    cwd: { type: "string" },
    excerpt: { type: "string", description: "Start of its last reply, or the question it asks." },
  },
  required: ["machine", "pane_id", "agent"],
  additionalProperties: false,
};

export const EVENTS = [
  { name: "agent.finished", description: "A watched coding agent finished its turn and is idle.", delivery: ["webhook"], inputSchema: agentArgs, payloadSchema: agentPayload },
  { name: "agent.asks", description: "A watched coding agent stopped and asks the owner something.", delivery: ["webhook"], inputSchema: agentArgs, payloadSchema: agentPayload },
];

const Delivery = z.looseObject({ mode: z.string().optional(), url: z.string().optional(), secret: z.string().optional() });
const SubscribeParams = z.looseObject({ name: z.string(), arguments: z.record(z.string(), z.unknown()).optional(), delivery: Delivery.optional(), cursor: z.unknown().optional() });

// What a subscribe looked like, without the signing secret or the callback path.
export function describeSubscribe(p: z.infer<typeof SubscribeParams>) {
  let host: string | undefined;
  try {
    host = p.delivery?.url ? new URL(p.delivery.url).host : undefined;
  } catch {
    host = "unparseable";
  }
  return { event: "events_subscribe", name: p.name, arguments: p.arguments, mode: p.delivery?.mode, callback_host: host, has_secret: typeof p.delivery?.secret === "string", extra: Object.keys(p).filter((k) => !["name", "arguments", "delivery", "cursor"].includes(k)) };
}

export function registerEvents(server: McpServer, log: (line: string) => void = console.log) {
  // Not in the SDK's ServerCapabilities type yet; the capability object passes through as is.
  server.server.registerCapabilities({ events: {} } as ServerCapabilities);
  server.server.setRequestHandler("events/list", { params: z.looseObject({}).optional() }, async () => ({ events: EVENTS }));
  server.server.setRequestHandler("events/subscribe", { params: SubscribeParams }, async (params) => {
    log(JSON.stringify(describeSubscribe(params)));
    throw new ProtocolError(-32603, "WorkDone lists its events but does not deliver them yet: use its phone notifications, or wait_agent in this chat.");
  });
  server.server.setRequestHandler("events/unsubscribe", { params: z.looseObject({ name: z.string().optional() }) }, async (params) => {
    log(JSON.stringify({ event: "events_unsubscribe", name: params.name }));
    return {};
  });
}
