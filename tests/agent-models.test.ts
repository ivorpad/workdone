import { expect, test } from "bun:test";
import { cursorSplit, familyOf, newestPerFamily } from "../scripts/agent-models.ts";

test("a Cursor model ID splits into its model and effort", () => {
  expect(cursorSplit("claude-opus-5-5-xhigh-fast")).toEqual(["claude-opus-5-5", "xhigh-fast"]);
  expect(cursorSplit("claude-4.6-opus-max-thinking")).toEqual(["claude-4.6-opus-thinking", "max"]);
  expect(cursorSplit("claude-opus-5-thinking-high")).toEqual(["claude-opus-5-thinking", "high"]);
  expect(cursorSplit("gpt-5.5-extra-high-fast")).toEqual(["gpt-5.5", "xhigh-fast"]);
  expect(cursorSplit("gpt-5.2-fast")).toEqual(["gpt-5.2", "fast"]);
  expect(cursorSplit("gemini-3.1-pro")).toEqual(["gemini-3.1-pro", "default"]);
  expect(cursorSplit("kimi-k2.7-code")).toEqual(["kimi-k2.7-code", "default"]);
});

test("a model ID is a family and a version", () => {
  expect(familyOf("gpt-6.1-sol")).toEqual({ family: "gpt-sol", version: [6, 1] });
  expect(familyOf("claude-opus-5-5")).toEqual({ family: "claude-opus", version: [5, 5] });
  expect(familyOf("kimi-k2.7-code")).toEqual({ family: "kimi-code", version: [2, 7] });
  expect(familyOf("cursor-grok-4.6")).toEqual({ family: "grok", version: [4, 6] });
  expect(familyOf("gpt-reserve")).toEqual({ family: "gpt-reserve", version: [] });
});

test("only the newest of each family, and no family a generation behind its vendor", () => {
  const codex = ["gpt-6.1-sol", "gpt-6-astra", "gpt-6-sol", "gpt-6-luna", "gpt-reserve", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5"];
  expect(Object.fromEntries(newestPerFamily(codex))).toEqual({
    "gpt-sol": "gpt-6.1-sol", "gpt-astra": "gpt-6-astra", "gpt-luna": "gpt-6-luna", "gpt-reserve": "gpt-reserve",
  });
  const cursor = ["grok-4.7", "cursor-grok-4.6", "cursor-grok-4.5", "gemini-3.8-flash", "gemini-3.7-flash", "gemini-3.1-pro", "kimi-k3", "kimi-k2.7-code", "auto"];
  expect(Object.fromEntries(newestPerFamily(cursor))).toEqual({
    grok: "grok-4.7", "gemini-flash": "gemini-3.8-flash", "gemini-pro": "gemini-3.1-pro", kimi: "kimi-k3", auto: "auto",
  });
});
