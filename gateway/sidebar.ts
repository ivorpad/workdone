// What WorkDone is doing with an agent, shown in Herdr's sidebar through
// pane.report_metadata tokens. Two keys, because a token's TTL clears it rather than
// bringing back the value before: $workdone is "watched" while WorkDone reports on
// the agent, $workdone_note says what just happened ("approved permission: Yes",
// "done") and expires on its own.
//
// Display only: Herdr drops the tokens on a restart and the state files stay the
// source of truth. A report is never awaited and its failure is ignored, so it
// cannot fail or slow an op. Each report goes on its own connection, so two can land
// out of order; seq, from the clock, makes Herdr drop the older one.

import type { HerdrCall } from "./config.ts";
import type { Approval } from "./answer-ops.ts";

const SOURCE = "workdone";
export const APPROVED_TTL_MS = 60_000;
export const DONE_TTL_MS = 10 * 60_000;

let last = 0;
const nextSeq = () => (last = Math.max(last + 1, Date.now() * 1000));

function report(herdr: HerdrCall, paneId: string, tokens: Record<string, string | null>, ttlMs?: number) {
  try {
    // Herdr caps token values at 80 characters.
    const clipped = Object.fromEntries(Object.entries(tokens).map(([k, v]) => [k, v && v.slice(0, 80)]));
    herdr("pane.report_metadata", { pane_id: paneId, source: SOURCE, seq: nextSeq(), tokens: clipped, ...(ttlMs ? { ttl_ms: ttlMs } : {}) }, 2000).catch(() => {});
  } catch {
    // A display hint must never break a request.
  }
}

export function showWatched(herdr: HerdrCall, paneId: string, watched: boolean) {
  report(herdr, paneId, watched ? { workdone: "watched" } : { workdone: null, workdone_note: null });
}

export function showApproved(herdr: HerdrCall, paneId: string, approved: Approval[]) {
  if (!approved.length) return;
  const last = approved.at(-1)!;
  const text = approved.length === 1 ? `approved ${last.kind}: ${last.option}` : `approved ${approved.length}: ${approved.map((a) => a.kind).join(", ")}`;
  report(herdr, paneId, { workdone_note: text }, APPROVED_TTL_MS);
}

export function showDone(herdr: HerdrCall, paneId: string) {
  report(herdr, paneId, { workdone_note: "done" }, DONE_TTL_MS);
}

// A new prompt makes "done" or an old approval stale.
export function clearNote(herdr: HerdrCall, paneId: string) {
  report(herdr, paneId, { workdone_note: null });
}
