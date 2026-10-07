// Which panes a ChatGPT thread may act on. Every conversation reaches the gateway
// through the same tunnel, so a thread identifies itself with a lease: claim_agents
// hands one out for the agents the owner assigned to that thread, and every call that
// acts on an agent or pane passes it back. A thread can read everything but steer,
// prompt, answer, watch, move, rename or close only what its lease holds, so two
// threads never drive the same worker. Agents a thread starts join its lease.
// Leases are per machine and lapse after a day without use.

import { GatewayError, TARGET_RE } from "./config.ts";
import type { Gateway } from "./gateway.ts";
import { optBool, optStr, type Params } from "./params.ts";
import type { Lease } from "./state.ts";

export const LEASE_RE = /^L-[a-z0-9]{6,12}$/;
const LAPSE_MS = 24 * 3600_000;

const newId = () => `L-${Math.random().toString(36).slice(2, 10)}`;
export const live = (l: Lease, now: number) => now - Date.parse(l.used) < LAPSE_MS;

// The ops that act on something, and where their pane comes from. "agent" targets
// are names or pane IDs.
type Where = { param: string; as: "agent" | "pane" } | ((p: Params) => { param: string; as: "agent" | "pane" } | null);
const GUARDED: Record<string, Where> = {
  prompt_agent: { param: "target", as: "agent" },
  steer_agent: { param: "target", as: "agent" },
  supervisor_nudge: { param: "target", as: "agent" },
  send_agent_keys: { param: "target", as: "agent" },
  answer_agent: { param: "target", as: "agent" },
  set_agent_approval: { param: "target", as: "agent" },
  watch_agent: { param: "target", as: "agent" },
  start_agent: { param: "pane_id", as: "pane" },
  send_pane_input: { param: "pane_id", as: "pane" },
  run_command_in_pane: { param: "pane_id", as: "pane" },
  move_pane: { param: "pane_id", as: "pane" },
  rename: (p) => (p.kind === "agent" ? { param: "id", as: "agent" } : p.kind === "pane" ? { param: "id", as: "pane" } : null),
  close: (p) => (p.kind === "pane" ? { param: "id", as: "pane" } : null),
};

export function leaseOps(g: Gateway) {
  const now = () => Date.now();

  async function paneOf(target: string, as: "agent" | "pane"): Promise<any> {
    if (as === "agent") return await g.scopedAgent(target);
    return await g.scopedPane(target);
  }

  // Who holds a pane, among live leases.
  function holder(leases: Record<string, Lease>, paneId: string): [string, Lease] | null {
    const t = now();
    for (const [id, l] of Object.entries(leases)) if (live(l, t) && l.panes.includes(paneId)) return [id, l];
    return null;
  }

  function need(params: Params): string {
    const id = optStr(params, "lease");
    if (!id) {
      throw new GatewayError(
        "needs_lease",
        "this thread has no lease: call claim_agents with the agents the user assigned to this conversation (a label and their names), then pass lease on every call that acts on them",
      );
    }
    if (!LEASE_RE.test(id)) throw new GatewayError("invalid_params", "lease looks like L-xxxxxx, as claim_agents returned it");
    return id;
  }

  function touch(id: string, add: string[] = []) {
    g.state.updateLeases((l) => {
      const cur = l[id];
      if (!cur) return;
      cur.used = new Date().toISOString();
      for (const p of add) if (!cur.panes.includes(p)) cur.panes.push(p);
    });
  }

  // Before an op runs: may this lease act on its pane? Returns the lease ID to add
  // new panes to afterwards, or null when leases are off or the op is not guarded.
  async function check(op: string, params: Params): Promise<string | null> {
    if (!g.cfg.leases) return null;
    // The owner at the console acts over every lease and takes none: the message goes in
    // stamped as the console's, and the thread that holds the agent keeps it. ChatGPT's
    // tools never forward this field (the MCP server drops it).
    if (params.origin === "console") return null;
    if (op === "spawn_agent") return params.lease === undefined ? null : need(params);
    const rule = GUARDED[op];
    const where = typeof rule === "function" ? rule(params) : rule;
    if (!where) {
      // Closing a tab or workspace closes every pane in it: all of them must be ours.
      if (op === "close" && (params.kind === "tab" || params.kind === "workspace")) {
        const id = need(params);
        const key = params.kind === "tab" ? "tab_id" : "workspace_id";
        const panes = ((await g.herdr("pane.list", {})).panes ?? []).filter((p: any) => p[key] === params.id);
        const leases = g.state.leases();
        for (const p of panes) {
          const h = holder(leases, p.pane_id);
          if (p.agent && h?.[0] !== id) throw notYours(p.pane_id, h);
        }
        return id;
      }
      return null;
    }
    const target = params[where.param];
    if (typeof target !== "string" || !TARGET_RE.test(target)) return null; // the op reports the bad param
    const pane = await paneOf(target, where.as);
    const leases = g.state.leases();
    const h = holder(leases, pane.pane_id);
    // A shell pane nobody holds is free to use; one with an agent must be in your lease.
    if (!h && !pane.agent && where.as === "pane") return params.lease === undefined ? null : need(params);
    const id = need(params);
    if (!leases[id] || !live(leases[id]!, now())) throw new GatewayError("lease_unknown", `lease ${id} is not known on this machine or lapsed: call claim_agents again with this thread's agents`);
    if (h?.[0] !== id) throw notYours(pane.pane_id, h);
    return id;
  }

  function notYours(paneId: string, h: [string, Lease] | null) {
    return h
      ? new GatewayError("not_your_agent", `${paneId} belongs to another thread ("${h[1].label}"). Leave it alone unless the user tells you to take it over: then claim_agents with take_over: true`)
      : new GatewayError("not_your_agent", `${paneId} is not in this thread's lease. Only act on agents the user assigned to this conversation: claim_agents with it if they did`);
  }

  // After a successful op: the pane it made or started joins the lease.
  function after(op: string, id: string | null, params: Params, result: any) {
    if (!id) return;
    const add: string[] = [];
    if (op === "spawn_agent" && result?.pane?.pane_id) add.push(result.pane.pane_id);
    if (op === "start_agent" && typeof params.pane_id === "string") add.push(params.pane_id);
    touch(id, add);
  }

  // origin is internal: request() passes "spawn" when it mints a lease for a lease-less
  // spawn_agent. As an op, claim_agents only ever gets params.
  async function claim_agents(params: Params, origin: "spawn" | "claim" = "claim") {
    const label = optStr(params, "label")?.trim().slice(0, 80);
    const targets = params.targets ?? [];
    if (!Array.isArray(targets) || targets.length > 20 || !targets.every((t) => typeof t === "string" && TARGET_RE.test(t))) {
      throw new GatewayError("invalid_params", "targets must be up to 20 agent names or pane IDs");
    }
    const takeOver = optBool(params, "take_over", false);
    let id = optStr(params, "lease");
    if (id && !LEASE_RE.test(id)) throw new GatewayError("invalid_params", "lease looks like L-xxxxxx");
    const panes = await Promise.all(targets.map((t: string) => paneOf(t, /^[a-z0-9]+:[a-z0-9]+$/i.test(t) ? "pane" : "agent")));
    const t = now();
    const taken: string[] = [];
    const result = g.state.updateLeases((l) => {
      for (const [k, v] of Object.entries(l)) if (!live(v, t)) delete l[k];
      id ??= newId();
      const mine = (l[id!] ??= { label: label ?? "ChatGPT thread", panes: [], created: new Date(t).toISOString(), used: new Date(t).toISOString(), origin });
      if (label) mine.label = label;
      mine.used = new Date(t).toISOString();
      const refused: Array<{ pane_id: string; held_by: string }> = [];
      for (const p of panes) {
        const h = Object.entries(l).find(([k, v]) => k !== id && v.panes.includes(p.pane_id));
        if (h && !takeOver) {
          refused.push({ pane_id: p.pane_id, held_by: h[1].label });
          continue;
        }
        if (h) {
          h[1].panes = h[1].panes.filter((x) => x !== p.pane_id);
          if (h[1].approvals) delete h[1].approvals[p.pane_id];
          taken.push(p.pane_id);
        }
        if (!mine.panes.includes(p.pane_id)) mine.panes.push(p.pane_id);
      }
      return { lease: id!, label: mine.label, panes: [...mine.panes], refused };
    });
    return {
      ...result,
      ...(taken.length ? { taken_over: taken } : {}),
      note: "keep this lease for the whole conversation and pass it on every call that acts on these agents; other threads' agents are read-only to you",
    };
  }

  async function release_agents(params: Params) {
    const id = need(params);
    const targets = params.targets;
    return g.state.updateLeases((l) => {
      const cur = l[id];
      if (!cur) return { released: [], lease: null };
      if (!Array.isArray(targets)) {
        delete l[id];
        return { released: cur.panes, lease: null };
      }
      const ids = new Set(targets.filter((x): x is string => typeof x === "string"));
      const released = cur.panes.filter((p) => ids.has(p));
      cur.panes = cur.panes.filter((p) => !ids.has(p));
      for (const paneId of released) if (cur.approvals) delete cur.approvals[paneId];
      return { released, lease: id, panes: cur.panes };
    });
  }

  // Internal, for the MCP server's watch_here: does this lease exist, is it live, and
  // which panes does it hold. Never touches the lease, so checking doesn't extend it.
  async function lease_check(params: Params) {
    const id = optStr(params, "lease");
    if (!id || !LEASE_RE.test(id)) return { valid: false, reason: "malformed", panes: [] };
    const l = g.state.leases()[id];
    if (!l) return { valid: false, reason: "unknown", panes: [] };
    if (!live(l, now())) return { valid: false, reason: "lapsed", panes: [] };
    return { valid: true, label: l.label, panes: [...l.panes] };
  }

  // Internal, for the console: every live lease with only its tail, its label and its
  // panes, and which one is the caller's. A lease ID is a credential; never returned whole.
  async function lease_list(params: Params) {
    const mine = optStr(params, "lease");
    const t = now();
    return {
      leases: Object.entries(g.state.leases()).filter(([, l]) => live(l, t)).map(([id, l]) => ({ tail: "…" + id.slice(-4), label: l.label, panes: [...l.panes], used: l.used, mine: id === mine })),
    };
  }

  // For views: which thread holds each pane.
  function labels(): Map<string, string> {
    const t = now();
    const m = new Map<string, string>();
    for (const l of Object.values(g.state.leases())) if (live(l, t)) for (const p of l.panes) m.set(p, l.label);
    return m;
  }

  // A live lease from params, for ops that act on something other than a pane (the
  // supervisor's coordination state). null when leases are off.
  function requireLive(params: Params): string | null {
    if (!g.cfg.leases) return null;
    const id = need(params);
    const l = g.state.leases()[id];
    if (!l || !live(l, now())) throw new GatewayError("lease_unknown", `lease ${id} is not known on this machine or lapsed: call claim_agents again`);
    touch(id);
    return id;
  }

  // A lease minted for a spawn that then failed: gone again if nothing joined it.
  function dropIfEmpty(id: string) {
    g.state.updateLeases((l) => {
      if (l[id] && l[id]!.panes.length === 0) delete l[id];
    });
  }

  return { check, after, claim_agents, release_agents, lease_check, lease_list, labels, requireLive, dropIfEmpty };
}
