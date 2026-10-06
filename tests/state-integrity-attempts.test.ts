import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type HerdrCall } from "../gateway/config.ts";
import { Gateway } from "../gateway/gateway.ts";
import { StateStore } from "../gateway/state.ts";
import { validateState } from "../gateway/state-journal.ts";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
async function delivered() {
  const dir = mkdtempSync(join(tmpdir(), "wd-attempt-integrity-")); dirs.push(dir);
  const agent = { pane_id: "w1:p1", name: "worker", agent: "codex", agent_status: "idle", cwd: dir, agent_session: { value: "session1" }, state_change_seq: 1 };
  const sends: string[] = [];
  const herdr: HerdrCall = async (method, params: any) => {
    if (method === "agent.list") return { agents: [agent] };
    if (method === "agent.get") return { agent };
    if (method === "agent.prompt") { sends.push(params.text); return { agent }; }
    return { read: { text: "" } };
  };
  const g = new Gateway(loadConfig({ stateDir: dir, allowedRoots: [dir], leases: true, autoApprove: false }), herdr);
  const { lease } = await g.request("claim_agents", { label: "Mock supervisor", targets: ["worker"] }) as any;
  await g.request("coord_update", { objective: "demo", title: "Mock objective", lease, tasks: [{ id: "task", title: "Mock task", owner: "worker" }] });
  const params = { target: "worker", text: "Do the slice", task: { objective: "demo", id: "task" }, command_id: "same-command", lease };
  await g.request("prompt_agent", params);
  const path = join(dir, "coord.json");
  const coord = JSON.parse(readFileSync(path, "utf8"));
  expect(coord.commands[params.command_id].state).toBe("delivered");
  expect(sends).toHaveLength(1);
  return { dir, g, sends, params, path, coord };
}
const task = (s: any) => s.objectives.demo.tasks.task;
const command = (s: any) => s.commands["same-command"];
const reportReceipt = { hash: "a".repeat(64), at: "2026-10-06T00:00:00.000Z", version: 1, status: "executing" };
const corruptions: Array<[string, (s: any) => void]> = [
  ["commands null", s => { s.commands = null; }],
  ["commands deleted despite binding dispatch", s => { delete s.commands; }],
  ["commands deleted despite pending attempt", s => {
    delete s.commands;
    delete task(s).binding.dispatch;
    task(s).pending = { command_id: "pending", at: reportReceipt.at, binding: { ...task(s).binding, id: "pending-attempt", generation: 2 } };
  }],
  ["commands array", s => { s.commands = []; }],
  ["command record null", s => { s.commands["same-command"] = null; }],
  ["command record array", s => { s.commands["same-command"] = []; }],
  ["command missing hash", s => { delete command(s).hash; }],
  ["command invalid hash", s => { command(s).hash = "not-a-digest"; }],
  ["command null hash", s => { command(s).hash = null; }],
  ["command invalid state", s => { command(s).state = "complete"; }],
  ["command invalid timestamp", s => { command(s).at = "yesterday"; }],
  ["command missing binding identity", s => { delete command(s).binding_id; }],
  ["command invalid binding identity", s => { command(s).binding_id = 42; }],
  ["command mismatched binding identity", s => { command(s).binding_id = "different-attempt"; }],
  ["command mismatched pane", s => { command(s).pane_id = "w1:p2"; }],
  ["command mismatched objective", s => { command(s).objective = "other"; }],
  ["command mismatched task", s => { command(s).task = "other"; }],
  ["command receipt missing for present dispatch", s => { s.commands = {}; }],
  ["current null", s => { s.current = null; }],
  ["current empty identity", s => { s.current["w1:p1"] = ""; }],
  ["current malformed identity", s => { s.current["w1:p1"] = {}; }],
  ["current binding belongs to another pane", s => { s.current["w1:p2"] = task(s).binding.id; }],
  ["binding empty identity", s => { task(s).binding.id = ""; }],
  ["binding malformed token hash", s => { task(s).binding.token_hash = "bad"; }],
  ["binding token hash mismatch", s => { task(s).binding.token_hash = "b".repeat(64); }],
  ["binding generation mismatch", s => { task(s).binding.generation++; }],
  ["binding dispatch malformed", s => { task(s).binding.dispatch = []; }],
  ["binding dispatch unknown state", s => { task(s).binding.dispatch.state = "accepted"; }],
  ["binding dispatch command mismatch", s => { task(s).binding.dispatch.command_id = "other-command"; }],
  ["binding dispatch receipt state mismatch", s => { task(s).binding.dispatch.state = "unknown"; }],
  ["binding dispatch nested prev malformed", s => { task(s).binding.dispatch.prev = { ...task(s).binding.dispatch, prev: { command_id: "earlier", state: false, at: reportReceipt.at } }; }],
  ["binding receipts null", s => { task(s).binding.receipts = null; }],
  ["binding nested receipt malformed", s => { task(s).binding.receipts.report1 = { ...reportReceipt, hash: {} }; }],
  ["task receipts null", s => { task(s).receipts = null; }],
  ["task nested receipt malformed", s => { task(s).receipts.report1 = { ...reportReceipt, version: -1 }; }],
  ["pending malformed", s => { task(s).pending = []; }],
  ["pending missing attempt", s => { task(s).pending = { command_id: "pending", at: reportReceipt.at }; }],
  ["pending invalid nested receipts", s => { task(s).pending = { command_id: "pending", at: reportReceipt.at, binding: { ...task(s).binding, id: "pending-attempt", generation: 2, receipts: { report1: { ...reportReceipt, status: "invalid" } } } }; }],
  ["pending duplicate binding identity", s => { task(s).pending = { command_id: "pending", at: reportReceipt.at, binding: { ...task(s).binding, generation: 2 } }; }],
  ["resource binding malformed", s => { s.resources.test = { objective: "demo", task: "task", binding: {}, pane_id: null, session: null, generation: 1, acquired_at: reportReceipt.at, renewed_at: reportReceipt.at, stale_since: null }; }],
];

test.each(corruptions)("corrupt present attempt state fails closed: %s", async (_, mutate) => {
  const f = await delivered();
  mutate(f.coord);
  const bad = JSON.stringify(f.coord);
  writeFileSync(f.path, bad);
  const snapshot = () => Object.fromEntries(readdirSync(f.dir).sort().map(name => [name, readFileSync(join(f.dir, name), "utf8")]));
  const before = snapshot();
  // This is the reviewed duplicate-command repro through the public request path.
  await expect(f.g.request("prompt_agent", f.params)).rejects.toThrow("Invalid gateway state: coord.json");
  let ran = false;
  expect(() => new StateStore(f.dir).updateCoord(() => { ran = true; })).toThrow("Invalid gateway state: coord.json");
  expect(ran).toBe(false);
  expect(f.sends).toHaveLength(1);
  expect(readFileSync(f.path, "utf8")).toBe(bad);
  expect(snapshot()).toEqual(before);
});

test("missing attempt fields in old v2 stores migrate without dropping old report IDs", async () => {
  const f = await delivered();
  const t = task(f.coord);
  delete f.coord.commands;
  delete f.coord.current;
  delete t.progress;
  delete t.pending;
  delete t.receipts;
  delete t.binding.dispatch;
  delete t.binding.receipts;
  t.report_ids = ["old-report"];
  writeFileSync(f.path, JSON.stringify(f.coord));
  const store = new StateStore(f.dir);
  store.updateCoord(() => {});
  const migrated = store.coord();
  expect(migrated.commands).toEqual({});
  expect(migrated.current).toEqual({ "w1:p1": t.binding.id });
  expect(migrated.objectives.demo!.tasks.task!.binding!.receipts!["old-report"]).toMatchObject({ hash: null, status: "executing" });
  expect(migrated.objectives.demo!.tasks.task!.pending).toBeNull();
});

test("expired-attempt command receipts and dangling current mappings remain readable", async () => {
  const f = await delivered();
  const old = structuredClone(command(f.coord));
  f.coord.commands["historical-command"] = { ...old, binding_id: "expired-attempt" };
  f.coord.current["removed-pane"] = "removed-attempt";
  writeFileSync(f.path, JSON.stringify(f.coord));
  expect(() => validateState("coord.json", f.coord)).not.toThrow();
  const res: any = await f.g.request("prompt_agent", f.params);
  expect(res.duplicate).toBe(true);
  expect(f.sends).toHaveLength(1);
});

test("an invalid command registry in a redo journal refuses recovery without overwriting canonical state", async () => {
  const f = await delivered();
  const good = readFileSync(f.path, "utf8");
  f.coord.commands = null;
  const journal = JSON.stringify({ version: 1, writes: { "coord.json": f.coord } });
  writeFileSync(join(f.dir, "transaction.json"), journal);
  expect(() => new StateStore(f.dir).coord()).toThrow("Invalid gateway state: coord.json");
  expect(readFileSync(f.path, "utf8")).toBe(good);
  expect(readFileSync(join(f.dir, "transaction.json"), "utf8")).toBe(journal);
});
