// Owner-selected policy for one claimed agent. A lease transfer, restart, unwatch
// or expiry removes its authority. This governs menus, never arbitrary MCP commands.
import { GatewayError, type GatewayConfig } from "./config.ts";
import type { StateStore, ApprovalPolicy } from "./state.ts";

const DAY = 24 * 3600_000;
const sessionOf = (agent: any): string | null => typeof agent?.agent_session?.value === "string" && agent.agent_session.value.trim() ? agent.agent_session.value : null;

export function validateApprovalRequest(cfg: GatewayConfig, agent: any, mode: unknown, ttl: unknown): number {
  if (!cfg.leases) throw new GatewayError("needs_lease", "approval policy requires this conversation's live lease");
  if (typeof mode !== "string" || !["ask", "permissions", "all_permissions", "default"].includes(mode)) throw new GatewayError("invalid_params", "mode must be ask, permissions, all_permissions or default");
  if (mode !== "ask" && mode !== "default" && !cfg.autoApprove) throw new GatewayError("capability_disabled", "automatic menu approval is disabled on this machine");
  if (mode === "all_permissions" && !sessionOf(agent)) throw new GatewayError("session_required", "all_permissions requires a stable agent session ID from Herdr; use manual approval for this agent until session detection is available");
  const seconds = ttl === undefined ? 86400 : ttl;
  if (typeof seconds !== "number" || !Number.isInteger(seconds) || seconds < 60 || seconds > 86400) throw new GatewayError("invalid_params", "ttl_seconds must be 60-86400");
  return seconds;
}

export function approvalPolicy(store: StateStore, paneId: string, agent: any, now = Date.now()): ApprovalPolicy | null {
  const watch = store.watched()[paneId];
  if (!watch) return null;
  for (const lease of Object.values(store.leases())) {
    if (!lease.panes.includes(paneId) || !(now - Date.parse(lease.used) < DAY)) continue;
    const policy = lease.approvals?.[paneId];
    if (!policy || !(Date.parse(policy.expires_at) > now) || policy.watch_since !== watch.since) continue;
    if (policy.kind !== (agent?.agent ?? null) || policy.session !== sessionOf(agent)) continue;
    return policy;
  }
  return null;
}

export function setApprovalPolicy(cfg: GatewayConfig, store: StateStore, agent: any, leaseId: unknown, mode: unknown, ttl: unknown): ApprovalPolicy | null {
  if (!cfg.leases || typeof leaseId !== "string") throw new GatewayError("needs_lease", "approval policy requires this conversation's live lease");
  const seconds = validateApprovalRequest(cfg, agent, mode, ttl);
  const now = Date.now();
  const paneId = agent.pane_id;
  const watch = store.watched()[paneId];
  return store.updateLeases((leases) => {
    const lease = leases[leaseId];
    if (!lease || !(now - Date.parse(lease.used) < DAY) || !lease.panes.includes(paneId)) throw new GatewayError("not_your_agent", "approval policy requires a live lease holding this agent");
    if (mode === "default") {
      if (lease.approvals) delete lease.approvals[paneId];
      return null;
    }
    if (!watch) throw new GatewayError("not_watched", "watch this agent before setting its approval policy");
    const policy: ApprovalPolicy = {
      mode: mode as ApprovalPolicy["mode"], expires_at: new Date(Math.min(now + seconds * 1000, Date.parse(lease.used) + DAY)).toISOString(),
      kind: agent.agent ?? null, session: sessionOf(agent), watch_since: watch.since,
    };
    (lease.approvals ??= {})[paneId] = policy;
    return policy;
  });
}
