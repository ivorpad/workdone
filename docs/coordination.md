# Coordination: the opt-in turn contract

WorkDone keeps the state of multi-agent work (objectives, tasks, owners, dependencies, acceptance, evidence, resources) so agents don't restate it in prose. This is opt-in. A prompt to an agent with no task binding behaves exactly as before: no injected text, no reporting. Work started without a binding is still owed: `owed_work` lists it until the user settles it (`settle_work`), and merging a bound task `complete` settles the work bound to it.

## Model

Each gateway keeps `coord.json` in its state directory, written under the same lock as `watch.json` and `leases.json`:

- **Objective**: any bounded outcome (an issue, an epic, a research job). It has one supervisor, the lease of the ChatGPT thread that plans it. `take_over: true` moves it to another thread and keeps every task. Taking over an agent (`claim_agents` with `take_over`) moves the pane only, since the objective may plan other agents' tasks: the claim lists under `supervised_elsewhere` each claimed pane whose task belongs to an objective another lease supervises (objective, task, protocol, supervisor, task count, and `next`: the exact `coord_update` to move the objective too, plus the `dispatch: delivered | lost` settle when a prompt is in doubt), and `get_agent` shows the task's `supervisor`. Settling that task's dispatch, binding it or accepting it needs the objective's own `take_over`, on the user's word.
- **Task**: one executable slice. Fields: `status` (`queued`, `executing`, `waiting_dependency`, `verifying`, `blocked`, `complete`), `owner`, `deps` (task ids, no cycles), `acceptance`, `evidence`, `artifacts`, `blocker` with `blocker_kind`, `next_action`, `result`, `version` and `progress`. `version` moves on anything a supervisor merge could conflict with; `progress` only on substantive work (status, evidence, artifacts, result, blocker, waits, resources held). A heartbeat report moves neither. Each worker has one current slice, and independent workers run in parallel. There is no global lock.
  - `blocker_kind` is one of `dependency`, `resource`, `defect` (needs a `next_action`) or `human`. Only `human` means a person has to act. Approval policies stay separate.
- **Binding** (an attempt): a task's tie to one agent run. It holds a pane, a Herdr session, a `generation` and a token hash. Reassigning the owner or binding again increments the generation, and the old token stops working.
  - Each pane has one **current** binding (`coord.json` → `current`): the one most recently bound there. Slices, supervision, `get_agent` and turn attribution all resolve the pane through `currentTaskBinding`. An earlier binding on the pane (a task left in `verifying` when the worker moved on) is history. Its token can still add evidence to its own task, but that task never becomes the pane's current one again, even after the current task completes or is reassigned. A binding issued to another Herdr session is not current for a restarted agent.
- **Transitions**: a per-objective log with sequence numbers (`ready`, `needs_acceptance`, `blocked_human`, `missing_report`, `worker_gone`, `resource_stale`, `dispatch_unknown`). Each names its own objective: a resource released in one objective can make another objective's task ready, and that transition is logged and notified there. The notification goes to that objective's supervisor lease with event id `coord:<objective>:<seq>`, never to whichever worker pane caused it, and a newly ready task with no worker still reaches its supervisor. The supervisor acknowledges with `ack_seq`. Anything unacknowledged shows in the resume view. A notification is a hint and never proof the supervisor processed the transition.
- **Resources**: machine-wide (`coord.json` → `resources`), so `e2e` or a browser port conflicts across objectives too. Every grant has a generation and names the binding (attempt) that holds it. Only that attempt renews or releases it. A later run of the same task is a different holder: rebinding to the same pane and session carries the lease over (same process); rebinding anywhere else marks it `stale` at once. A stale lease is never granted again, not even to the same task, until the supervisor frees it with `null`, because the old process may still be using it. Moving a live lease to another task needs `{task, expected_generation}`. Completing or removing a task frees only what its current run holds; anything an earlier run holds stays stale. A worker releases with `name@generation` so a late release can't free a grant it acquired again since.

## Turn contract

- **Supervisor binds** with `task: {objective, id}` on `spawn_agent`, `prompt_agent` or `steer_agent`, under the objective's lease. The gateway assigns the pane and issues a token.
- **Dispatch**: a prompt that carries a slice is a dispatch with an outcome, recorded under its `command_id` (the caller's, or one the gateway makes) with a hash of the operation, pane, task and the caller's text as sent, before the provenance stamp (whose minute changes between retries). Receipts live as long as their attempt and are never evicted; an attempt that has used 1000 is refused (`commands_full`) before anything is sent, and a rebind starts a new attempt and a new retry lifetime.
  - A new binding is pending until Herdr accepts the prompt, or until a report arrives with its token (proof of delivery).
  - A definitive Herdr refusal (`agent_busy`, `agent_not_ready`, ...) drops the pending binding and touches nothing else, so a report or merge written meanwhile survives.
  - A transport failure after sending (`herdr_timeout`, `herdr_closed`, ...) makes the binding current with `protocol: dispatch_unknown` and status left as it was, not executing.
  - A transport failure before the request left whole counts as a refusal: Herdr acts on a request only once its line ends. A long request goes out in several writes, since a macOS Unix socket takes 8 KB at a time.
  - While a dispatch is in flight or in doubt, nothing else goes to that pane through WorkDone, bound or plain. That includes a retry with a new `command_id`, and holds across a gateway restart. A report from the run, or `coord_update` with `dispatch: delivered | lost` on the task after reading the agent, settles it.
  - The same `command_id` and text again returns the recorded outcome without sending; other text under that id is `command_conflict`.
  - A settle for an attempt that was superseded meanwhile changes nothing.
- **Readiness**: a prompt to a bound run executes its task, so it is refused with `deps_unmet` while any dependency is incomplete. That holds whether the prompt names the task or just goes to the pane bound to it. Binding with no prompt (`spawn_agent` without one) is still allowed. Prompts to agents with no binding are unchanged.
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
- **Decisions for a person**: a worker that needs the owner to decide or answer something reports it as `blocker` with `blocker_kind: "human"` (and `status: "blocked"` if it can't go on), then ends its turn. That record, not the wording of its last reply, is what WorkDone goes by. A question asked only in prose is not tracked: the turn ends with `missing_report`. The slice says so.
- **State before acknowledgement**: a report is written under the lock before the command returns, and before any notification is sent. A `result` moves the task to `verifying`. That is not acceptance and not a push: the supervisor checks evidence against acceptance and merges `complete`.
- **Missing report**: a bound worker whose turn ends (a final answer that asks a question in prose is a turn end too), or whose agent goes away, with no report since its last prompt gets `protocol: missing_report` or `worker_gone`. That is never complete. WorkDone doesn't re-prompt it, so it can't loop.
- **Coordinator resume view**: `coord_snapshot` with `view: "resume"` returns ready, blocked by kind, needs acceptance, protocol problems, next actions and unacknowledged transitions. Evidence is given by count.

## Writes and retries

- Supervisor merges take `expected_version`, either per objective or per task, so a conflict is scoped to the task it touches.
- Worker reports take `report_id`. Receipts belong to the attempt (binding) and are kept for its whole life, up to 1000; past that the next new id is refused with `receipts_full` before anything changes, and the supervisor rebinds. The same id with the same payload returns the first receipt and changes nothing; the same id with other content is `report_conflict`.
- Once a result has put a task in `verifying`, a worker report can't take it back to `executing`, `waiting_dependency` or `blocked` (`regressive_report`). Evidence and blockers still go in. Reopening is the supervisor's `coord_update` status change.
- A stale generation, a session that changed in the bound pane, or a reassigned owner is refused with `stale_binding`, and nothing is written.
- A result never erases an explicit blocker. A blocker stays visible in the resume view (`blocked_human`, `blocked_other`) whatever the status, and acceptance entries carry it. A human blocker is listed in `blocked_human` even while the task also waits on a resource, and a `wait_for` report doesn't change its kind. Until a report or merge clears it (`blocker: null`, or another `blocker_kind`) or the task completes, `owed_work` shows the bound agent as `needs_you` with the blocker in `task`, whatever its last reply says; `settle_work` and answering its messages don't clear it. `complete` is refused with `unresolved_blocker` unless the same merge sets `blocker: null`.
- Ready propagation: when a task completes, every dependent that waited on dependencies and now has none outstanding goes to `queued`, with one `ready` transition. A resource release does the same for its waiters.
- Progress for a bound worker is its task `progress`, compared only between turns of the same task and binding (`task_identity` on turn records), never the shared repo HEAD or `version`. Turn history without those fields is unknown, not a stall.
- A bound agent is prunable only once its task is accepted `complete`, no `reply: true` result is owed, and, if the task produced a commit, the branch shows it published (an upstream with nothing ahead). A task with no commit is `accepted` and prunable without implying anything was published. An unbound agent's `landed` likewise needs its commit pushed, not just committed.

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
- the supervisor prefers task progress over shared HEAD

Regressions from the 2026-10-06 review (`tests/coord-regressions.test.ts`, `tests/coord-regressions-gateway.test.ts`):

- a verifying task and the pane's next task, in one objective and across two; session restart; v2 store migration
- stale and earlier-attempt leases, fenced reassignment and release, complete or remove with an old holder, v2 lease migration
- a release in one objective readies another's waiter, notified to that supervisor; an unbound ready task reaches its supervisor
- refused, unknown and concurrent dispatch, prompt and steer; deps on named and implicit prompts; caller `command_id` replay; pane held by an in-flight or crashed dispatch
- partial result with a human or defect blocker; complete refused until resolved
- replay after result, receipts per attempt, more than 500 reports, capacity refusal
- heartbeats, next_action-only reports, another task's turns, publication and owed results

Regressions from 2026-10-07 (`tests/herdr-socket.test.ts`, `tests/coord-regressions-gateway.test.ts`):

- a request bigger than the socket buffer arrives whole, and a long bound prompt is delivered with its slice
- a failure before the request left whole is a refusal (no binding, no `dispatch_unknown`, the same `command_id` retries); one after it is still unknown
- taking over a bound agent moves the pane, not its objective, and the claim says so

Live checks on the Mac: a bound Claude agent reports from its own shell tool, a repeated `report_id` changes nothing, and an unbound prompt reaches Herdr unchanged.

## Coverage gaps

The contract covers prompts WorkDone sends. It does not cover:
- prompts typed into a terminal;
- agent-to-agent prompts sent with the herdr CLI;
- what an agent does after its turn has started.

`coord_snapshot` shows only objectives made with `coord_update`. `owed_work` lists all owed work, bound or not.

Claude and Codex queue a steer message until the current tool call ends, so a steer slice can be stale by the time it is read. The token is visible in the pane and its transcript, so anyone who can read that pane can write that one task slice; that is the boundary, and it is narrower than the pane itself. `data.result.commit` on `agent.finished` is the repo's HEAD; the coordination `result.commit` is the worker's own claim.
