import { expect, test } from "bun:test";
import { cursorSplit } from "../scripts/agent-aliases.ts";

test("a Cursor model ID splits into its model and effort", () => {
  expect(cursorSplit("claude-opus-5-5-xhigh-fast")).toEqual(["claude-opus-5-5", "xhigh-fast"]);
  expect(cursorSplit("claude-4.6-opus-max-thinking")).toEqual(["claude-4.6-opus-thinking", "max"]);
  expect(cursorSplit("claude-opus-5-thinking-high")).toEqual(["claude-opus-5-thinking", "high"]);
  expect(cursorSplit("gpt-5.5-extra-high-fast")).toEqual(["gpt-5.5", "xhigh-fast"]);
  expect(cursorSplit("gpt-5.2-fast")).toEqual(["gpt-5.2", "fast"]);
  expect(cursorSplit("gemini-3.1-pro")).toEqual(["gemini-3.1-pro", "default"]);
  expect(cursorSplit("kimi-k2.7-code")).toEqual(["kimi-k2.7-code", "default"]);
});
