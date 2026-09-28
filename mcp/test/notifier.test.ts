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
    await n.tick();
    n.stop();
    expect(calls).toContainEqual(["ovh", "notify", { message: "syno: fixer finished in app" }]);
    calls.length = 0;
    await n.tick();
    expect(calls.map(([m, op]) => `${m}:${op}`)).toEqual(["mac:watch_poll"]);
    n.markPending("syno");
    calls.length = 0;
    await n.tick();
    expect(calls.map(([m, op]) => `${m}:${op}`)).toEqual(["mac:watch_poll", "syno:watch_poll", "ovh:notify"]);
  });
  test("keeps polling a machine whose gateway fails for another reason", async () => {
    let polls = 0;
    const call: CallGateway = async () => {
      polls++;
      return { ok: false, error: { code: "internal_error", message: "boom" } };
    };
    const n = startNotifier(call, ["mac"], "mac", 3_600_000);
    await n.tick();
    await n.tick();
    n.stop();
    expect(polls).toBe(2);
  });
  test("drops a machine whose gateway does not know watch_poll", async () => {
    let polls = 0;
    const call: CallGateway = async () => {
      polls++;
      return { ok: false, error: { code: "unknown_operation", message: "old gateway" } };
    };
    const n = startNotifier(call, ["mac"], "mac", 3_600_000);
    await n.tick();
    await n.tick();
    n.stop();
    expect(polls).toBe(1);
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
