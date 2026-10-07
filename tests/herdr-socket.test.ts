// The gateway's Herdr client over a real Unix socket. Regression for 2026-10-07: a
// request longer than the socket buffer (8 KB on macOS) went out cut short, Herdr timed
// out reading it ("timed out reading api request") and closed, and the bound prompt was
// recorded dispatch_unknown although Herdr never parsed it and the agent stayed blank.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { timing } from "../gateway/answer-ops.ts";
import { loadConfig } from "../gateway/config.ts";
import { sendOutcome } from "../gateway/coord-ops.ts";
import { Gateway } from "../gateway/gateway.ts";
import { herdrSocket, unsent } from "../gateway/herdr-socket.ts";

const dirs: string[] = [];
const servers: Array<{ stop(force?: boolean): void }> = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = (prefix: string) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
};

// Herdr's side: one request line per connection, given up on (closed unanswered) if the
// line hasn't ended within readMs. answer gets the parsed request.
function fakeHerdr(answer: (req: any) => unknown, readMs = 300) {
  const path = join(tmp("hs-"), "h.sock");
  const got: any[] = [];
  servers.push(Bun.listen<{ buf: Buffer; timer: ReturnType<typeof setTimeout> }>({
    unix: path,
    socket: {
      open(s) {
        s.data = { buf: Buffer.alloc(0), timer: setTimeout(() => s.end(), readMs) };
      },
      data(s, chunk) {
        s.data.buf = Buffer.concat([s.data.buf, chunk]);
        const nl = s.data.buf.indexOf(0x0a);
        if (nl < 0) return;
        clearTimeout(s.data.timer);
        const req = JSON.parse(s.data.buf.subarray(0, nl).toString("utf8"));
        got.push(req);
        s.write(JSON.stringify({ id: req.id, result: answer(req) }) + "\n");
      },
      close(s) {
        clearTimeout(s.data?.timer);
      },
    },
  }));
  return { path, got };
}

describe("herdrSocket", () => {
  test("a request far bigger than the socket buffer arrives whole", async () => {
    const h = fakeHerdr((req) => ({ len: req.params.text.length }), 5000);
    // 1.2 MB of two-byte characters: past Linux's Unix socket buffer too, not only macOS's.
    const text = "é".repeat(600_000);
    expect(await herdrSocket(h.path)("agent.prompt", { target: "w1:p1", text }, 10_000)).toEqual({ len: 600_000 });
    expect(h.got[0].params.text).toBe(text);
  });

  test("closed before the request left whole: nothing was delivered", async () => {
    const path = join(tmp("hs-"), "h.sock");
    // Hangs up on the first bytes, as Herdr does when it stops reading.
    servers.push(Bun.listen({ unix: path, socket: { data: (s) => void s.end() } }));
    const err = await herdrSocket(path)("agent.prompt", { target: "w1:p1", text: "x".repeat(4_000_000) }, 10_000).catch((e) => e);
    expect(["herdr_closed", "herdr_unavailable"]).toContain(err.code);
    expect(err.message).toContain("not sent whole");
    expect(unsent(err)).toBe(true);
    expect(sendOutcome(err)).toBe("refused");
  });

  test("no socket to connect to: nothing was delivered", async () => {
    const err = await herdrSocket(join(tmp("hs-"), "missing.sock"))("agent.prompt", { target: "w1:p1", text: "go" }).catch((e) => e);
    expect(err.code).toBe("herdr_unavailable");
    expect(unsent(err)).toBe(true);
    expect(sendOutcome(err)).toBe("refused");
  });

  test("closed after the whole request went in, without an answer: delivery unknown", async () => {
    const path = join(tmp("hs-"), "h.sock");
    servers.push(Bun.listen({ unix: path, socket: { data: (s, d) => void (d.includes(0x0a) && s.end()) } }));
    const err = await herdrSocket(path)("agent.prompt", { target: "w1:p1", text: "go" }).catch((e) => e);
    expect(err.code).toBe("herdr_closed");
    expect(unsent(err)).toBe(false);
    expect(sendOutcome(err)).toBe("unknown");
  });
});

describe("a long bound prompt through the gateway (2026-10-07 incident)", () => {
  test("is delivered with its slice, and the task runs instead of going dispatch_unknown", async () => {
    timing.key = timing.text = timing.settle = 0;
    const agent = { pane_id: "w1:p1", name: "researcher", agent: "claude", agent_status: "idle", cwd: "/srv/allowed/app", agent_session: { value: "s1" }, state_change_seq: 1 };
    const h = fakeHerdr((req) => {
      if (req.method === "agent.list") return { agents: [agent] };
      if (req.method === "agent.get") return { agent };
      if (req.method === "agent.read") return { text: "" };
      if (req.method === "agent.prompt") return { agent: { ...agent, agent_status: "working" } };
      return {};
    });
    const state = tmp("hs-gw-");
    const g = new Gateway(loadConfig({ allowedRoots: ["/srv/allowed"], stateDir: state, leases: true }), herdrSocket(h.path));
    const { lease } = (await g.request("claim_agents", { label: "sup", targets: ["researcher"] })) as any;
    await g.request("coord_update", { objective: "playbook", lease, tasks: [{ id: "research", title: "Research", owner: "researcher" }] });
    // A research brief of about 12 KB, like the one that went in doubt.
    const brief = "RESEARCH ONLY. ".repeat(800);
    const res: any = await g.request("prompt_agent", { target: "researcher", text: brief, task: { objective: "playbook", id: "research" }, lease, command_id: "brief-v1" });
    expect(res.dispatch).toMatchObject({ command_id: "brief-v1", state: "delivered" });
    const prompt = h.got.find((r) => r.method === "agent.prompt");
    expect(prompt.params.text).toContain(brief);
    expect(prompt.params.text).toContain("workdone-task --token wdt_");
    const task = JSON.parse(readFileSync(join(state, "coord.json"), "utf8")).objectives.playbook.tasks.research;
    expect(task).toMatchObject({ status: "executing", protocol: null, binding: { dispatch: { state: "delivered" } } });
    expect(task.binding.prompted_at).not.toBeNull();
  });
});
