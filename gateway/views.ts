// The subset of Herdr's pane and agent objects the gateway returns.

import type { WatchInfo, Watched } from "./state.ts";

export function agentView(a: any) {
  return {
    name: a.name ?? null,
    pane_id: a.pane_id,
    agent: a.agent,
    status: a.agent_status,
    cwd: a.foreground_cwd ?? a.cwd,
    title: a.terminal_title_stripped ?? null,
    label: a.label ?? null,
    workspace_id: a.workspace_id,
    tab_id: a.tab_id,
  };
}

export function paneView(p: any) {
  return {
    pane_id: p.pane_id,
    agent: p.agent ?? null,
    status: p.agent ? p.agent_status : null,
    cwd: p.foreground_cwd ?? p.cwd,
    title: p.terminal_title_stripped ?? null,
    label: p.label ?? null,
    workspace_id: p.workspace_id,
    tab_id: p.tab_id,
  };
}

// Whether the bridge reports on this agent: "turn" until the turn prompt_agent started
// is reported, "managed" for every turn until it exits. last_event is the last report.
export function watchView(w: Watched | undefined) {
  if (!w) return null;
  return { mode: w.managed ? "managed" : "turn", since: w.since, last_event: w.last_event ?? null };
}

export function watchInfo(a: any): WatchInfo {
  return { name: a.name ?? null, cwd: a.foreground_cwd ?? a.cwd ?? null, kind: a.agent ?? null };
}

export function textOf(res: any): string {
  const t = res?.text ?? res?.read?.text;
  return typeof t === "string" ? t : "";
}

export function lastLines(text: string, n: number): string {
  const lines = text.replace(/\s+$/, "").split("\n");
  return lines.slice(-n).join("\n");
}
