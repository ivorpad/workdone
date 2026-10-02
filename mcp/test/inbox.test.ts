import { describe, expect, test } from "bun:test";
import type { Report } from "../../gateway/watcher.ts";
import { Inbox, POLL_MS, QUIET_POLL_MS, type Opened, type WakeType } from "../src/inbox.ts";

const report = (over: Partial<Report> = {}): Report => ({
  pane_id: "w1:p1", type: "question", agent: "robin", kind: "claude", cwd: "/src/relay", excerpt: "Which branch?", lease: "L-abc123", reply_to: null, message: "robin asks", ...over,
});

// open() that must succeed, for tests about what happens after.
function opened(box: Inbox, machine: string, lease: string, opts: Parameters<Inbox["open"]>[2] = {}) {
  const o: Opened = box.open(machine, lease, opts);
  if (!o.ok) throw new Error(`open refused: ${o.code}`);
  return o;
}
const ASKS: WakeType[] = ["message", "reply", "blocked", "question"];

describe("inbox routing", () => {
  test("an event goes only to the watch whose machine and lease hold the agent", async () => {
    const box = new Inbox();
    const mine = opened(box, "mac", "L-abc123", { wake: ASKS });
    const other = opened(box, "mac", "L-zzz999", { wake: ASKS });
    const ovh = opened(box, "ovh", "L-abc123", { wake: ASKS });
    expect(box.add("mac", [report(), report({ lease: null }), report({ lease: "L-nobody1" })])).toBe(1);
    expect((await box.next(mine.key.watch_id, mine.key.cap, 0)).events.map((e) => [e.agent, e.type, e.excerpt])).toEqual([["robin", "question", "Which branch?"]]);
    expect((await box.next(other.key.watch_id, other.key.cap, 0)).events).toEqual([]);
    expect((await box.next(ovh.key.watch_id, ovh.key.cap, 0)).events).toEqual([]);
  });

  test("a turn the thread asked for wakes it as its reply; the owner's own turns don't", async () => {
    const box = new Inbox();
    const w = opened(box, "mac", "L-abc123");
    box.add("mac", [
      report({ type: "finished", reply_to: "L-abc123", excerpt: "Reviewed: 3 issues" }),
      report({ type: "question", reply_to: "L-abc123", excerpt: "Fix all three?" }),
      report({ type: "finished", excerpt: "owner's own turn" }),
      report({ type: "question", excerpt: "owner's own question" }),
      report({ type: "finished", reply_to: "L-other99", excerpt: "owed to another thread" }),
    ]);
    expect((await box.next(w.key.watch_id, w.key.cap, 0)).events.map((e) => [e.type, e.excerpt])).toEqual([["reply", "Reviewed: 3 issues"], ["reply", "Fix all three?"]]);
  });

  test("a message an agent sends on purpose wakes its thread, even one sent before the link opened", async () => {
    let now = 0;
    const box = new Inbox(() => now);
    box.add("mac", [report({ type: "message", excerpt: "early" }), report({ type: "finished", excerpt: "not held" })]);
    const w = opened(box, "mac", "L-abc123");
    box.add("mac", [report({ type: "message", excerpt: "later" })]);
    expect((await box.next(w.key.watch_id, w.key.cap, 0)).events.map((e) => [e.type, e.excerpt])).toEqual([["message", "early"], ["message", "later"]]);
    box.add("mac", [report({ type: "message", lease: "L-late0001", excerpt: "too old" })]);
    now += 3600_000;
    const late = opened(box, "mac", "L-late0001");
    expect((await box.next(late.key.watch_id, late.key.cap, 0)).events).toEqual([]);
  });

  test("a chat that takes an agent over gets what the agent told the lease it came from", async () => {
    const box = new Inbox();
    box.add("mac", [
      report({ type: "message", lease: "L-old0001", pane_id: "w1:p1", excerpt: "told the old lease" }),
      report({ type: "message", lease: "L-old0001", pane_id: "w2:p1", excerpt: "another agent's" }),
    ]);
    const w = opened(box, "mac", "L-new0001", { panes: ["w1:p1"] });
    expect((await box.next(w.key.watch_id, w.key.cap, 0)).events.map((e) => e.excerpt)).toEqual(["told the old lease"]);
    // The other pane's message stays with the lease that holds it.
    const other = opened(box, "mac", "L-old0001", { panes: ["w2:p1"] });
    expect((await box.next(other.key.watch_id, other.key.cap, 0)).events.map((e) => e.excerpt)).toEqual(["another agent's"]);
  });

  test("events are handed out once, and a long poll wakes on a new one", async () => {
    const box = new Inbox();
    const w = opened(box, "mac", "L-abc123");
    const waiting = box.next(w.key.watch_id, w.key.cap, 5000);
    box.add("mac", [report({ reply_to: "L-abc123" })]);
    expect((await waiting).events).toHaveLength(1);
    expect((await box.next(w.key.watch_id, w.key.cap, 0)).events).toEqual([]);
  });
});

describe("inbox credentials", () => {
  test("the model-visible state has no lease, watch id or cap", () => {
    const box = new Inbox();
    const w = opened(box, "mac", "L-abc123");
    const shown = JSON.stringify(w.state);
    expect(shown).not.toContain("L-abc123");
    expect(shown).not.toContain(w.key.watch_id);
    expect(shown).not.toContain(w.key.cap);
    expect(w.key.cap).toMatch(/^wc_[0-9a-f]{40}$/);
  });

  test("watch_next and stop need the cap: the watch id alone gets nothing", async () => {
    const box = new Inbox();
    const w = opened(box, "mac", "L-abc123");
    box.add("mac", [report({ reply_to: "L-abc123" })]);
    expect(await box.next(w.key.watch_id, "wc_wrong", 0)).toEqual({ events: [], state: null });
    expect(box.stop(w.key.watch_id, "wc_wrong")).toBeNull();
    // The event is still there for the card that holds the cap.
    expect((await box.next(w.key.watch_id, w.key.cap, 0)).events).toHaveLength(1);
  });

  test("an open link can't be replaced by the lease alone; with its cap it can, keeping its rounds", async () => {
    const box = new Inbox();
    const first = opened(box, "mac", "L-abc123");
    box.add("mac", [report({ reply_to: "L-abc123" })]);
    await box.next(first.key.watch_id, first.key.cap, 0);
    expect(box.open("mac", "L-abc123")).toMatchObject({ ok: false, code: "already_linked" });
    expect(box.open("mac", "L-abc123", { cap: "wc_guess" })).toMatchObject({ ok: false, code: "already_linked" });
    const second = opened(box, "mac", "L-abc123", { cap: first.key.cap });
    expect(second.state.rounds).toBe(1);
    expect((await box.next(first.key.watch_id, first.key.cap, 0)).state).toMatchObject({ active: false, ended: "replaced by a new watch" });
  });

  test("after a restart the server knows no watch, so the card opens a new one", async () => {
    const before = opened(new Inbox(), "mac", "L-abc123");
    const after = new Inbox();
    expect((await after.next(before.key.watch_id, before.key.cap, 0)).state).toBeNull();
    expect(after.open("mac", "L-abc123", { cap: before.key.cap }).ok).toBe(true);
  });
});

describe("inbox limits", () => {
  test("a link that used up its rounds ends, and can be opened again at once", async () => {
    let now = 0;
    const box = new Inbox(() => now);
    const w = opened(box, "mac", "L-abc123", { maxRounds: 2 });
    box.add("mac", [report({ reply_to: "L-abc123" }), report({ reply_to: "L-abc123", excerpt: "second" }), report({ reply_to: "L-abc123", excerpt: "third" })]);
    const got = await box.next(w.key.watch_id, w.key.cap, 0);
    expect(got.events.map((e) => e.excerpt)).toEqual(["Which branch?", "second"]);
    expect(got.state).toMatchObject({ active: false, rounds: 2, ended: "reached its 2 rounds" });
    expect(box.open("mac", "L-abc123").ok).toBe(true);
  });

  test("stopping or expiring isn't a used-up link: it can open again at once", async () => {
    let now = 0;
    const box = new Inbox(() => now);
    const w = opened(box, "mac", "L-abc123", { hours: 1 });
    box.stop(w.key.watch_id, w.key.cap);
    expect(opened(box, "mac", "L-abc123", { hours: 1 }).ok).toBe(true);
    now += 3600_000;
    expect(box.open("mac", "L-abc123").ok).toBe(true);
  });

  test("after a wake the thread sends its agents one message, with no override; its reply allows the next", async () => {
    let now = 0;
    const box = new Inbox(() => now);
    const w = opened(box, "mac", "L-abc123");
    // Before any wake the thread is acting for the user: no limit.
    box.noteMessage("mac", "L-abc123");
    expect(box.allowMessage("mac", "L-abc123").ok).toBe(true);
    box.add("mac", [report({ reply_to: "L-abc123" })]);
    await box.next(w.key.watch_id, w.key.cap, 0);
    expect(box.allowMessage("mac", "L-abc123").ok).toBe(true);
    box.noteMessage("mac", "L-abc123");
    expect(box.allowMessage("mac", "L-abc123")).toMatchObject({ ok: false });
    expect(box.allowMessage("mac", "L-other99").ok).toBe(true);
    // The agent's reply is a new wake: one more message.
    box.add("mac", [report({ reply_to: "L-abc123", excerpt: "second reply" })]);
    await box.next(w.key.watch_id, w.key.cap, 0);
    expect(box.allowMessage("mac", "L-abc123").ok).toBe(true);
    box.noteMessage("mac", "L-abc123");
    expect(box.allowMessage("mac", "L-abc123").ok).toBe(false);
    now += 10 * 60_000;
    expect(box.allowMessage("mac", "L-abc123").ok).toBe(true);
  });

  test("the waiter of a timed-out poll is removed, and stop wakes a waiting poll", async () => {
    const box = new Inbox();
    const w = opened(box, "mac", "L-abc123");
    await box.next(w.key.watch_id, w.key.cap, 5);
    const waiting = box.next(w.key.watch_id, w.key.cap, 60_000);
    box.stop(w.key.watch_id, w.key.cap);
    expect((await waiting).state).toMatchObject({ active: false, ended: "stopped" });
  });
});

describe("polling load", () => {
  const MIN = 60_000;

  test("a watch ends after 30 quiet minutes, and a wake or a message to an agent moves that out", async () => {
    let now = 0;
    const box = new Inbox(() => now);
    const w = opened(box, "mac", "L-abc123");
    now += 29 * MIN;
    expect((await box.next(w.key.watch_id, w.key.cap, 0)).state?.active).toBe(true);
    box.noteMessage("mac", "L-abc123");
    now += 29 * MIN;
    expect((await box.next(w.key.watch_id, w.key.cap, 0)).state?.active).toBe(true);
    box.add("mac", [report({ type: "message", excerpt: "hi" })]);
    expect((await box.next(w.key.watch_id, w.key.cap, 0)).events).toHaveLength(1);
    now += 29 * MIN;
    expect((await box.next(w.key.watch_id, w.key.cap, 0)).state?.active).toBe(true);
    now += 2 * MIN;
    const ended = (await box.next(w.key.watch_id, w.key.cap, 0)).state;
    expect(ended?.active).toBe(false);
    expect(ended?.ended).toContain("idle");
  });

  test("polling alone doesn't keep a watch alive", async () => {
    let now = 0;
    const box = new Inbox(() => now);
    const w = opened(box, "mac", "L-abc123");
    for (let i = 0; i < 20; i++) {
      now += 2 * MIN;
      await box.next(w.key.watch_id, w.key.cap, 0);
    }
    expect((await box.next(w.key.watch_id, w.key.cap, 0)).state?.active).toBe(false);
  });

  test("an idle end is not a used-up link: the chat can link again at once", async () => {
    let now = 0;
    const box = new Inbox(() => now);
    opened(box, "mac", "L-abc123");
    now += 31 * MIN;
    expect(box.open("mac", "L-abc123").ok).toBe(true);
  });

  test("polls get longer once the watch has been quiet", () => {
    let now = 0;
    const box = new Inbox(() => now);
    const w = opened(box, "mac", "L-abc123");
    expect(box.pollMs(w.key.watch_id)).toBe(POLL_MS);
    now += 6 * MIN;
    expect(box.pollMs(w.key.watch_id)).toBe(QUIET_POLL_MS);
    box.noteMessage("mac", "L-abc123");
    expect(box.pollMs(w.key.watch_id)).toBe(POLL_MS);
  });

  test("a second poll on the same watch is turned away while the first waits, and events still reach the first", async () => {
    const box = new Inbox(Date.now, 10);
    const w = opened(box, "mac", "L-abc123");
    const first = box.next(w.key.watch_id, w.key.cap, 5000);
    const second = await box.next(w.key.watch_id, w.key.cap, 5000);
    expect(second.busy).toBe(true);
    expect(second.events).toEqual([]);
    box.add("mac", [report({ type: "message" })]);
    expect((await first).events).toHaveLength(1);
    // With nobody waiting any more, the next poll is served.
    expect((await box.next(w.key.watch_id, w.key.cap, 0)).busy).toBeUndefined();
  });
});

describe("watch logging", () => {
  test("open, poll and end are logged with the end of the ids, never the cap or the whole lease", async () => {
    let now = 0;
    const lines: string[] = [];
    const box = new Inbox(() => now, 30_000, (l) => lines.push(l));
    const w = opened(box, "mac", "L-abc123");
    await box.next(w.key.watch_id, w.key.cap, 0);
    now += 31 * 60_000;
    await box.next(w.key.watch_id, w.key.cap, 0);
    const events = lines.map((l) => JSON.parse(l).event);
    expect(events).toEqual(["watch_open", "watch_poll", "watch_end"]);
    const all = lines.join("\n");
    expect(all).not.toContain(w.key.cap);
    expect(all).not.toContain("L-abc123");
    expect(all).toContain("c123");
    expect(JSON.parse(lines[2]).why).toContain("idle");
  });
});
