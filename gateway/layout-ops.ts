// Herdr layout ops: workspaces, tabs, renaming, focus, moving and closing, and raw
// pane input. A tab or workspace is in scope when it holds at least one in-scope
// pane; closing one also needs every pane in it to be in scope.

import { AGENT_NAME_RE, GatewayError, KEY_RE, TARGET_RE, paneInScope } from "./config.ts";
import { gatedBy } from "./gated.ts";
import type { Gateway } from "./gateway.ts";
import { LABEL_RE, optBool, optEnum, optStr, optStrArray, str, type Op, type Params } from "./params.ts";
import type { CreatedKind } from "./state.ts";
import { agentView, paneView } from "./views.ts";

function need<T extends string>(params: Params, key: string, values: readonly T[]): T {
  const v = params[key];
  if (typeof v !== "string" || !values.includes(v as T)) throw new GatewayError("invalid_params", `${key} must be one of ${values.join(", ")}`);
  return v as T;
}

const CREATED: Record<"pane" | "tab" | "workspace", CreatedKind> = { pane: "panes", tab: "tabs", workspace: "workspaces" };

export function layoutOps(g: Gateway): Record<string, Op> {
  const inScope = (p: any) => paneInScope(p, g.cfg.allowedRoots);

  async function members(kind: "tab" | "workspace", id: string) {
    const all = (await g.herdr("pane.list", {})).panes ?? [];
    const panes = all.filter((p: any) => (kind === "tab" ? p.tab_id : p.workspace_id) === id);
    const visible = panes.filter(inScope);
    if (visible.length === 0) throw new GatewayError(`${kind}_not_found`, `${kind} ${id} not found`);
    return { visible, allInScope: visible.length === panes.length };
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

    // Brings something to the front in the Herdr window on the machine itself.
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
      return { focused: kind, id };
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
      if (moved?.pane_id && moved.pane_id !== pane.pane_id && g.state.created("panes").includes(pane.pane_id)) {
        g.state.forget("panes", pane.pane_id);
        g.state.remember("panes", moved.pane_id);
      }
      if (result.created_workspace?.workspace_id) g.state.remember("workspaces", result.created_workspace.workspace_id);
      if (result.created_tab?.tab_id) g.state.remember("tabs", result.created_tab.tab_id);
      return { pane: moved ? paneView(moved) : null, previous_pane_id: pane.pane_id };
    },

    async close(params) {
      const kind = need(params, "kind", ["pane", "tab", "workspace"] as const);
      const id = str(params, "id", TARGET_RE);
      const ours = g.state.created(CREATED[kind]).includes(id);
      if (!ours && !g.cfg.allowCloseAny) throw new GatewayError(`not_bridge_${kind}`, `${kind} ${id} was not created by this bridge`);
      if (kind === "pane") {
        await g.scopedPane(id);
        await g.herdr("pane.close", { pane_id: id });
      } else {
        const { allInScope } = await members(kind, id);
        if (!allInScope) throw new GatewayError("outside_scope", `${kind} ${id} also holds panes outside the allowed roots`);
        await g.herdr(`${kind}.close`, kind === "tab" ? { tab_id: id } : { workspace_id: id });
      }
      g.state.forget(CREATED[kind], id);
      return { closed: kind, id };
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
