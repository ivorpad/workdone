// Ops for the owner's console: the inbox of what agents told the owner, and (below) one
// batched snapshot of everything the console shows. Internal: no ChatGPT tool maps to them.

import { randomUUID } from "node:crypto";
import { GatewayError, TARGET_RE } from "./config.ts";
import { paneTask } from "./coord-ops.ts";
import type { Gateway } from "./gateway.ts";
import { optInt, optStr, type Op } from "./params.ts";
import type { InboxEntry } from "./state.ts";

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

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

// Herdr's own "done" (finished, not yet looked at) for agents the watcher has no entry for: an
// agent nobody watches, or a turn that ended before a watch existed. Not stored: it is read
// off the live agent each time, and goes away when Herdr marks the agent seen. An entry the
// inbox already holds for that pane at or after the reply stands in for it.
export function derivedFinished(agents: any[], stored: InboxEntry[]) {
  const out: any[] = [];
  for (const a of agents) {
    if (a.status !== "done" || typeof a.pane_id !== "string") continue;
    const said = Date.parse(a.last_reply?.at ?? "") || 0;
    if (stored.some((e) => e.pane_id === a.pane_id && Date.parse(e.at) >= said - 60_000)) continue;
    out.push({
      id: `derived:${a.pane_id}:${a.last_reply?.at ?? "unknown"}`, kind: "finished", status: "unanswered", derived: true,
      at: a.last_reply?.at ?? new Date().toISOString(), pane_id: a.pane_id, agent: a.name ?? null, agent_kind: a.agent ?? null, cwd: a.cwd ?? null, session: null,
      lease: null, thread: a.held_by ?? null, task: a.task ? { objective: a.task.objective, id: a.task.id } : null, text: clip(a.last_reply?.text ?? "finished", 600),
    });
  }
  return out;
}

export function consoleOps(g: Gateway): Record<string, Op> {
  return {
    // Everything the console shows, in one round trip instead of six: the agents (overview),
    // the supervisor's view of them, coordination objectives, who holds which agent, file
    // claims, the recent touches in the audit log, and the owner's inbox. Read-only. A section
    // that fails is reported under errors and left out, so the console can still show the rest;
    // without the agent list there is nothing to show, so that failure is the call's.
    async console_snapshot(params) {
      const attempt = async <T>(f: () => Promise<T>) => f().then((v) => ({ v, err: null as null | { code: string; message: string } }), (e) => ({ v: null as T | null, err: { code: String(e?.code ?? "error"), message: String(e?.message ?? e).slice(0, 300) } }));
      const ops = Array.isArray(params.audit_ops) && params.audit_ops.every((o) => typeof o === "string") ? (params.audit_ops as string[]).slice(0, 40) : undefined;
      const [overview, supervisor, coord, leases, claims, audit] = await Promise.all([
        g.handle("overview", {}) as Promise<any>,
        attempt(() => g.handle("supervisor_status", {}) as Promise<any>),
        attempt(() => g.handle("coord_snapshot", { view: "resume" }) as Promise<any>),
        attempt(() => g.handle("lease_list", {}) as Promise<any>),
        attempt(() => g.handle("claims", {}) as Promise<any>),
        attempt(() => g.handle("audit_tail", { n: optInt(params, "audit_n", 1, 200) ?? 60, ...(ops ? { ops } : {}) }) as Promise<any>),
      ]);
      const errors: Record<string, { code: string; message: string }> = {};
      for (const [name, r] of Object.entries({ supervisor, coord, leases, claims, audit })) if (r.err) errors[name] = r.err;
      const inbox = inboxView(g);
      const derived = derivedFinished(overview.agents ?? [], g.state.inbox());
      return {
        agents: overview.agents ?? [], counts: overview.counts ?? {},
        supervisor: supervisor.v?.agents ?? [], objectives: coord.v?.objectives ?? [], leases: leases.v?.leases ?? [], claims: claims.v?.claims ?? [], audit: audit.v?.entries ?? [],
        inbox: { entries: [...derived, ...inbox.entries], pending: inbox.pending, unanswered: inbox.unanswered + derived.length },
        errors,
      };
    },

    // The owner's inbox as the gateway holds it, independent of any chat card.
    async inbox_list(params) {
      return inboxView(g, optInt(params, "limit", 1, 500) ?? 80);
    },

    // Dismiss one entry by id, or every unanswered entry of one agent (target: pane id or name).
    async inbox_resolve(params) {
      const id = optStr(params, "id");
      const target = optStr(params, "target", TARGET_RE);
      if (!id && !target) throw new GatewayError("invalid_params", "pass id or target");
      const by = params.origin === "console" ? "console" : "owner";
      // A derived entry is not stored: dismissing it stores a dismissed one, so it does not come back.
      if (id?.startsWith("derived:")) {
        if (!target) throw new GatewayError("invalid_params", "dismissing a derived entry needs its target");
        const agent = await g.scopedAgent(target);
        g.state.inboxAdd({ id, kind: "finished", at: new Date().toISOString(), ...inboxContext(g, agent.pane_id, agent), text: "dismissed", status: "dismissed", resolved_at: new Date().toISOString(), resolved_by: by });
        return { resolved: 1 };
      }
      return { resolved: g.state.inboxResolve({ id, target }, "dismissed", by) };
    },
  };
}
