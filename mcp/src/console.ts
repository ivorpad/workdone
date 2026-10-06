// The owner's console: one page that shows every agent on every machine, who steers it,
// what waits on the owner, and what each controller just did, and lets the owner answer,
// steer or leave a note for the chat. It calls the same gateway ops ChatGPT's tools do,
// as the owner: origin "console" acts over every lease and takes none, so a thread that
// holds an agent keeps it and the message is stamped as the console's. Nothing here
// claims, releases or takes over.
//
// Third loopback listener. Tailnet exposure is `tailscale serve`, which adds the
// caller's Tailscale-User-Login header; only configured owner logins pass. A process on
// this box could forge that header (agents run here), the same trust the SSH key and
// config already extend to it: docs/console.md.

import type { ConsoleConfig, OvhConfig } from "./config.ts";
import { holdIfGated, type PendingCalls } from "./confirm.ts";
import { TOUCH, auditToEvent, buildNeeds, controlOf, deliveryOf, pollDelay, reportToEvent, type ConsoleEvent, type MachineState } from "./console-model.ts";
import type { CallGateway, GatewayResponse } from "./gateway-client.ts";
import type { Report } from "../../gateway/watcher.ts";

const HTML = await Bun.file(new URL("./console.html", import.meta.url)).text();
const RING = 300;
const FRESH_MS = 3_000;
// What the gateway reads as the owner at the console: acts over every lease, takes none.
const CONSOLE = "console";
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

export interface ConsoleDeps {
  cfg: OvhConfig & { console: ConsoleConfig };
  call: CallGateway;
  pending: PendingCalls;
  bus: ConsoleBus;
  // Whether a chat has a native agent.message subscription on this machine (Work chats).
  wantsMessages?: (machine: string) => boolean;
  now?: () => number;
  // Polling pace while a page is open: the fast interval and the slowest it backs off to.
  pollBaseMs?: number;
  pollMaxMs?: number;
}

const ok = (result: unknown): GatewayResponse => ({ ok: true, result });
const fail = (code: string, message: string): GatewayResponse => ({ ok: false, error: { code, message } });
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });

export function createConsole(deps: ConsoleDeps) {
  const { cfg, call, pending, bus } = deps;
  const now = deps.now ?? Date.now;
  const machines = Object.keys(cfg.machines);
  let snapshot: { at: number; body: any } | null = null;
  let inflight: Promise<any> | null = null;
  let lastFingerprint = "";
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let unchanged = 0;
  const base = deps.pollBaseMs ?? 4_000;
  const ceiling = deps.pollMaxMs ?? 60_000;
  // Gateways from before console_snapshot, and when to ask them again.
  const legacy = new Map<string, number>();
  const RECHECK_MS = 5 * 60_000;
  const emptyState = (error?: { code: string; message: string }): MachineState => ({ ok: !error, ...(error ? { error } : {}), agents: [], counts: {}, objectives: [], claims: [], leases: [], inbox: { entries: [], pending: [], unanswered: 0 } });

  // One gateway call per machine. A gateway without the op (deployed before it) is read the old way, six calls, and says so.
  async function readMachine(machine: string): Promise<{ state: MachineState; supervisor: Record<string, any> }> {
    const since = legacy.get(machine);
    if (since === undefined || now() - since > RECHECK_MS) {
      const snap = await call(machine, "console_snapshot", { audit_n: 60, audit_ops: [...TOUCH] });
      if (snap.ok) { legacy.delete(machine); return fromSnapshot(machine, snap.result as any); }
      if (snap.error.code !== "unknown_operation") return { state: emptyState({ code: snap.error.code, message: snap.error.message }), supervisor: {} };
      legacy.set(machine, now());
    }
    return await readLegacy(machine);
  }

  function ingestAudit(machine: string, entries: any[]) {
    for (const e of entries ?? []) {
      const ev = auditToEvent(machine, e);
      if (ev) bus.publish(ev, `audit:${machine}:${e.ts}:${e.op}:${e.id ?? ""}`);
    }
  }

  function fromSnapshot(machine: string, r: any): { state: MachineState; supervisor: Record<string, any> } {
    const leaseRows = r.leases ?? [];
    const supervisor: Record<string, any> = {};
    for (const s of r.supervisor ?? []) supervisor[s.pane_id] = { state: s.state, recommendations: s.recommendations };
    ingestAudit(machine, r.audit);
    const events = deps.wantsMessages?.(machine) ?? false;
    const entries = (r.inbox?.entries ?? []).map((e: any) => ({ ...e, delivery: deliveryOf(e, events) }));
    const agents = (r.agents ?? []).map((a: any) => ({ ...a, control: controlOf(a.pane_id, leaseRows), supervisor: supervisor[a.pane_id] ?? null }));
    return { supervisor, state: { ok: true, agents, counts: r.counts ?? {}, objectives: r.objectives ?? [], claims: r.claims ?? [], leases: leaseRows, inbox: { entries, pending: r.inbox?.pending ?? [], unanswered: r.inbox?.unanswered ?? 0 } } };
  }

  async function readLegacy(machine: string): Promise<{ state: MachineState; supervisor: Record<string, any> }> {
    const [overview, sup, coord, leaseList, claims, audit] = await Promise.all([
      call(machine, "overview", {}), call(machine, "supervisor_status", {}), call(machine, "coord_snapshot", { view: "resume" }),
      call(machine, "lease_list", {}), call(machine, "claims", {}), call(machine, "audit_tail", { n: 60, ops: [...TOUCH] }),
    ]);
    if (!overview.ok) return { state: emptyState({ code: overview.error.code, message: overview.error.message }), supervisor: {} };
    const r = {
      agents: (overview.result as any)?.agents ?? [], counts: (overview.result as any)?.counts ?? {}, supervisor: sup.ok ? (sup.result as any)?.agents : [],
      objectives: coord.ok ? (coord.result as any)?.objectives : [], leases: leaseList.ok ? (leaseList.result as any)?.leases : [], claims: claims.ok ? (claims.result as any)?.claims : [],
      audit: audit.ok ? (audit.result as any)?.entries : [], inbox: { entries: [], pending: [], unanswered: 0 },
    };
    const out = fromSnapshot(machine, r);
    out.state.legacy = true;
    return out;
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

  // What changed, as a string: the state without the clock, the feed, or a lease's last-used time.
  function fingerprint(body: any): string {
    const { at: _at, events: _events, ...rest } = body;
    return JSON.stringify(rest, (k, v) => (k === "used" ? undefined : v));
  }

  // Looks only while a page is open. Fast while things change, slower each quiet look, fast again on any report or click.
  async function tick() {
    timer = null;
    if (bus.hasClients()) {
      try {
        const body = await refresh();
        const fp = fingerprint(body);
        if (fp !== lastFingerprint) {
          lastFingerprint = fp;
          unchanged = 0;
          bus.publish({ at: body.at, machine: null, source: "gateway", kind: "state", agent: null, text: "state changed" });
        } else unchanged++;
      } catch { unchanged++; }
    }
    schedule();
  }
  function schedule() {
    if (!running) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { void tick(); }, pollDelay(unchanged, base, ceiling));
  }
  function start() { running = true; schedule(); }
  function stop() { running = false; if (timer) clearTimeout(timer); timer = null; }
  let nudged: ReturnType<typeof setTimeout> | null = null;
  // A report arrived, a page connected or the owner clicked: look again soon, once, however many arrive together, and at the fast pace.
  function soon() {
    unchanged = 0;
    if (nudged) return;
    nudged = setTimeout(() => { nudged = null; if (timer) clearTimeout(timer); void tick(); }, 600);
  }

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
      case "prompt":
      case "steer": {
        if (!text.trim()) return { status: 400, body: fail("invalid_params", "text is empty") };
        res = await call(machine, action === "steer" ? "steer_agent" : "prompt_agent", { target, text, origin: CONSOLE });
        log(action, `${res.ok ? (action === "steer" ? "steered" : "prompted") : `refused (${res.error.code}):`} ${target}: ${clip(text)}`, !res.ok);
        break;
      }
      case "answer": {
        // Bound to the menu the page showed: a menu that moved on is stale_dialog, never a wrong answer.
        if (typeof body.dialog_id !== "string" || !/^[a-f0-9]{64}$/.test(body.dialog_id)) return { status: 400, body: fail("invalid_params", "dialog_id from the menu shown is required") };
        const params: Record<string, unknown> = { target, expected_dialog_id: body.dialog_id };
        if (Array.isArray(body.options)) params.options = body.options; else params.option = body.option;
        if (text.trim()) params.text = text;
        params.origin = CONSOLE;
        res = holdIfGated(pending, machine, "answer_agent", params, await call(machine, "answer_agent", params));
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
        res = await call(machine, "supervisor_nudge", { target, origin: CONSOLE });
        log("nudge", `${res.ok ? "nudged" : `nudge refused (${res.error.code}):`} ${target}`, !res.ok);
        break;
      case "close":
        res = await call(machine, "close", { kind: "pane", id: target, origin: CONSOLE });
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
      case "dismiss": {
        // One entry by id (a derived one needs its target too), or everything unanswered from one agent.
        const id = typeof body.id === "string" ? body.id : undefined;
        res = await call(machine, "inbox_resolve", { ...(id ? { id } : {}), target, origin: CONSOLE });
        log("dismiss", `${res.ok ? "dismissed" : `dismiss refused (${res.error.code}):`} ${id ? "a message from" : "messages from"} ${target}`, false);
        break;
      }
      case "focus":
        // Brings the agent's pane to the front in Herdr on that machine. It changes no steering, so it takes no lease.
        res = await call(machine, "focus", { kind: "agent", id: target });
        log("focus", `${res.ok ? "focused" : `focus refused (${res.error.code}):`} ${target}`, false);
        break;
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
