import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { gitAgent } from "./git-agent.ts";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const setup = () => {
  const t = gitAgent();
  dirs.push(t.root);
  return t;
};
// Distinct start and end, so a cut at either side shows.
const long = (n: number, tag: string) => `START-${tag} ` + "x".repeat(n) + ` END-${tag}`;
const readAll = async (t: ReturnType<typeof setup>, id: string) => {
  let text = "";
  for (let offset: number | null = 0; offset !== null;) {
    const page: any = await t.gw.handle("read_message", { id, offset });
    text += page.text;
    offset = page.next_offset;
  }
  return text;
};

describe("read_message", () => {
  test("a long answer stays whole after the agent moves on, though the wake only previews it", async () => {
    const t = setup();
    await t.gw.handle("watch_agent", { target: "w1:p1" });
    const first = long(30_000, "one");
    t.finish(first);
    const [r] = await t.poll();
    expect(r.excerpt.length).toBeLessThan(first.length);
    expect(r).toMatchObject({ text_id: r.event_id, text_chars: first.length });
    const page: any = await t.gw.handle("read_message", { id: r.text_id });
    expect(page).toMatchObject({ kind: "reply", pane_id: "w1:p1", chars: first.length, offset: 0, next_offset: 20_000 });
    expect(await readAll(t, r.text_id)).toBe(first);

    // Another turn replaces what read_agent sees; the first answer is still there by id.
    t.finish("Second answer.");
    await t.poll();
    expect(((await t.gw.handle("read_agent", { target: "w1:p1", source: "reply" })) as any).reply.text).toBe("Second answer.");
    expect(await readAll(t, r.text_id)).toBe(first);
  });

  test("a tell longer than any preview is kept whole, and owed_work points at it", async () => {
    const t = setup();
    const text = long(6000, "tell");
    await t.gw.handle("tell", { pane_id: "w1:p1", text });
    const [r] = await t.poll();
    expect(r).toMatchObject({ type: "message", text_id: r.event_id, text_chars: text.length });
    expect(await readAll(t, r.text_id)).toBe(text);
    const owed: any = await t.gw.handle("owed_work", {});
    expect(owed.items[0].unanswered[0]).toMatchObject({ id: r.event_id, text_id: r.event_id });
  });

  test("an unknown or malformed id says so", async () => {
    const t = setup();
    await expect(t.gw.handle("read_message", { id: "nope" })).rejects.toMatchObject({ code: "not_found" });
    await expect(t.gw.handle("read_message", { id: "../watch" })).rejects.toMatchObject({ code: "invalid_params" });
  });
});
