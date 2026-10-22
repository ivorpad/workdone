import { describe, expect, test } from "bun:test";
import { TOOLS } from "../mcp/src/tools.ts";
import { TIERS, decide, levelOfMethod, visible, type Level } from "../executor/workdone/policy.ts";

// The Executor app wraps WorkDone's MCP server and decides per access level which tools exist and
// which ones stop for the owner. These hold that decision to WorkDone's own tool registry, so a
// rename or a changed annotation there cannot quietly move a tool to the wrong tier.

const ann = (name: string) => TOOLS[name]?.annotations;
const elsewhere = new Set(["get_profile"]); // registered outside TOOLS, only with an OAuth principal

describe("tiers against WorkDone's registry", () => {
  test("every named tool exists", () => {
    for (const name of [...TIERS.look, ...TIERS.bookkeeping, ...TIERS.drive]) {
      if (!elsewhere.has(name)) expect(TOOLS[name], name).toBeDefined();
    }
  });

  test("look tools are read-only and the other tiers are not", () => {
    for (const name of TIERS.look) if (!elsewhere.has(name)) expect(ann(name)?.readOnlyHint, name).toBe(true);
    for (const name of [...TIERS.bookkeeping, ...TIERS.drive]) expect(ann(name)?.readOnlyHint, name).toBe(false);
  });

  test("no tool is in two tiers", () => {
    const all = [...TIERS.look, ...TIERS.bookkeeping, ...TIERS.drive, ...TIERS.chatgptOnly];
    expect(new Set(all).size).toBe(all.length);
  });
});

describe("read only", () => {
  const level: Level = "read_only";
  test("sees agent state and nothing that starts, prompts or runs", () => {
    expect(TIERS.look.every((name) => visible(level, name))).toBe(true);
    for (const name of ["claim_agents", "spawn_agent", "prompt_agent", "exec", "read_file", "close"]) expect(visible(level, name), name).toBe(false);
  });
  test("a hidden tool called anyway is denied", () => {
    expect(decide(level, "spawn_agent", ann("spawn_agent"), { kind: "claude" })).toBe("denied");
    expect(decide(level, "exec", ann("exec"), { command: "ls" })).toBe("denied");
  });
  test("reads run without asking", () => {
    expect(decide(level, "overview", ann("overview"), {})).toBe("approved");
  });
});

describe("read plus approved writes", () => {
  const level: Level = "approved_writes";
  test("starting, prompting, steering and answering agents ask first", () => {
    for (const name of ["spawn_agent", "start_agent", "prompt_agent", "steer_agent", "answer_agent", "send_agent_keys"]) {
      expect(decide(level, name, ann(name), {}), name).toBe("user-approval");
    }
  });
  test("leases and layout run without asking", () => {
    for (const name of ["claim_agents", "release_agents", "watch_agent", "rename", "create_tab"]) expect(decide(level, name, ann(name), {}), name).toBe("approved");
  });
  test("shell, files, raw pane input, close and policy changes are not there", () => {
    for (const name of ["exec", "run_command_in_pane", "send_pane_input", "read_file", "write_file", "delete_path", "close", "set_agent_approval", "browse"]) {
      expect(visible(level, name), name).toBe(false);
    }
  });
});

describe("everything", () => {
  const level: Level = "everything";
  test("starting and prompting agents run without asking", () => {
    for (const name of ["spawn_agent", "prompt_agent", "steer_agent"]) expect(decide(level, name, ann(name), {}), name).toBe("approved");
  });
  test("settling work, waking a box, answering menus and anything destructive or shell ask", () => {
    for (const name of ["settle_work", "wake_machine", "answer_agent", "exec", "run_command_in_pane", "write_file", "delete_path", "close", "set_agent_approval", "browse", "ask_openclaw"]) {
      expect(decide(level, name, ann(name), {}), name).toBe("user-approval");
    }
  });
  test("host reads run without asking", () => {
    for (const name of ["read_file", "list_dir", "search_files"]) expect(decide(level, name, ann(name), {}), name).toBe("approved");
  });
  test("a tool added to WorkDone later asks unless it declares itself read-only", () => {
    expect(decide(level, "future_tool", { readOnlyHint: true }, {})).toBe("approved");
    expect(decide(level, "future_tool", undefined, {})).toBe("user-approval");
    expect(visible("approved_writes", "future_tool")).toBe(false);
  });
});

describe("every level", () => {
  const levels: Level[] = ["read_only", "approved_writes", "everything"];
  test("ChatGPT's cards and event hooks are never offered", () => {
    for (const level of levels) for (const name of TIERS.chatgptOnly) expect(visible(level, name), `${level} ${name}`).toBe(false);
  });
  test("a call that claims the owner already confirmed goes back to the owner", () => {
    for (const name of ["overview", "claim_agents", "spawn_agent", "exec"]) {
      expect(decide("everything", name, ann(name), { confirm: true }), name).toBe("user-approval");
    }
    expect(decide("approved_writes", "answer_agent", ann("answer_agent"), { confirm: true })).toBe("user-approval");
  });
  test("confirm does not make a hidden tool callable", () => {
    expect(decide("read_only", "exec", ann("exec"), { confirm: true })).toBe("denied");
  });
  test("method names map to levels and unknown ones to none", () => {
    expect(levelOfMethod("readOnly")).toBe("read_only");
    expect(levelOfMethod("approvedWrites")).toBe("approved_writes");
    expect(levelOfMethod("everything")).toBe("everything");
    expect(levelOfMethod("oauth")).toBeUndefined();
  });
});
