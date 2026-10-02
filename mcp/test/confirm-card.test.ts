import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const html = readFileSync(new URL("../src/confirm.html", import.meta.url), "utf8");
const script = html.match(/<script>([\s\S]*?)<\/script>/)![1]!;

type Rpc = { id?: number; method: string; params: any };

function card() {
  const elements = new Map<string, any>();
  const element = (id: string) => {
    if (!elements.has(id)) elements.set(id, {
      hidden: ["card", "outcome", "output", "error", "notification"].includes(id), disabled: false, textContent: "", className: "",
      addEventListener() {}, getBoundingClientRect: () => ({ height: 100 }),
    });
    return elements.get(id);
  };
  let now = 0;
  let nextTimer = 1;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const sent: Rpc[] = [];
  let receive = (_event: any): void => { throw new Error("card did not register its message listener"); };
  const parent = { postMessage: (rpc: Rpc) => { sent.push(rpc); } };
  const context: any = {
    document: { getElementById: element, querySelector: () => element("main"), documentElement: { dataset: {} } },
    window: { parent, addEventListener: (_name: string, callback: (event: any) => void) => { receive = callback; } },
    ResizeObserver: class { observe() {} },
    setTimeout: (callback: () => void, ms: number) => {
      const id = nextTimer++;
      timers.set(id, { at: now + ms, callback });
      return id;
    },
    clearTimeout: (id: number) => { timers.delete(id); },
  };
  runInNewContext(script, context);
  const reply = (rpc: Rpc, result: any, error?: any) => receive({ source: parent, data: { jsonrpc: "2.0", id: rpc.id, ...(error ? { error } : { result }) } });
  reply(sent[0]!, {});
  receive({ source: parent, data: { jsonrpc: "2.0", method: "ui/notifications/tool-result", params: {
    structuredContent: { pending: "pc_test", reason: "runs git push", machine: "mac", detail: "git push", expires: "2026-10-01T12:00:00Z" },
  } } });
  const advance = (ms: number) => {
    now += ms;
    for (const [id, timer] of [...timers]) if (timer.at <= now) {
      timers.delete(id);
      timer.callback();
    }
  };
  return { element, sent, reply, advance, timers, decide: (approve = true): Promise<void> => context.decide(approve) };
}

const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
const ran = { structuredContent: { status: "ran", machine: "mac", detail: "git push", result: { exit_code: 0, stdout: "pushed" } } };

describe("confirmation card delivery", () => {
  test("a hung context update does not stop the approval from waking chat", async () => {
    const c = card();
    const decision = c.decide();
    c.reply(c.sent.find(r => r.method === "tools/call")!, ran);
    await flush();
    const wake = c.sent.find(r => r.method === "ui/message");
    expect(wake).toBeDefined();
    expect(wake!.params.content[0].text).toContain("owner approved and it ran");
    c.reply(wake!, {});
    c.advance(10000);
    await decision;
    expect(c.element("status").textContent).toBe("Approved and ran");
    expect(c.element("output").textContent).toBe("pushed");
    expect(c.element("notification").hidden).toBe(true);
    expect(c.timers.size).toBe(0);
  });

  test("a delayed chat notification failure preserves the completed approval", async () => {
    const c = card();
    const decision = c.decide();
    c.reply(c.sent.find(r => r.method === "tools/call")!, ran);
    await flush();
    c.reply(c.sent.find(r => r.method === "ui/update-model-context")!, {});
    expect(c.element("status").textContent).toBe("Approved and ran");
    c.advance(10000);
    await decision;
    expect(c.element("status").textContent).toBe("Approved and ran");
    expect(c.element("notification").textContent).toContain("Could not notify this chat");
    expect(c.element("notification").hidden).toBe(false);
    await c.decide();
    expect(c.sent.filter(r => r.method === "tools/call")).toHaveLength(1);
    expect(c.timers.size).toBe(0);
  });

  test("an approval timeout never offers or executes the same approval again", async () => {
    const c = card();
    const decision = c.decide();
    const rpc = c.sent.find(r => r.method === "tools/call")!;
    c.advance(149999);
    await flush();
    expect(c.element("status").textContent).toBe("Running…");
    c.advance(1);
    await decision;
    expect(c.element("status").textContent).toContain("approval may already have run");
    expect(c.element("status").textContent).toContain("Check the agent");
    expect(c.element("actions").hidden).toBe(true);
    expect(c.element("approve").disabled).toBe(true);
    await c.decide();
    c.reply(rpc, ran);
    await flush();
    expect(c.sent.filter(r => r.method === "tools/call")).toHaveLength(1);
    expect(c.sent.some(r => r.method === "ui/message")).toBe(false);
    expect(c.timers.size).toBe(0);
  });

  test("an RPC error leaves approval single-use and clears its timeout", async () => {
    const c = card();
    const decision = c.decide();
    c.reply(c.sent.find(r => r.method === "tools/call")!, null, { message: "connection lost" });
    await decision;
    expect(c.element("status").textContent).toContain("connection lost");
    expect(c.element("status").textContent).toContain("approval may already have run");
    await c.decide();
    expect(c.sent.filter(r => r.method === "tools/call")).toHaveLength(1);
    expect(c.timers.size).toBe(0);
  });

  test("an agent approval reports the menu answer without claiming command completion", async () => {
    const c = card();
    const decision = c.decide();
    c.reply(c.sent.find(r => r.method === "tools/call")!, {
      structuredContent: { status: "ran", op: "answer_agent", machine: "mac", detail: "Run git push?", result: { answered: 1 } },
    });
    await flush();
    expect(c.element("status").textContent).toBe("Agent menu answered");
    const wake = c.sent.find(r => r.method === "ui/message")!;
    expect(wake.params.content[0].text).toContain("agent menu was answered");
    expect(wake.params.content[0].text).not.toContain("it ran");
    c.reply(c.sent.find(r => r.method === "ui/update-model-context")!, {});
    c.reply(wake, {});
    await decision;
    expect(c.timers.size).toBe(0);
  });

  test("a vanished menu does not claim that any option was pressed", async () => {
    const c = card();
    const decision = c.decide();
    c.reply(c.sent.find(r => r.method === "tools/call")!, {
      structuredContent: { status: "ran", op: "answer_agent", machine: "mac", detail: "Run git push?", result: { answered: null } },
    });
    await flush();
    expect(c.element("status").textContent).toBe("No menu remained; check the agent");
    const wake = c.sent.find(r => r.method === "ui/message")!;
    expect(wake.params.content[0].text).toContain("no option was pressed");
    c.reply(c.sent.find(r => r.method === "ui/update-model-context")!, {});
    c.reply(wake, {});
    await decision;
  });
});
