// Ops for the owner's console: the inbox of what agents told the owner, and (below) one
// batched snapshot of everything the console shows. Internal: no ChatGPT tool maps to them.

import { randomUUID } from "node:crypto";
import { GatewayError, TARGET_RE } from "./config.ts";
import { paneTask } from "./coord-ops.ts";
import type { Gateway } from "./gateway.ts";
import { optInt, optStr, type Op } from "./params.ts";

const tail = (lease: string | null) => (lease ? "…" + lease.slice(-4) : null);

// Who an agent is and what it was doing when it spoke: kept with the entry.
export function inboxContext(g: Gateway, paneId: string, agent: { name?: string | null; agent?: string | null; foreground_cwd?: string; cwd?: string; agent_session?: { value?: string } } | null, fallback: { name?: string | null; kind?: string | null; cwd?: string | null; session?: string | null } = {}) {
  const session = agent?.agent_session?.value ?? fallback.session ?? null;
  const name = agent?.name ?? fallback.name ?? null;
  const task = paneTask(g, paneId, name, session);
  const lease = Object.entries(g.state.leases()).find(([, l]) => l.panes.includes(paneId))?.[0] ?? null;
  return {
    pane_id: paneId, agent: name, agent_kind: agent?.agent ?? fallback.kind ?? null, cwd: agent?.foreground_cwd ?? agent?.cwd ?? fallback.cwd ?? null,
    session, lease, task: task ? { objective: task.objective, id: task.id } : null,
  };
}

export function newInboxId() { return `in_${randomUUID().replaceAll("-", "").slice(0, 20)}`; }

// What the console shows: every entry (lease as a tail and its thread's label), and the
// results asked for with reply: true that have not come back yet.
export function inboxView(g: Gateway, limit = 80) {
  const leases = g.state.leases();
  const label = (lease: string | null) => (lease && leases[lease] ? leases[lease]!.label : null);
  const entries = g.state.inbox().slice(-limit).reverse().map(({ lease, ...e }) => ({ ...e, lease: tail(lease), thread: label(lease) }));
  const pending = Object.entries(g.state.watched()).filter(([, w]) => w.result_request).map(([paneId, w]) => {
    const lease = w.result_request!.lease ?? null;
    return { id: `pending:${w.result_request!.id}`, kind: "result" as const, status: "pending" as const, at: w.result_request!.at, pane_id: paneId, agent: w.name, agent_kind: w.kind ?? null, cwd: w.cwd, result_id: w.result_request!.id, lease: tail(lease), thread: label(lease) };
  });
  return { entries, pending, unanswered: g.state.inbox().filter((e) => e.status === "unanswered").length };
}

export function consoleOps(g: Gateway): Record<string, Op> {
  return {
    // The owner's inbox as the gateway holds it, independent of any chat card.
    async inbox_list(params) {
      return inboxView(g, optInt(params, "limit", 1, 500) ?? 80);
    },

    // Dismiss one entry by id, or every unanswered entry of one agent (target: pane id or name).
    async inbox_resolve(params) {
      const id = optStr(params, "id");
      const target = optStr(params, "target", TARGET_RE);
      if (!id && !target) throw new GatewayError("invalid_params", "pass id or target");
      const resolved = g.state.inboxResolve({ id, target }, "dismissed", params.origin === "console" ? "console" : "owner");
      return { resolved };
    },
  };
}
