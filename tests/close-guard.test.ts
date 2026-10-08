// close, from the 2026-10-08 incident on the Mac: a cleanup chat closed workspace wKR
// (the Codex agent relay-decisions-api-research in wKR:p1) while the owner meant the
// Claude pane on their screen, wKV:p2. The gateway answered closed for what it was given
// without checking it was the pane meant, idle, or gone afterwards.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GatewayError, loadConfig, type HerdrCall } from "../gateway/config.ts";
import { Gateway } from "../gateway/gateway.ts";
import { closeTiming } from "../gateway/layout-ops.ts";
import { trackWork } from "../gateway/work.ts";

closeTiming.ms = 0;
const RELAY = "/srv/allowed/relay";

function world() {
  // Herdr's pane records name the agent's CLI, not the agent; agent.list has the names.
  const panes: Record<string, any> = {
    "wKR:p1": { pane_id: "wKR:p1", workspace_id: "wKR", tab_id: "wKR:t1", terminal_id: "term_r1", cwd: RELAY, agent: "codex", agent_status: "idle", agent_session: { kind: "id", value: "s-r1" } },
    "wKV:p1": { pane_id: "wKV:p1", workspace_id: "wKV", tab_id: "wKV:t1", terminal_id: "term_v1", cwd: RELAY, agent: "claude", agent_status: "working", agent_session: { kind: "id", value: "s-v1" } },
    "wKV:p2": { pane_id: "wKV:p2", workspace_id: "wKV", tab_id: "wKV:t1", terminal_id: "term_v2", cwd: RELAY, agent: "claude", agent_status: "idle", agent_session: { kind: "id", value: "s-v2" }, focused: true },
    "wKV:p3": { pane_id: "wKV:p3", workspace_id: "wKV", tab_id: "wKV:t1", terminal_id: "term_v3", cwd: RELAY, agent_status: "unknown" },
  };
  const names: Record<string, string> = { "wKR:p1": "relay-decisions-api-research", "wKV:p1": "decisions" };
  const sent: Array<[string, any]> = [];
  // before: runs as Herdr gets each call, to change the world under the gateway.
  // close: replaces what a close does. down: every read fails as if the socket were gone.
  const fx = { before: null as null | ((method: string, params: any) => void), close: null as null | ((method: string, params: any) => unknown), down: false };
  const herdr: HerdrCall = async (method, params: any) => {
    if (method === "pane.report_metadata") return {};
    sent.push([method, params]);
    fx.before?.(method, params);
    const read = method.endsWith(".get") || method.endsWith(".list");
    if (fx.down && read) throw new GatewayError("herdr_unavailable", "herdr socket unavailable");
    switch (method) {
      case "pane.get":
        if (!panes[params.pane_id]) throw new GatewayError("pane_not_found", `pane ${params.pane_id} not found`);
        return { pane: { ...panes[params.pane_id] } };
      case "pane.list":
        return { panes: Object.values(panes).map((p) => ({ ...p })) };
      case "agent.list":
        return { agents: Object.values(panes).filter((p) => p.agent).map((p) => ({ ...p, name: names[p.pane_id] ?? null })) };
      case "agent.get": {
        const p = panes[params.target] ?? Object.values(panes).find((x) => names[x.pane_id] === params.target);
        if (!p?.agent) throw new GatewayError("agent_not_found", `agent ${params.target} not found`);
        return { agent: { ...p, name: names[p.pane_id] ?? null } };
      }
      case "workspace.create": {
        const pane = { pane_id: "wN1:p1", workspace_id: "wN1", tab_id: "wN1:t1", terminal_id: "term_n1", cwd: params.cwd, agent_status: "unknown" };
        panes[pane.pane_id] = pane;
        return { workspace: { workspace_id: "wN1" }, tab: { tab_id: "wN1:t1" }, root_pane: pane };
      }
      case "pane.close":
      case "tab.close":
      case "workspace.close": {
        if (fx.close) return fx.close(method, params);
        for (const [id, p] of Object.entries(panes)) {
          if (method === "pane.close" ? id === params.pane_id : method === "tab.close" ? p.tab_id === params.tab_id : p.workspace_id === params.workspace_id) delete panes[id];
        }
        return {};
      }
      default:
        return {};
    }
  };
  return { panes, names, sent, fx, herdr };
}

function setup(extra: Record<string, unknown> = {}) {
  const w = world();
  const state = mkdtempSync(join(tmpdir(), "herdr-close-"));
  const cfg = loadConfig({ allowedRoots: ["/srv/allowed"], stateDir: state, transcriptRoots: [state], agentKinds: ["claude", "codex"], allowCloseAny: true, ...extra });
  const gw = new Gateway(cfg, w.herdr);
  const claim = async (targets: string[], label: string, more: Record<string, unknown> = {}) => ((await gw.request("claim_agents", { label, targets, ...more })) as any).lease as string;
  const closes = () => w.sent.filter(([m]) => m.endsWith(".close"));
  const file = (name: string) => JSON.parse(readFileSync(join(state, name), "utf8"));
  return { ...w, gw, state, claim, closes, file };
}

describe("close: the target is the pane the owner meant", () => {
  test("list_panes tells the panes apart: the visible one, which are agents, their names and holders", async () => {
    const { gw, claim } = setup();
    await claim(["wKR:p1"], "cleanup");
    const list: any = await gw.request("list_panes", {});
    expect(list.panes.filter((p: any) => p.focused).map((p: any) => p.pane_id)).toEqual(["wKV:p2"]);
    expect(list.panes.find((p: any) => p.pane_id === "wKV:p2")).toMatchObject({ agent: "claude", name: null, status: "idle" });
    expect(list.panes.find((p: any) => p.pane_id === "wKR:p1")).toMatchObject({ agent: "codex", name: "relay-decisions-api-research", held_by: "cleanup" });
    const shell = list.panes.find((p: any) => p.pane_id === "wKV:p3");
    expect(shell).toMatchObject({ agent: null, status: null });
    expect(shell).not.toHaveProperty("name");
  });

  test("the wrong ID with what the owner meant is refused, and nothing closes", async () => {
    const { gw, panes, claim, closes } = setup();
    const lease = await claim(["wKR:p1", "wKV:p2"], "cleanup");
    // The incident: the chat sent wKR:p1 for the Claude pane on the owner's screen.
    await expect(gw.request("close", { kind: "pane", id: "wKR:p1", lease, confirm: true, expect: [{ pane_id: "wKV:p2", agent: "claude" }] }))
      .rejects.toMatchObject({ code: "target_mismatch", message: expect.stringContaining('codex "relay-decisions-api-research" wKR:p1') });
    // The right ID with the wrong belief about it.
    await expect(gw.request("close", { kind: "pane", id: "wKR:p1", lease, confirm: true, expect: [{ pane_id: "wKR:p1", agent: "claude", name: null }] }))
      .rejects.toMatchObject({ code: "target_mismatch", details: { targets: [{ pane_id: "wKR:p1", agent: "codex", name: "relay-decisions-api-research", terminal_id: "term_r1", session: "s-r1" }] } });
    // A workspace close names every pane it takes: one not listed is refused.
    await expect(gw.request("close", { kind: "workspace", id: "wKR", lease, confirm: true, expect: [{ pane_id: "wKV:p2" }] })).rejects.toMatchObject({ code: "target_mismatch" });
    expect(closes()).toEqual([]);
    expect(panes["wKR:p1"]).toBeDefined();

    const res: any = await gw.request("close", { kind: "pane", id: "wKV:p2", lease, confirm: true, expect: [{ pane_id: "wKV:p2", agent: "claude", name: null }] });
    expect(res).toMatchObject({ closed: "pane", id: "wKV:p2", outcome: "closed", verified: true, panes: [{ pane_id: "wKV:p2", agent: "claude", name: null, cwd: RELAY, status: "idle" }] });
    expect(closes()).toEqual([["pane.close", { pane_id: "wKV:p2" }]]);
    expect(panes["wKR:p1"]).toBeDefined();
  });

  test("the go-ahead request names each pane in full, and its targets bind the approved call", async () => {
    const { gw, panes, claim, closes } = setup();
    const lease = await claim(["wKR:p1"], "cleanup");
    const asked: any = await gw.request("close", { kind: "workspace", id: "wKR", lease }).catch((e: any) => e);
    expect(asked).toMatchObject({ code: "needs_confirmation", details: { panes: ["wKR:p1"], targets: [{ pane_id: "wKR:p1", agent: "codex", name: "relay-decisions-api-research" }] } });
    expect(asked.message).toContain('codex "relay-decisions-api-research" wKR:p1, idle, in relay');
    // Between the card and the click another agent replaced the one shown.
    Object.assign(panes["wKR:p1"], { agent: "claude", agent_session: { kind: "id", value: "s-other" } });
    await expect(gw.request("close", { kind: "workspace", id: "wKR", lease, confirm: true, expect: asked.details.targets })).rejects.toMatchObject({ code: "target_mismatch" });
    expect(closes()).toEqual([]);
  });
});

describe("close: never an agent mid-turn on an earlier go-ahead", () => {
  test("a working agent is refused before any card is offered, for a pane and for its workspace", async () => {
    const { gw, panes, claim, closes } = setup();
    const lease = await claim(["wKV:p1", "wKV:p2"], "decisions");
    await expect(gw.request("close", { kind: "pane", id: "wKV:p1", lease })).rejects.toMatchObject({ code: "agent_working", details: { panes: ["wKV:p1"] } });
    await expect(gw.request("close", { kind: "pane", id: "wKV:p1", lease, confirm: true })).rejects.toMatchObject({ code: "agent_working", message: expect.stringContaining('claude "decisions" wKV:p1, working') });
    await expect(gw.request("close", { kind: "workspace", id: "wKV", lease, confirm: true })).rejects.toMatchObject({ code: "agent_working" });
    expect(closes()).toEqual([]);
    // The owner wants it stopped mid-turn.
    expect(await gw.request("close", { kind: "pane", id: "wKV:p1", lease, confirm: true, even_if_working: true })).toMatchObject({ outcome: "closed" });
    expect(panes["wKV:p1"]).toBeUndefined();
  });

  test("the owner's click in the console closes a working agent: they see its status", async () => {
    const { gw, panes } = setup();
    expect(await gw.request("close", { kind: "pane", id: "wKV:p1", origin: "console" })).toMatchObject({ outcome: "closed" });
    expect(panes["wKV:p1"]).toBeUndefined();
  });
});

describe("close: the pane changes while close checks it", () => {
  test("the agent starts a turn after the checks: refused on the last read", async () => {
    const { gw, panes, fx, claim, closes } = setup();
    const lease = await claim(["wKV:p2"], "tool test");
    fx.before = (m) => { if (m === "agent.list") panes["wKV:p2"].agent_status = "working"; };
    await expect(gw.request("close", { kind: "pane", id: "wKV:p2", lease, confirm: true })).rejects.toMatchObject({ code: "agent_working" });
    expect(closes()).toEqual([]);
  });

  test("another agent replaces it after the checks: target_changed", async () => {
    const { gw, panes, fx, claim, closes } = setup();
    const lease = await claim(["wKV:p2"], "tool test");
    fx.before = (m) => { if (m === "agent.list") Object.assign(panes["wKV:p2"], { agent: "codex", agent_session: { kind: "id", value: "s-new" } }); };
    await expect(gw.request("close", { kind: "pane", id: "wKV:p2", lease, confirm: true })).rejects.toMatchObject({ code: "target_changed", message: expect.stringContaining("agent changed from claude to codex") });
    expect(closes()).toEqual([]);
  });

  test("a pane joins the workspace after the checks: target_changed", async () => {
    const { gw, panes, fx, claim, closes } = setup();
    const lease = await claim(["wKR:p1"], "cleanup");
    fx.before = (m) => { if (m === "agent.list") panes["wKR:p2"] = { pane_id: "wKR:p2", workspace_id: "wKR", tab_id: "wKR:t1", terminal_id: "term_r2", cwd: RELAY, agent_status: "unknown" }; };
    await expect(gw.request("close", { kind: "workspace", id: "wKR", lease, confirm: true })).rejects.toMatchObject({ code: "target_changed", message: expect.stringContaining("shell wKR:p2") });
    expect(closes()).toEqual([]);
  });

  test("a shell pane that gets an agent after the lease check is not closed without a lease on it", async () => {
    const { gw, panes, fx, closes } = setup();
    // The lease check reads the shell (free to use), then an agent starts in it.
    let gets = 0;
    fx.before = (m, p) => { if (m === "pane.get" && p.pane_id === "wKV:p3" && ++gets === 2) Object.assign(panes["wKV:p3"], { agent: "claude", agent_status: "idle", agent_session: { kind: "id", value: "s-new" } }); };
    await expect(gw.request("close", { kind: "pane", id: "wKV:p3", confirm: true })).rejects.toMatchObject({ code: "not_your_agent" });
    expect(closes()).toEqual([]);
  });
});

describe("close: the outcome comes from Herdr, not from the call", () => {
  test("Herdr takes the close but the pane stays: not_closed, and nothing is recorded closed", async () => {
    const { gw, fx, closes, file } = setup({ allowCloseAny: false });
    const made: any = await gw.handle("create_workspace", { cwd: RELAY });
    const id = made.pane.pane_id;
    fx.close = () => ({});
    await expect(gw.request("close", { kind: "pane", id, confirm: true })).rejects.toMatchObject({ code: "not_closed", details: { still_open: [id] } });
    expect(closes().length).toBe(1);
    expect(file("created-panes.json")).toContain(id);
    expect(file("closed.json")).toEqual([]);
  });

  test("Herdr's answer is lost but the pane closed: closed, verified", async () => {
    const { gw, panes, fx, claim } = setup();
    const lease = await claim(["wKV:p2"], "tool test");
    fx.close = () => { delete panes["wKV:p2"]; throw new GatewayError("herdr_timeout", "herdr did not answer"); };
    expect(await gw.request("close", { kind: "pane", id: "wKV:p2", lease, confirm: true })).toMatchObject({ outcome: "closed", verified: true });
  });

  test("nothing can be read back: close_uncertain, and a repeat once Herdr answers says already_closed", async () => {
    const { gw, panes, fx, claim, closes, file } = setup();
    const lease = await claim(["wKV:p2"], "tool test");
    fx.close = () => { delete panes["wKV:p2"]; fx.down = true; throw new GatewayError("herdr_closed", "herdr closed the connection"); };
    await expect(gw.request("close", { kind: "pane", id: "wKV:p2", lease, confirm: true })).rejects.toMatchObject({ code: "close_uncertain" });
    expect(file("closed.json")).toMatchObject([{ kind: "pane", id: "wKV:p2", status: "closing" }]);
    fx.down = false;
    fx.close = null;
    const again: any = await gw.request("close", { kind: "pane", id: "wKV:p2", lease, confirm: true });
    expect(again).toMatchObject({ closed: "pane", id: "wKV:p2", outcome: "already_closed", verified: true, panes: [{ pane_id: "wKV:p2", agent: "claude" }] });
    expect(file("closed.json")).toMatchObject([{ kind: "pane", id: "wKV:p2", status: "closed" }]);
    expect(closes().length).toBe(1);
  });
});

describe("close: a repeat is answered, not refused", () => {
  test("closing twice: the second says already_closed and sends nothing (not not_bridge_pane)", async () => {
    const { gw, closes } = setup({ allowCloseAny: false });
    const made: any = await gw.handle("create_workspace", { cwd: RELAY });
    const id = made.pane.pane_id;
    const lease = ((await gw.request("claim_agents", { label: "scratch", targets: [id] })) as any).lease;
    expect(await gw.request("close", { kind: "pane", id, lease, confirm: true })).toMatchObject({ outcome: "closed" });
    const again: any = await gw.request("close", { kind: "pane", id, lease, confirm: true });
    expect(again).toMatchObject({ outcome: "already_closed", closed_by: `lease …${lease.slice(-4)}` });
    expect(closes().length).toBe(1);
  });

  test("a pane its workspace's close took, a workspace closed twice, and an ID that never existed", async () => {
    const { gw, claim, closes } = setup();
    const lease = await claim(["wKR:p1"], "cleanup");
    expect(await gw.request("close", { kind: "workspace", id: "wKR", lease, confirm: true })).toMatchObject({ outcome: "closed", panes: [{ pane_id: "wKR:p1", name: "relay-decisions-api-research" }] });
    expect(await gw.request("close", { kind: "workspace", id: "wKR", lease, confirm: true })).toMatchObject({ outcome: "already_closed" });
    expect(await gw.request("close", { kind: "pane", id: "wKR:p1", lease, confirm: true })).toMatchObject({ outcome: "already_closed", closed_by: `lease …${lease.slice(-4)}` });
    expect(closes().length).toBe(1);
    await expect(gw.request("close", { kind: "pane", id: "wZZ:p9", lease, confirm: true })).rejects.toMatchObject({ code: "pane_not_found" });
  });
});

describe("close: shell panes and leases", () => {
  test("a shell-only pane nobody holds closes without a lease, and says it was a shell", async () => {
    const { gw, panes } = setup();
    const asked: any = await gw.request("close", { kind: "pane", id: "wKV:p3" }).catch((e: any) => e);
    expect(asked.message).toContain("shell wKV:p3, in relay");
    const res: any = await gw.request("close", { kind: "pane", id: "wKV:p3", confirm: true });
    expect(res).toMatchObject({ outcome: "closed", panes: [{ pane_id: "wKV:p3", agent: null, name: null, status: null }] });
    expect(panes["wKV:p3"]).toBeUndefined();
  });

  test("another conversation's pane is refused until the owner moves it here; the work stays the first one's", async () => {
    const { gw, panes, claim, closes, file } = setup();
    const first = await claim(["wKV:p2", "wKV:p3"], "tool-dispatch test");
    trackWork(gw, "prompt_agent", { target: "wKV:p2", text: "Round 0" }, { submitted: true }, first, panes["wKV:p2"]);
    const other = await claim([], "cleanup");
    await expect(gw.request("close", { kind: "pane", id: "wKV:p2", confirm: true })).rejects.toMatchObject({ code: "needs_lease" });
    await expect(gw.request("close", { kind: "pane", id: "wKV:p2", lease: other, confirm: true })).rejects.toMatchObject({ code: "not_your_agent", message: expect.stringContaining("tool-dispatch test") });
    await expect(gw.request("close", { kind: "pane", id: "wKV:p3", lease: other, confirm: true })).rejects.toMatchObject({ code: "not_your_agent" });
    await expect(gw.request("close", { kind: "workspace", id: "wKV", lease: other, confirm: true, even_if_working: true })).rejects.toMatchObject({ code: "not_your_agent" });
    expect(closes()).toEqual([]);
    // On the owner's word.
    await claim(["wKV:p2"], "cleanup", { lease: other, take_over: true });
    expect(await gw.request("close", { kind: "pane", id: "wKV:p2", lease: other, confirm: true })).toMatchObject({ outcome: "closed" });
    const work = Object.values(file("work.json")) as any[];
    expect(work).toMatchObject([{ pane_id: "wKV:p2", lease: first, status: "open" }]);
  });

  test("closing settles nothing: the work stays open, owed, held and settleable", async () => {
    const { gw, panes, claim, file } = setup();
    const lease = await claim(["wKV:p2"], "tool-dispatch test");
    trackWork(gw, "prompt_agent", { target: "wKV:p2", text: "Round 0" }, { submitted: true }, lease, panes["wKV:p2"]);
    const workId = (Object.values(file("work.json"))[0] as any).id;
    expect(await gw.request("close", { kind: "pane", id: "wKV:p2", lease, confirm: true })).toMatchObject({ outcome: "closed" });
    const owed: any = await gw.request("owed_work", { lease });
    const item = owed.items.find((i: any) => i.pane_id === "wKV:p2");
    expect(item).toMatchObject({ status: "gone", state: "gone", yours: true, holder: { lease: `…${lease.slice(-4)}`, live: true }, work: { id: workId }, settle: { work_id: workId } });
    expect(((await gw.request("lease_check", { lease })) as any).panes).toContain("wKV:p2");
    expect(await gw.request("settle_work", { work_id: workId, outcome: "accepted", lease })).toMatchObject({ settled: true });
  });
});
