// Owner confirmation by click. A gated call (push, commit, merge, rm -rf, deploy, ...) that
// the gateway refuses with needs_confirmation is held here as a pending call. The model
// can show it with request_confirmation, which renders confirm.html in ChatGPT; only
// that card can call confirm_pending (visibility "app"), which runs the held call with
// confirm: true. The card shows what the server holds, not the model's account of it.

import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { CallGateway, GatewayResponse } from "./gateway-client.ts";
import type { render as renderResult } from "./render.ts";

// Versioned: ChatGPT caches a card by URI, so a changed card needs a new one.
export const CONFIRM_URI = "ui://workdone/confirm-3.html";
// A declared, empty CSP: the cards load nothing from outside. Without one ChatGPT's web app
// shows "CSP off", and its iOS app showed a blank card (30-09), so both forms are declared.
export const CARD_META = {
  ui: { csp: { connectDomains: [], resourceDomains: [] }, prefersBorder: true },
  "openai/widgetCSP": { connect_domains: [], resource_domains: [] },
};

// Registers a card under its current URI and every earlier one. ChatGPT's web app picks up
// a new URI on Refresh tools, but its iOS app kept asking for an old one (30-09) and
// showed a blank card when that was gone, so old URIs keep answering with the current card.
export function registerCard(server: McpServer, name: string, uris: string[], config: { title: string; description?: string }, html: string) {
  for (const [i, uri] of uris.entries()) {
    server.registerResource(i === 0 ? name : `${name}_${i}`, uri, { ...config, mimeType: MIME }, async () => ({ contents: [{ uri, mimeType: MIME, text: html, _meta: CARD_META }] }));
  }
}
const MIME = "text/html;profile=mcp-app";
const HTML = await Bun.file(new URL("./confirm.html", import.meta.url)).text();

// Tools whose gateway op can answer needs_confirmation.
export const GATED = new Set(["exec", "answer_agent", "send_pane_input", "run_command_in_pane"]);
export const PENDING_TTL_MS = 15 * 60_000;
const MAX_PENDING = 50;

interface Pending {
  machine: string;
  op: string;
  params: Record<string, unknown>;
  reason: string;
  expires: number;
  menu?: string;
}

// Shows what the call does, for the card: the command, the input, or the menu answer.
function detail(op: string, p: Record<string, any>): string {
  if (op === "exec") return [p.cwd ? `cd ${p.cwd}` : p.repo ? `(repo ${p.repo})` : "", p.command].filter(Boolean).join("\n");
  if (op === "run_command_in_pane") return `${p.pane_id}: ${p.command}`;
  if (op === "send_pane_input") return `${p.pane_id}: ${[p.text, ...(p.keys ?? [])].filter((x) => x != null).join(" + ")}`;
  if (op === "answer_agent") return `${p.target}: option ${p.options?.join(", ") ?? p.option}${p.text ? ` "${p.text}"` : ""}`;
  return JSON.stringify(p);
}

export class PendingCalls {
  private calls = new Map<string, Pending>();
  constructor(private now: () => number = Date.now) {}

  hold(machine: string, op: string, params: Record<string, unknown>, reason: string, menu?: string): string {
    this.sweep();
    while (this.calls.size >= MAX_PENDING) this.calls.delete(this.calls.keys().next().value!);
    const id = `pc_${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`;
    this.calls.set(id, { machine, op, params, reason, expires: this.now() + PENDING_TTL_MS, menu });
    return id;
  }

  peek(id: string): Pending | undefined {
    this.sweep();
    return this.calls.get(id);
  }

  // Single use: a second click, or a replayed call, finds nothing.
  take(id: string): Pending | undefined {
    const p = this.peek(id);
    this.calls.delete(id);
    return p;
  }

  // Every held call, for the console's approval list. The same holds a chat can show on a card.
  list(): Array<{ pending: string; machine: string; op: string; reason: string; detail: string; expires: string }> {
    this.sweep();
    return [...this.calls].map(([id, p]) => card(id, p));
  }

  private sweep() {
    for (const [id, p] of this.calls) if (p.expires <= this.now()) this.calls.delete(id);
  }
}

export const pendingCalls = new PendingCalls();

// Turns a gateway needs_confirmation into a held call the owner can approve with a click.
export function holdIfGated(pending: PendingCalls, machine: string, op: string, params: Record<string, unknown>, res: GatewayResponse): GatewayResponse {
  if (res.ok || res.error.code !== "needs_confirmation" || !GATED.has(op)) return res;
  const { confirm: _, ...rest } = params;
  // "this command runs a git push, which is..." -> "runs git push"
  const reason = res.error.message
    .replace(/, which is the owner's call.*$/, "")
    .replace(/^this (?:command|input) runs a /, "runs ")
    .replace(/^this menu asks to run a /, "answers a menu that runs ");
  const dialogId = res.error.details?.dialog_id;
  if (op === "answer_agent" && dialogId) rest.expected_dialog_id = dialogId;
  // Older gateways cannot bind a held answer to a menu. Do not create a card that
  // could approve a different command after the agent advances.
  if (op === "answer_agent" && !rest.expected_dialog_id) return res;
  const id = pending.hold(machine, op, rest, reason, res.error.details?.menu);
  return {
    ok: false,
    error: {
      code: "needs_confirmation",
      message: `This call ${reason} and needs the owner's authorization. If their current decision or existing instruction covers it, call the original tool again with confirm: true; do not ask again. For an agent menu, reread it and use the approved dialog's expected_dialog_id. Otherwise call request_confirmation with pending "${id}" to show an Approve button, or obtain their decision in chat.`,
      pending: id,
    },
  };
}

function card(id: string, p: Pending) {
  return { pending: id, machine: p.machine, op: p.op, reason: p.reason, detail: [p.menu, detail(p.op, p.params as Record<string, any>)].filter(Boolean).join("\n"), expires: new Date(p.expires).toISOString() };
}

export function registerConfirm(server: McpServer, call: CallGateway, render: typeof renderResult, pending: PendingCalls = pendingCalls) {
  registerCard(server, "confirm", [CONFIRM_URI, "ui://workdone/confirm-2.html", "ui://workdone/confirm.html"], { title: "Approve a held action", description: "Approve or decline an action that is the owner's call." }, HTML);

  server.registerTool(
    "request_confirmation",
    {
      title: "Ask the owner to approve",
      description:
        "Show an Approve / Decline card when a call returned needs_confirmation with a pending id and the owner's authorization is still needed. If their current decision or an existing instruction already covers the operation, call the original tool with confirm:true instead of asking again. The card shows the exact held command or menu; its click runs that held call. After showing it, tell the user what needs approval and stop: the result reaches you once they click. Pending ids last 15 minutes, work once and are lost on an MCP server restart.",
      inputSchema: z.object({ pending: z.string().describe("The pending id from the needs_confirmation error.") }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      _meta: { ui: { resourceUri: CONFIRM_URI } },
    },
    async ({ pending: id }) => {
      const p = pending.peek(id);
      if (!p) return render({ ok: false, error: { code: "pending_not_found", message: `no held call ${id}: it expired, ran already or never existed. Make the call again to get a new id.` } });
      const c = card(id, p);
      return {
        content: [{ type: "text" as const, text: `Waiting for the owner to approve on ${p.machine}: ${c.reason}.\n${c.detail}` }],
        structuredContent: { status: "pending", ...c },
        isError: false,
      };
    },
  );

  server.registerTool(
    "confirm_pending",
    {
      title: "Run or drop a held action",
      description: "Called by the approval card when the owner clicks Approve or Decline.",
      inputSchema: z.object({ pending: z.string(), approve: z.boolean() }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      // App-only: the card calls it, the model never sees it. No resourceUri: ChatGPT
      // warns that a private tool cannot render a widget of its own.
      _meta: { ui: { visibility: ["app"] } },
    },
    async ({ pending: id, approve }) => {
      const p = pending.take(id);
      if (!p) return render({ ok: false, error: { code: "pending_not_found", message: `no held call ${id}: it expired or ran already` } });
      const c = card(id, p);
      if (!approve) {
        return { content: [{ type: "text" as const, text: `The owner declined on ${p.machine}: ${c.detail}` }], structuredContent: { status: "declined", ...c }, isError: false };
      }
      const res = await call(p.machine, p.op, { ...p.params, confirm: true });
      const out = render(res);
      return { ...out, structuredContent: { status: res.ok ? "ran" : "failed", ...c, result: res.ok ? res.result : { error: res.error } } };
    },
  );
}
