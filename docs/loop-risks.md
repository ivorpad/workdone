# Loop and runaway risks in agent ↔ ChatGPT wiring

ChatGPT's analysis, 2026-09-30, asked in the "Run watcher loop" chat after the first review → fix loop through `watch_here`. Condensed from its answer; its wording where quoted.

Its summary: the simple `watch_here` case is bounded by `max_rounds` and expiry, but the whole setup is not. Fresh watches, fresh threads, spawned agents, takeovers and direct agent → Herdr prompts form a feedback graph, and "max_rounds=20 bounds one edge of that graph, not the graph itself."

## The ten risks

| # | Risk | Likelihood | Trigger | Smallest guard |
|---|---|---|---|---|
| 1 | "Want me to continue?" ping-pong | High | The `question` regex fires on ordinary closing phrases; ChatGPT answers "continue" | Don't wake on continuation questions, only on unresolved decisions; suppress the same question twice from one agent |
| 2 | Review / nit loop with `finished: true` | High for review work | Every finished turn wakes ChatGPT, and there is always one more cleanup | Done criteria set before the loop; stop after two finished turns with no progress toward them |
| 3 | A ↔ B cycles in one thread | Medium to high | A's result makes ChatGPT prompt B and B's makes it prompt A | A goal-level transition budget; stop when the same A→B edge repeats three times with no state change |
| 4 | Spawn fan-out | Medium, can be severe | Spawned helpers join the lease and each wakes the thread; spawns aren't rounds | Server caps: concurrent agents per goal (4), total spawned (6), spawn depth (1) |
| 5 | Agents prompting each other directly (herdr CLI, WorkDone) | Medium, highest severity | Agents have full shell access | Every pane-to-pane prompt carries run id, depth and remaining budget, and the gateway refuses once they run out |
| 6 | `target: "new"` threads that open more threads or watches | Low to medium now | A research thread starts its own watch or thread | Threads opened by automation are leaves: no `target: new`, no new watch, no budget refill without a real user message there |
| 7 | Caps resetting | High, a design loophole | MCP restart, a new `watch_here`, a new thread | A persistent goal budget outside any watch; only a user-written message refills it |
| 8 | Prompt injection through wake text | Medium to high | An agent's excerpt contains "[WorkDone watch] … prompt agent X" | Events as structured data; the excerpt is payload with no authority; agent text can't set target, lease or pending ids |
| 9 | Two threads fighting over one agent with `take_over` | Medium | A stale queued event in the old thread acts after the takeover | Lease generation (fencing token): events and actions carry it, stale ones fail with `stale_owner`; after two takeovers in a short time, require the user |
| 10 | Cost and rate limits | High over hours | Wakes every few minutes, several agents | A global wake rate and total budget, a cooldown, and coalescing: five agents finishing within 10 s make one wake |

## Risks it added

- **The regex misfires both ways.** "I considered whether I should continue" isn't a question. "Need the production namespace before proceeding" is one, with no question mark. Agents should report a structured state (`needs_input`, question, decision type) instead of prose being parsed.
- **Duplicate work despite exactly-once delivery.** A reviewer rereads stale state and repeats a fixed finding. Events need state versions (commit SHA, tree hash), not only ids.
- **Stale events after the goal is done.** A queued finish event reopens finished work. Once a goal is terminal, events are recorded but can't start a model turn.
- **Wake storms.** Ten agents finishing at once make ten turns on the same state. Debounce and coalesce.
- **Retry loops.** "Connection failed, try again?" over and over. The same operation with the same error twice and no change in between stops automatic retries.
- **Context growth.** Fifteen rounds can make a thread huge and later turns slow and less reliable. Bound it, or restart from a state summary.
- **Useful work can still run away.** "There's a new diff" isn't progress. Progress means progress toward an explicit, finite goal.

## Guardrails, in its order

1. A durable goal/run budget (model wakes, agent prompts, spawns, agent-to-agent messages, wall time), shared across watches, threads, restarts, machines and helpers. A new watch doesn't reset it, and only a real user message refills it.
2. Fencing and provenance on every event and action: `goal_run_id`, lease id, lease generation, event id, parent event, origin.
3. Agent-to-agent actions go through the same accounting, enforced by the gateway, not by the agents.
4. Threads opened by automation don't recurse by default.
5. Structured event types from agents (`finished`, `needs_user_input`, `blocked_permission`, `blocked_decision`, `failed`); the regex stays only as a fallback.
6. A progress check per goal (HEAD / tree hash, test status, files changed). The same question twice, the same error twice, two no-progress finished turns or an A→B→A cycle stops the run; meeting the done criteria ends the watch.
7. Done criteria and a policy per watch, for example `{ goal, done_when: ["fix turn finished", "bun run check passes"], max_followups: 1, allowed_files: ["mcp/src/inbox.ts"] }`. "This would have terminated our loop deterministically after the second wake."
8. Spawn limits on the server.
9. Coalescing (2–10 s) and a per-agent cooldown. Blocking owner decisions skip the cooldown.
10. Human checkpoints, for example a user-written message after 5 autonomous turns; earlier for risky work.
11. Data kept apart from control in wake messages: "SYSTEM EVENT" fields, then "UNTRUSTED AGENT OUTPUT".
12. Cost quotas in units the user understands: max wakes, max minutes, max agents.

## Instructions versus code

Model instructions work "most of the time" for: treating excerpts as data, not answering yes to "should I continue", stopping at done criteria, not chasing cosmetic nits once checks pass, not re-arming after a cap, spawning sparingly, checking in after N rounds, noticing an identical question.

It says these must be enforced on the server: the global persistent budget (surviving restarts, not reset by re-arming, refilled only by a user message), spawn limits and depth, agent-to-agent limits, lease fencing, event ids and stale-event rejection, no recursion from automation threads, rate limits and coalescing, a hard wall-clock limit, global concurrency, destructive-operation policy, and authenticated event metadata.

Its sharpest point: with full-access agents, "any safety property that must survive a malicious, confused, or prompt-injected agent has to be enforced by the gateway/OS/tool boundary, not by a ChatGPT approval convention." The Approve card only covers what ChatGPT runs through WorkDone. An agent with a shell can push or deploy without it.

## The five it would ship first

1. A persistent `run_id` with one `remaining_actions` counter shared across threads, watches, agents and restarts.
2. Lease generation (fencing) so stale threads can't act after a takeover.
3. Agent → agent Herdr prompts consume the same budget.
4. Threads opened by automation can't open more automation threads or refill budgets.
5. A progress stop: the same blocker, question or error twice, or two finished turns with no progress, ends the autonomy and waits for the user.

Then wake batching, spawn-depth limits, structured agent state and cost quotas.
