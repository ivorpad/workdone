import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "../src/config.ts";
import { OFFLINE_MS, sshGateway, type CallGateway } from "../src/gateway-client.ts";
import { startNotifier } from "../src/notifier.ts";

describe("notifier", () => {
  test("polls pending machines, sends through the notify machine, keeps offline ones", async () => {
    const calls: Array<[string, string, any]> = [];
    const call: CallGateway = async (machine, op, params) => {
      calls.push([machine, op, params]);
      if (op === "notify") return { ok: true, result: { exit_code: 0 } };
      if (machine === "mac") return { ok: false, error: { code: "machine_offline", message: "asleep" } };
      if (machine === "syno") return { ok: true, result: { messages: ["fixer finished in app"], remaining: 0 } };
      return { ok: true, result: { messages: [], remaining: 0 } };
    };
    const n = startNotifier(call, ["mac", "ovh", "syno"], "ovh", 3_600_000);
    await Bun.sleep(20);
    expect(calls).toContainEqual(["syno", "watch_poll", { wait_ms: 20_000 }]);
    expect(calls).toContainEqual(["ovh", "notify", { message: "syno: fixer finished in app" }]);
    // mac rests an interval after failing; the others are done.
    expect(calls.filter(([m]) => m === "mac")).toHaveLength(1);
    calls.length = 0;
    n.markPending("syno");
    await Bun.sleep(20);
    expect(calls.map(([m, op]) => `${m}:${op}`)).toEqual(["syno:watch_poll", "ovh:notify"]);
    n.stop();
    await n.idle();
  });
  test("keeps polling a machine whose gateway fails for another reason, an interval apart", async () => {
    let polls = 0;
    const call: CallGateway = async () => {
      polls++;
      return { ok: false, error: { code: "internal_error", message: "boom" } };
    };
    const n = startNotifier(call, ["mac"], "mac", 50);
    await Bun.sleep(130);
    n.stop();
    await n.idle();
    // Calls at about 0, 50 and 100 ms.
    expect(polls).toBeGreaterThanOrEqual(2);
    expect(polls).toBeLessThanOrEqual(4);
  });
  test("drops a machine whose gateway does not know watch_poll", async () => {
    let polls = 0;
    const call: CallGateway = async () => {
      polls++;
      return { ok: false, error: { code: "unknown_operation", message: "old gateway" } };
    };
    const n = startNotifier(call, ["mac"], "mac", 10);
    await n.idle();
    expect(polls).toBe(1);
  });
  test("a gateway that waits is called again as soon as it returns, one call at a time", async () => {
    let polls = 0;
    let inflight = 0;
    let most = 0;
    const call: CallGateway = async (_m, _op, params) => {
      polls++;
      most = Math.max(most, ++inflight);
      await Bun.sleep(params.wait_ms as number);
      inflight--;
      return { ok: true, result: { messages: [], remaining: 1 } };
    };
    const n = startNotifier(call, ["mac"], "mac", 3_600_000, 20);
    for (let i = 0; i < 5; i++) n.markPending("mac");
    await Bun.sleep(110);
    n.stop();
    await n.idle();
    expect(polls).toBeGreaterThanOrEqual(4);
    expect(most).toBe(1);
  });
  test("a gateway that ignores wait_ms (older, or nothing to listen to) is not hot-looped", async () => {
    let polls = 0;
    const call: CallGateway = async () => {
      polls++;
      return { ok: true, result: { messages: [], remaining: 1 } };
    };
    const n = startNotifier(call, ["mac"], "mac", 50, 20_000);
    await Bun.sleep(130);
    n.stop();
    await n.idle();
    // Calls at about 0, 50 and 100 ms.
    expect(polls).toBeGreaterThanOrEqual(2);
    expect(polls).toBeLessThanOrEqual(4);
  });
  test("messages from a quick return are sent and the next call goes out at once", async () => {
    const calls: string[] = [];
    let polls = 0;
    const call: CallGateway = async (machine, op) => {
      calls.push(`${machine}:${op}`);
      if (op === "notify") return { ok: true, result: {} };
      return { ok: true, result: { messages: ++polls === 1 ? ["fixer finished"] : [], remaining: 1 } };
    };
    const n = startNotifier(call, ["mac"], "mac", 3_600_000);
    await Bun.sleep(30);
    // The second call returned early with nothing: resting, so no third call yet.
    expect(calls).toEqual(["mac:watch_poll", "mac:notify", "mac:watch_poll"]);
    n.stop();
    await n.idle();
  });
  test("an offline machine is rested between calls, and markPending wakes it", async () => {
    let polls = 0;
    const call: CallGateway = async () => {
      polls++;
      return { ok: false, error: { code: "machine_offline", message: "asleep" } };
    };
    const n = startNotifier(call, ["mac"], "mac", 3_600_000);
    await Bun.sleep(30);
    expect(polls).toBe(1);
    n.markPending("mac");
    await Bun.sleep(10);
    expect(polls).toBe(2);
    n.stop();
    await n.idle();
  });
});

describe("offline machines fail fast", () => {
  test("after one failed connect, calls skip ssh until the window passes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "herdr-fake-ssh-"));
    const count = join(dir, "count");
    writeFileSync(count, "");
    const fake = join(dir, "ssh");
    writeFileSync(fake, `#!/bin/sh\necho x >> '${count}'\necho "ssh: connect to host 100.64.0.1 port 22: Operation timed out" >&2\nexit 255\n`);
    chmodSync(fake, 0o755);
    const cfg = parseConfig({ machines: { mac: { binary: fake, user: "u", host: "100.64.0.1", identityFile: "/k", knownHostsFile: "/kh" } } });
    let clock = 1_000_000;
    const call = sshGateway(cfg, () => clock);
    const spawns = () => readFileSync(count, "utf8").split("\n").filter(Boolean).length;
    expect(await call("mac", "bridge_status", {})).toMatchObject({ ok: false, error: { code: "machine_offline" } });
    expect(await call("mac", "bridge_status", {})).toMatchObject({ ok: false, error: { code: "machine_offline" } });
    expect(spawns()).toBe(1);
    clock += OFFLINE_MS + 1;
    await call("mac", "bridge_status", {});
    expect(spawns()).toBe(2);
  });
});
