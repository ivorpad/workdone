import { describe, expect, test } from "bun:test";
import type { Report } from "../../gateway/watcher.ts";
import { Inbox } from "../src/inbox.ts";

const report = (over: Partial<Report> = {}): Report => ({
  pane_id: "w1:p1", type: "question", agent: "robin", kind: "claude", cwd: "/src/relay", excerpt: "Which branch?", lease: "L-abc123", message: "robin asks", ...over,
});

describe("inbox", () => {
  test("an event goes only to the watch whose machine and lease hold the agent", async () => {
    const box = new Inbox();
    const mine = box.open("mac", "L-abc123");
    const other = box.open("mac", "L-zzz999");
    const ovh = box.open("ovh", "L-abc123");
    expect(box.add("mac", [report(), report({ lease: null }), report({ lease: "L-nobody1" })])).toBe(1);
    expect((await box.next(mine.watch_id, 0)).events.map((e) => [e.agent, e.type, e.excerpt])).toEqual([["robin", "question", "Which branch?"]]);
    expect((await box.next(other.watch_id, 0)).events).toEqual([]);
    expect((await box.next(ovh.watch_id, 0)).events).toEqual([]);
  });

  test("finished turns wake only a watch that asked for them", async () => {
    const box = new Inbox();
    const answers = box.open("mac", "L-abc123");
    box.add("mac", [report({ type: "finished" }), report({ type: "blocked" })]);
    expect((await box.next(answers.watch_id, 0)).events.map((e) => e.type)).toEqual(["blocked"]);
    const reviews = box.open("mac", "L-abc123", { wake: ["question", "blocked", "finished"] });
    box.add("mac", [report({ type: "finished" })]);
    expect((await box.next(reviews.watch_id, 0)).events.map((e) => e.type)).toEqual(["finished"]);
  });

  test("events are handed out once, and a long poll wakes on a new one", async () => {
    const box = new Inbox();
    const w = box.open("mac", "L-abc123");
    const waiting = box.next(w.watch_id, 5000);
    box.add("mac", [report()]);
    expect((await waiting).events).toHaveLength(1);
    expect((await box.next(w.watch_id, 0)).events).toEqual([]);
  });

  test("the watch ends at its round cap and drops what is left", async () => {
    const box = new Inbox();
    const w = box.open("mac", "L-abc123", { maxRounds: 2 });
    box.add("mac", [report(), report({ excerpt: "second" }), report({ excerpt: "third" })]);
    const got = await box.next(w.watch_id, 0);
    expect(got.events.map((e) => e.excerpt)).toEqual(["Which branch?", "second"]);
    expect(got.state).toMatchObject({ active: false, rounds: 2, ended: "reached its 2 rounds" });
    box.add("mac", [report()]);
    expect((await box.next(w.watch_id, 0)).events).toEqual([]);
  });

  test("a watch expires, and a new watch for the same thread replaces the old one", async () => {
    let now = 0;
    const box = new Inbox(() => now);
    const first = box.open("mac", "L-abc123", { hours: 1 });
    const second = box.open("mac", "L-abc123", { hours: 1 });
    expect(box.state(first.watch_id)).toMatchObject({ active: false, ended: "replaced by a new watch" });
    now += 3600_000;
    box.add("mac", [report()]);
    expect((await box.next(second.watch_id, 0)).state).toMatchObject({ active: false, ended: "expired" });
  });

  test("stop wakes a waiting poll", async () => {
    const box = new Inbox();
    const w = box.open("mac", "L-abc123");
    const waiting = box.next(w.watch_id, 60_000);
    box.stop(w.watch_id);
    expect((await waiting).state).toMatchObject({ active: false, ended: "stopped" });
  });
});
