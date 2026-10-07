// What a fresh ChatGPT session reads about results and supervision: tool descriptions,
// server instructions, the event catalog and the two plugin skills.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EVENTS } from "../mcp/src/events.ts";
import { TOOLS, buildServer } from "../mcp/src/tools.ts";

const root = join(import.meta.dir, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const skill = read("plugin/herdr-remote/skills/herdr-remote/SKILL.md");
const eventsSkill = read("plugin/workdone-events/skills/workdone-events/SKILL.md");

test("reply: true is an opt-in input on every tool that starts or prompts a turn", () => {
  for (const name of ["spawn_agent", "start_agent", "prompt_agent", "steer_agent", "supervisor_nudge"]) {
    const reply = TOOLS[name]!.input.reply as any;
    expect(reply).toBeDefined();
    expect(reply.safeParse(undefined).success).toBe(true);
    expect(reply.description).toContain("Opt-in");
    expect(reply.description).toContain("RESULT:");
    expect(reply.description).toContain("don't poll");
  }
});

test("the instructions and skills teach results, the one-nudge supervisor and Events first", () => {
  const instructions: string = (buildServer(async () => ({ ok: true, result: {} }) as any, ["mac"], "mac") as any).server._instructions ?? "";
  for (const text of [instructions, skill]) {
    expect(text).toContain("reply: true");
    expect(text).toContain("supervisor_nudge");
    expect(text).toMatch(/never (nudge again|a second nudge)/i);
  }
  expect(skill).toContain("data.result");
  expect(skill).toContain("prune_close");
  expect(skill).toContain("Never spawn a reviewer to review a reviewer");
  // Native Events stay primary; the card is the fallback.
  expect(instructions).toMatch(/prefer native MCP Events/);
  expect(skill).toMatch(/fallback when Events is unavailable/);
  expect(eventsSkill).toContain("data.result");
  expect(eventsSkill).toContain("nothing to poll");
  expect(EVENTS.find((e) => e.name === "agent.finished")!.description).toContain("reply: true");
});

test("work stays owed until the user settles it, not until a notification goes out", () => {
  const instructions: string = (buildServer(async () => ({ ok: true, result: {} }) as any, ["mac"], "mac") as any).server._instructions ?? "";
  expect(instructions).toContain("owed_work");
  expect(instructions).toContain("settle_work only on the user's word");
  expect(instructions).not.toMatch(/otherwise stop, since they get phone notifications/);
  expect(instructions).not.toContain("spawn_agent without a lease creates one");
  expect(skill).toContain("## Owed work");
  expect(skill).toContain("settle_work");
  expect(skill).not.toMatch(/phone notifications cover the rest|say that and stop|join your lease on their own/);
  expect(eventsSkill).toContain("owed_work");
  expect(TOOLS.claim_agents!.description).not.toContain("join your lease on their own");
  expect(TOOLS.settle_work!.description).toContain("closes nothing");
});

test("the Events skill carries a read-only owed-work automation for both wakes", () => {
  const recipe = eventsSkill.slice(eventsSkill.indexOf("## Supervise owed work"));
  expect(recipe).toContain("When WorkDone Events fires agent.finished for machine M, call owed_work");
  expect(recipe).toContain("agent.asks instead of agent.finished");
  expect(recipe).toContain("never prompt, settle, claim or close anything");
  expect(recipe).toContain("nothing new");
  // Asked for as an automation, never as a call ChatGPT can't make.
  expect(recipe).not.toMatch(/call events\/subscribe/);
  expect(skill).toContain("Supervise owed work");
  const events = JSON.parse(read("plugin/workdone-events/.codex-plugin/plugin.json"));
  expect(events.interface.defaultPrompt[0]).toContain("still owed");
});

test("plugin versions moved with the new tool and payload", () => {
  const atLeast = (path: string, min: string) => {
    const version = JSON.parse(read(path)).version as string;
    expect(Bun.semver.order(version, min)).toBeGreaterThanOrEqual(0);
  };
  atLeast("plugin/herdr-remote/.codex-plugin/plugin.json", "0.12.0");
  atLeast("plugin/workdone-events/.codex-plugin/plugin.json", "0.3.0");
});

test("packaged skills teach attempt fencing, acceptance and objective event limits", () => {
  for (const text of [skill, eventsSkill]) {
    expect(text).toMatch(/(opt-in|one-off)/);
    expect(text).toContain("accepted");
    expect(text).toContain("published to an upstream with nothing ahead");
    expect(text).toMatch(/(no owed result|no result still owed|not prune with an owed result|not prune while a result is owed)/);
    expect(text).toContain("task_progress");
    expect(text).toContain("task_identity");
    expect(text).toContain("command_id");
    expect(text).toContain("attempt's retry lifetime");
    expect(text).toContain("dispatch_unknown");
    expect(text).toContain("dispatch: delivered");
    expect(text).toContain("lost");
    expect(text).toContain("name@generation");
    expect(text).toContain("expected_generation");
    expect(text).toContain("unresolved blocker");
    expect(text).toContain("blocker: null");
    expect(text).toContain("coord.changed");
    expect(text).toMatch(/`machine` and `objective` filters/);
    expect(text).toContain("data-only");
    expect(text).toContain("wake signal only");
    expect(text).toContain("Ask for an automation instead");
    expect(text).toContain("best effort");
  }
  const event = EVENTS.find(e => e.name === "coord.changed")!;
  expect(Object.keys(event.inputSchema.properties!)).toEqual(["machine", "objective"]);
  expect(Object.keys(event.payloadSchema.properties!)).not.toContain("lease");
});
