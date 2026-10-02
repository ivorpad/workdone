import { expect, test } from "bun:test";
import { auditDetail, auditOutcome } from "../gateway/herdr-gateway.ts";

const before = "a".repeat(64);
const next = "b".repeat(64);

test("approval audit distinguishes an answered menu, a following menu and a no-op", () => {
  expect(auditOutcome("answer_agent", {
    answered: { dialog_id: before, options: [1], labels: ["Yes"], text: "private answer" },
    status: "blocked",
    dialog: { dialog_id: next, kind: "question", text: "private next menu" },
    screen_tail: "private reply",
  })).toEqual({ outcome: { answered: true, status: "blocked", dialog_id: before, next_dialog_id: next, next_kind: "question" } });
  expect(auditOutcome("answer_agent", { answered: null, status: "working", note: "already answered" }))
    .toEqual({ outcome: { answered: false, status: "working" } });
  expect(auditOutcome("read_agent", { reply: { text: "private reply" } })).toEqual({});
});

test("approval audit records authorization scope, only the tail of a lease, and no unchecked menu ID", () => {
  expect(auditDetail({ target: "worker", confirm: true, expected_dialog_id: before, mode: "all_permissions", ttl_seconds: 600, lease: "L-g6dakoyi" }))
    .toEqual({ target: "worker", confirm: true, expected_dialog_id: before, mode: "all_permissions", ttl_seconds: 600, lease: "…koyi" });
  expect(auditDetail({ expected_dialog_id: "private text", mode: "unexpected" })).toEqual({});
});
