// The owner's console: one page that shows every agent on every machine, who steers it,
// what waits on the owner, and what each controller just did, and lets the owner answer,
// steer, take over or leave a note for the chat. It is a client of the same gateway
// calls ChatGPT's tools make, under its own lease ("console"), so a thread that tries to
// steer an agent the console holds gets not_your_agent, and the reverse.
//
// Third loopback listener. Tailnet exposure is `tailscale serve`, which adds the
// caller's Tailscale-User-Login header; only configured owner logins pass. A process on
// this box could forge that header (agents run here), the same trust the SSH key and
// config already extend to it: docs/console.md.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ConsoleConfig, OvhConfig } from "./config.ts";
import { holdIfGated, type PendingCalls } from "./confirm.ts";
import { TOUCH, auditToEvent, buildNeeds, controlOf, reportToEvent, type ConsoleEvent, type MachineState } from "./console-model.ts";
import type { CallGateway, GatewayResponse } from "./gateway-client.ts";
import type { Report } from "../../gateway/watcher.ts";

const HTML = await Bun.file(new URL("./console.html", import.meta.url)).text();
const RING = 300;
const REFRESH_MS = 10_000;
const FRESH_MS = 3_000;
const TARGET = /^[A-Za-z0-9_.:-]{1,80}$/;
const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "[::1]"];

// What reaches connected consoles: gateway reports, audit lines of other controllers, and
// this console's own actions. A ring keeps the latest for a page that just opened.
export class ConsoleBus {
  private ring: ConsoleEvent[] = [];
  private subs = new Set<(e: ConsoleEvent) => void>();
  private seq = 0;
  private seen = new Set<string>();
  onConnect: () => void = () => {};

  hasClients() { return this.subs.size > 0; }

  subscribe(fn: (e: ConsoleEvent) => void): () => void {
    this.subs.add(fn);
    this.onConnect();
    return () => { this.subs.delete(fn); };
  }

  recent(): ConsoleEvent[] { return [...this.ring]; }

  publish(e: Omit<ConsoleEvent, "id">, dedupeKey?: string): ConsoleEvent | null {
    if (dedupeKey) {
      if (this.seen.has(dedupeKey)) return null;
      this.seen.add(dedupeKey);
      if (this.seen.size > 2000) this.seen = new Set([...this.seen].slice(-1000));
    }
    const ev = { ...e, id: ++this.seq };
    this.ring.push(ev);
    // Audit lines arrive late and in batches: keep the ring in time order.
    this.ring.sort((a, b) => a.at.localeCompare(b.at) || a.id - b.id);
    if (this.ring.length > RING) this.ring.splice(0, this.ring.length - RING);
    for (const fn of this.subs) fn(ev);
    return ev;
  }

  publishReports(machine: string, reports: Report[]) {
    for (const r of reports) this.publish(reportToEvent(machine, r), r.event_id ? `report:${machine}:${r.event_id}` : undefined);
  }
}

// The console's lease on each machine. Guarded gateway ops need one; it lapses after a day
// without use, so a lapsed lease is claimed again once and the call retried (the gateway
// refuses before running anything, so a retry cannot repeat an action).
export class ConsoleLeases {
  private ids: Record<string, string> = {};
  constructor(private path: string | null, private call: CallGateway) {
    if (path) try { this.ids = JSON.parse(readFileSync(path, "utf8")); } catch { /* first run */ }
  }

  peek(machine: string): string | undefined { return this.ids[machine]; }
  tail(machine: string): string | null { const id = this.ids[machine]; return id ? "…" + id.slice(-4) : null; }

  private save() {
    if (!this.path) return;
    try {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      writeFileSync(this.path, JSON.stringify(this.ids), { mode: 0o600 });
    } catch { /* a lease that is not saved is claimed again after a restart */ }
  }

  async ensure(machine: string, fresh = false): Promise<GatewayResponse & { lease?: string }> {
    const have = this.ids[machine];
    if (have && !fresh) return { ok: true, result: null, lease: have };
    const res = await this.call(machine, "claim_agents", { label: "console", targets: [] });
    if (!res.ok) return res;
    const lease = (res.result as any)?.lease;
    if (typeof lease !== "string") return { ok: false, error: { code: "gateway_bad_response", message: "claim_agents returned no lease" } };
    this.ids[machine] = lease;
    this.save();
    return { ok: true, result: res.result, lease };
  }

  async run(machine: string, op: string, params: Record<string, unknown>): Promise<GatewayResponse> {
    const first = await this.ensure(machine);
    if (!first.ok) return first;
    let res = await this.call(machine, op, { ...params, lease: first.lease });
    if (!res.ok && (res.error.code === "lease_unknown" || res.error.code === "needs_lease")) {
      const again = await this.ensure(machine, true);
      if (!again.ok) return again;
      res = await this.call(machine, op, { ...params, lease: again.lease });
    }
    return res;
  }
}

export interface ConsoleDeps {
  cfg: OvhConfig & { console: ConsoleConfig };
  call: CallGateway;
  pending: PendingCalls;
  bus: ConsoleBus;
  leases: ConsoleLeases;
  // Whether a chat has a native agent.message subscription on this machine (Work chats).
  wantsMessages?: (machine: string) => boolean;
  now?: () => number;
}

const ok = (result: unknown): GatewayResponse => ({ ok: true, result });
const fail = (code: string, message: string): GatewayResponse => ({ ok: false, error: { code, message } });
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });

export function createConsole(deps: ConsoleDeps) {
  const { cfg, call, pending, bus, leases } = deps;
  const now = deps.now ?? Date.now;
  const machines = Object.keys(cfg.machines);
  let snapshot: { at: number; body: any } | null = null;
  let inflight: Promise<any> | null = null;
  let lastFingerprint = "";
  let timer: ReturnType<typeof setInterval> | null = null;

  async function readMachine(machine: string): Promise<{ state: MachineState; supervisor: Record<string, any> }> {
    const mine = leases.peek(machine);
    const [overview, sup, coord, leaseList, claims, audit] = await Promise.all([
      call(machine, "overview", {}), call(machine, "supervisor_status", {}), call(machine, "coord_snapshot", { view: "resume" }),
      call(machine, "lease_list", mine ? { lease: mine } : {}), call(machine, "claims", {}), call(machine, "audit_tail", { n: 60, ops: [...TOUCH] }),
    ]);
    // The overview is the one that says the machine is up. Without it nothing else is worth showing.
    if (!overview.ok) return { state: { ok: false, error: { code: overview.error.code, message: overview.error.message }, agents: [], counts: {}, objectives: [], claims: [], leases: [] }, supervisor: {} };
    const leaseRows = leaseList.ok ? ((leaseList.result as any)?.leases ?? []) : [];
    const agents = (((overview.result as any)?.agents ?? []) as any[]).map((a) => ({ ...a, control: controlOf(a.pane_id, leaseRows) }));
    const supervisor: Record<string, any> = {};
    if (sup.ok) for (const s of (sup.result as any)?.agents ?? []) supervisor[s.pane_id] = { state: s.state, recommendations: s.recommendations };
    if (audit.ok) {
      for (const e of (audit.result as any)?.entries ?? []) {
        const ev = auditToEvent(machine, e, leases.tail(machine));
        if (ev) bus.publish(ev, `audit:${machine}:${e.ts}:${e.op}:${e.id ?? ""}`);
      }
    }
    return {
      supervisor,
      state: {
        ok: true, agents: agents.map((a) => ({ ...a, supervisor: supervisor[a.pane_id] ?? null })), counts: (overview.result as any)?.counts ?? {},
        objectives: coord.ok ? ((coord.result as any)?.objectives ?? []) : [], claims: claims.ok ? ((claims.result as any)?.claims ?? []) : [], leases: leaseRows,
      },
    };
  }

  async function refresh(): Promise<any> {
    if (inflight) return inflight;
    inflight = (async () => {
      const read = await Promise.all(machines.map(async (m) => [m, await readMachine(m)] as const));
      const states = Object.fromEntries(read.map(([m, r]) => [m, r.state]));
      const sup = Object.fromEntries(read.map(([m, r]) => [m, r.supervisor]));
      const held = pending.list();
      const body = { at: new Date(now()).toISOString(), machines: states, pending: held, needs: buildNeeds(states, sup, held), events: bus.recent() };
      snapshot = { at: now(), body };
      return body;
    })().finally(() => { inflight = null; });
    return inflight;
  }

  async function state(force = false) {
    if (!force && snapshot && now() - snapshot.at < FRESH_MS) return { ...snapshot.body, events: bus.recent() };
    return await refresh();
  }

  // While a page is open the state is read every REFRESH_MS and pushed when it changed.
  function tick() {
    if (!bus.hasClients()) return;
    void refresh().then((body) => {
      const { at: _at, events: _events, ...rest } = body;
      const fp = JSON.stringify(rest);
      if (fp !== lastFingerprint) { lastFingerprint = fp; bus.publish({ at: body.at, machine: null, source: "gateway", kind: "state", agent: null, text: "state changed" }); }
    }).catch(() => {});
  }
  function start() { if (!timer) timer = setInterval(tick, REFRESH_MS); }
  function stop() { if (timer) clearInterval(timer); timer = null; }
  let nudged: ReturnType<typeof setTimeout> | null = null;
  // A report arrived: look again soon, once, however many arrive together.
  function soon() { if (nudged) return; nudged = setTimeout(() => { nudged = null; tick(); }, 600); }

  function identity(req: Request): Response | null {
    const c = cfg.console;
    const host = (req.headers.get("host") ?? "").replace(/:\d+$/, "");
    if (c.devNoAuth) return LOOPBACK_HOSTS.includes(host) ? null : json(fail("bad_host", "devNoAuth answers loopback hosts only"), 421);
    const login = req.headers.get("tailscale-user-login")?.toLowerCase();
    if (!login) return json(fail("no_identity", "this console answers through tailscale serve, which names the caller"), 401);
    if (!c.ownerLogins.includes(login)) return json(fail("not_owner", "this tailnet identity is not allowed here"), 403);
    return null;
  }

  async function act(body: any): Promise<{ status: number; body: unknown }> {
    const machine = body?.machine;
    if (typeof machine !== "string" || !machines.includes(machine)) return { status: 400, body: fail("unknown_machine", "machine is not configured") };
    const action = String(body?.action ?? "");
    const target = body?.target;
    if (action !== "confirm" && action !== "refresh" && (typeof target !== "string" || !TARGET.test(target))) return { status: 400, body: fail("invalid_params", "target must be an agent name or pane id") };
    const text = typeof body?.text === "string" ? body.text : "";
    if (text.length > 4000) return { status: 400, body: fail("invalid_params", "text exceeds 4000 characters") };
    const log = (kind: string, line: string, flag = false) => bus.publish({ at: new Date(now()).toISOString(), machine, source: "console", kind, agent: typeof target === "string" ? target : null, text: line, flag });
    const clip = (s: string) => (s.length > 120 ? s.slice(0, 119) + "…" : s);
    let res: GatewayResponse;
    switch (action) {
      case "claim": {
        const first = await leases.ensure(machine);
        if (!first.ok) { res = first; break; }
        res = await leases.run(machine, "claim_agents", { targets: [target], take_over: body.take_over === true });
        const refused = (res.ok && (res.result as any)?.refused?.length) ? (res.result as any).refused : [];
        if (res.ok && refused.length) res = { ok: false, error: { code: "held_by_other", message: `${target} is held by "${refused[0].held_by}". Take over to move it here.` } };
        log("claim", `${res.ok ? (body.take_over === true ? "took over" : "took control of") : "could not take control of"} ${target}`, body.take_over === true);
        break;
      }
      case "release":
        res = await leases.run(machine, "release_agents", { targets: [target] });
        log("release", `released ${target}`);
        break;
      case "prompt":
      case "steer": {
        if (!text.trim()) return { status: 400, body: fail("invalid_params", "text is empty") };
        res = await leases.run(machine, action === "steer" ? "steer_agent" : "prompt_agent", { target, text, origin: "console" });
        log(action, `${res.ok ? (action === "steer" ? "steered" : "prompted") : `refused (${res.error.code}):`} ${target}: ${clip(text)}`, !res.ok);
        break;
      }
      case "answer": {
        // Bound to the menu the page showed: a menu that moved on is stale_dialog, never a wrong answer.
        if (typeof body.dialog_id !== "string" || !/^[a-f0-9]{64}$/.test(body.dialog_id)) return { status: 400, body: fail("invalid_params", "dialog_id from the menu shown is required") };
        const params: Record<string, unknown> = { target, expected_dialog_id: body.dialog_id };
        if (Array.isArray(body.options)) params.options = body.options; else params.option = body.option;
        if (text.trim()) params.text = text;
        const answered = await leases.run(machine, "answer_agent", params);
        // The held call keeps the console's lease, so approving it later acts as the console.
        res = holdIfGated(pending, machine, "answer_agent", { ...params, lease: leases.peek(machine) }, answered);
        log("answer", `${res.ok ? "answered" : res.error.code === "needs_confirmation" ? "held for approval" : `refused (${res.error.code}):`} menu on ${target}`, !res.ok && res.error.code !== "needs_confirmation");
        break;
      }
      case "confirm": {
        if (typeof body.pending !== "string") return { status: 400, body: fail("invalid_params", "pending id required") };
        const held = pending.take(body.pending);
        if (!held) return { status: 404, body: fail("pending_not_found", "this held call expired, ran already or never existed") };
        const label = `${held.op} on ${held.machine}`;
        if (body.approve !== true) { bus.publish({ at: new Date(now()).toISOString(), machine: held.machine, source: "console", kind: "decline", agent: null, text: `declined ${label}` }); res = ok({ declined: true }); break; }
        res = await call(held.machine, held.op, { ...held.params, confirm: true });
        bus.publish({ at: new Date(now()).toISOString(), machine: held.machine, source: "console", kind: "approve", agent: null, text: `${res.ok ? "approved" : "approval failed:"} ${label}`, flag: !res.ok });
        break;
      }
      case "nudge":
        res = await leases.run(machine, "supervisor_nudge", { target });
        log("nudge", `${res.ok ? "nudged" : `nudge refused (${res.error.code}):`} ${target}`, !res.ok);
        break;
      case "close":
        res = await leases.run(machine, "close", { kind: "pane", id: target });
        log("close", `${res.ok ? "closed" : `close refused (${res.error.code}):`} ${target}`, !res.ok);
        break;
      case "note": {
        if (!text.trim()) return { status: 400, body: fail("invalid_params", "text is empty") };
        res = await call(machine, "owner_note", { pane_id: target, text });
        if (res.ok) {
          const r = res.result as any;
          // Say what can deliver it, never that it arrived: that is the chat's to confirm.
          const events = deps.wantsMessages?.(machine) ?? false;
          res = ok({ ...r, events_subscribed: events, delivery: events ? "queued; a chat subscribed to agent.message on this machine will be woken" : r.held_by ? "queued; reaches the chat only while its link card is open, and waits up to an hour" : "queued; no chat holds this agent and no Events subscription is active, so nobody may get it" });
        }
        log("note", `${res.ok ? "left a note for the chat about" : `note refused (${res.error.code}):`} ${target}: ${clip(text)}`, !res.ok);
        break;
      }
      case "refresh":
        await state(true);
        res = ok({ refreshed: true });
        break;
      default:
        return { status: 400, body: fail("unknown_action", `no action ${action}`) };
    }
    snapshot = null;
    soon();
    // A gateway refusal is an answer the page shows, not a transport failure.
    return { status: 200, body: res };
  }

  async function handler(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/healthz" && req.method === "GET") return json({ ok: true, service: "workdone-console" });
    const denied = identity(req);
    if (denied) return denied;
    if (url.pathname === "/" && req.method === "GET") {
      return new Response(HTML, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" } });
    }
    if (url.pathname === "/api/state" && req.method === "GET") return json(await state(url.searchParams.get("fresh") === "1"));
    if (url.pathname === "/api/events" && req.method === "GET") {
      let off = () => {};
      let beat: ReturnType<typeof setInterval> | undefined;
      const stream = new ReadableStream({
        start(controller) {
          const enc = new TextEncoder();
          const send = (e: ConsoleEvent) => { try { controller.enqueue(enc.encode(`id: ${e.id}\nevent: ${e.kind === "state" ? "state" : "feed"}\ndata: ${JSON.stringify(e)}\n\n`)); } catch { off(); } };
          controller.enqueue(enc.encode("retry: 3000\n\n"));
          off = bus.subscribe(send);
          beat = setInterval(() => { try { controller.enqueue(enc.encode(": keepalive\n\n")); } catch { off(); } }, 20_000);
        },
        cancel() { off(); if (beat) clearInterval(beat); },
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" } });
    }
    if (url.pathname === "/api/act" && req.method === "POST") {
      // The page sets this header; another site's form post cannot, and a cross-origin fetch with it needs a preflight we never grant.
      if (req.headers.get("x-workdone-console") !== "1") return json(fail("csrf", "missing X-WorkDone-Console header"), 403);
      const origin = req.headers.get("origin");
      // "null" (a sandboxed frame) and anything unparseable count as cross-origin.
      let sameOrigin = true;
      if (origin) { try { sameOrigin = new URL(origin).host === req.headers.get("host"); } catch { sameOrigin = false; } }
      if (!sameOrigin) return json(fail("csrf", "cross-origin request"), 403);
      let body: unknown;
      try {
        const raw = await req.text();
        if (raw.length > 64_000) return json(fail("too_large", "request body over 64 KB"), 413);
        body = JSON.parse(raw);
      } catch { return json(fail("invalid_json", "body must be JSON"), 400); }
      const out = await act(body);
      return json(out.body, out.status);
    }
    return new Response(null, { status: 404 });
  }

  return { handler, refresh: state, start, stop, soon };
}
