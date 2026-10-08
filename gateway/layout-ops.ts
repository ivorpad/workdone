// Herdr layout ops: workspaces, tabs, renaming, focus, moving and closing, and raw
// pane input. A tab or workspace is in scope when it holds at least one in-scope
// pane; closing one also needs every pane in it to be in scope.

import { basename } from "node:path";
import { AGENT_NAME_RE, GatewayError, KEY_RE, TARGET_RE, paneInScope } from "./config.ts";
import { sendOutcome } from "./coord-ops.ts";
import { gatedBy } from "./gated.ts";
import type { Gateway } from "./gateway.ts";
import { LEASE_CHECKED } from "./leases.ts";
import { LABEL_RE, optBool, optEnum, optStr, optStrArray, str, type Op, type Params } from "./params.ts";
import type { ClosedPane, ClosedRecord, CreatedKind } from "./state.ts";
import { agentView, paneView } from "./views.ts";

function need<T extends string>(params: Params, key: string, values: readonly T[]): T {
  const v = params[key];
  if (typeof v !== "string" || !values.includes(v as T)) throw new GatewayError("invalid_params", `${key} must be one of ${values.join(", ")}`);
  return v as T;
}

const CREATED: Record<"pane" | "tab" | "workspace", CreatedKind> = { pane: "panes", tab: "tabs", workspace: "workspaces" };

// Before anything that kills panes (close, remove_worktree). Finished, prunable or
// prune_close is not the owner saying close it. Only a pane spawned disposable goes
// without their go-ahead: the console's click, or confirm: true from a chat where they
// asked (or the approval card). Returns the disposable ones, to forget once closed.
// targets, from close, name each pane in full and go back with the refusal, so the
// approval card can bind its click to exactly these panes (expect).
export function ownerMayClose(g: Gateway, what: string, panes: any[], params: Params, targets?: Target[]): string[] {
  const disposable = new Set(g.state.created("disposable"));
  const kept = panes.filter((p) => !disposable.has(p.pane_id));
  if (kept.length && params.origin !== "console" && params.confirm !== true) {
    const names = kept.map((p) => {
      const t = targets?.find((x) => x.pane_id === p.pane_id);
      return t ? describe(t) : p.agent ? `${p.name ?? p.agent} ${p.pane_id}` : p.pane_id;
    }).join("; ");
    throw new GatewayError("needs_confirmation", `this closes ${what} (${names}), which is the owner's call: close only when they asked to close or clean it up; finished or prunable is not that`, {
      panes: kept.map((p) => p.pane_id),
      ...(targets ? { targets: targets.map(identity) } : {}),
    });
  }
  return panes.map((p) => p.pane_id).filter((id) => disposable.has(id));
}

// What a close kills, as Herdr reports it right now. Herdr's pane records carry the
// agent's kind, not its name: that comes from its agent list.
type Target = ReturnType<typeof target>;
function target(p: any, names: Map<string, string | null>) {
  return {
    pane_id: String(p.pane_id),
    terminal_id: typeof p.terminal_id === "string" ? p.terminal_id : null,
    agent: typeof p.agent === "string" ? p.agent : null,
    name: p.agent ? (names.get(p.pane_id) ?? p.name ?? null) : null,
    session: p.agent && typeof p.agent_session?.value === "string" ? p.agent_session.value : null,
    status: p.agent ? (p.agent_status ?? null) : null,
    cwd: p.foreground_cwd ?? p.cwd ?? null,
    title: p.terminal_title_stripped ?? null,
    label: p.label ?? null,
  };
}

// The fields expect compares, and that a close record keeps.
const IDENTITY = ["terminal_id", "agent", "name", "session"] as const;
const identity = (t: Target): ClosedPane => ({ pane_id: t.pane_id, terminal_id: t.terminal_id, agent: t.agent, name: t.name, session: t.session });

// claude "research" w1:p9, idle, in app
export function describe(t: Pick<Target, "pane_id" | "agent" | "name"> & Partial<Target>): string {
  const who = t.agent ? `${t.agent}${t.name ? ` "${t.name}"` : ""}` : "shell";
  return [`${who} ${t.pane_id}`, t.status, t.cwd ? `in ${basename(t.cwd)}` : null].filter(Boolean).join(", ");
}

type Expected = { pane_id: string } & Partial<Record<(typeof IDENTITY)[number], string | null>>;
function expected(params: Params): Expected[] | null {
  const v = params.expect;
  if (v === undefined || v === null) return null;
  const ok = Array.isArray(v) && v.length > 0 && v.length <= 50 && v.every((e) =>
    !!e && typeof e === "object" && typeof e.pane_id === "string" && TARGET_RE.test(e.pane_id)
    && IDENTITY.every((k) => !Object.hasOwn(e, k) || e[k] === null || typeof e[k] === "string"));
  if (!ok) throw new GatewayError("invalid_params", `expect must be 1-50 objects, each with pane_id and any of ${IDENTITY.join(", ")}`);
  return v as Expected[];
}

// Why the live target is not what the caller said it closes, or null when it is. Panes
// expected but already gone are fine: closing the rest is within what was approved.
function mismatch(kind: string, id: string, exp: Expected[], live: Target[]): string | null {
  if (kind === "pane" && !exp.some((e) => e.pane_id === id)) {
    return `expect names ${exp.map((e) => e.pane_id).join(", ")}, but this closes pane ${id} (${describe(live[0]!)})`;
  }
  for (const t of live) {
    const e = exp.find((x) => x.pane_id === t.pane_id);
    if (!e) return `${kind} ${id} also holds ${describe(t)}, which expect does not list`;
    for (const k of IDENTITY) {
      if (Object.hasOwn(e, k) && (e[k] ?? null) !== t[k]) return `${t.pane_id} is ${describe(t)}: its ${k} is ${t[k] ?? "none"}, expected ${e[k] ?? "none"}`;
    }
  }
  return null;
}

// How long close waits for Herdr to show the target gone. Tests set ms to 0.
export const closeTiming = { tries: 6, ms: 250 };

export function layoutOps(g: Gateway): Record<string, Op> {
  const inScope = (p: any) => paneInScope(p, g.cfg.allowedRoots);

  async function members(kind: "tab" | "workspace", id: string) {
    const all = (await g.herdr("pane.list", {})).panes ?? [];
    const panes = all.filter((p: any) => (kind === "tab" ? p.tab_id : p.workspace_id) === id);
    const visible = panes.filter(inScope);
    if (visible.length === 0) throw new GatewayError(`${kind}_not_found`, `${kind} ${id} not found`);
    return { visible, allInScope: visible.length === panes.length };
  }

  // Closing a tab or workspace also kills its panes outside the allowed roots: refused.
  async function inScopeMembers(kind: "tab" | "workspace", id: string) {
    const { visible, allInScope } = await members(kind, id);
    if (!allInScope) throw new GatewayError("outside_scope", `${kind} ${id} also holds panes outside the allowed roots`);
    return visible;
  }

  async function targetsOf(panes: any[]): Promise<Target[]> {
    const names = new Map<string, string | null>();
    if (panes.some((p) => p.agent)) {
      const agents = (await g.herdr("agent.list", {}).catch(() => null))?.agents ?? [];
      for (const a of agents) if (typeof a?.pane_id === "string") names.set(a.pane_id, a.name ?? null);
    }
    return panes.map((p) => target(p, names));
  }

  // An agent mid-turn is not closed on an earlier go-ahead: the owner said close it when
  // it was idle, or never saw it working. The console's owner sees its status.
  function refuseWorking(targets: Target[], allowed: boolean) {
    const working = targets.filter((t) => t.status === "working");
    if (!working.length || allowed) return;
    throw new GatewayError("agent_working", `not closed: ${working.map(describe).join("; ")} is working. Closing kills its turn: tell the owner, and close with even_if_working: true only if they want it stopped mid-turn`, { panes: working.map((t) => t.pane_id), targets: targets.map(identity) });
  }

  // The target as Herdr has it now, read raw: a pane that left the roots is not "gone".
  async function look(kind: "pane" | "tab" | "workspace", id: string): Promise<{ gone: boolean; outside: boolean; panes: any[] }> {
    if (kind === "pane") {
      const res = await g.herdr("pane.get", { pane_id: id }).catch((err) => {
        if ((err as GatewayError)?.code === "pane_not_found") return null;
        throw err;
      });
      if (!res) return { gone: true, outside: false, panes: [] };
      const pane = res.pane ?? res;
      return { gone: false, outside: !inScope(pane), panes: [pane] };
    }
    const all = (await g.herdr("pane.list", {})).panes ?? [];
    const panes = all.filter((p: any) => (kind === "tab" ? p.tab_id : p.workspace_id) === id);
    return { gone: panes.length === 0, outside: !panes.every(inScope), panes };
  }

  // What differs between the panes checked and the panes there now: a pane that joined,
  // or one whose terminal, agent or agent session is another.
  function drift(before: Target[], now: any[]): string | null {
    for (const p of now) {
      const t = before.find((x) => x.pane_id === p.pane_id);
      const live = target(p, new Map());
      if (!t) return `${describe(live)} joined it`;
      for (const k of ["terminal_id", "agent", "session"] as const) if (t[k] !== live[k]) return `${p.pane_id}'s ${k} changed from ${t[k] ?? "none"} to ${live[k] ?? "none"}`;
    }
    return null;
  }

  // The panes of the target Herdr still shows after a close, read up to tries times
  // until none are left. null when the last read failed: nobody knows.
  async function remaining(kind: "pane" | "tab" | "workspace", id: string, paneIds: string[], tries: number): Promise<string[] | null> {
    let left: string[] | null = null;
    for (let i = 0; i < tries; i++) {
      if (i) await Bun.sleep(closeTiming.ms);
      try {
        if (kind === "pane") {
          const there = await g.herdr("pane.get", { pane_id: id }).then(() => true, (err) => {
            if ((err as GatewayError)?.code === "pane_not_found") return false;
            throw err;
          });
          left = there ? [id] : [];
        } else {
          const all = (await g.herdr("pane.list", {})).panes ?? [];
          left = all.filter((p: any) => (kind === "tab" ? p.tab_id : p.workspace_id) === id || paneIds.includes(p.pane_id)).map((p: any) => p.pane_id);
        }
      } catch {
        left = null;
      }
      if (left && left.length === 0) return left;
    }
    return left;
  }

  // A repeat of a close that already happened. A record still "closing" (its first call
  // could not read Herdr back) is settled now that Herdr shows the target gone.
  function alreadyClosed(kind: "pane" | "tab" | "workspace", id: string, rec: ClosedRecord, note?: string) {
    if (rec.status === "closing" && rec.kind === kind && rec.id === id) {
      g.state.recordClose({ ...rec, status: "closed" });
      g.state.forget(CREATED[kind], id);
      const disposable = new Set(g.state.created("disposable"));
      for (const p of rec.panes) if (disposable.has(p.pane_id)) g.state.forget("disposable", p.pane_id);
    }
    // A pane its tab's or workspace's close took: only that pane, not the others it took.
    const panes = kind === "pane" ? rec.panes.filter((p) => p.pane_id === id) : rec.panes;
    return {
      closed: kind, id, outcome: "already_closed", verified: true, closed_at: rec.at, closed_by: rec.by, panes,
      note: note ?? `${kind} ${id} was already closed${rec.by ? ` (by ${rec.by})` : ""}; nothing else was closed`,
    };
  }

  function rememberNew(res: any) {
    if (res?.workspace?.workspace_id) g.state.remember("workspaces", res.workspace.workspace_id);
    if (res?.tab?.tab_id) g.state.remember("tabs", res.tab.tab_id);
    if (res?.root_pane?.pane_id) g.state.remember("panes", res.root_pane.pane_id);
  }

  function created(res: any) {
    return {
      workspace: res?.workspace ? { workspace_id: res.workspace.workspace_id, label: res.workspace.label ?? null } : undefined,
      tab: res?.tab ? { tab_id: res.tab.tab_id, label: res.tab.label ?? null } : undefined,
      pane: res?.root_pane ? paneView(res.root_pane) : undefined,
    };
  }

  const ops: Record<string, Op> = {
    async list_workspaces() {
      const [ws, tabs, panes] = await Promise.all([g.herdr("workspace.list", {}), g.herdr("tab.list", {}), g.herdr("pane.list", {})]);
      const visible = (panes.panes ?? []).filter(inScope);
      const workspaces = (ws.workspaces ?? [])
        .map((w: any) => ({
          workspace_id: w.workspace_id,
          label: w.label ?? null,
          focused: w.focused ?? false,
          agent_status: w.agent_status ?? null,
          tabs: (tabs.tabs ?? [])
            .filter((t: any) => t.workspace_id === w.workspace_id)
            .map((t: any) => ({
              tab_id: t.tab_id,
              label: t.label ?? null,
              focused: t.focused ?? false,
              panes: visible.filter((p: any) => p.tab_id === t.tab_id).map(paneView),
            }))
            .filter((t: any) => t.panes.length > 0),
        }))
        .filter((w: any) => w.tabs.length > 0);
      return { workspaces };
    },

    async create_workspace(params) {
      const res = await g.herdr("workspace.create", {
        cwd: g.cwdFrom(params),
        label: optStr(params, "label", LABEL_RE) ?? null,
        focus: optBool(params, "focus", false),
      });
      rememberNew(res);
      return created(res);
    },

    async create_tab(params) {
      const workspaceId = str(params, "workspace_id", TARGET_RE);
      const { visible } = await members("workspace", workspaceId);
      const res = await g.herdr("tab.create", {
        workspace_id: workspaceId,
        cwd: g.cwdFrom(params, visible[0].foreground_cwd ?? visible[0].cwd),
        label: optStr(params, "label", LABEL_RE) ?? null,
        focus: optBool(params, "focus", false),
      });
      rememberNew(res);
      return created(res);
    },

    async rename(params) {
      const kind = need(params, "kind", ["pane", "tab", "workspace", "agent"] as const);
      const id = str(params, "id", TARGET_RE);
      const label = optStr(params, "label", kind === "agent" ? AGENT_NAME_RE : LABEL_RE);
      if (kind === "pane") {
        await g.scopedPane(id);
        const res = await g.herdr("pane.rename", label ? { pane_id: id, label } : { pane_id: id });
        return { pane: paneView(res.pane ?? { pane_id: id, label }) };
      }
      if (kind === "agent") {
        const agent = await g.scopedAgent(id);
        const res = await g.herdr("agent.rename", label ? { target: agent.pane_id, name: label } : { target: agent.pane_id });
        return { agent: agentView(res.agent ?? { ...agent, name: label ?? null }) };
      }
      if (!label) throw new GatewayError("invalid_params", `a ${kind} label cannot be empty`);
      await members(kind, id);
      if (kind === "tab") await g.herdr("tab.rename", { tab_id: id, label });
      else await g.herdr("workspace.rename", { workspace_id: id, label });
      return { renamed: kind, id, label };
    },

    // Brings something to the front in the Herdr window on the machine itself, and (raise,
    // on unless false) the terminal app that hosts that window. A failed raise is reported,
    // not an error: the pane is focused either way.
    async focus(params) {
      const kind = need(params, "kind", ["pane", "tab", "workspace", "agent"] as const);
      const id = str(params, "id", TARGET_RE);
      if (kind === "pane") {
        await g.scopedPane(id);
        await g.herdr("pane.focus", { pane_id: id });
      } else if (kind === "agent") {
        const agent = await g.scopedAgent(id);
        await g.herdr("agent.focus", { target: agent.pane_id });
      } else {
        await members(kind, id);
        await g.herdr(`${kind}.focus`, kind === "tab" ? { tab_id: id } : { workspace_id: id });
      }
      const raised = optBool(params, "raise", true) ? await g.raiser(g.cfg).catch((err) => ({ raised: false, reason: String(err?.message ?? err).slice(0, 200) })) : null;
      return { focused: kind, id, ...(raised ? { terminal: raised } : {}) };
    },

    async move_pane(params) {
      const pane = await g.scopedPane(str(params, "pane_id", TARGET_RE));
      const to = need(params, "to", ["tab", "new_tab", "new_workspace"] as const);
      const label = optStr(params, "label", LABEL_RE) ?? null;
      let destination: Record<string, unknown>;
      if (to === "tab") {
        const tabId = str(params, "tab_id", TARGET_RE);
        await members("tab", tabId);
        destination = { type: "tab", tab_id: tabId, split: optEnum(params, "direction", ["right", "down"] as const, "right") };
      } else if (to === "new_tab") {
        const workspaceId = optStr(params, "workspace_id", TARGET_RE);
        if (workspaceId) await members("workspace", workspaceId);
        destination = { type: "new_tab", workspace_id: workspaceId ?? null, label };
      } else {
        destination = { type: "new_workspace", label };
      }
      const res = await g.herdr("pane.move", { pane_id: pane.pane_id, destination, focus: false });
      const result = res.move_result ?? res;
      const moved = result.pane;
      // A pane that changes workspace gets a new ID; keep the bridge's record pointing at it.
      if (moved?.pane_id && moved.pane_id !== pane.pane_id) {
        for (const k of ["panes", "disposable"] as const) {
          if (!g.state.created(k).includes(pane.pane_id)) continue;
          g.state.forget(k, pane.pane_id);
          g.state.remember(k, moved.pane_id);
        }
      }
      if (result.created_workspace?.workspace_id) g.state.remember("workspaces", result.created_workspace.workspace_id);
      if (result.created_tab?.tab_id) g.state.remember("tabs", result.created_tab.tab_id);
      return { pane: moved ? paneView(moved) : null, previous_pane_id: pane.pane_id };
    },

    // Closes exactly what the caller saw: the panes read first are read again just before
    // the Herdr call and must still be the same terminals and agents, none of them working
    // (unless even_if_working, or the owner's click in the console). The result comes from
    // Herdr afterwards, not from the call: closed once Herdr no longer shows the target,
    // not_closed while it does, close_uncertain when it can't be read back. A repeat for a
    // target WorkDone already closed answers already_closed. Open work, leases and
    // results owed stay as they were: closing a pane settles nothing (owed_work).
    async close(params) {
      const kind = need(params, "kind", ["pane", "tab", "workspace"] as const);
      const id = str(params, "id", TARGET_RE);
      const exp = expected(params);
      const owner = params.origin === "console";
      const evenIfWorking = optBool(params, "even_if_working", false);
      let panes: any[];
      try {
        panes = kind === "pane" ? [await g.scopedPane(id)] : await inScopeMembers(kind, id);
      } catch (err) {
        const rec = (err as GatewayError)?.code === `${kind}_not_found` ? g.state.closedRecord(kind, id) : null;
        if (rec) return alreadyClosed(kind, id, rec);
        throw err;
      }
      const ours = g.state.created(CREATED[kind]).includes(id);
      if (!ours && !g.cfg.allowCloseAny) throw new GatewayError(`not_bridge_${kind}`, `${kind} ${id} was not created by this bridge`);
      const targets = await targetsOf(panes);
      const wrong = exp && mismatch(kind, id, exp, targets);
      if (wrong) throw new GatewayError("target_mismatch", `not closed: ${wrong}. Read list_panes again and close the pane the owner meant`, { targets: targets.map(identity) });
      refuseWorking(targets, owner || evenIfWorking);
      const disposable = ownerMayClose(g, `${kind} ${id}`, panes, params, targets);

      // Read again right before closing: what was checked must be what dies.
      const now = await look(kind, id);
      if (now.gone) {
        const gone: ClosedRecord = { kind, id, at: new Date().toISOString(), status: "closing", by: null, panes: targets.map(identity) };
        g.state.recordClose(gone);
        return alreadyClosed(kind, id, gone, `${kind} ${id} closed before this call sent its close; nothing else was closed`);
      }
      const changed = now.outside ? `${kind} ${id} now holds panes outside the allowed roots` : drift(targets, now.panes);
      if (changed) throw new GatewayError("target_changed", `not closed: ${changed} since this call read it. Read it again and ask the owner if it is still the one to close`, { targets: targets.map(identity) });
      refuseWorking(now.panes.map((p) => ({ ...target(p, new Map()), name: targets.find((t) => t.pane_id === p.pane_id)?.name ?? null })), owner || evenIfWorking);
      if ((params as any)[LEASE_CHECKED]) for (const p of now.panes) g.leases.closeGuard(params.lease, p);

      const by = owner ? "console" : typeof params.lease === "string" ? `lease …${params.lease.slice(-4)}` : null;
      const rec: ClosedRecord = { kind, id, at: new Date().toISOString(), status: "closing", by, panes: targets.map(identity) };
      g.state.recordClose(rec);
      let sent: unknown = null;
      try {
        if (kind === "pane") await g.herdr("pane.close", { pane_id: id });
        else await g.herdr(`${kind}.close`, kind === "tab" ? { tab_id: id } : { workspace_id: id });
      } catch (err) {
        sent = err;
      }
      const left = await remaining(kind, id, targets.map((t) => t.pane_id), sent && sendOutcome(sent) === "refused" ? 1 : closeTiming.tries);
      const answered = sent ? `; Herdr answered ${(sent as GatewayError).code ?? "error"}: ${String((sent as Error).message ?? sent).slice(0, 200)}` : "";
      if (left === null) {
        // The record stays "closing": a repeat that finds it gone answers already_closed.
        throw new GatewayError("close_uncertain", `the close of ${kind} ${id} was sent, but Herdr could not be read back${answered}. Whether it closed is unknown: do not report it closed. Read list_panes once, or call close again (a target that is gone answers already_closed)`, { targets: targets.map(identity) });
      }
      if (left.length) {
        g.state.dropClose(kind, id);
        throw new GatewayError("not_closed", `${kind} ${id} is still open: Herdr shows ${left.join(", ")} after the close${answered}. Tell the owner it did not close`, { still_open: left, targets: targets.map(identity) });
      }
      g.state.recordClose({ ...rec, status: "closed" });
      g.state.forget(CREATED[kind], id);
      for (const p of disposable) g.state.forget("disposable", p);
      return { closed: kind, id, outcome: "closed", verified: true, panes: targets };
    },

    // Type text and keys into any in-scope pane, agent or shell. Text followed by
    // enter runs a command, so this sits behind the raw pane capability.
    async send_pane_input(params) {
      if (!g.cfg.allowRawPaneRun) throw new GatewayError("capability_disabled", "raw pane input is disabled in the gateway config");
      const pane = await g.scopedPane(str(params, "pane_id", TARGET_RE));
      const text = optStr(params, "text");
      if (text && text.length > g.cfg.maxPromptChars) throw new GatewayError("invalid_params", `text exceeds ${g.cfg.maxPromptChars} characters`);
      const keys = optStrArray(params, "keys", 20, KEY_RE) ?? [];
      if (!text && keys.length === 0) throw new GatewayError("invalid_params", "pass text, keys or both");
      const gated = text && keys.includes("enter") ? gatedBy(text) : null;
      if (gated && params.confirm !== true) {
        throw new GatewayError("needs_confirmation", `this input runs a ${gated}, which is the owner's call: ask them, then call again with confirm: true`);
      }
      await g.herdr("pane.send_input", { pane_id: pane.pane_id, ...(text ? { text } : {}), ...(keys.length ? { keys } : {}) });
      return { sent: true, pane_id: pane.pane_id };
    },
  };
  return ops;
}
