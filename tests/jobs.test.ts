import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../gateway/config.ts";
import { Gateway } from "../gateway/gateway.ts";

// A stand-in for `jev-browser run`: its exit code and summary come from the first goal.
const FAKE = `#!/bin/sh
url=$1; goal=$2
case "$goal" in
  sleep) sleep 30 ;;
  fail) echo "jev-browser run: no Chrome on 9223" >&2; exit 2 ;;
esac
echo "step 1 CLICK [3]" >&2
status=DONE; code=0
[ "$goal" = block ] && status=BLOCKED && code=1
for a in "$@"; do case "$prev" in --trace) echo '{"runs":[]}' > "$a" ;; esac; prev=$a; done
printf '{"ok": %s, "steps": 4, "elapsed_ms": 900, "runs": [{"name": "goal 1", "status": "%s", "url": "%s/orders", "title": "Orders", "elapsed_ms": 900, "steps": 4}]}\\n' "$([ $code = 0 ] && echo true || echo false)" "$status" "$url"
exit $code
`;

function setup(extra: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "herdr-jobs-"));
  const bin = join(dir, "jev-browser");
  writeFileSync(bin, FAKE);
  chmodSync(bin, 0o755);
  const cfg = loadConfig({ allowedRoots: ["/srv/allowed"], stateDir: join(dir, "state"), allowExec: true, browser: { command: [bin], cwd: dir }, ...extra });
  return new Gateway(cfg, async () => ({ agents: [] }));
}

async function settled(gw: Gateway, id: string) {
  for (let i = 0; i < 100; i++) {
    const v: any = await gw.handle("browse_status", { id });
    if (v.state !== "running") return v;
    await Bun.sleep(50);
  }
  throw new Error("still running");
}

test("a run starts detached, reports its result once, and keeps its trace", async () => {
  const gw = setup();
  const started: any = await gw.handle("browse", { url: "https://shop.example", goals: ["done"], label: "orders" });
  expect(started.state).toBe("running");
  const v = await settled(gw, started.id);
  expect(v).toMatchObject({ state: "done", label: "orders", summary: { ok: true, steps: 4 } });
  expect(v.log_tail).toContain("CLICK");
  expect(existsSync(v.trace)).toBe(true);
  const poll: any = await gw.handle("watch_poll", {});
  expect(poll.messages).toEqual(['browser run "orders" done in 4 steps: https://shop.example/orders']);
  expect(poll.remaining).toBe(0);
  expect(((await gw.handle("watch_poll", {})) as any).messages).toEqual([]);
});

test("blocked and failed runs say so", async () => {
  const gw = setup();
  const b: any = await gw.handle("browse", { url: "https://a.example", goals: ["block"] });
  const f: any = await gw.handle("browse", { url: "https://a.example", goals: ["fail"] });
  expect((await settled(gw, b.id)).state).toBe("blocked");
  expect((await settled(gw, f.id)).state).toBe("failed");
  const { messages }: any = await gw.handle("watch_poll", {});
  expect(messages.sort()).toEqual([
    `browser run ${b.id} blocked at goal 1 in 4 steps: https://a.example/orders`,
    `browser run ${f.id} failed to start: jev-browser run: no Chrome on 9223`,
  ].sort());
});

test("a running run keeps the notifier polling until it is stopped", async () => {
  const gw = setup();
  const r: any = await gw.handle("browse", { url: "https://a.example", goals: ["sleep"] });
  expect(((await gw.handle("watch_poll", {})) as any).remaining).toBe(1);
  expect(((await gw.handle("browse_stop", { id: r.id })) as any).state).toBe("stopped");
  await Bun.sleep(100);
  const { messages, remaining }: any = await gw.handle("watch_poll", {});
  expect(remaining).toBe(0);
  expect(messages).toEqual([`browser run ${r.id} stopped`]);
  const list: any = await gw.handle("browse_status", {});
  expect(list.runs[0]).toMatchObject({ id: r.id, state: "stopped" });
});

test("goals reach the command as arguments, never through a shell", async () => {
  const gw = setup();
  const r: any = await gw.handle("browse", { url: "https://a.example", goals: ["done", "$(touch /tmp/owned); `id`"] });
  await settled(gw, r.id);
  expect(existsSync("/tmp/owned")).toBe(false);
  expect(JSON.parse(readFileSync(join((gw.cfg as any).stateDir, "jobs", r.id, "job.json"), "utf8")).goals[1]).toBe("$(touch /tmp/owned); `id`");
});

test("browse needs a configured browser and exec", async () => {
  await expect(setup({ browser: null }).handle("browse", { url: "https://a.example", goals: ["x"] })).rejects.toMatchObject({ code: "capability_disabled" });
  await expect(setup({ allowExec: false }).handle("browse", { url: "https://a.example", goals: ["x"] })).rejects.toMatchObject({ code: "capability_disabled" });
  await expect(setup().handle("browse", { url: "file:///etc/passwd", goals: ["x"] })).rejects.toMatchObject({ code: "invalid_params" });
});
