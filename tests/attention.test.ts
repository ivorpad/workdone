import { describe, expect, test } from "bun:test";
import { asksOwner, attentionOf, dialogExcerpt, openDialog, redact, replyExcerpt, screenReply } from "../gateway/attention.ts";

// The bottom of a Cursor CLI screen: the answer, then the input box between two
// block rules, then the model and folder footer.
const RULE_TOP = " " + "▄".repeat(60);
const RULE_BOTTOM = " " + "▀".repeat(60);
const cursorScreen = [
  "  3. Next step",
  "",
  "  Finish the open Automations gap on this branch.",
  "",
  "  Then stop. Do not open a niche module.",
  "",
  "",
  RULE_TOP,
  "  → Add a follow-up",
  RULE_BOTTOM,
  "  Grok 4.7 256K Extra High · 50%",
  "  ~/src/tries/2026-08-26-relay · feat/automations-mvp",
].join("\n");

describe("questions", () => {
  test("an answer that ends by asking the owner counts", () => {
    expect(asksOwner("I fixed the build.\n\nShould I also bump the version?")).toBe(true);
    expect(asksOwner("Two ways to go:\n\n1. Migrate now\n2. Wait for #423\n\nWhich one do you want")).toBe(true);
    expect(asksOwner("Done with the schema.\n\nDecision needed: pick the pilot niche before I continue.")).toBe(true);
    expect(asksOwner("The tests pass.\n\n**Want me to open a PR?**")).toBe(true);
  });
  test("a question earlier in the answer, or none, does not", () => {
    expect(asksOwner("Why did it fail? The cache was stale.\n\nFixed it.\n\nAll 12 tests pass.")).toBe(false);
    expect(asksOwner("Merged the branch and pushed.")).toBe(false);
  });
  test("attention: dialog when blocked, question only when settled", () => {
    expect(attentionOf("blocked", null)).toBe("dialog");
    expect(attentionOf("idle", "Should I push?")).toBe("question");
    expect(attentionOf("done", "Should I push?")).toBe("question");
    expect(attentionOf("working", "Should I push?")).toBeNull();
    expect(attentionOf("idle", "Pushed.")).toBeNull();
  });
});

describe("excerpts", () => {
  test("a question is quoted from where it is asked", () => {
    const text = "## Summary\n\nThe migration is ready.\n\nBefore I run it against staging: should I take a backup first?";
    expect(replyExcerpt(text, true)).toBe("The migration is ready. Before I run it against staging: should I take a backup first?");
  });
  test("a finished answer is quoted from its start, without markdown", () => {
    const text = "## Result\n\n**Fixed** the `retry` loop in [the worker](src/worker.ts).\n\n" + "More detail. ".repeat(40);
    const e = replyExcerpt(text, false);
    expect(e.startsWith("Result Fixed the retry loop in the worker.")).toBe(true);
    expect(e.length).toBeLessThanOrEqual(200);
    expect(e.endsWith("…")).toBe(true);
  });
  test("the answer above a Cursor input box, without the box and footer", () => {
    expect(screenReply(cursorScreen)).toBe(["  3. Next step", "  Finish the open Automations gap on this branch.", "  Then stop. Do not open a niche module."].join("\n"));
  });
  test("a screen with no input box keeps its last lines minus footer hints", () => {
    expect(screenReply("a\nb\nc\n  ? for shortcuts")).toBe("a\nb\nc");
  });
  test("a Cursor command approval", () => {
    const screen = ["  I need to reset the database.", "", "  Waiting for approval...", "  Run this command?", "  $ pnpm db:reset --force", "  → Run (once) (y)", "    Add to allowlist", "    Skip (esc or n)"].join("\n");
    expect(dialogExcerpt(screen)).toBe("I need to reset the database. / Waiting for approval... / Run this command? / $ pnpm db:reset --force / → Run (once) (y)");
  });
  test("a boxed Claude permission dialog", () => {
    const screen = [
      "╭────────────────────────────────╮",
      "│ Bash command                   │",
      "│                                │",
      "│   rm -rf build                 │",
      "│   Remove the build directory   │",
      "│                                │",
      "│ Do you want to proceed?        │",
      "│ ❯ 1. Yes                       │",
      "│   2. No, and tell Claude (esc) │",
      "╰────────────────────────────────╯",
    ].join("\n");
    expect(dialogExcerpt(screen)).toBe("rm -rf build / Remove the build directory / Do you want to proceed? / ❯ 1. Yes / 2. No, and tell Claude (esc)");
  });
  test("credentials are redacted, paths and prose are not", () => {
    const text = "export OPENAI_API_KEY=sk-proj-abcdefghijklmnop1234 and Authorization: Bearer abc.def-ghi_jkl; token=ghp_" + "a".repeat(36);
    const out = redact(text);
    expect(out).not.toContain("sk-proj-abcdefghijklmnop1234");
    expect(out).not.toContain("abc.def-ghi_jkl");
    expect(out).not.toContain("ghp_");
    expect(out).toContain("Bearer [redacted]");
    const safe = "the token expired; see ~/src/tries/2026-08-26-relay/apps/web/src/components/automations/WorkflowEditor.tsx at 8c99ff61";
    expect(redact(safe)).toBe(safe);
    expect(redact("commit " + "0123456789abcdef".repeat(2) + "01234567")).toBe("commit [redacted]");
  });
  test("credentials in environment variables, URLs and other token formats", () => {
    const cases: Array<[string, string]> = [
      ["export DB_PASSWORD=hunter2hunter2", "export DB_PASSWORD=[redacted]"],
      ["PGPASSWORD=S3cretPassw0rd psql -h db", "PGPASSWORD=[redacted] psql -h db"],
      ["AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", "AWS_SECRET_ACCESS_KEY=[redacted]"],
      ["GITHUB_TOKEN=abcdEFGH1234ijklMNOP5678", "GITHUB_TOKEN=[redacted]"],
      ["STRIPE_KEY=sk_live_51Hxxxx0000aaaa1111", "STRIPE_KEY=[redacted]"],
      ["psql postgres://admin:S3cretPassw0rd@db.internal:5432/app", "psql postgres://admin:[redacted]@db.internal:5432/app"],
      [":_authToken npm_" + "a".repeat(36), ":_authToken [redacted]"],
      ["glpat-abcdefghijklmnopqrst", "[redacted]"],
    ];
    for (const [input, out] of cases) expect(redact(input)).toBe(out);
  });
  test("a dialog line is redacted before it is shortened", () => {
    const screen = `Run this command?\n$ ${"x".repeat(80)} API_KEY=abcdefghijklmnop0123456789\n→ Run (once) (y)`;
    expect(dialogExcerpt(screen)).not.toContain("abcdefgh");
  });
});

describe("dialogs Herdr misses", () => {
  const trust = [
    "  ╭" + "─".repeat(60),
    "  │  ⚠ Workspace Trust Required",
    "  │  Do you trust the contents of this directory?",
    "  │    /private/tmp/live",
    "  │    [a] Trust this workspace",
    "  │    [q] Quit",
    "  ╰" + "─".repeat(60),
  ];
  test("Cursor's workspace trust prompt is open until an input box is drawn under it", () => {
    expect(openDialog(trust.join("\n"))).toContain("Do you trust the contents of this directory?");
    // After [a]: the old dialog stays on screen above the new input box.
    const answered = [...trust, "  Cursor Agent", RULE_TOP, "  → Plan, search, build anything", RULE_BOTTOM, "  Grok 4.7 256K Low"];
    expect(openDialog(answered.join("\n"))).toBeNull();
    expect(openDialog(cursorScreen)).toBeNull();
  });
  test("only the bottom of the screen counts", () => {
    const quoted = ["  The prompt reads: Workspace Trust Required", ...Array.from({ length: 25 }, (_, i) => `  line ${i}`)];
    expect(openDialog(quoted.join("\n"))).toBeNull();
  });
});
