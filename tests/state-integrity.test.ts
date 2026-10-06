import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { StateStore } from "../gateway/state.ts";
import { tryLock } from "../gateway/state-lock.ts";

const dirs: string[] = [];
const dir = () => { const d = mkdtempSync(join(tmpdir(), "wd-integrity-")); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const stateModule = resolve(import.meta.dir, "../gateway/state.ts");

describe("gateway state integrity", () => {
  test("a live old lock times out without running the mutation", () => {
    const d = dir();
    const path = join(d, "watch.lock");
    const release = tryLock(path)!;
    utimesSync(path, new Date(0), new Date(0));
    let written = false;
    try {
      expect(() => new StateStore(d).updateWatched(() => { written = true; })).toThrow("lock is held");
      expect(written).toBe(false);
      expect(existsSync(path)).toBe(true);
      expect(existsSync(join(d, "watch.json"))).toBe(false);
    } finally { release(); }
  });

  test("unknown legacy lock ownership is never inferred from age", () => {
    const d = dir();
    mkdirSync(join(d, "watch.lock"));
    utimesSync(join(d, "watch.lock"), new Date(0), new Date(0));
    expect(() => new StateStore(d).setExecWorkspace("w1")).toThrow("lock is held");
    expect(existsSync(join(d, "watch.lock"))).toBe(true);
    expect(existsSync(join(d, "exec-workspace.json"))).toBe(false);
  });

  test("a killed lock owner can be reclaimed across processes", async () => {
    const d = dir();
    const child = Bun.spawn([process.execPath, "-e", `import {tryLock} from ${JSON.stringify(resolve(import.meta.dir, "../gateway/state-lock.ts"))}; tryLock(process.argv[1]+"/watch.lock"); console.log("held"); await Bun.sleep(60000);`, d], { stdout: "pipe", stderr: "pipe" });
    const reader = child.stdout.getReader();
    await reader.read();
    child.kill("SIGKILL");
    await child.exited;
    new StateStore(d).setExecWorkspace("w1");
    expect(new StateStore(d).execWorkspace()).toBe("w1");
  });

  test("malformed and structurally invalid stores refuse writes without overwriting any sibling", () => {
    for (const bad of ["{broken", "null", "[]", '{"version":2,"objectives":[]}', '{"version":999,"objectives":{}}']) {
      const d = dir();
      writeFileSync(join(d, "coord.json"), bad);
      writeFileSync(join(d, "watch.json"), "{}");
      const store = new StateStore(d);
      expect(() => store.updateCoord(c => { c.objectives = {}; })).toThrow();
      expect(() => store.setExecWorkspace("w1")).toThrow();
      expect(readFileSync(join(d, "coord.json"), "utf8")).toBe(bad);
      expect(readFileSync(join(d, "watch.json"), "utf8")).toBe("{}");
      expect(existsSync(join(d, "exec-workspace.json"))).toBe(false);
    }
  });

  test("an unreadable state path is an error, while absent files initialize", () => {
    const d = dir();
    mkdirSync(join(d, "coord.json"));
    expect(() => new StateStore(d).updateCoord(() => {})).toThrow();
    const empty = new StateStore(dir());
    empty.updateCoord(c => { c.resource_generations.test = 1; });
    expect(empty.coord().resource_generations.test).toBe(1);
  });

  test("a transaction rolls back all staged files when its callback fails", () => {
    const d = dir();
    const store = new StateStore(d);
    expect(() => store.transaction(() => {
      store.setExecWorkspace("w1");
      store.addTold({ pane_id: "w1:p1", text: "hello", at: new Date().toISOString() });
      throw new Error("cancel");
    })).toThrow("cancel");
    expect(existsSync(join(d, "exec-workspace.json"))).toBe(false);
    expect(store.hasTold()).toBe(false);
  });

  test("an interrupted committed journal recovers source state and outbox together", () => {
    const d = dir();
    const report = { event_id: "event1", pane_id: "w1:p1", type: "finished" as const, agent: null, kind: null, cwd: null, excerpt: null, lease: null, reply_to: null, message: "finished" };
    writeFileSync(join(d, "watch.json"), '{"w1:p1":{"busy":true}}');
    writeFileSync(join(d, "outbox.json"), JSON.stringify([report])); // first file installed before crash
    writeFileSync(join(d, "transaction.json"), JSON.stringify({ version: 1, writes: { "watch.json": {}, "outbox.json": [report], "told.json": [] } }));
    const store = new StateStore(d);
    expect(store.watched()).toEqual({});
    expect(store.outbox()).toEqual([report]);
    expect(store.hasTold()).toBe(false);
    expect(existsSync(join(d, "transaction.json"))).toBe(false);
  });

  test("a corrupt journal refuses recovery instead of overwriting canonical state", () => {
    const d = dir();
    writeFileSync(join(d, "watch.json"), "{}");
    writeFileSync(join(d, "transaction.json"), '{"version":1,"writes":{"watch.json":[]}}');
    expect(() => new StateStore(d).setExecWorkspace("w1")).toThrow();
    expect(readFileSync(join(d, "watch.json"), "utf8")).toBe("{}");
  });

  test("multiprocess mutations preserve every watch and tell", async () => {
    const d = dir();
    const script = `import {StateStore} from ${JSON.stringify(stateModule)}; const s=new StateStore(process.argv[1]); for(let i=0;i<15;i++){ const id=process.argv[2]+":"+i; s.transaction(()=>{s.updateWatched(w=>{w[id]={name:id,cwd:null,since:new Date().toISOString()}});s.addTold({pane_id:id,text:id,at:new Date().toISOString()})}); }`;
    const children = Array.from({ length: 5 }, (_, i) => Bun.spawn([process.execPath, "-e", script, d, String(i)], { stdout: "pipe", stderr: "pipe" }));
    for (const child of children) {
      expect(await child.exited).toBe(0);
      expect(await new Response(child.stderr).text()).toBe("");
    }
    const store = new StateStore(d);
    expect(Object.keys(store.watched())).toHaveLength(75);
    expect(store.takeTold()).toHaveLength(75);
  });
});

test("a killed menu-lock owner is recovered on a zero-wait answer attempt", async () => {
  const d = dir();
  const child = Bun.spawn([process.execPath, "-e", `import {tryLock} from ${JSON.stringify(resolve(import.meta.dir, "../gateway/state-lock.ts"))}; tryLock(process.argv[1]+"/answer-w1_p1.lock"); console.log("held"); await Bun.sleep(60000);`, d], { stdout: "pipe", stderr: "pipe" });
  await child.stdout.getReader().read(); child.kill("SIGKILL"); await child.exited;
  expect(await new StateStore(d).withPane("w1:p1", 0, async () => "answered")).toBe("answered");
});
