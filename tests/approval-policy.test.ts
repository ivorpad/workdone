import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { approvalPolicy } from "../gateway/approval-policy.ts";
import { approveMenus, timing } from "../gateway/answer-ops.ts";
import { loadConfig, type HerdrCall } from "../gateway/config.ts";
import { Gateway } from "../gateway/gateway.ts";

const PANE = "w1:p1";
const DAY = 24 * 3600_000;
const directories: string[] = [];
const screen = (name: string) => readFileSync(join(import.meta.dir, "fixtures/screens", `${name}.txt`), "utf8");
const permission = (command = "bun test") => screen("claude-perm")
  .replaceAll("curl -sI https://example.com | head -1", command)
  .replaceAll("curl -sI https://example.com", command);

timing.key = timing.text = timing.settle = 0;
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function setup(extra: Record<string, unknown> = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), "herdr-approval-"));
  directories.push(stateDir);
  const cfg = loadConfig({ allowedRoots: ["/srv/allowed"], stateDir, ...extra });
  const agent: any = {
    pane_id: PANE, workspace_id: "w1", tab_id: "w1:t1", agent: "claude", name: "worker",
    cwd: "/srv/allowed/app", agent_status: "idle", agent_session: { value: "session-1" },
  };
  const pressed: string[] = [];
  const calls: string[] = [];
  let shown = "ready";
  let next = "ready";
  let nextStatus = "idle";
  let onRead = () => {};
  const snapshot = () => ({ ...agent, ...(agent.agent_session ? { agent_session: { ...agent.agent_session } } : {}) });
  const herdr: HerdrCall = async (method, params: any) => {
    calls.push(method);
    if (method === "agent.get") return { agent: snapshot() };
    if (method === "pane.get") return { pane: snapshot() };
    if (method === "agent.list") return { agents: [snapshot()] };
    if (method === "agent.read") { onRead(); return { text: shown }; }
    if (method === "agent.send_keys") {
      pressed.push(...params.keys);
      shown = next;
      agent.agent_status = nextStatus;
    }
    if (method === "pane.send_input") pressed.push(`text:${params.text}`);
    return {};
  };
  const gw = new Gateway(cfg, herdr);
  return {
    cfg, gw, herdr, agent, pressed, calls, stateDir,
    setScreen: (text: string, after = "ready", status = "idle") => { shown = text; next = after; nextStatus = status; },
    setOnRead: (fn: () => void) => { onRead = fn; },
    async claim(label = "owner") {
      const result: any = await gw.request("claim_agents", { label, targets: [PANE] });
      return result.lease as string;
    },
    async set(lease: string, mode: string, ttl_seconds?: number) {
      return await gw.request("set_agent_approval", { target: PANE, lease, mode, ...(ttl_seconds === undefined ? {} : { ttl_seconds }) }) as any;
    },
  };
}

describe("owner-selected approval policy", () => {
  test("ask, permissions and all_permissions persist on the owner's lease; default removes the override", async () => {
    const t = setup();
    const lease = await t.claim();
    for (const mode of ["ask", "permissions", "all_permissions"]) {
      const result = await t.set(lease, mode, 300);
      expect(result).toMatchObject({ pane_id: PANE, policy: { mode, kind: "claude", session: "session-1" }, auto_approved: [] });
      const persisted = t.gw.state.leases()[lease]!.approvals![PANE]!;
      expect(persisted).toEqual(result.policy);
      expect(persisted.watch_since).toBe(t.gw.state.watched()[PANE]!.since);
      expect(approvalPolicy(t.gw.state, PANE, t.agent)).toEqual(persisted);
    }
    expect(await t.set(lease, "default")).toMatchObject({ policy: null, auto_approved: [] });
    expect(t.gw.state.leases()[lease]!.approvals?.[PANE]).toBeUndefined();
    expect(approvalPolicy(t.gw.state, PANE, t.agent)).toBeNull();
    expect(t.pressed).toEqual([]);
  });

  test("a new Gateway instance loads the policy and uses it without another ChatGPT approval", async () => {
    const t = setup();
    const lease = await t.claim();
    const original = (await t.set(lease, "all_permissions", 300)).policy;
    const restarted = new Gateway(t.cfg, t.herdr);
    expect(approvalPolicy(restarted.state, PANE, t.agent)).toEqual(original);
    t.setScreen(permission("git push origin main"));
    const result: any = await restarted.handle("watch_poll", {});
    expect(t.pressed).toEqual(["1"]);
    expect(result.reports ?? []).toEqual([]);
    const audit = readFileSync(join(t.stateDir, "audit.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(audit.at(-1)).toMatchObject({ op: "auto_approve", via: "watch_poll", policy: "all_permissions", ok: true });
  });

  test("setting a policy requires the current lease holder, including through internal handle", async () => {
    const t = setup();
    const owner = await t.claim();
    const outsider: any = await t.gw.request("claim_agents", { label: "other thread", targets: [] });
    await expect(t.gw.request("set_agent_approval", { target: PANE, mode: "all_permissions" })).rejects.toMatchObject({ code: "needs_lease" });
    await expect(t.set(outsider.lease, "all_permissions")).rejects.toMatchObject({ code: "not_your_agent" });
    await expect(t.gw.handle("set_agent_approval", { target: PANE, lease: outsider.lease, mode: "all_permissions" })).rejects.toMatchObject({ code: "not_your_agent" });
    expect(t.gw.state.watched()).toEqual({});
    expect(t.gw.state.leases()[owner]!.approvals).toBeUndefined();
    expect(t.pressed).toEqual([]);
  });

  test("release deletes the authority, and reclaim does not revive it", async () => {
    const t = setup();
    const lease = await t.claim();
    await t.set(lease, "all_permissions");
    expect(await t.gw.request("release_agents", { lease, targets: [PANE] })).toMatchObject({ released: [PANE], panes: [] });
    expect(t.gw.state.leases()[lease]!.approvals?.[PANE]).toBeUndefined();
    expect(approvalPolicy(t.gw.state, PANE, t.agent)).toBeNull();
    await t.gw.request("claim_agents", { lease, targets: [PANE] });
    expect(approvalPolicy(t.gw.state, PANE, t.agent)).toBeNull();
    t.setScreen(permission("git push origin main"));
    expect((await approveMenus(t.cfg, t.herdr, PANE, "watch_poll", { waitMs: 0 })).approved).toEqual([]);
    expect(t.pressed).toEqual([]);
    await t.gw.request("release_agents", { lease });
    expect(t.gw.state.leases()[lease]).toBeUndefined();
  });

  test("takeover clears the former holder's policy and requires a new explicit choice", async () => {
    const t = setup();
    const original = await t.claim();
    await t.set(original, "all_permissions");
    const other: any = await t.gw.request("claim_agents", { label: "new owner", targets: [] });
    expect(await t.gw.request("claim_agents", { lease: other.lease, targets: [PANE], take_over: true })).toMatchObject({ taken_over: [PANE] });
    expect(t.gw.state.leases()[original]!.approvals?.[PANE]).toBeUndefined();
    expect(t.gw.state.leases()[other.lease]!.approvals?.[PANE]).toBeUndefined();
    expect(approvalPolicy(t.gw.state, PANE, t.agent)).toBeNull();
    await expect(t.set(original, "all_permissions")).rejects.toMatchObject({ code: "not_your_agent" });
    await t.set(other.lease, "all_permissions");
    expect(approvalPolicy(t.gw.state, PANE, t.agent)?.mode).toBe("all_permissions");
  });

  test("session and agent-kind replacement invalidate the saved authority", async () => {
    const t = setup();
    const lease = await t.claim();
    await t.set(lease, "all_permissions");
    t.agent.agent_session.value = "session-2";
    expect(approvalPolicy(t.gw.state, PANE, t.agent)).toBeNull();
    t.setScreen(permission("rm -rf /tmp/obsolete"));
    expect((await approveMenus(t.cfg, t.herdr, PANE, "watch_poll", { waitMs: 0 })).approved).toEqual([]);
    t.agent.agent_session.value = "session-1";
    t.agent.agent = "codex";
    expect(approvalPolicy(t.gw.state, PANE, t.agent)).toBeNull();
    expect(t.pressed).toEqual([]);
  });

  test("unwatch and a new watch invalidate the prior policy", async () => {
    const t = setup();
    const lease = await t.claim();
    await t.set(lease, "all_permissions");
    const original = t.gw.state.watched()[PANE]!.since;
    await t.gw.request("watch_agent", { target: PANE, lease, stop: true });
    expect(t.gw.state.leases()[lease]!.approvals?.[PANE]).toBeUndefined();
    expect(approvalPolicy(t.gw.state, PANE, t.agent)).toBeNull();
    await t.gw.request("watch_agent", { target: PANE, lease });
    // Reused clock timestamps cannot revive the deleted approval authority.
    t.gw.state.updateWatched((watched) => { watched[PANE]!.since = original; });
    expect(approvalPolicy(t.gw.state, PANE, t.agent)).toBeNull();
  });

  test("expiry is exclusive, refresh replaces it, and authority cannot outlive the issuing lease", async () => {
    const t = setup();
    const lease = await t.claim();
    const policy = (await t.set(lease, "all_permissions", 60)).policy;
    const expires = Date.parse(policy.expires_at);
    expect(approvalPolicy(t.gw.state, PANE, t.agent, expires - 1)?.mode).toBe("all_permissions");
    expect(approvalPolicy(t.gw.state, PANE, t.agent, expires)).toBeNull();
    const refreshed = (await t.set(lease, "all_permissions", 120)).policy;
    expect(Date.parse(refreshed.expires_at)).toBeGreaterThan(expires);
    expect(approvalPolicy(t.gw.state, PANE, t.agent, expires)).toEqual(refreshed);
    const leaseEnd = Date.now() + 90_000;
    t.gw.state.updateLeases((leases) => { leases[lease]!.used = new Date(leaseEnd - DAY).toISOString(); });
    const bounded = (await t.set(lease, "all_permissions", 3600)).policy;
    expect(Date.parse(bounded.expires_at)).toBe(leaseEnd);
    expect(approvalPolicy(t.gw.state, PANE, t.agent, leaseEnd)).toBeNull();
    t.gw.state.updateLeases((leases) => { leases[lease]!.used = new Date(Date.now() - DAY - 1).toISOString(); });
    expect(approvalPolicy(t.gw.state, PANE, t.agent)).toBeNull();
    await expect(t.set(lease, "all_permissions")).rejects.toMatchObject({ code: "lease_unknown" });
  });

  test("invalid mode and TTL leave the watch, policy and terminal untouched", async () => {
    const t = setup();
    const lease = await t.claim();
    t.setScreen(permission());
    for (const params of [
      { mode: "always" }, { mode: { toString: () => "ask" } },
      { mode: "permissions", ttl_seconds: 59 }, { mode: "permissions", ttl_seconds: 86401 },
      { mode: "permissions", ttl_seconds: 60.5 }, { mode: "permissions", ttl_seconds: "60" },
    ]) {
      await expect(t.gw.request("set_agent_approval", { target: PANE, lease, ...params })).rejects.toMatchObject({ code: "invalid_params" });
      expect(t.gw.state.watched()).toEqual({});
      expect(t.gw.state.leases()[lease]!.approvals).toBeUndefined();
    }
    expect(t.pressed).toEqual([]);
  });

  test("all_permissions requires a nonempty stable session before creating a watch", async () => {
    const t = setup();
    const lease = await t.claim();
    for (const session of [undefined, { value: "" }, { value: "   " }]) {
      t.agent.agent_session = session;
      await expect(t.set(lease, "all_permissions")).rejects.toMatchObject({ code: "session_required" });
      expect(t.gw.state.watched()).toEqual({});
      expect(t.gw.state.leases()[lease]!.approvals).toBeUndefined();
    }
    expect((await t.set(lease, "ask")).policy.session).toBeNull();
  });

  test("machine switches cannot be overridden by a policy", async () => {
    const t = setup({ autoApprove: false });
    const lease = await t.claim();
    for (const mode of ["permissions", "all_permissions"]) {
      await expect(t.set(lease, mode)).rejects.toMatchObject({ code: "capability_disabled" });
      expect(t.gw.state.watched()).toEqual({});
    }
    await t.set(lease, "ask");
    t.setScreen(permission());
    expect(await approveMenus(t.cfg, t.herdr, PANE, "watch_poll", { waitMs: 0 })).toEqual({ approved: [], status: null });
    expect(t.pressed).toEqual([]);
    const unleased = setup({ leases: false });
    await expect(unleased.gw.request("set_agent_approval", { target: PANE, mode: "ask", lease: "L-abcdef" })).rejects.toMatchObject({ code: "needs_lease" });
    expect(unleased.gw.state.watched()).toEqual({});
  });
});

describe("policy-driven delivery and manual answers", () => {
  test("all_permissions advances gated permission prompts while ChatGPT is idle", async () => {
    for (const command of ["git push origin main", "rm -rf /tmp/obsolete"]) {
      const t = setup();
      const lease = await t.claim();
      await t.set(lease, "all_permissions");
      // No ChatGPT answer_agent call after the prompt appears. Herdr still says idle.
      t.setScreen(permission(command));
      const result: any = await t.gw.handle("watch_poll", {});
      expect(t.pressed).toEqual(["1"]);
      expect(result.reports ?? []).toEqual([]);
      expect(t.gw.state.watched()[PANE]!.last_event).toMatchObject({ type: "approved" });
    }
  });

  test("permissions preserves owner confirmation for gated operations", async () => {
    const t = setup();
    const lease = await t.claim();
    await t.set(lease, "permissions");
    t.setScreen(permission("git push origin main"));
    expect((await approveMenus(t.cfg, t.herdr, PANE, "watch_poll", { waitMs: 0 })).approved).toEqual([]);
    await expect(t.gw.request("answer_agent", { target: PANE, lease, option: 1 })).rejects.toMatchObject({ code: "needs_confirmation" });
    expect(t.pressed).toEqual([]);
    expect(await t.gw.request("answer_agent", { target: PANE, lease, option: 1, confirm: true })).toMatchObject({ answered: { options: [1] } });
    expect(t.pressed).toEqual(["1"]);
  });

  test("all_permissions never answers ordinary questions or product Yes/No decisions", async () => {
    for (const question of [screen("claude-ask"), "Do you want to create another example for this documentation?\n❯ 1. Yes\n  2. No\nEnter to select · Esc to cancel"]) {
      const t = setup();
      const lease = await t.claim();
      await t.set(lease, "all_permissions");
      t.setScreen(question);
      const result: any = await t.gw.handle("watch_poll", {});
      expect(t.pressed).toEqual([]);
      expect(result.reports).toHaveLength(1);
      expect(result.reports[0]).toMatchObject({ type: "blocked", choices: { kind: "question", go_ahead: null } });
    }
  });

  test("an ask override stops automatic approvals and reports the current menu", async () => {
    const t = setup();
    const lease = await t.claim();
    await t.set(lease, "all_permissions");
    t.setScreen(permission());
    expect(await t.set(lease, "ask")).toMatchObject({ policy: { mode: "ask" }, auto_approved: [] });
    expect(t.pressed).toEqual([]);
    const result: any = await t.gw.handle("watch_poll", {});
    expect(result.reports).toHaveLength(1);
    expect(result.reports[0]).toMatchObject({ type: "blocked", choices: { kind: "permission", go_ahead: 1 } });
    expect(t.pressed).toEqual([]);
    expect(await t.gw.request("answer_agent", { target: PANE, lease, option: 1, expected_dialog_id: result.reports[0].choices.dialog_id })).toMatchObject({ answered: { options: [1] } });
    expect(t.pressed).toEqual(["1"]);
  });

  test("a stale manual answer is rejected before terminal keys despite all_permissions", async () => {
    const t = setup();
    const lease = await t.claim();
    await t.set(lease, "all_permissions");
    t.setScreen(permission("git push origin main"));
    const first: any = await t.gw.request("get_agent", { target: PANE });
    expect(first.choices.dialog_id).toMatch(/^[a-f0-9]{64}$/);
    t.setScreen(permission("git push origin release"));
    await expect(t.gw.request("answer_agent", { target: PANE, lease, option: 1, expected_dialog_id: first.choices.dialog_id })).rejects.toMatchObject({ code: "stale_dialog" });
    expect(t.pressed).toEqual([]);
    const current: any = await t.gw.request("get_agent", { target: PANE });
    expect(current.choices.dialog_id).not.toBe(first.choices.dialog_id);
    expect(await t.gw.request("answer_agent", { target: PANE, lease, option: 1, expected_dialog_id: current.choices.dialog_id })).toMatchObject({ answered: { options: [1] } });
    expect(t.pressed).toEqual(["1"]);
  });

  test("a session replacement during menu read cannot borrow the old all_permissions authority", async () => {
    const t = setup();
    const lease = await t.claim();
    await t.set(lease, "all_permissions");
    t.setScreen(permission("git push origin main"));
    t.setOnRead(() => { t.agent.agent_session.value = "replacement-session"; });
    await expect(t.gw.request("answer_agent", { target: PANE, lease, option: 1 })).rejects.toMatchObject({ code: "needs_confirmation" });
    expect(t.pressed).toEqual([]);
  });

  test("automatic approval rechecks allowed roots after the menu read", async () => {
    const t = setup();
    const lease = await t.claim();
    await t.set(lease, "all_permissions");
    t.setScreen(permission("git push origin main"));
    // agent.list returned the in-scope snapshot. Reading the menu races a cd out.
    t.setOnRead(() => { t.agent.cwd = "/srv/secret"; });
    await t.gw.handle("watch_poll", {});
    expect(t.pressed).toEqual([]);
  });

  test("failed current-agent lookup cannot downgrade ask to automatic permission approval", async () => {
    const t = setup();
    const lease = await t.claim();
    await t.set(lease, "ask");
    t.setScreen(permission());
    const unavailable: HerdrCall = async (method, params, timeoutMs) => {
      if (method === "agent.get") throw new Error("Herdr unavailable");
      return await t.herdr(method, params, timeoutMs);
    };
    expect((await approveMenus(t.cfg, unavailable, PANE, "watch_poll", { waitMs: 0 })).approved).toEqual([]);
    expect(t.pressed).toEqual([]);
  });
});
