# Coordination: the opt-in turn contract

WorkDone keeps the state of multi-agent work (objectives, tasks, owners, dependencies, acceptance, evidence, resources) so agents don't restate it in prose. This is opt-in. A prompt to an agent with no task binding behaves exactly as before: no injected text, no reporting.

## Model

Each gateway keeps `coord.json` in its state directory, written under the same lock as `watch.json` and `leases.json`:

- **Objective**: any bounded outcome (an issue, an epic, a research job). It has one supervisor, the lease of the ChatGPT thread that plans it. `take_over: true` moves it to another thread and keeps every task.
- **Task**: one executable slice. Fields: `status` (`queued`, `executing`, `waiting_dependency`, `verifying`, `blocked`, `complete`), `owner`, `deps` (task ids, no cycles), `acceptance`, `evidence`, `artifacts`, `blocker` with `blocker_kind`, `next_action`, `result`, and `version`. Each worker has one current slice, and independent workers run in parallel. There is no global lock.
  - `blocker_kind` is one of `dependency`, `resource`, `defect` (needs a `next_action`) or `human`. Only `human` means a person has to act. Approval policies stay separate.
- **Binding**: a task's tie to one agent run. It holds a pane, a Herdr session, a `generation` and a token hash. Reassigning the owner or binding again increments the generation, and the old token stops working.
- **Transitions**: a per-objective log with sequence numbers (`ready`, `needs_acceptance`, `blocked_human`, `missing_report`, `worker_gone`, `resource_stale`). The supervisor acknowledges with `ack_seq`. Anything unacknowledged shows in the resume view. A tell-route notification goes out as a hint and is never proof the supervisor processed the transition.
- **Resources**: machine-wide (`coord.json` → `resources`), so `e2e` or a browser port conflicts across objectives too. Every grant has a generation. A holder that has gone away or expired shows as `stale` and is not granted to anyone else until the supervisor frees it explicitly, because the old process may still be using it.

## Turn contract

- **Supervisor binds** with `task: {objective, id}` on `spawn_agent`, `prompt_agent` or `steer_agent`, under the objective's lease. The gateway assigns the pane and issues a token.
- **Slice at delivery**: every prompt WorkDone sends to a bound pane with an open task gets a bounded slice appended, read when the prompt goes in. The slice contains:
  - objective, task, run and generation, plus versions;
  - acceptance;
  - dependencies with their status;
  - resources held;
  - the last three evidence items (the rest by count);
  - the next action;
  - the exact `workdone-task --token …` command, with an absolute path.

  The slice never carries the whole objective.
- **Worker reports** with `workdone-task --token wdt_… '{…}'`. The token is the authorization: it is scoped to one task binding and generation. `HERDR_PANE_ID` is a convenience for agents whose shells have it, and it works only for an owner with no binding. Claude Code and Codex shell tools don't always pass `HERDR_PANE_ID` on, so the token goes in the slice.
- **State before acknowledgement**: a report is written under the lock before the command returns, and before any notification is sent. A `result` moves the task to `verifying`. That is not acceptance and not a push: the supervisor checks evidence against acceptance and merges `complete`.
- **Missing report**: a bound worker whose turn ends, or whose agent goes away, with no report since its last prompt gets `protocol: missing_report` or `worker_gone`. That is never complete. WorkDone doesn't re-prompt it, so it can't loop.
- **Coordinator resume view**: `coord_snapshot` with `view: "resume"` returns ready, blocked by kind, needs acceptance, protocol problems, next actions and unacknowledged transitions. Evidence is given by count.

## Writes and retries

- Supervisor merges take `expected_version`, either per objective or per task, so a conflict is scoped to the task it touches.
- Worker reports take `report_id`. A repeat returns the first result without applying it again.
- A stale generation, a session that changed in the bound pane, or a reassigned owner is refused with `stale_binding`, and nothing is written.
- A result never erases an explicit blocker.
- Ready propagation: when a task completes, every dependent that waited on dependencies and now has none outstanding goes to `queued`, with one `ready` transition. A resource release does the same for its waiters.
- Progress for a bound worker is its task version, not the shared repo HEAD. Several workers share one tree, so `landed` accepts a complete task without a clean tree.

## Acceptance

Unit and gateway tests (`tests/coord.test.ts`, `tests/turn-contract.test.ts`):

- one-off prompt unchanged
- bound prompt gets the slice, and the report persists
- A completes, so B becomes ready once
- duplicate report ignored
- stale generation and reassignment refused
- per-task expected version
- worker death leaves the resource stale, not free
- resource conflict across objectives
- missing report is not complete
- lost notification recovered from the resume view
- result keeps an explicit blocker
- two bound workers run in parallel
- the supervisor prefers task version over shared HEAD

Live checks on the Mac: a bound Claude agent reports from its own shell tool, a repeated `report_id` changes nothing, and an unbound prompt reaches Herdr unchanged.

## Coverage gaps

The contract covers prompts WorkDone sends. It does not cover:
- prompts typed into a terminal;
- agent-to-agent prompts sent with the herdr CLI;
- what an agent does after its turn has started.

Claude and Codex queue a steer message until the current tool call ends, so a steer slice can be stale by the time it is read. The token is visible in the pane and its transcript, so anyone who can read that pane can write that one task slice; that is the boundary, and it is narrower than the pane itself. `data.result.commit` on `agent.finished` is the repo's HEAD; the coordination `result.commit` is the worker's own claim.
