import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../gateway/config.ts";
import { Gateway } from "../gateway/gateway.ts";
import type { Watched } from "../gateway/state.ts";
import { decide, decideBackground, message } from "../gateway/watcher.ts";

const now = Date.parse("2026-09-25T12:00:00Z");
const since = (msAgo: number) => new Date(now - msAgo).toISOString();

// Feeds a sequence of polls through decide as the poller would, 15 s apart, and
// returns the events it reported. "done@7" is status done with state_change_seq 7.
function run(w: Watched, polls: string[]) {
  const events: string[] = [];
  let t = now;
  for (const p of polls) {
    t += 15_000;
    const [s, seq] = p.split("@");
    const d = decide(w, { agent_status: s, ...(seq ? { state_change_seq: Number(seq) } : {}) }, t);
    if (d.event) events.push(`${p}:${d.event}`);
    if (d.drop) {
      events.push("dropped");
      break;
    }
    w = { ...w, ...d.set };
  }
  return { events, w };
}

describe("turn watch (prompt_agent)", () => {
  test("a finished agent is reported once and dropped", () => {
    const w = { name: "relay", cwd: "/Users/me/src/tries/relay", since: since(60_000), last_status: "working" };
    expect(decide(w, { agent_status: "idle" }, now)).toMatchObject({ event: "finished", drop: true });
  });
  test("idle right after the prompt is not yet a finish", () => {
    const w = { name: "relay", cwd: null, since: since(2000) };
    expect(decide(w, { agent_status: "idle" }, now)).toEqual({});
    expect(decide(w, { agent_status: "working" }, now)).toEqual({ set: { last_status: "working" } });
  });
  test("a dialog is reported once, then watching continues", () => {
    const w = { name: null, cwd: null, since: since(30_000), last_status: "working" };
    expect(decide(w, { name: "fixer", agent_status: "blocked" }, now)).toEqual({ event: "blocked", set: { last_status: "blocked" } });
    expect(decide({ ...w, last_status: "blocked" }, { agent_status: "blocked" }, now)).toEqual({});
  });
  test("a vanished agent is reported; stale entries are dropped quietly", () => {
    const w = { name: "x", cwd: null, since: since(10_000) };
    expect(decide(w, undefined, now)).toEqual({ event: "gone", drop: true });
    expect(decide({ ...w, since: since(25 * 3600_000) }, { agent_status: "working" }, now)).toEqual({ drop: true });
  });
});

describe("managed watch", () => {
  const managed = (extra: Partial<Watched> = {}): Watched => ({ name: "worker", cwd: null, since: since(0), last_status: "idle", managed: true, busy: false, ...extra });

  test("every turn is reported once, an idle agent stays quiet, and the entry stays", () => {
    const { events } = run(managed(), ["idle", "working", "working", "idle", "idle", "idle", "working", "done", "done"]);
    expect(events).toEqual(["idle:finished", "done:finished"]);
  });
  test("a dialog mid-turn is reported, then the finish", () => {
    const { events } = run(managed(), ["working", "blocked", "blocked", "working", "idle"]);
    expect(events).toEqual(["blocked:blocked", "idle:finished"]);
  });
  test("a dialog without a turn, like folder trust at startup, is not a finish", () => {
    expect(run(managed({ last_status: "unknown" }), ["blocked", "idle"]).events).toEqual(["blocked:blocked"]);
    expect(run(managed({ last_status: "blocked" }), ["blocked", "idle"]).events).toEqual([]);
  });
  test("a turn that ran between two polls: done after idle", () => {
    expect(run(managed(), ["done"]).events).toEqual(["done:finished"]);
    // Someone looked at it: done becomes idle, which is not a new turn.
    expect(run(managed({ last_status: "done" }), ["idle", "idle"]).events).toEqual([]);
  });
  test("working through unknown still ends in a finish", () => {
    expect(run(managed(), ["working", "unknown", "idle"]).events).toEqual(["idle:finished"]);
    expect(run(managed(), ["unknown", "idle"]).events).toEqual([]);
  });
  test("after prompt_agent, idle within the grace period waits; later idle is the finish", () => {
    const w = managed({ busy: true, prompted_at: since(0) });
    expect(decide(w, { agent_status: "idle" }, now + 5000)).toEqual({});
    expect(decide(w, { agent_status: "idle" }, now + 20_000)).toMatchObject({ event: "finished", set: { busy: false } });
  });
  test("state_change_seq catches turns shorter than the poll interval", () => {
    // An unseen agent stays done; each short turn moves the seq by two.
    expect(run(managed({ last_status: "done", seq: 1 }), ["done@1", "done@3", "done@5", "done@5"]).events).toEqual(["done@3:finished", "done@5:finished"]);
    // A dialog in a short turn, approved, then done before the next poll.
    expect(run(managed({ seq: 1 }), ["blocked@3", "done@5"]).events).toEqual(["blocked@3:blocked", "done@5:finished"]);
    // watch_agent while it was blocked mid-turn.
    expect(run(managed({ last_status: "blocked", seq: 4 }), ["blocked@4", "done@6"]).events).toEqual(["done@6:finished"]);
    // A second dialog after the first was answered.
    expect(run(managed({ last_status: "blocked", seq: 4 }), ["blocked@6"]).events).toEqual(["blocked@6:blocked"]);
    // Someone looked at a done agent: idle, a new seq, and no turn.
    expect(run(managed({ last_status: "done", seq: 5 }), ["idle@6", "idle@6"]).events).toEqual([]);
    // A pane on screen goes back to idle after a turn: idle, then idle with a new seq.
    expect(run(managed({ seq: 5 }), ["idle@5", "idle@9", "idle@9"]).events).toEqual(["idle@9:finished"]);
  });
  test("a prompt that went through does not wait out the grace period", () => {
    const w = managed({ busy: true, prompted_at: since(0), seq: 10 });
    expect(decide(w, { agent_status: "done", state_change_seq: 10 }, now + 5000)).toEqual({});
    expect(decide(w, { agent_status: "done", state_change_seq: 12 }, now + 5000)).toMatchObject({ event: "finished" });
  });
  test("an agent replaced in the same pane: another kind is gone, a new session starts over", () => {
    const w = managed({ kind: "cursor", busy: true, last_status: "working", session: "s1" });
    expect(decide(w, { agent: "claude", agent_status: "idle" }, now)).toEqual({ event: "gone", drop: true });
    const d = decide(w, { agent: "cursor", agent_status: "idle", agent_session: { value: "s2" } }, now);
    expect(d).toEqual({ set: { last_status: "idle", session: "s2", busy: false, prompted_at: undefined } });
    expect(decide({ ...w, ...d.set }, { agent: "cursor", agent_status: "idle", agent_session: { value: "s2" } }, now)).toEqual({});
  });
  test("an exited agent is reported and dropped; age never drops a managed entry", () => {
    expect(decide(managed(), undefined, now)).toEqual({ event: "gone", drop: true });
    expect(decide(managed({ since: since(30 * 24 * 3600_000) }), { agent_status: "idle" }, now)).toEqual({});
  });
});

describe("an agent in the background of its pane", () => {
  const w: Watched = { name: "worker", cwd: null, since: since(0), last_status: "working", managed: true, busy: true, kind: "cursor" };
  test("reported once per state, and the watch stays", () => {
    expect(decideBackground(w, { pid: 5, stopped: false }, now)).toEqual({ event: "background", set: { last_status: "background" } });
    expect(decideBackground({ ...w, last_status: "background" }, { pid: 5, stopped: false }, now)).toEqual({});
    expect(decideBackground({ ...w, last_status: "background" }, { pid: 5, stopped: true }, now)).toEqual({ event: "background", set: { last_status: "stopped" } });
  });
  test("back in the foreground, the turn it was on still ends in a finish", () => {
    expect(decide({ ...w, last_status: "background" }, { agent_status: "idle" }, now)).toMatchObject({ event: "finished" });
  });
});

describe("messages", () => {
  const w: Watched = { name: null, cwd: "/Users/me/src/tries/2026-08-26-relay", since: since(0), kind: "cursor" };
  test("an unnamed agent is named by kind, title and pane", () => {
    const agent = { agent: "cursor", terminal_title_stripped: "Relay MVP Audit" };
    expect(message(w, agent, "w3T:pKW", { type: "question", excerpt: "Should I migrate now?" })).toBe(
      'cursor "Relay MVP Audit" (w3T:pKW) asks in 2026-08-26-relay: Should I migrate now?',
    );
  });
  test("a named agent by name; a gone agent from the entry", () => {
    expect(message(w, { name: "stays", agent: "cursor" }, "w3T:pKV", { type: "finished", excerpt: null })).toBe("stays finished in 2026-08-26-relay");
    expect(message(w, undefined, "w3T:pKV", { type: "gone", excerpt: null })).toBe("cursor (w3T:pKV) in 2026-08-26-relay is gone (pane closed or agent exited)");
    expect(message(w, { name: "stays" }, "w3T:pKV", { type: "blocked", excerpt: "Run this command? / $ ls" })).toBe(
      "stays in 2026-08-26-relay is waiting for an answer: Run this command? / $ ls",
    );
  });
  test("a message is one line, short enough for notify", () => {
    const m = message(w, { name: "x" }, "p", { type: "finished", excerpt: "line one\nline two ".repeat(60) });
    expect(m.includes("\n")).toBe(false);
    expect(m.length).toBeLessThanOrEqual(450);
  });
});

describe("watch_poll and notify ops", () => {
  const CURSOR_ID = "5bada10f-7201-4b25-8616-ec95d6a71501";

  function setup(extra: Record<string, unknown> = {}) {
    const state = mkdtempSync(join(tmpdir(), "herdr-watch-"));
    const agents: any[] = [{ pane_id: "w1:p1", agent: "claude", agent_status: "idle", cwd: "/srv/allowed/app" }];
    const reads: string[] = [];
    let onList = () => {};
    let screen: string | Error = "";
    const herdr = async (method: string, params: any) => {
      if (method === "agent.list") {
        onList();
        return { agents };
      }
      if (method === "agent.read") {
        reads.push(params.source);
        if (screen instanceof Error) throw screen;
        return { read: { text: screen } };
      }
      return {};
    };
    const gw = new Gateway(loadConfig({ allowedRoots: ["/srv/allowed"], stateDir: state, cursorTranscriptRoots: [state], ...extra }), herdr);
    const watch = (entries: Record<string, Partial<Watched>>) => writeFileSync(join(state, "watch.json"), JSON.stringify(entries));
    const saved = () => JSON.parse(readFileSync(join(state, "watch.json"), "utf8"));
    return {
      gw, state, agents, reads, watch, saved,
      setScreen: (s: string | Error) => void (screen = s),
      setOnList: (f: () => void) => void (onList = f),
    };
  }

  test("reports a finished agent once and says nothing is left", async () => {
    const { gw, watch } = setup();
    watch({ "w1:p1": { name: "fixer", cwd: "/srv/allowed/app", since: new Date(Date.now() - 60_000).toISOString(), last_status: "working" } });
    expect(await gw.handle("watch_poll", {})).toEqual({ messages: ["fixer finished in app"], remaining: 0 });
    expect(await gw.handle("watch_poll", {})).toEqual({ messages: [], remaining: 0 });
  });
  test("a working agent stays on the list with its status recorded", async () => {
    const { gw, agents, watch, saved } = setup();
    agents[0].agent_status = "working";
    watch({ "w1:p1": { name: null, cwd: null, since: new Date().toISOString() } });
    expect(await gw.handle("watch_poll", {})).toEqual({ messages: [], remaining: 1 });
    expect(saved()["w1:p1"].last_status).toBe("working");
  });
  test("a managed Cursor worker: its answer from the transcript, once, and it stays watched", async () => {
    const { gw, state, agents, watch, saved } = setup();
    agents[0] = {
      pane_id: "w3:p1", agent: "cursor", agent_status: "done", cwd: "/srv/allowed/relay",
      terminal_title_stripped: "Automations MVP", agent_session: { kind: "id", value: CURSOR_ID },
    };
    const dir = join(state, "srv-allowed-relay", "agent-transcripts", CURSOR_ID);
    mkdirSync(dir, { recursive: true });
    const lines = [
      { role: "user", message: { content: [{ type: "text", text: "<user_query>\nfinish the editor\n</user_query>" }] } },
      { role: "assistant", message: { content: [{ type: "text", text: "Editor done, tests pass.\n\nShould I start the pack assignment next?" }] } },
      { type: "turn_ended", status: "success" },
    ];
    writeFileSync(join(dir, `${CURSOR_ID}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n"));
    watch({ "w3:p1": { name: null, cwd: "/srv/allowed/relay", since: new Date().toISOString(), last_status: "working", managed: true, busy: true, kind: "cursor" } });
    expect(await gw.handle("watch_poll", {})).toEqual({
      messages: ['cursor "Automations MVP" (w3:p1) asks in relay: Editor done, tests pass. Should I start the pack assignment next?'],
      remaining: 1,
    });
    expect(saved()["w3:p1"]).toMatchObject({ managed: true, busy: false, last_status: "done", last_event: { type: "question" } });
    expect(await gw.handle("watch_poll", {})).toEqual({ messages: [], remaining: 1 });
  });
  test("a dialog is quoted from the detection screen", async () => {
    const { gw, agents, reads, watch, setScreen } = setup();
    agents[0].agent_status = "blocked";
    setScreen("  Run this command?\n  $ pnpm db:reset\n  → Run (once) (y)\n  Skip (esc or n)");
    watch({ "w1:p1": { name: "fixer", cwd: "/srv/allowed/app", since: new Date().toISOString(), last_status: "working" } });
    expect(await gw.handle("watch_poll", {})).toEqual({
      messages: ["fixer in app is waiting for an answer: Run this command? / $ pnpm db:reset / → Run (once) (y)"],
      remaining: 1,
    });
    expect(reads).toEqual(["detection"]);
  });
  test("an excerpt that cannot be read does not stop the report", async () => {
    const { gw, agents, watch, setScreen } = setup();
    agents[0].agent_status = "blocked";
    setScreen(new Error("agent_not_idle"));
    watch({ "w1:p1": { name: "fixer", cwd: null, since: new Date().toISOString(), last_status: "working" } });
    expect(await gw.handle("watch_poll", {})).toMatchObject({ messages: ["fixer is waiting for an answer"] });
  });
  test("an agent that left the allowed roots is gone", async () => {
    const { gw, agents, watch } = setup();
    agents[0].cwd = "/srv/secret";
    watch({ "w1:p1": { name: "fixer", cwd: "/srv/allowed/app", since: new Date().toISOString(), last_status: "working", managed: true, busy: true } });
    expect(await gw.handle("watch_poll", {})).toEqual({ messages: ["fixer in app is gone (pane closed or agent exited)"], remaining: 0 });
  });
  // Writes that land while a poll runs, between its read of the watch list and its write.
  const info = { name: "fixer", cwd: null, kind: "claude" };
  test("a prompt sent while a poll runs keeps its turn", async () => {
    const { gw, watch, saved, setOnList } = setup();
    watch({ "w1:p1": { name: "fixer", cwd: null, since: new Date().toISOString(), last_status: "working", managed: true, busy: true } });
    setOnList(() => gw.state.prompted("w1:p1", info, { agent_status: "idle" }, false));
    expect(((await gw.handle("watch_poll", {})) as any).messages).toEqual(["fixer finished"]);
    expect(saved()["w1:p1"]).toMatchObject({ busy: true, last_event: { type: "finished" } });
    expect(saved()["w1:p1"].prompted_at).toBeString();
  });
  test("a finished turn watch does not delete the next turn's watch", async () => {
    const { gw, watch, saved, setOnList } = setup();
    watch({ "w1:p1": { name: "fixer", cwd: null, since: new Date(Date.now() - 60_000).toISOString(), last_status: "working" } });
    setOnList(() => gw.state.prompted("w1:p1", info, { agent_status: "working" }, false));
    expect(await gw.handle("watch_poll", {})).toEqual({ messages: ["fixer finished"], remaining: 1 });
    expect(saved()["w1:p1"]).toMatchObject({ name: "fixer", last_event: { type: "finished" } });
  });
  test("an answer prompt_agent already returned is not reported by a poll that overlapped it", async () => {
    const { gw, agents, watch, saved, setOnList } = setup();
    agents[0].agent_status = "working";
    watch({ "w1:p1": { name: "fixer", cwd: null, since: new Date().toISOString(), last_status: "idle", managed: true, busy: false } });
    setOnList(() => gw.state.prompted("w1:p1", info, { agent_status: "idle" }, true));
    await gw.handle("watch_poll", {});
    expect(saved()["w1:p1"]).toMatchObject({ busy: false, last_status: "idle" });
    agents[0].agent_status = "idle";
    setOnList(() => {});
    expect(await gw.handle("watch_poll", {})).toEqual({ messages: [], remaining: 1 });
  });
  test("an agent started in a pane the poll reports gone keeps its new watch", async () => {
    const { gw, agents, watch, saved, setOnList } = setup();
    agents.length = 0;
    watch({ "w1:p1": { name: "old", cwd: null, since: new Date().toISOString(), last_status: "working", managed: true, busy: true } });
    setOnList(() => gw.state.manage("w1:p1", { name: "new", cwd: null, kind: "cursor" }, { agent_status: "idle" }, true));
    expect(await gw.handle("watch_poll", {})).toEqual({ messages: ["old is gone (pane closed or agent exited)"], remaining: 1 });
    expect(saved()["w1:p1"]).toMatchObject({ name: "new", managed: true, busy: false });
  });
  test("parallel watch_agent calls keep both entries", async () => {
    const { state } = setup();
    const script = join(state, "manage.ts");
    writeFileSync(script, `import { StateStore } from ${JSON.stringify(join(import.meta.dir, "../gateway/state.ts"))};
for (let i = 0; i < 20; i++) new StateStore(${JSON.stringify(state)}).manage(process.argv[2] + ":" + i, { name: null, cwd: null, kind: "cursor" }, { agent_status: "idle" });`);
    const procs = ["a", "b", "c"].map((p) => Bun.spawn(["bun", script, p]));
    await Promise.all(procs.map((p) => p.exited));
    expect(Object.keys(JSON.parse(readFileSync(join(state, "watch.json"), "utf8"))).length).toBe(60);
  });
  test("a watched agent that left the foreground is found among its shell's children", async () => {
    const { gw, state, agents, watch, saved } = setup();
    agents.length = 0;
    // A process whose command line names cursor-agent, started by this test process,
    // which plays the pane's shell.
    const bin = mkdtempSync(join(tmpdir(), "herdr-bg-"));
    symlinkSync("/bin/sleep", join(bin, "cursor-agent"));
    const job = Bun.spawn([join(bin, "cursor-agent"), "30"]);
    const shell = { pane_id: "w1:p1", cwd: "/srv/allowed/app" };
    const herdr = gw.herdr;
    (gw as any).herdr = async (method: string, params: any) =>
      method === "pane.get" ? { pane: shell }
      : method === "pane.list" ? { panes: [shell] }
      : method === "pane.process_info" ? { process_info: { shell_pid: process.pid } }
      : herdr(method, params);
    watch({ "w1:p1": { name: "worker", cwd: "/srv/allowed/app", since: new Date().toISOString(), last_status: "working", managed: true, busy: true, kind: "cursor" } });
    try {
      expect(await gw.handle("watch_poll", {})).toEqual({
        messages: [`worker in app is running in the background of its pane (pid ${job.pid}), out of Herdr's sight and unable to take input; fg in that shell brings it back`],
        remaining: 1,
      });
      expect(await gw.handle("watch_poll", {})).toEqual({ messages: [], remaining: 1 });
      process.kill(job.pid, "SIGSTOP");
      await Bun.sleep(100);
      expect(((await gw.handle("watch_poll", {})) as any).messages).toEqual([`worker in app is stopped in the background of its pane (pid ${job.pid}); fg in that shell resumes it`]);
      expect(saved()["w1:p1"]).toMatchObject({ last_status: "stopped", busy: true });
      // ChatGPT sees it too: as a watched pane, and in overview.
      const listed: any = await gw.handle("list_panes", {});
      expect(listed.panes[0]).toMatchObject({ pane_id: "w1:p1", agent: null, watch: { mode: "managed", state: "stopped" } });
      const overview: any = await gw.handle("overview", {});
      expect(overview.background).toEqual([expect.objectContaining({ pane_id: "w1:p1", agent: "cursor", status: "stopped" })]);
      expect(state).toBeString();
    } finally {
      process.kill(job.pid, "SIGCONT");
      job.kill();
      await job.exited;
    }
    expect(await gw.handle("watch_poll", {})).toEqual({ messages: ["worker in app is gone (pane closed or agent exited)"], remaining: 0 });
  });
  test("notify runs notifyCommand with the message as the last argument", async () => {
    const out = join(mkdtempSync(join(tmpdir(), "herdr-notify-")), "sent.txt");
    const script = join(tmpdir(), `fake-notify-${process.pid}.sh`);
    writeFileSync(script, `#!/bin/sh\nprintf '%s|%s' "$1" "$2" > '${out}'\n`);
    chmodSync(script, 0o755);
    const { gw } = setup({ notifyCommand: [script, "-m"] });
    await gw.handle("notify", { message: "relay finished" });
    expect(readFileSync(out, "utf8")).toBe("-m|relay finished");
    await expect(setup().gw.handle("notify", { message: "x" })).rejects.toMatchObject({ code: "capability_disabled" });
  });
});
