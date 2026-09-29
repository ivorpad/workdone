import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../gateway/config.ts";
import { Gateway } from "../gateway/gateway.ts";
import { herdrSubscribe, type Subscribe } from "../gateway/herdr-events.ts";
import type { Watched } from "../gateway/state.ts";

// Stands in for Herdr's events.subscribe: push() delivers one event to the open subscription.
function fakeEvents() {
  const opened: Array<Array<Record<string, unknown>>> = [];
  const queue: any[] = [];
  let wake: (() => void) | null = null;
  let closed = 0;
  let gone = false;
  const subscribe: Subscribe = async (subscriptions) => {
    opened.push(subscriptions);
    return {
      next: (ms) =>
        new Promise((res, rej) => {
          if (queue.length) return res(queue.shift());
          if (gone) return rej(new Error("closed"));
          const t = setTimeout(() => {
            wake = null;
            res(null);
          }, ms);
          wake = () => {
            clearTimeout(t);
            queue.length ? res(queue.shift()) : rej(new Error("closed"));
          };
        }),
      close: () => void closed++,
    };
  };
  const poke = () => {
    const w = wake;
    wake = null;
    w?.();
  };
  return {
    subscribe, opened,
    closed: () => closed,
    push: (e: any) => (queue.push(e), poke()),
    hangUp: () => ((gone = true), poke()),
  };
}

function setup() {
  const state = mkdtempSync(join(tmpdir(), "herdr-wait-"));
  const agents: any[] = [{ pane_id: "w1:p1", agent: "claude", agent_status: "working", cwd: "/srv/allowed/app", state_change_seq: 1 }];
  let lists = 0;
  const events = fakeEvents();
  const herdr = Object.assign(
    async (method: string) => {
      if (method === "agent.list") {
        lists++;
        return { agents };
      }
      return {};
    },
    { subscribe: events.subscribe },
  );
  const gw = new Gateway(loadConfig({ allowedRoots: ["/srv/allowed"], stateDir: state, cursorTranscriptRoots: [state] }), herdr);
  const watch = (entries: Record<string, Partial<Watched>>) => writeFileSync(join(state, "watch.json"), JSON.stringify(entries));
  const entry = { name: "fixer", cwd: null, since: new Date(Date.now() - 60_000).toISOString(), last_status: "working", managed: true, busy: true, seq: 1 };
  return { gw, agents, events, watch, entry, lists: () => lists };
}

const status = (pane_id: string, agent_status: string) => ({ event: "pane.agent_status_changed", data: { agent: "claude", agent_status, pane_id, workspace_id: "w1" } });

describe("watch_poll with wait_ms", () => {
  test("wakes on the watched agent's event and reports it", async () => {
    const { gw, agents, events, watch, entry } = setup();
    watch({ "w1:p1": entry });
    setTimeout(() => {
      agents[0].agent_status = "idle";
      agents[0].state_change_seq = 2;
      events.push(status("w1:p1", "idle"));
    }, 50);
    const t0 = Date.now();
    expect(await gw.handle("watch_poll", { wait_ms: 20_000 })).toEqual({ messages: ["fixer finished"], remaining: 1 });
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(events.opened).toEqual([
      [{ type: "pane.agent_status_changed", pane_id: "w1:p1" }, { type: "pane.exited" }, { type: "pane.closed" }, { type: "pane.agent_detected" }],
    ]);
    expect(events.closed()).toBe(1);
  });
  test("events for panes nobody watches do not wake it", async () => {
    const { gw, events, watch, entry, lists } = setup();
    watch({ "w1:p1": entry });
    setTimeout(() => events.push({ event: "pane_agent_detected", data: { agent: "cursor", pane_id: "w9:p1", type: "pane_agent_detected", workspace_id: "w9" } }), 20);
    expect(await gw.handle("watch_poll", { wait_ms: 300 })).toEqual({ messages: [], remaining: 1 });
    // The first pass and the one at the deadline.
    expect(lists()).toBe(2);
  });
  test("with nothing happening it returns at wait_ms with the same shape", async () => {
    const { gw, events, watch, entry } = setup();
    watch({ "w1:p1": entry });
    const t0 = Date.now();
    expect(await gw.handle("watch_poll", { wait_ms: 300 })).toEqual({ messages: [], remaining: 1 });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(290);
    expect(events.closed()).toBe(1);
  });
  test("an event that changes nothing reportable goes back to waiting", async () => {
    const { gw, agents, events, watch, entry, lists } = setup();
    watch({ "w1:p1": entry });
    setTimeout(() => {
      agents[0].agent_status = "blocked";
      agents[0].state_change_seq = 2;
      events.push(status("w1:p1", "blocked"));
      events.push(status("w1:p1", "working"));
    }, 20);
    setTimeout(() => {
      agents[0].agent_status = "working";
      agents[0].state_change_seq = 3;
    }, 21);
    setTimeout(() => {
      agents[0].agent_status = "done";
      agents[0].state_change_seq = 4;
      events.push(status("w1:p1", "done"));
    }, 150);
    const res: any = await gw.handle("watch_poll", { wait_ms: 5000 });
    expect(res.messages).toEqual(["fixer finished"]);
    // Queued events are skipped: one pass per wake, not one per event.
    expect(lists()).toBe(3);
    expect(events.opened).toHaveLength(1);
  });
  test("nothing watched: no subscription, one pass, back at once", async () => {
    const { gw, events } = setup();
    expect(await gw.handle("watch_poll", { wait_ms: 20_000 })).toEqual({ messages: [], remaining: 0 });
    expect(events.opened).toHaveLength(0);
  });
  test("without wait_ms it is the plain poll", async () => {
    const { gw, events, watch, entry } = setup();
    watch({ "w1:p1": entry });
    expect(await gw.handle("watch_poll", {})).toEqual({ messages: [], remaining: 1 });
    expect(events.opened).toHaveLength(0);
  });
  test("a Herdr without subscriptions is polled once", async () => {
    const { gw, watch, entry, lists } = setup();
    (gw.herdr as any).subscribe = async () => {
      throw new Error("unknown method");
    };
    watch({ "w1:p1": entry });
    expect(await gw.handle("watch_poll", { wait_ms: 20_000 })).toEqual({ messages: [], remaining: 1 });
    expect(lists()).toBe(1);
  });
  test("Herdr going away ends the wait with one more pass", async () => {
    const { gw, events, watch, entry, lists } = setup();
    watch({ "w1:p1": entry });
    setTimeout(() => events.hangUp(), 30);
    const t0 = Date.now();
    expect(await gw.handle("watch_poll", { wait_ms: 20_000 })).toEqual({ messages: [], remaining: 1 });
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(lists()).toBe(2);
  });
  test("a watch added during the wait is subscribed to", async () => {
    const { gw, agents, events, watch, entry } = setup();
    watch({ "w1:p1": entry });
    agents.push({ pane_id: "w2:p1", agent: "claude", agent_status: "working", cwd: "/srv/allowed/app", state_change_seq: 1 });
    setTimeout(() => watch({ "w1:p1": entry, "w2:p1": { ...entry, name: "second" } }), 50);
    setTimeout(() => {
      agents[1].agent_status = "idle";
      agents[1].state_change_seq = 2;
      events.push(status("w2:p1", "idle"));
    }, 2500);
    expect(await gw.handle("watch_poll", { wait_ms: 10_000 })).toEqual({ messages: ["second finished"], remaining: 2 });
    expect(events.opened).toHaveLength(2);
    expect(events.opened[1][1]).toEqual({ type: "pane.agent_status_changed", pane_id: "w2:p1" });
  });
});

describe("herdrSubscribe over a socket", () => {
  test("ack first, then events, split mid-line and mid-character", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "herdr-sock-")), "h.sock");
    let request = "";
    let ended = false;
    const server = Bun.listen({
      unix: path,
      socket: {
        data(s, d) {
          request += d.toString();
          const ev = Buffer.from(JSON.stringify({ event: "pane.agent_status_changed", data: { pane_id: "w1:p1", title: "café ✓" } }) + "\n");
          const cut = ev.indexOf(Buffer.from("✓")) + 1;
          s.write('{"id":"x","result":{"type":"subscription_started"}}\n' + '{"event":"a","data":{}}\n'.slice(0, 5));
          setTimeout(() => s.write('{"event":"a","data":{}}\n'.slice(5)), 10);
          setTimeout(() => s.write(ev.subarray(0, cut)), 20);
          setTimeout(() => s.write(ev.subarray(cut)), 30);
        },
        close() {
          ended = true;
        },
      },
    });
    try {
      const sub = await herdrSubscribe(path)([{ type: "pane.exited" }]);
      expect(JSON.parse(request)).toMatchObject({ method: "events.subscribe", params: { subscriptions: [{ type: "pane.exited" }] } });
      expect(await sub.next(1000)).toEqual({ event: "a", data: {} });
      expect(await sub.next(1000)).toEqual({ event: "pane.agent_status_changed", data: { pane_id: "w1:p1", title: "café ✓" } });
      expect(await sub.next(50)).toBeNull();
      sub.close();
      await Bun.sleep(20);
      expect(ended).toBe(true);
      await expect(sub.next(10)).rejects.toMatchObject({ code: "herdr_closed" });
    } finally {
      server.stop(true);
    }
  });
  test("an error instead of the ack rejects", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "herdr-sock-")), "h.sock");
    const server = Bun.listen({
      unix: path,
      socket: { data: (s) => void s.write('{"id":"x","error":{"code":"unknown_method","message":"no"}}\n') },
    });
    try {
      await expect(herdrSubscribe(path)([])).rejects.toMatchObject({ code: "unknown_method" });
      await expect(herdrSubscribe(join(path, "missing"))([])).rejects.toMatchObject({ code: "herdr_unavailable" });
    } finally {
      server.stop(true);
    }
  });
});
